/* Koishi 生态插件安装：把 npm 上的 koishi 插件装进本机 Koishi 并启用
 *
 * 参数：{ package: 'koishi-plugin-dataview' }
 *
 * 为什么单独一份脚本：
 *   市场里 46 个插件是本市场自己的插件（跑在 DSH 宿主里）。
 *   Koishi 生态那一万多个插件是另一套东西 —— 它们必须装进 Koishi 自己的
 *   node_modules，并在 koishi.yml 里登记才会被加载。这两件事不能混为一谈，
 *   混了就会出现"装了但没生效"的假成功。
 *
 * 做的事：
 *   1. 确认本机有 Koishi 运行时（没有就明确让你先部署 napcat-koishi）
 *   2. 去 registry 核实这个包**真实存在**（不存在就停，不瞎装）
 *   3. npm install 到 runtimes/koishi
 *   4. 在 koishi.yml 的 plugins 段追加一行启用它（只追加，不动你已有的配置）
 *   5. 重启 Koishi 并**等它真的起来**（探测控制台），起来了才算成功
 */
import path from 'node:path';
import fs from 'node:fs';
import { ROOT, readJson, writeJson } from '../scripts/lib/paths.mjs';

const RUNTIME_ID = 'koishi';
const CONSOLE_PORT = 5140;
const REGISTRY = 'https://registry.npmmirror.com';

/** koishi-plugin-dataview → dataview；@koishijs/plugin-help → help */
function shortName(pkg) {
  return String(pkg).replace(/^@koishijs\/plugin-/, '').replace(/^koishi-plugin-/, '');
}

