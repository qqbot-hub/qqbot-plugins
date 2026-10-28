/* SnowLuma 协议端：把 QQ 变成 OneBot v11 接口
 *
 * 本机常见的安装位置（按顺序探测）：
 *   config.json 的 snowluma.installDir → C:\SnowLuma → runtimes/snowluma
 * 它没有公开的自动安装包，所以「没装」这一步给的是人工指引；装了以后
 * 启动、探测、读 QQ 身份全自动。
 */
import path from 'node:path';
import fs from 'node:fs';

const CANDIDATES = (ctx) => [
  ctx.cfg()?.snowluma?.installDir,
  'C:\\SnowLuma',
  ctx.paths.runtimeDir('snowluma'),
].filter(Boolean);

const findInstall = (ctx) => {
  for (const dir of CANDIDATES(ctx)) {
    const entry = path.join(dir, 'index.mjs');
    if (fs.existsSync(entry)) return dir;
  }
  return '';
};

export default {
  id: 'snowluma',
  title: 'SnowLuma 协议端',
  kind: 'protocol',
  steps: [
    {
      key: 'detect',
      title: '找安装位置',
      hint: '去 https://github.com/SnowLuma/SnowLuma 下载发行包，解压到 C:\\SnowLuma 后再点一次安装',
      async run(ctx) {
        const dir = findInstall(ctx);
        if (!dir) return { status: 'fail', detail: '这台机器上没找到 SnowLuma（找过 C:\\SnowLuma 和 runtimes\\snowluma）' };
        ctx.state.dir = dir;
        ctx.log(`安装目录：${dir}`);
        // 顺便把位置记进配置，后面 doctor / 状态接口都用得上
        ctx.saveCfg({ snowluma: Object.assign({}, ctx.cfg().snowluma, { installDir: dir }) });
        return { status: 'ok', detail: dir };
      },
    },
    {
      key: 'running',
      title: '检查是否已在运行',
      async run(ctx) {
        const open = await ctx.portOpen('127.0.0.1', 3000);
        if (open) {
          ctx.state.running = true;
          return { status: 'ok', detail: 'HTTP 3000 已在监听，不用重启' };
        }
        return { status: 'skip', detail: '还没起来，下一步启动它' };
      },
    },
    {
      key: 'start',
      title: '启动协议端',
      hint: '双击 C:\\SnowLuma\\launcher.bat 手动启动，看它窗口里报什么错',
      async run(ctx) {
        if (ctx.state.running) return { status: 'skip', detail: '已在运行' };
        const dir = ctx.state.dir;
        const bat = path.join(dir, 'launcher.bat');
        if (fs.existsSync(bat)) {
          if (ctx.isWin) ctx.spawnDetached('cmd.exe', ['/c', 'start', '', bat], { cwd: dir });
          else ctx.spawnDetached(bat, [], { cwd: dir });
        } else {
          ctx.spawnDetached(process.execPath, ['index.mjs'], { cwd: dir });
        }
        // 等它把 3000 端口的监听建立起来，最多 40 秒
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          if (await ctx.portOpen('127.0.0.1', 3000)) return { status: 'ok', detail: '已在后台启动，HTTP 3000 监听中' };
        }
        return { status: 'fail', detail: '启动了但 40 秒内没监听 3000' };
      },
    },
    {
      key: 'login',
      title: '确认 QQ 登录状态',
      hint: '在 SnowLuma 的窗口/面板里扫码登录 QQ，登录成功后回来点一次安装（这一步一定需要人工）',
      async run(ctx) {
        const sl = ctx.cfg().snowluma || {};
        const token = String(sl.accessToken || '');
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = 'Bearer ' + token;
        let info = null;
        let why = '';
        try {
          const r = await fetch('http://127.0.0.1:3000/get_login_info', {
            method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(5000),
          });
          if (r.status === 401) return { status: 'manual', detail: '协议端拒绝了请求：AccessToken 不对', hint: '把 SnowLuma 里配的 AccessToken 填到「连接设置」里' };
          const text = await r.text();
          try { info = JSON.parse(text); } catch { why = '返回的不是 JSON：' + text.slice(0, 80); }
        } catch (e) {
          why = '连不上 3000：' + e.message;
        }
        const data = (info && (info.data || info)) || {};
        const selfId = data.user_id || data.uin;
        if (info && (info.status === 'ok' || info.retcode === 0) && selfId) {
          const nick = data.nickname || '';
          ctx.saveCfg({ snowluma: Object.assign({}, ctx.cfg().snowluma, { selfId: String(selfId), nickname: nick }) });
          return { status: 'ok', detail: `已登录：${nick ? '「' + nick + '」' : ''}QQ ${selfId}` };
        }
        if (info && (info.status === 'failed' || info.retcode)) {
          return { status: 'manual', detail: '协议端在跑，但 QQ 没登录（这是唯一必须你动手的一步）' };
        }
        return { status: 'manual', detail: why || '拿不到登录信息（协议端面板里可能还没登录）' };
      },
    },
    {
      key: 'verify',
      title: '验证 OneBot 接口',
      async run(ctx) {
        const open = await ctx.portOpen('127.0.0.1', 3000);
        const ws = await ctx.portOpen('127.0.0.1', 3001);
        if (!open) return { status: 'fail', detail: 'HTTP 3000 不通', hint: '看 SnowLuma 窗口日志；端口被占用就改它的配置' };
        return { status: 'ok', detail: `HTTP 3000 ${open ? '通' : '不通'} · WS 3001 ${ws ? '通' : '不通'}${ws ? '' : '（没开 WebSocket 也能用 HTTP 模式）'}` };
      },
    },
  ],
};
