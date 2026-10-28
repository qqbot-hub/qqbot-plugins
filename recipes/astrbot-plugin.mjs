/* ============================================================
 * astrbot-plugin.mjs —— 把 GitHub 上的 AstrBot 插件装进本机 AstrBot
 *
 * AstrBot 的插件是「目录型」的，和 Koishi(NPM) / NoneBot(PyPI) 都不一样：
 *   装 = 把仓库工作树放到 <AstrBot根>/data/plugins/<目录名>/
 *   认 = 目录里必须有 metadata.yaml，且含 name / desc / version / author 四个字段
 *   （这四个字段不是我编的：astrbot/core/star/updater.py 里
 *    PLUGIN_METADATA_REQUIRED_FIELDS = ("name", "desc", "version", "author")）
 * 少一个字段 AstrBot 就会抛「插件元数据校验失败」，所以这里装完先自己校一遍，
 * 不合格直接报错，不让你到 WebUI 里才发现装了个废的。
 *
 * 参数：{ repo: 'https://github.com/owner/repo', name?: '自定义目录名' }
 *       { repo: '...', action: 'remove' }
 * ============================================================ */
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { readJson, writeJson } from '../scripts/lib/paths.mjs';

const RUNTIME_ID = 'astrbot';
const STATE_FILE = 'astrbotPlugins';
const WEBUI_PORT = 6185;          // AstrBot 默认 dashboard 端口（core/config/default.py）
const META_FILES = ['metadata.yaml', 'metadata.yml'];
const REQUIRED = ['name', 'desc', 'version', 'author'];

function dataDir(ctx) {
  return path.join(ctx.state.dir, 'data');
}
function pluginDir(ctx) {
  return path.join(dataDir(ctx), 'plugins');
}
function pyExeOf(ctx) {
  return ctx.isWin ? path.join(ctx.state.venv, 'Scripts', 'python.exe') : path.join(ctx.state.venv, 'bin', 'python');
}

/** 极简顶层 YAML 解析：只要 key: value 这一层，够用来验 metadata */
export function parseTopYaml(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    if (/^\s/.test(raw)) continue;                    // 缩进行属于上层 key 的值，跳过
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2].trim();
    /* 行尾注释要剥掉：AstrBot 的 metadata.yaml 习惯写成
     *   name: helloworld # 插件唯一识别名
     * 不剥的话插件名会变成「helloworld # 插件唯一识别名」—— 看着像 bug 的脏数据。
     * 值本身带引号时不动，避免误伤 "#" 开头的合法值。 */
    if (!/^["']/.test(v)) {
      const hash = v.indexOf('#');
      if (hash >= 0) v = v.slice(0, hash).trim();
    }
    v = v.replace(/^["'](.*)["']$/, '$1');
    if (v === '' || v === '{}' || v === '[]') continue;
    out[m[1]] = v;
  }
  return out;
}

/** 目录里找 metadata.yaml，返回 {file, meta, missing} */
function readMetadata(dir) {
  for (const f of META_FILES) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) {
      const meta = parseTopYaml(fs.readFileSync(p, 'utf8'));
      return { file: f, meta, missing: REQUIRED.filter((k) => !meta[k]) };
    }
  }
  return { file: '', meta: {}, missing: REQUIRED.slice() };
}

