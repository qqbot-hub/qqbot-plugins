/* ============================================================
 * nonebot-plugin.mjs —— 把 PyPI 上的 NoneBot 插件真装进本机 NoneBot
 *
 * 为什么需要这份脚本（和 recipes/plugin.mjs 的区别）：
 *   plugin.mjs 装的是「本市场的插件」—— 跑在 DSH 宿主里的 JS 工具。
 *   NoneBot 生态的插件是 Python 包，必须：pip 装进 runtimes/nonebot/.venv，
 *   并且把模块名写进 pyproject.toml 的 [tool.nonebot] plugins，
 *   NoneBot 启动时才会 import 它。少任何一步都是「装了但没生效」。
 *
 * 参数：{ package: 'nonebot-plugin-apscheduler' }
 *       { package: '...', action: 'remove' }   ← 卸载
 *
 * 幂等：包已装且清单里已有 → 全部 skip。
 * 可解释：每一步都给中文 detail；失败给具体命令，不甩英文栈。
 * ============================================================ */
import path from 'node:path';
import fs from 'node:fs';
import { readNonebotPlugins, upsertNonebotPlugins } from '../scripts/lib/toml-lite.mjs';
import { isNewer } from '../scripts/lib/version.mjs';

const RUNTIME_ID = 'nonebot';
const PORTS = [8080, 20080];
const STATE_FILE = 'nonebotPlugins';

/* 国内直连 pypi 常卡死，先镜像后官方 */
const PIP_MIRRORS = [
  ['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'],
  [],
];