/** 只动 plugins 段里我们加的那一行，其余内容原样保留 */
function upsertPlugin(yml, key, config) {
  const body = config && Object.keys(config).length
    ? '    ' + Object.entries(config).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n    ')
    : ' {}';
  const head = new RegExp('^  ' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(:|\\s*$)', 'm');
  if (head.test(yml)) return { yml, changed: false };
  const line = `  ${key}:qqhub:${body}`;
  const trimmed = yml.replace(/\s*$/, '');
  return { yml: trimmed + '\n' + line + '\n', changed: true };
}

function removePlugin(yml, key) {
  const re = new RegExp('^  ' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':qqhub:.*(?:\\n(?:    .*\\n)*)?', 'm');
  return { yml: yml.replace(re, ''), changed: re.test(yml) };
}

export default {
  id: 'koishi-plugin',
  title: '安装 Koishi 插件',
  kind: 'plugin',
  steps: [
    {
      key: 'preflight',
      title: '检查 Koishi 运行时',
      hint: '没装 Koishi 就先部署「NapCat + Koishi」那条方法，插件得有地方装',
      async run(ctx) {
        const dir = ctx.paths.runtimeDir(RUNTIME_ID);
        const koishiPkg = path.join(dir, 'node_modules', 'koishi', 'package.json');
        if (!fs.existsSync(koishiPkg)) {
          return { status: 'fail', detail: `本机没有 Koishi 运行时（${dir}）`, hint: '先去「部署方法」里跑一次 NapCat + Koishi' };
        }
        let ver = '';
        try { ver = JSON.parse(fs.readFileSync(koishiPkg, 'utf8')).version; } catch { /* 版本读不到不影响安装 */ }
        ctx.state.dir = dir;
        return { status: 'ok', detail: `Koishi ${ver || '（版本未知）'} 在 ${dir}` };
      },
    },
    {
      key: 'check',
      title: '核实插件包真实存在',
      hint: '包名要写 npm 上的真名，例如 koishi-plugin-dataview',
      async run(ctx) {
        const pkg = String(ctx.params.package || ctx.params.id || '').trim();
        if (!pkg) return { status: 'fail', detail: '没给包名（参数 package）' };
        if (!/^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(pkg)) {
          return { status: 'fail', detail: `包名不合法：${pkg}` };
        }
        ctx.state.pkg = pkg;
        ctx.state.key = shortName(pkg);
        const r = await ctx.httpGet(`${REGISTRY}/${encodeURIComponent(pkg).replace('%2F', '%2F')}`, 15000);
        if (!r.ok) {
          return { status: 'fail', detail: `registry 上没有 ${pkg}（HTTP ${r.status}）`, hint: '包名拼错了，或者它不在 npm 上' };
        }
        let meta = null;
        try { meta = JSON.parse(r.text); } catch { /* 解析失败下面会兜住 */ }
        const latest = meta && meta['dist-tags'] && meta['dist-tags'].latest;
        if (!latest) return { status: 'fail', detail: `${pkg} 查不到最新版本号` };
        ctx.state.version = latest;
        const desc = (meta.description || '').slice(0, 60);
        return { status: 'ok', detail: `${pkg}@${latest} ${desc ? '· ' + desc : ''}` };
      },
    },
    {
      key: 'install',
      title: 'npm 安装到 Koishi',
      hint: '装不动通常是网络问题，脚本会自动换源重试一次',
      async run(ctx) {
        const npm = ctx.isWin ? 'npm.cmd' : 'npm';
        const mirrors = [
          ['--registry=https://registry.npmmirror.com'],
          [],
        ];
        let last = '';
        for (const extra of mirrors) {
          ctx.log(`npm install ${ctx.state.pkg}@${ctx.state.version} ${extra.join(' ')}`.trim());
          const r = await ctx.exec(npm, [
            'install', '--no-audit', '--no-fund', '--save',
            `${ctx.state.pkg}@${ctx.state.version}`, ...extra,
          ], { cwd: ctx.state.dir, timeoutMs: 420000 });
          if (r.code === 0) {
            const installed = path.join(ctx.state.dir, 'node_modules', ctx.state.pkg, 'package.json');
            if (fs.existsSync(installed)) {
              return { status: 'ok', detail: `${ctx.state.pkg}@${ctx.state.version} 已装进 node_modules` };
            }
            last = '命令成功但 node_modules 里找不到包';
            continue;
          }
          last = String(r.stderr || r.stdout || '').slice(-300);
        }
        return { status: 'fail', detail: 'npm 安装失败：' + last };
      },
    },
    {
      key: 'enable',
      title: '在 koishi.yml 里启用',
      hint: '只追加一行，不动你已有的配置',
      async run(ctx) {
        const ymlFile = path.join(ctx.state.dir, 'koishi.yml');
        const before = fs.existsSync(ymlFile) ? fs.readFileSync(ymlFile, 'utf8') : 'plugins:\n';
        const { yml, changed } = upsertPlugin(before, ctx.state.key, ctx.params.config);
        if (!changed) return { status: 'skip', detail: `${ctx.state.key} 已在配置里，不重复添加` };
        if (!/^plugins:\s*$/m.test(yml)) {
          return { status: 'fail', detail: 'koishi.yml 不是预期的结构（缺少顶层 plugins:）', hint: `手动加一行：  ${ctx.state.key}:qqhub: {}` };
        }
        fs.writeFileSync(ymlFile, yml);
        return { status: 'ok', detail: `已在 koishi.yml 追加 ${ctx.state.key}:qqhub` };
      },
    },
    {
      key: 'restart',
      title: '重启 Koishi 让其生效',
      hint: '重启后控制台应该还能打开；起来了又掉下去说明插件把它弄坏了',
      async run(ctx) {
        /* 先停：按端口找进程，避免误杀别的 node */
        if (await ctx.portOpen('127.0.0.1', CONSOLE_PORT)) {
          const r = await ctx.exec(ctx.isWin ? 'powershell' : 'sh', ctx.isWin
            ? ['-NoProfile', '-Command',
              `Get-NetTCPConnection -LocalPort ${CONSOLE_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }`]
            : ['-c', `lsof -ti tcp:${CONSOLE_PORT} | xargs -r kill -9`], { timeoutMs: 20000, quiet: true });
          ctx.log(`停止旧 Koishi 进程（退出码 ${r.code}）`);
          await new Promise((res) => setTimeout(res, 1200));
        }
        /* 直接用 node 跑 koishi 的 bin.js：
         * 少一层 cmd.exe，进程树更干净，installer 退出后不容易被连带清理 */
        const nodeExe = process.execPath;
        const binJs = path.join(ctx.state.dir, 'node_modules', 'koishi', 'bin.js');
        if (!fs.existsSync(binJs)) {
          return { status: 'fail', detail: '找不到 node_modules/koishi/bin.js，Koishi 装得不完整' };
        }
        const logFile = path.join(ctx.state.dir, 'koishi.log');
        const fd = fs.openSync(logFile, 'a');
        const started = ctx.spawnDetached(nodeExe, [binJs, 'start'], {
          cwd: ctx.state.dir, stdio: ['ignore', fd, fd],
        });
        if (!started.ok) return { status: 'fail', detail: '启动失败：' + started.error };

        /* 第一段：等控制台起来 */
        let up = false;
        for (let i = 0; i < 30; i++) {
          await new Promise((res) => setTimeout(res, 1500));
          const probe = await ctx.httpGet(`http://127.0.0.1:${CONSOLE_PORT}/`, 2500);
          if (probe.ok) { up = true; break; }
        }
        if (!up) {
          const tail = (() => { try { return fs.readFileSync(logFile, 'utf8').slice(-500); } catch { return ''; } })();
          return {
            status: 'fail',
            detail: `重启后 45 秒内控制台 ${CONSOLE_PORT} 没起来`,
            hint: '可能是这个插件与当前 Koishi 版本不兼容，日志尾部：' + (tail || '（空）'),
          };
        }

        /* 第二段：起来了还要确认「站得住」。
         * 之前这里只看第一眼 200 就报成功，结果进程随后退出，页面却显示成功 —— 假成功。 */
        await new Promise((res) => setTimeout(res, 8000));
        const again = await ctx.httpGet(`http://127.0.0.1:${CONSOLE_PORT}/`, 2500);
        const tail = (() => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } })();
        const recent = tail.slice(-4000);
        const loaded = new RegExp('apply plugin ' + ctx.state.key + ':').test(recent);
        if (!again.ok) {
          return {
            status: 'fail',
            detail: `控制台曾起来但 8 秒后掉线（自检探到 200，之后不可用）`,
            hint: '说明进程崩了，多半是新插件不兼容。日志尾部：' + (recent.slice(-400) || '（空）'),
          };
        }
        /* 适配器崩溃是另一回事：Koishi 本身没问题，但 QQ 连不上，必须说清楚 */
        const adapterBroken = /Cannot read properties of undefined \(reading 'extend'\)/.test(recent);
        const detail = [
          `Koishi 已重启并稳定运行（控制台 ${CONSOLE_PORT}，pid ${started.pid}）`,
          loaded ? `日志确认已加载 ${ctx.state.key}` : `日志里没看到 ${ctx.state.key} 的加载记录，插件可能未生效`,
        ].join('；');
        return {
          status: adapterBroken ? 'manual' : 'ok',
          detail: adapterBroken
            ? detail + '；但 OneBot 适配器启动报错，QQ 这边没连上（已知：adapter-onebot 与 Koishi 4.18 的 @satorijs/core 版本冲突，该适配器官方已弃用）'
            : detail,
          hint: adapterBroken ? 'Koishi 控制台能进，但机器人不会收消息；要连 QQ 需换用其它 Koishi 适配器或改走 OneBot 直连' : '',
        };
      },
    },
    {
      key: 'record',
      title: '登记已装的生态插件',
      async run(ctx) {
        const file = 'koishiPlugins';
        const all = readJson(file, {}) || {};
        all[ctx.state.pkg] = {
          package: ctx.state.pkg,
          version: ctx.state.version,
          key: ctx.state.key,
          installedAt: new Date().toISOString(),
        };
        writeJson(file, all);
        return { status: 'ok', detail: `已登记（本机共 ${Object.keys(all).length} 个 Koishi 生态插件）` };
      },
    },
  ],

  /** 卸载时用：从 yml 移除并登记表里删掉（npm uninstall 由 recipes/plugin 或手动做） */
  helpers: { shortName, upsertPlugin, removePlugin },
};