/** 从仓库 URL 推一个安全的目录名 */
export function dirNameFromRepo(url) {
  const m = /[/:]([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  return m ? m[1] : '';
}

/** git clone：先正常来，失败再关掉证书吊销检查重试一次 */
async function gitClone(ctx, repo, target) {
  const attempts = [
    { label: 'git clone', args: ['clone', '--depth', '1', '--single-branch', '--no-tags', repo, target], env: {} },
    {
      label: 'git clone（跳过证书吊销检查）',
      args: ['-c', 'http.sslVerify=false', 'clone', '--depth', '1', '--single-branch', '--no-tags', repo, target],
      env: { GIT_TERMINAL_PROMPT: '0' },
    },
  ];
  let last = '';
  for (const a of attempts) {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    ctx.log(`${a.label} → ${path.basename(target)}`);
    const r = await ctx.exec('git', a.args, { cwd: ctx.state.dir, timeoutMs: 240000, env: a.env });
    if (r.code === 0 && fs.existsSync(target)) return { ok: true, label: a.label };
    last = String(r.stderr || r.stdout || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' / ');
    /* 只有 TLS/证书类错误才值得降级重试；仓库不存在就不要再试一遍 */
    if (!/certificate|schannel|SSL|revocation/i.test(last)) break;
  }
  return { ok: false, error: last };
}

function runningPort(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { s.destroy(); } catch { /* 已关 */ } resolve(v); };
    s.setTimeout(1200);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

export default {
  id: 'astrbot-plugin',
  title: '安装 AstrBot 插件',
  kind: 'plugin',
  steps: [
    {
      key: 'preflight',
      title: '检查 AstrBot 运行时',
      hint: '没装 AstrBot 就先部署「NapCat + AstrBot」那条方法',
      async run(ctx) {
        const dir = ctx.paths.runtimeDir(RUNTIME_ID);
        const venv = path.join(dir, '.venv');
        /* 先把路径塞进 state：下面 pyExeOf() 依赖它，顺序错了会拿到 undefined */
        ctx.state.dir = dir;
        ctx.state.venv = venv;
        if (!fs.existsSync(path.join(dir, 'main.py'))) {
          return {
            status: 'fail',
            detail: `本机没有 AstrBot 源码（${dir}）`,
            hint: '先去「部署方法」跑一次 NapCat + AstrBot；插件是装进它的 data/plugins 的，没有本体无处可装',
          };
        }
        if (!fs.existsSync(pyExeOf(ctx))) {
          return { status: 'fail', detail: 'AstrBot 的 venv 不存在', hint: '重新跑一次 NapCat + AstrBot 部署' };
        }
        let ver = '';
        try {
          const pj = fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf8');
          ver = (/^\s*version\s*=\s*"([^"]+)"/m.exec(pj) || [])[1] || '';
        } catch { /* 版本读不到不影响装插件 */ }
        ctx.state.astrbotVersion = ver;
        return { status: 'ok', detail: `AstrBot ${ver || '（版本未知）'} 在 ${dir}` };
      },
    },
    {
      key: 'check',
      title: '校验仓库地址',
      hint: '必须是 GitHub/Gitee 这类 git 仓库地址；插件作者一般会在 README 里给',
      async run(ctx) {
        const repo = String(ctx.params.repo || ctx.params.url || '').trim();
        if (!repo) return { status: 'fail', detail: '没给仓库地址（参数 repo）' };
        /* 只接受 http(s) 和 ssh 形状，且不允许以 - 开头（防 git 参数注入） */
        if (!/^(https?:\/\/[^\s]+|git@[^\s:]+:[^\s]+)$/.test(repo) || /^-/.test(repo)) {
          return { status: 'fail', detail: `仓库地址不合法：${repo}`, hint: '形如 https://github.com/作者/插件仓库' };
        }
        const name = String(ctx.params.name || '').trim() || dirNameFromRepo(repo);
        if (!/^[A-Za-z0-9._-]{2,64}$/.test(name)) {
          return { status: 'fail', detail: `推不出合法的插件目录名（得到：${name || '空'}）`, hint: '用参数 name 显式指定，例如 --name=my-plugin' };
        }
        ctx.state.repo = repo;
        ctx.state.name = name;
        ctx.state.removing = String(ctx.params.action || '') === 'remove';
        const exists = fs.existsSync(path.join(pluginDir(ctx), name));
        return {
          status: 'ok',
          detail: `${repo} → data/plugins/${name}${exists ? '（这个目录已存在，安装时会先删掉重装）' : ''}`,
        };
      },
    },
    {
      key: 'download',
      title: '拉取插件代码',
      hint: 'GitHub 连不上就换个网络，或者让作者打包成 zip；本机证书链有问题时脚本会自动降级重试',
      async run(ctx) {
        if (ctx.state.removing) return { status: 'skip', detail: '卸载不需要下载' };
        const target = path.join(pluginDir(ctx), ctx.state.name);
        fs.mkdirSync(pluginDir(ctx), { recursive: true });
        const r = await gitClone(ctx, ctx.state.repo, target);
        if (!r.ok) {
          return {
            status: 'fail',
            detail: '拉取失败：' + (r.error || '未知原因'),
            hint: '仓库地址是否正确、是不是私有仓库（私有仓库需要你自己配好 git 凭证）；也可以下载 zip 后手动解压到 data/plugins/',
          };
        }
        const gitDir = path.join(target, '.git');
        if (fs.existsSync(gitDir)) fs.rmSync(gitDir, { recursive: true, force: true });
        ctx.record({ kind: 'dir', value: target, why: 'AstrBot 插件目录' });
        const files = fs.readdirSync(target).filter((f) => !f.startsWith('.'));
        return { status: 'ok', detail: `已拉到 ${path.relative(ctx.paths.root, target)}（${files.length} 个顶层文件/目录）` };
      },
    },
    {
      key: 'validate',
      title: '校验 metadata.yaml',
      hint: 'AstrBot 要求 name/desc/version/author 四个字段，缺一个就会被拒装',
      async run(ctx) {
        const dir = path.join(pluginDir(ctx), ctx.state.name);
        if (ctx.state.removing) return { status: 'skip', detail: '卸载不需要校验元数据' };
        if (!fs.existsSync(dir)) return { status: 'fail', detail: '插件目录不存在，下载那一步没成功' };
        const { file, meta, missing } = readMetadata(dir);
        if (!file) {
          /* 有些仓库把插件放在子目录里（如 src/），提示用户用 name 参数指过去 */
          const subs = fs.readdirSync(dir).filter((f) => {
            const p = path.join(dir, f);
            return fs.statSync(p).isDirectory() && META_FILES.some((m) => fs.existsSync(path.join(p, m)));
          });
          return {
            status: 'fail',
            detail: `data/plugins/${ctx.state.name} 里没有 metadata.yaml`,
            hint: subs.length
              ? `插件本体在子目录里（${subs.join('、')}），把内容移上来，或用 --name 指向正确目录`
              : '这个仓库可能不是 AstrBot 插件，或者需要看 README 用别的方式安装',
          };
        }
        if (missing.length) {
          return {
            status: 'fail',
            detail: `${file} 缺少必需字段：${missing.join('、')}`,
            hint: 'AstrBot 会直接拒绝加载这种插件；联系作者补全，或自己按 AstrBot 文档补齐字段',
          };
        }
        ctx.state.meta = meta;
        /* 主入口：AstrBot 插件必须有 main.py（Star 装饰器所在文件） */
        const hasMain = fs.existsSync(path.join(dir, 'main.py'));
        /* 有的作者版本号就写成 v1.3.0，再拼个 v 会变成 vv1.3.0 */
        const ver = /^v/i.test(String(meta.version)) ? meta.version : 'v' + meta.version;
        return {
          status: hasMain ? 'ok' : 'manual',
          detail: `${file} 校验通过：${meta.name} ${ver} by ${meta.author}${hasMain ? '' : '（但没有 main.py，可能不是标准插件结构）'}`,
          hint: hasMain ? '' : '检查一下这个仓库的 README，确认安装方式',
        };
      },
    },
    {
      key: 'register',
      title: '登记 / 移除插件',
      hint: 'AstrBot 是按目录扫插件的，不需要写配置文件；这里只维护本平台的安装记录',
      async run(ctx) {
        const all = readJson(STATE_FILE, {}) || {};
        const name = ctx.state.name;
        if (ctx.state.removing) {
          const dir = path.join(pluginDir(ctx), name);
          if (fs.existsSync(dir)) {
            /* 只删 data/plugins 下的这一个目录：AstrBot 自己的代码一点不动 */
            fs.rmSync(dir, { recursive: true, force: true });
          }
          delete all[name];
          writeJson(STATE_FILE, all);
          return { status: 'ok', detail: `已删除 data/plugins/${name}（剩余 ${Object.keys(all).length} 个 AstrBot 插件）` };
        }
        all[name] = {
          name,
          repo: ctx.state.repo,
          displayName: (ctx.state.meta && ctx.state.meta.name) || name,
          version: (ctx.state.meta && ctx.state.meta.version) || '',
          author: (ctx.state.meta && ctx.state.meta.author) || '',
          installedAt: new Date().toISOString(),
        };
        writeJson(STATE_FILE, all);
        return { status: 'ok', detail: `已登记（本机共 ${Object.keys(all).length} 个 AstrBot 插件）` };
      },
    },
    {
      key: 'restart',
      title: '重启 AstrBot 并确认插件被加载',
      hint: 'AstrBot 只在启动时扫插件目录；日志里出现 Loading plugin <目录名> 且没有 Failed to import 才算成功',
      async run(ctx) {
        const wasUp = await runningPort(WEBUI_PORT);
        if (wasUp) {
          const r = await ctx.exec(ctx.isWin ? 'powershell' : 'sh', ctx.isWin
            ? ['-NoProfile', '-Command',
              `Get-NetTCPConnection -LocalPort ${WEBUI_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }`]
            : ['-c', `lsof -ti tcp:${WEBUI_PORT} | xargs -r kill -9`], { timeoutMs: 20000, quiet: true });
          ctx.log(`停止旧 AstrBot 进程（退出码 ${r.code}）`);
          await new Promise((res) => setTimeout(res, 1500));
        }
        const logFile = path.join(ctx.state.dir, 'astrbot.log');
        const sizeBefore = (() => { try { return fs.statSync(logFile).size; } catch { return 0; } })();

        /* Windows 上必须经 cmd 的 start /b 起：
         * 用 spawn(detached) 拉起的 python 会和安装器共享 console，
         * 安装器一退出它跟着退（本机实测：起来了，几秒后 6185 就没了）。
         * start /b 会新建进程组、脱离当前 console，进程能活下来。
         * 日志重定向写在 .cmd 里，免得 cmd 的引号规则把路径搞坏。 */
        let startErr = '';
        if (ctx.isWin) {
          const runner = path.join(ctx.state.dir, '_run_astrbot.cmd');
          const body = [
            '@echo off',
            'cd /d "%~dp0"',
            '".venv\\Scripts\\python.exe" main.py >> astrbot.log 2>&1',
            '',
          ].join('\r\n');
          if (!fs.existsSync(runner) || fs.readFileSync(runner, 'utf8') !== body) fs.writeFileSync(runner, body);
          /* 注意：这里不能用 ctx.exec —— 它把子进程的 stdout 接到管道上，
           * 而 start /b 起的进程会继承这个管道，导致管道永不关闭，
           * 安装命令就永远等不到结束（本机实测：直接 SIGTERM）。
           * 用 spawnDetached + stdio:'ignore'：输出全走 .cmd 里的重定向。 */
          const started = ctx.spawnDetached('cmd.exe', ['/d', '/s', '/c', 'start', '""', '/b', runner], {
            cwd: ctx.state.dir, stdio: 'ignore',
          });
          if (!started.ok) startErr = started.error;
        } else {
          const fd = fs.openSync(logFile, 'a');
          const started = ctx.spawnDetached(pyExeOf(ctx), ['main.py'], {
            cwd: ctx.state.dir, stdio: ['ignore', fd, fd],
          });
          if (!started.ok) startErr = started.error;
        }
        if (startErr) return { status: 'fail', detail: '启动 AstrBot 失败：' + startErr };

        /* AstrBot 启动比 NoneBot 慢得多：首次运行还会下载 WebUI（约 5MB，
         * 本机实测 60KB/s，光下载就要 1 分多钟）。所以给到 150 秒，
         * 并且把「正在下载 WebUI」当成正常进度的证据，而不是失败。 */
        let up = false;
        let downloading = false;
        for (let i = 0; i < 100; i++) {
          await new Promise((res) => setTimeout(res, 1500));
          if (await runningPort(WEBUI_PORT)) { up = true; break; }
          const now = (() => {
            try { const buf = fs.readFileSync(logFile); return buf.slice(sizeBefore).toString('utf8'); } catch { return ''; }
          })();
          if (/Downloading AstrBot WebUI|Downloading: https URL/.test(now)) downloading = true;
          /* 明确的启动失败就早点退出，别干等 150 秒 */
          if (/ModuleNotFoundError|ImportError|SyntaxError/.test(now)) break;
        }
        /* 起来了还不算：之前踩过"起来了又掉"的坑（进程被连带清理），
         * 隔 8 秒再确认一次，站得住才往下判插件加载 */
        if (up) {
          await new Promise((res) => setTimeout(res, 8000));
          if (!(await runningPort(WEBUI_PORT))) {
            return {
              status: 'manual',
              detail: `AstrBot 起来后 8 秒又退出了（${WEBUI_PORT} 不通）`,
              hint: '手动启动一次看真实报错：cd runtimes\\astrbot 然后 .venv\\Scripts\\python.exe main.py；插件文件已经放到位，跟插件无关',
            };
          }
        }
        const readNew = () => {
          try { const buf = fs.readFileSync(logFile); return buf.slice(sizeBefore).toString('utf8'); } catch { return ''; }
        };
        let logAll = readNew();
        const name = ctx.state.name;
        const loaded = new RegExp('Loading plugin ' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(logAll);
        const failed = new RegExp('Failed to import plugin ' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(logAll);

        if (ctx.state.removing) {
          if (loaded) {
            return {
              status: 'fail',
              detail: `目录已删，但 AstrBot 日志里仍在加载 ${name}`,
              hint: '可能有残留的 .pyc 缓存；确认 data/plugins 下确实没有这个目录，再重启一次',
            };
          }
          return {
            status: up ? 'ok' : 'manual',
            detail: up
              ? `已重启，WebUI ${WEBUI_PORT} 在跑；日志里没有 ${name}，卸载生效`
              : `目录已删，但 AstrBot 没能重新起来（${WEBUI_PORT} 不通）`,
            hint: up ? '' : '看 runtimes\\astrbot\\astrbot.log 尾部；也可能首次启动本来就需要先配 LLM，这跟卸载无关',
          };
        }

        if (failed) {
          const err = /Traceback[\s\S]{0,800}/.exec(logAll) || [];
          return {
            status: 'fail',
            detail: `${name} 被 AstrBot 拒绝加载`,
            hint: '日志报错：' + (err[0] ? err[0].split(/\r?\n/).slice(-5).join(' / ') : '看 runtimes\\astrbot\\astrbot.log')
              + ' —— 常见原因是插件版本要求的 AstrBot 版本更高，或缺 Python 依赖',
          };
        }
        if (!up) {
          if (downloading) {
            return {
              status: 'manual',
              detail: `AstrBot 首次启动正在下载 WebUI（约 5MB），150 秒内没下载完，${WEBUI_PORT} 还没起来`,
              hint: '这是首次运行的一次性动作，不用管它 —— 等 runtimes\\astrbot\\astrbot.log 里下载完、出现「WebUI」相关启动日志后，再点一次安装（或直接打开 http://127.0.0.1:6185 确认）。插件文件已经放到位了。',
            };
          }
          return {
            status: 'manual',
            detail: `AstrBot 启动后 ${WEBUI_PORT} 没起来，无法确认插件是否加载`,
            hint: '看 runtimes\\astrbot\\astrbot.log 尾部（常见：缺依赖、缺配置、端口被占）；插件文件本身已经放到位了',
          };
        }
        if (!loaded) {
          return {
            status: 'manual',
            detail: `AstrBot 已在 ${WEBUI_PORT} 端口运行，但日志里没看到 Loading plugin ${name}`,
            hint: '可能日志被截断，或者插件目录名和 metadata.name 不一致；去 WebUI 的「插件管理」里看一眼最准',
          };
        }
        return {
          status: 'ok',
          detail: `${wasUp ? '已重启' : '已启动'}，WebUI ${WEBUI_PORT} 在跑；日志确认 AstrBot 正在加载 ${name}`,
        };
      },
    },
  ],

  helpers: { parseTopYaml, dirNameFromRepo, readMetadata },
};
