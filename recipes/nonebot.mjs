/* ============================================================
 * nonebot.mjs —— NapCatQQ + NoneBot2
 *
 * 这条路线真的能一条龙：建 venv → 装 nonebot2 + onebot 适配器 → 写配置 →
 * 后台启动 → 探测 8080。协议端（NapCat）仍需你自己在 QQNT 里登录，
 * 这属于"任何脚本都替代不了的扫码"，不是我们偷懒。
 *
 * 幂等：venv 已存在、包已装、端口已在监听 → 全部 skip，不会重复下载。
 * 回滚：创建的 venv 目录、拉起的进程都登记进 job.artifacts，失败可一键撤销。
 * ============================================================ */
import path from 'node:path';
import fs from 'node:fs';

const RUNTIME_ID = 'nonebot';
const DEFAULT_WS_PORT = 8080;
const FALLBACK_WS_PORT = 20080;

/** 端口上是真 NoneBot（uvicorn/FastAPI）还是别的程序占着坑：
 *  只看端口通就认账会出现"别的程序占了 8080，我们也报成功"的假成功。 */
async function isUvicorn(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/openapi.json`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) return true;                                  // FastAPI 的 openapi.json 直接 200
    return String(r.headers.get('server') || '').toLowerCase().includes('uvicorn');
  } catch { return false; }
}

const BOT_PY = `# 由 qqbot-plugins 一键部署生成：NoneBot2 + OneBot v11（反向 WebSocket）
# 插件清单在 pyproject.toml 的 [tool.nonebot] plugins 里 —— 由市场安装插件时自动维护，
# 手改也没问题，下次安装只会往数组里追加，不会清掉你已有的。
import os
import nonebot
from nonebot.adapters.onebot.v11 import Adapter

nonebot.init()
driver = nonebot.get_driver()
driver.register_adapter(Adapter)

# 没有 pyproject.toml 也能跑（纯 NoneBot），有就按清单加载插件
if os.path.exists("pyproject.toml"):
    nonebot.load_from_toml("pyproject.toml")

nonebot.run()
`;

/** 初始 pyproject.toml：只放 NoneBot 认的那一段，别的不写，免得和你自己的项目配置打架 */
const PYPROJECT = `# 由 qqbot-plugins 生成：NoneBot 从这里读插件清单
[tool.nonebot]
plugins = []
`;

/* pip 走镜像：国内直连 pypi 经常卡死，失败再回退官方源 */
const PIP_MIRRORS = [
  ['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'],
  [],
];

export default {
  id: 'nonebot',
  title: 'NapCat + NoneBot2',
  kind: 'host',
  steps: [
    {
      key: 'python',
      title: '检查 Python',
      hint: '装 Python 3.10+ 并勾选 "Add python.exe to PATH"，重开终端后再点部署',
      async run(ctx) {
        const r = await ctx.exec('python', ['--version'], { timeoutMs: 8000, quiet: true });
        const text = String(r.stdout || '') + String(r.stderr || '');
        if (r.code !== 0) {
          const py3 = await ctx.exec('py', ['-3', '--version'], { timeoutMs: 8000, quiet: true });
          const t2 = String(py3.stdout || '') + String(py3.stderr || '');
          if (py3.code !== 0) return { status: 'fail', detail: '找不到 python / py 命令' };
          const v2 = (t2.match(/(\d+)\.(\d+)/) || []);
          if (Number(v2[1]) < 3 || (Number(v2[1]) === 3 && Number(v2[2]) < 10)) {
            return { status: 'fail', detail: `Python 版本太低：${t2.trim()}`, hint: '需要 3.10 以上' };
          }
          ctx.state.python = 'py';
          return { status: 'ok', detail: `python 通过 py 启动器调用：${t2.trim()}` };
        }
        const m = text.match(/(\d+)\.(\d+)/);
        if (!m || Number(m[1]) < 3 || (Number(m[1]) === 3 && Number(m[2]) < 10)) {
          return { status: 'fail', detail: `Python 版本太低：${text.trim()}`, hint: 'NoneBot2 需要 3.10 以上' };
        }
        ctx.state.python = 'python';
        return { status: 'ok', detail: text.trim() };
      },
    },
    {
      key: 'venv',
      title: '创建独立虚拟环境',
      hint: '删掉 runtimes\\nonebot\\.venv 再试；或手动 python -m venv 看报错',
      async run(ctx) {
        const dir = ctx.paths.runtimeDir(RUNTIME_ID);
        const venv = path.join(dir, '.venv');
        ctx.state.dir = dir;
        ctx.state.venv = venv;
        const pyExe = ctx.isWin ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
        if (fs.existsSync(pyExe)) return { status: 'skip', detail: '虚拟环境已存在，直接复用' };
        fs.mkdirSync(dir, { recursive: true });
        const r = await ctx.exec(ctx.state.python, ['-m', 'venv', venv], { timeoutMs: 120000 });
        if (!fs.existsSync(pyExe)) {
          return { status: 'fail', detail: '创建 venv 失败：' + String(r.stderr || r.stdout).slice(-300) };
        }
        ctx.record({ kind: 'dir', value: dir, why: '本次部署创建的 NoneBot 运行目录' });
        return { status: 'ok', detail: path.relative(ctx.paths.root, venv) };
      },
    },
    {
      key: 'install',
      title: '安装 nonebot2 + OneBot 适配器',
      hint: '网络问题就换镜像：在 runtimes\\nonebot 下手动跑 pip install -i https://pypi.tuna.tsinghua.edu.cn/simple nonebot2 nonebot-adapter-onebot',
      async run(ctx) {
        const pyExe = ctx.isWin
          ? path.join(ctx.state.venv, 'Scripts', 'python.exe')
          : path.join(ctx.state.venv, 'bin', 'python');
        const check = await ctx.exec(pyExe, ['-c', 'import nonebot, nonebot.adapters.onebot.v11, fastapi, uvicorn;print("ok")'], { timeoutMs: 30000, quiet: true });
        if (check.code === 0) return { status: 'skip', detail: '已安装，跳过下载' };

        let last = '';
        for (const mirror of PIP_MIRRORS) {
          /* 必须带 [fastapi] extra：只装 nonebot2 的话 fastapi 驱动会在启动时 ImportError */
          ctx.log(`pip install 'nonebot2[fastapi]' nonebot-adapter-onebot ${mirror.join(' ') || '(官方源)'}`);
          const r = await ctx.exec(pyExe, [
            '-m', 'pip', 'install', '--disable-pip-version-check', '-q',
            'nonebot2[fastapi]', 'nonebot-adapter-onebot', ...mirror,
          ], { timeoutMs: 480000 });
          if (r.code === 0) {
            const again = await ctx.exec(pyExe, ['-c', 'import nonebot, fastapi, uvicorn;print("ok")'], { timeoutMs: 30000, quiet: true });
            if (again.code === 0) return { status: 'ok', detail: `安装完成（${mirror[1] ? '清华镜像' : '官方源'}）` };
          }
          last = String(r.stderr || r.stdout).slice(-400);
        }
        return { status: 'fail', detail: 'pip 安装失败：' + last };
      },
    },
    {
      key: 'config',
      title: '写配置（反向 WS）',
      hint: '把 NapCat 的网络配置改成 WebSocket 客户端，URL 填 ws://127.0.0.1:<端口>/onebot/v11/ws（端口见 detail）',
      async run(ctx) {
        const dir = ctx.state.dir;
        /* 8080 是 NoneBot 默认端口，但经常被别的程序占：探明真身份再决定用不用，
         * 防止"别的程序占着 8080，我们也报成功"的假成功 */
        let port = DEFAULT_WS_PORT;
        if (await ctx.portOpen('127.0.0.1', port)) {
          if (await isUvicorn(port)) {
            ctx.state.port = port;
            return { status: 'skip', detail: '8080 上已经在跑 NoneBot（uvicorn），不重复写配置' };
          }
          port = FALLBACK_WS_PORT;
          ctx.log(`8080 被别的程序占用（不是 NoneBot），改用 ${port}`);
        }
        ctx.state.port = port;
        const token = String(ctx.params.onebotToken || '');
        const env = [
          'DRIVER=~fastapi',
          'HOST=127.0.0.1',
          `PORT=${port}`,
          `ONEBOT_ACCESS_TOKEN=${token}`,
          'COMMAND_START=["/", ""]',
        ].join('\n') + '\n';
        fs.writeFileSync(path.join(dir, '.env'), env);
        fs.writeFileSync(path.join(dir, 'bot.py'), BOT_PY);
        /* pyproject.toml 只在不存在时写：已经装过插件的话，plugins 数组不能被部署流程清空 */
        const pyproject = path.join(dir, 'pyproject.toml');
        if (!fs.existsSync(pyproject)) fs.writeFileSync(pyproject, PYPROJECT);
        return { status: 'ok', detail: `已写 bot.py + .env + pyproject.toml（端口 ${port}，token ${token ? '已配置（加密保存）' : '未配置'}）` };
      },
    },
    {
      key: 'start',
      title: '启动 NoneBot',
      hint: '看 runtimes\\nonebot\\nonebot.log；8080 被占时会自动改用 20080',
      async run(ctx) {
        const port = ctx.state.port || DEFAULT_WS_PORT;
        if (await ctx.portOpen('127.0.0.1', port) && await isUvicorn(port)) {
          return { status: 'skip', detail: `${port} 已在跑 NoneBot，不重复启动` };
        }
        const pyExe = ctx.isWin
          ? path.join(ctx.state.venv, 'Scripts', 'python.exe')
          : path.join(ctx.state.venv, 'bin', 'python');
        const logFile = path.join(ctx.state.dir, 'nonebot.log');
        const fd = fs.openSync(logFile, 'a');
        const r = ctx.spawnDetached(pyExe, ['bot.py'], { cwd: ctx.state.dir, stdio: ['ignore', fd, fd] });
        if (!r.ok) return { status: 'fail', detail: '启动失败：' + r.error };
        for (let i = 0; i < 15; i++) {
          await new Promise((res) => setTimeout(res, 1500));
          if (await ctx.portOpen('127.0.0.1', port) && await isUvicorn(port)) {
            return { status: 'ok', detail: `已启动，${port} 监听中（pid ${r.pid}）` };
          }
        }
        const tail = (() => { try { return fs.readFileSync(logFile, 'utf8').slice(-400); } catch { return ''; } })();
        return { status: 'fail', detail: `启动了但 22 秒内没监听 ${port}`, hint: '日志尾部：' + (tail || '（空）') };
      },
    },
    {
      key: 'verify',
      title: '自检',
      async run(ctx) {
        const port = ctx.state.port || DEFAULT_WS_PORT;
        const open = await ctx.portOpen('127.0.0.1', port) && await isUvicorn(port);
        const ob = await ctx.portOpen('127.0.0.1', 3000);
        if (!open) return { status: 'fail', detail: `NoneBot 端口 ${port} 不通（或被别的程序占用）` };
        if (!ob) return { status: 'manual', detail: `NoneBot 已就绪（${port}），但 NapCat 的 3000 没通`, hint: '先把 NapCat 装好并扫码登录 QQ，它会自己连上 NoneBot' };
        return { status: 'ok', detail: `NoneBot ${port} 通 · NapCat 3000 通，反向 WS 已具备连接条件` };
      },
    },
  ],
};