/** 端口上是真 NoneBot（uvicorn/FastAPI）还是别的程序 —— 与 recipes/nonebot.mjs 同一判据 */
async function isUvicorn(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/openapi.json`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) return true;
    return String(r.headers.get('server') || '').toLowerCase().includes('uvicorn');
  } catch { return false; }
}

function pyExe(ctx) {
  return ctx.isWin
    ? path.join(ctx.state.venv, 'Scripts', 'python.exe')
    : path.join(ctx.state.venv, 'bin', 'python');
}

function readLog(file, max = 8000) {
  try { return fs.readFileSync(file, 'utf8').slice(-max); } catch { return ''; }
}

/** NoneBot 的日志里没时间戳也有，统一抓关键行 */
function pluginLines(logText, mod) {
  const lines = logText.split(/\r?\n/);
  const ok = lines.filter((l) => /Succeeded to load plugin/i.test(l) && (!mod || l.includes(mod)));
  const bad = lines.filter((l) => /Failed to load plugin/i.test(l) && (!mod || l.includes(mod)));
  return { ok, bad };
}

/**
 * 找出「这个模块 import 时就抛异常」的证据。
 *
 * 关键事实：NoneBot 对插件加载异常是**吞掉并继续**的 —— 它只往日志打一段
 * traceback，进程照常起来、其它插件照常加载。所以「端口起来了」不等于
 * 「插件装好了」；只看端口会把一个报错的插件报成成功（假成功）。
 */
function moduleTraceback(logText, mod) {
  if (!mod) return '';
  const idx = logText.lastIndexOf(mod);
  if (idx < 0) return '';
  const tbIdx = logText.lastIndexOf('Traceback (most recent call last)', idx);
  if (tbIdx < 0) return '';
  const seg = logText.slice(tbIdx, idx + 600);
  /* 日志带 ANSI 颜色码（\x1b[31m），原样存进 state/展示到页面就是一串乱码，先剥掉 */
  const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const errLine = seg.split(/\r?\n/)
    .map((l) => strip(l).trim())
    .filter((l) => /^[A-Za-z_.]*(Error|Exception)\b.*:/.test(l))
    .pop();
  if (errLine) return errLine.slice(0, 300);
  /* 拿不到 "XxxError: ..." 就退一步取 traceback 最后一行非空内容 */
  const lines = seg.split(/\r?\n/).map((l) => strip(l).trim()).filter(Boolean);
  return (lines[lines.length - 1] || '').slice(0, 300);
}

/**
 * 把一个模块从 pyproject.toml 清单里摘掉；返回是否真的改动了文件。
 * 加载失败的插件必须撤下来，否则每次启动都往日志里灌 traceback。
 */
function dropFromManifest(ctx, mod) {
  const file = path.join(ctx.state.dir, 'pyproject.toml');
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  const cur = readNonebotPlugins(text);
  if (!cur.includes(mod)) return false;
  const res = upsertNonebotPlugins(text, cur.filter((x) => x !== mod));
  if (res.changed) fs.writeFileSync(file, res.text);
  return res.changed;
}

/**
 * 确保 bot.py 会去读 pyproject.toml 的插件清单。
 * 为什么需要这一步：早期版本部署出来的 bot.py 是「只注册适配器就 run()」，
 * 里面没有任何 load_* 调用 —— 这种运行时就算 pip 装了插件、清单也写了，
 * NoneBot 依然不会加载它（假装成功）。这里就地补上，避免为了装一个插件
 * 要求用户重跑整条部署流程。
 */
function ensureBotLoader(botPy) {
  if (!fs.existsSync(botPy)) return { ok: false, reason: '找不到 bot.py' };
  const src = fs.readFileSync(botPy, 'utf8');
  if (/load_from_toml|load_plugin|load_plugins|load_all_plugins/.test(src)) {
    return { ok: true, changed: false };
  }
  if (!/nonebot\.run\s*\(/.test(src)) {
    return { ok: false, reason: 'bot.py 里没有 nonebot.run()，结构不认识，不敢乱改' };
  }
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  let next = src;
  if (!/^import os\b/m.test(next)) {
    next = /^import nonebot\b/m.test(next)
      ? next.replace(/^import nonebot\b/m, 'import os' + nl + 'import nonebot')
      : 'import os' + nl + next;
  }
  const block = [
    '',
    '# 插件清单在 pyproject.toml 的 [tool.nonebot] plugins 里（由市场安装插件时自动维护）',
    'if os.path.exists("pyproject.toml"):',
    '    nonebot.load_from_toml("pyproject.toml")',
    '',
    '',
  ].join(nl);
  next = next.replace(/(^|\n)([ \t]*)(nonebot\.run\s*\()/, (m, pre, indent, call) => pre + block + indent + call);
  fs.writeFileSync(botPy, next);
  return { ok: true, changed: true };
}

export default {
  id: 'nonebot-plugin',
  title: '安装 NoneBot 插件',
  kind: 'plugin',
  steps: [
    {
      key: 'preflight',
      title: '检查 NoneBot 运行时',
      hint: '没装 NoneBot 就先部署「NapCat + NoneBot2」那条方法，插件得有地方装',
      async run(ctx) {
        const dir = ctx.paths.runtimeDir(RUNTIME_ID);
        const venv = path.join(dir, '.venv');
        const exe = ctx.isWin ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
        if (!fs.existsSync(exe)) {
          return { status: 'fail', detail: `本机没有 NoneBot 的 venv（${venv}）`, hint: '先去「部署方法」里跑一次 NapCat + NoneBot2' };
        }
        ctx.state.dir = dir;
        ctx.state.venv = venv;
        const chk = await ctx.exec(exe, ['-c', 'import nonebot;print(nonebot.__version__)'], { timeoutMs: 30000, quiet: true });
        if (chk.code !== 0) {
          return { status: 'fail', detail: 'venv 里没有 nonebot，运行时是坏的', hint: '重新跑一次 NapCat + NoneBot2 部署，或删掉 runtimes\\nonebot\\.venv 再来' };
        }
        ctx.state.nbVer = String(chk.stdout || '').trim();
        return { status: 'ok', detail: `NoneBot ${ctx.state.nbVer}（${path.relative(ctx.paths.root, venv)}）` };
      },
    },
    {
      key: 'check',
      title: '核实插件包真实存在',
      hint: '包名写 PyPI 上的真名，例如 nonebot-plugin-apscheduler',
      async run(ctx) {
        const pkg = String(ctx.params.package || ctx.params.pkg || ctx.params.id || '').trim();
        if (!pkg) return { status: 'fail', detail: '没给包名（参数 package）' };
        /* PEP 503 规范名：只允许字母数字和 . _ -，别把路径/命令塞进来 */
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pkg)) {
          return { status: 'fail', detail: `包名不合法：${pkg}` };
        }
        ctx.state.pkg = pkg;
        ctx.state.removing = String(ctx.params.action || '') === 'remove';

        /* pypi.org 在国内经常连不上（本机实测 connect timeout），
         * 所以先走镜像的 JSON API，全都挂了再试官方 —— 不把"网络不通"误报成"包不存在" */
        const sources = [
          ['清华镜像', `https://pypi.tuna.tsinghua.edu.cn/pypi/${encodeURIComponent(pkg)}/json`],
          ['阿里云镜像', `https://mirrors.aliyun.com/pypi/web/json/${encodeURIComponent(pkg)}`],
          ['官方 PyPI', `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`],
        ];
        let info = null;
        let missed = [];
        let lastErr = '';
        for (const [label, url] of sources) {
          const r = await ctx.httpGet(url, 15000);
          if (r.status === 404) { missed.push(label); continue; }
          if (r.ok && r.json && r.json.info) { info = r.json.info; ctx.log(`元数据来自${label}`); break; }
          lastErr = `${label} HTTP ${r.status}`;
        }
        if (!info) {
          if (missed.length === sources.length) {
            return {
              status: 'fail',
              detail: `三个源都查不到这个包：${pkg}`,
              hint: '包名拼错了？NoneBot 插件通常叫 nonebot-plugin-xxx，去 pypi.org 搜一下真名',
            };
          }
          return {
            status: 'fail',
            detail: `查 PyPI 元数据失败（${lastErr || '网络不通'}）`,
            hint: '镜像都连不上说明本机网络有问题，检查代理后重试；pip 安装那一步也会受影响',
          };
        }
        const latest = info.version || '';
        ctx.state.version = latest;
        /* 更新场景必须先知道「现在装的是哪个版本」，否则点一次更新就重装+重启一次机器人。
         * pip show 读的是 venv 里的真实状态，不是我们记的账。 */
        const curShow = await ctx.exec(pyExe(ctx), ['-m', 'pip', 'show', pkg], { timeoutMs: 30000, quiet: true });
        const curM = /^Version:\s*(.+)$/m.exec(curShow.stdout || '');
        ctx.state.installedVersion = curM ? curM[1].trim() : '';
        ctx.state.upToDate = !!ctx.state.installedVersion && !isNewer(latest, ctx.state.installedVersion);
        const summary = String(info.summary || '').slice(0, 70);
        /* 是不是 NoneBot 插件：包名约定 + 摘要提及，两个判据里至少一个；
         * 都不满足就只提示不拦（有些插件命名不规范，硬拦会误杀） */
        const looksNonebot = /^nonebot[-_]plugin[-_]/i.test(pkg) || /nonebot/i.test(summary + ' ' + String(info.home_page || ''));
        return {
          status: 'ok',
          detail: `${pkg}@${latest}${summary ? ' · ' + summary : ''}${looksNonebot ? '' : '（注意：从命名和摘要看不太像 NoneBot 插件，装了可能不会被加载）'}`,
        };
      },
    },
    {
      key: 'pip',
      title: 'pip 安装 / 卸载',
      hint: '装不动通常是网络，脚本会自动换官方源重试一次',
      async run(ctx) {
        const exe = pyExe(ctx);
        if (ctx.state.removing) {
          const r = await ctx.exec(exe, ['-m', 'pip', 'uninstall', '-y', ctx.state.pkg], { timeoutMs: 180000 });
          if (r.code !== 0) return { status: 'fail', detail: 'pip uninstall 失败：' + String(r.stderr || r.stdout).slice(-300) };
          return { status: 'ok', detail: `已从 venv 里卸掉 ${ctx.state.pkg}` };
        }

        /* 已装同版本就不重装（幂等） */
        const cur = await ctx.exec(exe, ['-m', 'pip', 'show', ctx.state.pkg], { timeoutMs: 30000, quiet: true });
        if (cur.code === 0) {
          const m = /^Version:\s*(.+)$/m.exec(cur.stdout || '');
          const ver = m ? m[1].trim() : '';
          if (ver && ver === ctx.state.version) {
            return { status: 'skip', detail: `已装 ${ctx.state.pkg}@${ver}，不重复安装` };
          }
          ctx.log(`已装 ${ver || '未知版本'}，将升级到 ${ctx.state.version}`);
        }

        let last = '';
        for (const mirror of PIP_MIRRORS) {
          ctx.log(`pip install ${ctx.state.pkg}==${ctx.state.version} ${mirror.join(' ') || '(官方源)'}`);
          const r = await ctx.exec(exe, [
            '-m', 'pip', 'install', '--disable-pip-version-check', '-q',
            `${ctx.state.pkg}==${ctx.state.version}`, ...mirror,
          ], { timeoutMs: 600000 });
          if (r.code === 0) {
            const again = await ctx.exec(exe, ['-m', 'pip', 'show', ctx.state.pkg], { timeoutMs: 30000, quiet: true });
            if (again.code === 0) return { status: 'ok', detail: `${ctx.state.pkg}@${ctx.state.version} 已装进 venv` };
            last = 'pip 返回成功但 pip show 查不到这个包';
            continue;
          }
          last = String(r.stderr || r.stdout || '').slice(-400);
        }
        return { status: 'fail', detail: 'pip 安装失败：' + last, hint: '换源也失败就别硬试了：先确认网络，再看这个插件声明的 Python 版本是否支持 3.13（venv 里的解释器）' };
      },
    },
    {
      key: 'resolve',
      title: '解析真实 import 名',
      hint: 'pip 包名和 import 名经常不一样（nonebot-plugin-a → nonebot_plugin_a），猜不得',
      async run(ctx) {
        if (ctx.state.removing) {
          /* 卸载时包可能已经不在 venv 里，pip show 不可靠：优先用登记表，其次按命名规则推 */
          const all = ctx.readJson(STATE_FILE, {}) || {};
          const rec = all[ctx.state.pkg] || {};
          const mod = rec.module || String(ctx.state.pkg).replace(/-/g, '_');
          ctx.state.module = mod;
          return {
            status: 'ok',
            detail: `模块名 ${mod}${rec.module ? '（来自安装登记表）' : '（按包名规则推断，登记表里没有记录）'}`,
          };
        }
        const exe = pyExe(ctx);
        /* pip show -f 的 Files 里能直接看到顶层包目录，比猜命名规则可靠 */
        const r = await ctx.exec(exe, ['-m', 'pip', 'show', '-f', ctx.state.pkg], { timeoutMs: 60000, quiet: true });
        if (r.code !== 0) return { status: 'fail', detail: 'pip show -f 读不到包内容' };
        const tops = new Set();
        for (const line of String(r.stdout || '').split(/\r?\n/)) {
          /* Windows 上 pip 的 Files 列表用反斜杠（nonebot_plugin_x\__init__.py），
           * Linux 用正斜杠 —— 两种都要认，之前只认 / 导致 Windows 上解析不出模块名 */
          const m = /^\s+([A-Za-z0-9_.-]+)[\\/]__init__\.py\s*$/.exec(line);
          if (m) tops.add(m[1]);
        }
        const list = [...tops];
        if (!list.length) {
          return { status: 'fail', detail: `${ctx.state.pkg} 里没找到 Python 包目录`, hint: '这可能是纯资源包或包装方式特殊，需要手动在 bot.py 里 load_plugin' };
        }
        /* 优先选 nonebot 插件命名，其次选第一个非私有的 */
        const mod = list.find((x) => /^nonebot_plugin_/i.test(x))
          || list.find((x) => !x.startsWith('_'))
          || list[0];
        ctx.state.module = mod;
        const extra = list.length > 1 ? `（这个包里还有：${list.filter((x) => x !== mod).join('、')}）` : '';
        return { status: 'ok', detail: `import 名是 ${mod}${extra}` };
      },
    },
    {
      key: 'enable',
      title: '写进 pyproject.toml 的插件清单',
      hint: 'NoneBot 只加载 [tool.nonebot] plugins 里列出的模块；只追加/删除这一项，不动别的配置',
      async run(ctx) {
        const file = path.join(ctx.state.dir, 'pyproject.toml');
        const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        const before = readNonebotPlugins(text);
        const mod = ctx.state.module;
        if (ctx.state.removing && !before.includes(mod)) {
          return { status: 'fail', detail: `${mod} 本来就不在启动清单里（现在只有：${before.join('、') || '空'}）`, hint: '它可能早已被移除；如果还想删包，用 pip uninstall ' + ctx.state.pkg };
        }
        const next = ctx.state.removing
          ? before.filter((x) => x !== mod)
          : before.concat([mod]);
        let res;
        try {
          res = upsertNonebotPlugins(text, next);
        } catch (e) {
          return { status: 'fail', detail: e.message };
        }
        if (!res.changed) {
          /* 清单没变也要检查 bot.py：老部署的 bot.py 不读清单，插件装了照样不生效 */
          const fix = ensureBotLoader(path.join(ctx.state.dir, 'bot.py'));
          if (!fix.ok) return { status: 'fail', detail: `${mod} 已在清单里，但 ${fix.reason}` };
          return {
            status: fix.changed ? 'ok' : 'skip',
            detail: fix.changed
              ? `${mod} 已在清单里；同时给 bot.py 补上了 load_from_toml（原来它不读插件清单）`
              : `${mod} 已在清单里，bot.py 也已支持加载，不重复添加`,
          };
        }
        fs.writeFileSync(file, res.text);
        const fix = ensureBotLoader(path.join(ctx.state.dir, 'bot.py'));
        const tailNote = fix.ok
          ? (fix.changed ? '；bot.py 已补上 load_from_toml' : '')
          : `；但 ${fix.reason}`;
        return {
          status: fix.ok ? 'ok' : 'fail',
          detail: (ctx.state.removing
            ? `已从清单移除 ${mod}（原 ${before.length} 个 → 现 ${next.length} 个）`
            : `清单已更新：${before.length} 个 → ${next.length} 个（${next.join('、')}）`) + tailNote,
        };
      },
    },
    {
      key: 'restart',
      title: '重启 NoneBot 并确认插件真的加载了',
      hint: '日志里要出现 Succeeded to load plugin 才算数；只看到端口起来不算',
      async run(ctx) {
        /* 版本没变就别重启 —— 重启一次机器人意味着群里的对话全断一次，
         * 点「更新」结果什么也没更新，用户没有理由承担这个代价 */
        if (ctx.state.upToDate) {
          return {
            status: 'skip',
            detail: `${ctx.state.pkg} 已是 v${ctx.state.installedVersion}（最新版），不重启 NoneBot`,
          };
        }
        /* 找现在 NoneBot 在哪个端口 */
        let port = 0;
        for (const p of PORTS) {
          if (await ctx.portOpen('127.0.0.1', p) && await isUvicorn(p)) { port = p; break; }
        }
        const wasRunning = !!port;
        if (port) {
          const r = await ctx.exec(ctx.isWin ? 'powershell' : 'sh', ctx.isWin
            ? ['-NoProfile', '-Command',
              `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }`]
            : ['-c', `lsof -ti tcp:${port} | xargs -r kill -9`], { timeoutMs: 20000, quiet: true });
          ctx.log(`停止旧 NoneBot 进程（退出码 ${r.code}，端口 ${port}）`);
          await new Promise((res) => setTimeout(res, 1200));
        }
        /* 端口没在跑也照样启动一次：装完插件不启动验证，等于没验证 */
        const exe = pyExe(ctx);
        const logFile = path.join(ctx.state.dir, 'nonebot.log');
        const sizeBefore = (() => { try { return fs.statSync(logFile).size; } catch { return 0; } })();
        const fd = fs.openSync(logFile, 'a');
        const started = ctx.spawnDetached(exe, ['bot.py'], { cwd: ctx.state.dir, stdio: ['ignore', fd, fd] });
        if (!started.ok) return { status: 'fail', detail: '启动 NoneBot 失败：' + started.error };

        let up = 0;
        for (let i = 0; i < 20; i++) {
          await new Promise((res) => setTimeout(res, 1500));
          for (const p of PORTS) {
            if (await ctx.portOpen('127.0.0.1', p) && await isUvicorn(p)) { up = p; break; }
          }
          if (up) break;
        }
        const logNow = (() => {
          try {
            const buf = fs.readFileSync(logFile);
            return buf.slice(sizeBefore).toString('utf8');
          } catch { return ''; }
        })();

        if (!up) {
          /* 端口没起来，多半是插件 import 就炸了 —— 把真实原因翻出来 */
          const err = /Traceback[\s\S]{0,600}/.exec(logNow);
          return {
            status: 'fail',
            detail: `NoneBot 启动后端口没起来，插件很可能把它带崩了`,
            hint: err ? '日志里的报错：' + err[0].split(/\r?\n/).slice(-6).join(' / ') : '看 runtimes\\nonebot\\nonebot.log；也可以先把这个插件从清单里删掉再启动，确认是不是它的问题',
          };
        }
        ctx.state.port = up;

        const mod = ctx.state.module;
        const readNew = () => {
          try { const buf = fs.readFileSync(logFile); return buf.slice(sizeBefore).toString('utf8'); } catch { return ''; }
        };
        let logAll = logNow;
        let { ok, bad } = pluginLines(logAll, mod);
        let tb = moduleTraceback(logAll, mod);
        if (!ok.length && !bad.length && !tb) {
          /* 日志可能还没刷出来，再等 5 秒复读一次（之前在这栽过：读早了误判"没加载"） */
          await new Promise((res) => setTimeout(res, 5000));
          logAll = readNew();
          ({ ok, bad } = pluginLines(logAll, mod));
          tb = moduleTraceback(logAll, mod);
        }
        /* 卸载方向：判据反过来 —— 加载记录消失才算卸干净 */
        if (ctx.state.removing) {
          if (ok.length) {
            return {
              status: 'fail',
              detail: `${mod} 已从清单删掉，但重启后日志里它又被加载了`,
              hint: '说明还有别的地方在加载它（比如 bot.py 里手写了 load_plugin，或 pyproject.toml 里还有另一处清单）。检查 runtimes\\nonebot\\bot.py',
            };
          }
          return {
            status: 'ok',
            detail: `已重启（${up} 端口在跑），日志里没有 ${mod} 的加载记录，卸载生效`,
          };
        }
        if (bad.length || tb) {
          const reason = tb || bad[0].slice(0, 300);
          /* 加载不了的插件留在清单里，NoneBot 每次启动都会打一遍 traceback。
           * 这是本次安装造成的污染，按"可回滚"原则撤掉；包本身留着，方便排查或换版本。 */
          const dropped = dropFromManifest(ctx, mod);
          const all = ctx.readJson(STATE_FILE, {}) || {};
          all[ctx.state.pkg] = {
            package: ctx.state.pkg,
            version: ctx.state.version,
            module: mod,
            status: 'broken',
            reason: String(reason).slice(0, 200),
            installedAt: new Date().toISOString(),
          };
          ctx.writeJson(STATE_FILE, all);
          return {
            status: 'fail',
            detail: `${mod} 没能加载（NoneBot 本身还在 ${up} 端口跑着，但会跳过这个插件）${dropped ? '；已把它从启动清单里撤下，避免每次启动都报错' : ''}`,
            hint: '真实报错：' + reason
              + ' —— 这类问题几乎都是插件与当前依赖版本不兼容（比如 NoneBot 2.5 自带 pydantic 2，老插件还在 from pydantic import BaseSettings）。'
              + '处理办法：换一个维护中的插件；包还在 venv 里（pip uninstall 可清掉），修好后重新安装即可加回清单。',
          };
        }
        if (!ok.length) {
          return {
            status: 'manual',
            detail: `NoneBot 已重启并在 ${up} 端口运行，但日志里没有 ${mod} 的加载记录，也没有报错`,
            hint: '有两种可能：插件已 import 但没打日志（少数插件这样），或它需要先填配置项。看一眼 runtimes\\nonebot\\nonebot.log 里 [INFO] ' + mod + ' 开头的行',
          };
        }
        const restarted = wasRunning ? '已重启' : '已启动';
        return {
          status: 'ok',
          detail: `${restarted}，${up} 端口在跑；日志确认 ${mod} 加载成功`,
        };
      },
    },
    {
      key: 'record',
      title: '登记已装的生态插件',
      async run(ctx) {
        const all = ctx.readJson(STATE_FILE, {}) || {};
        if (ctx.state.removing) {
          delete all[ctx.state.pkg];
          ctx.writeJson(STATE_FILE, all);
          return { status: 'ok', detail: `已从登记表移除（剩余 ${Object.keys(all).length} 个 NoneBot 插件）` };
        }
        all[ctx.state.pkg] = {
          package: ctx.state.pkg,
          version: ctx.state.version,
          module: ctx.state.module,
          port: ctx.state.port || 0,
          installedAt: new Date().toISOString(),
        };
        ctx.writeJson(STATE_FILE, all);
        return { status: 'ok', detail: `已登记（本机共 ${Object.keys(all).length} 个 NoneBot 生态插件）` };
      },
    },
  ],

  helpers: { readNonebotPlugins, upsertNonebotPlugins },
};
