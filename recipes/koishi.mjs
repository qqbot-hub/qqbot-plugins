/* ============================================================
 * koishi.mjs —— NapCatQQ + Koishi
 *
 * Koishi 是 Node 侧插件生态最大的一家，安装就是 npm 那点事：
 * 建目录 → npm i koishi + console + adapter-onebot → 写 koishi.yml → 起控制台 5140。
 *
 * 两个刻意的取舍：
 *   · koishi.yml 只在**不存在**时生成，绝不覆盖你已经在控制台里调好的配置；
 *   · selfId 从市场配置里读（协议端登录后记下来的 QQ 号），读不到就留空并提示去控制台填，
 *     不瞎猜一个号填进去（填错会导致适配器疯狂重连）。
 * ============================================================ */
import path from 'node:path';
import fs from 'node:fs';

const RUNTIME_ID = 'koishi';
const CONSOLE_PORT = 5140;

const yml = ({ selfId, token, endpoint }) => `# 由 qqbot-plugins 生成；在 Koishi 控制台里改也可以，改完重启生效
plugins:
  server:
    port: ${CONSOLE_PORT}
  adapter-onebot:
    protocol: ws
    selfId: '${selfId}'
    token: '${token}'
    endpoint: '${endpoint}'
  console: {}
`;

export default {
  id: 'koishi',
  title: 'NapCat + Koishi',
  kind: 'host',
  steps: [
    {
      key: 'node',
      title: '检查 Node 版本',
      hint: '装 Node.js 18 或 20 LTS，重开终端再试',
      async run(ctx) {
        const major = Number(process.versions.node.split('.')[0]);
        if (major < 18) return { status: 'fail', detail: `Node ${process.versions.node} 太老，Koishi 需要 18+` };
        return { status: 'ok', detail: `Node ${process.versions.node}` };
      },
    },
    {
      key: 'npm',
      title: '检查 npm',
      hint: 'npm 随 Node 一起装；找不到就把 Node 重装一遍（勾选 npm）',
      async run(ctx) {
        const r = await ctx.exec(ctx.isWin ? 'npm.cmd' : 'npm', ['--version'], { timeoutMs: 20000, quiet: true });
        if (r.code !== 0) return { status: 'fail', detail: 'npm 不可用：' + String(r.stderr).slice(0, 200) };
        ctx.state.npm = (ctx.isWin ? 'npm.cmd' : 'npm');
        return { status: 'ok', detail: 'npm ' + String(r.stdout).trim() };
      },
    },
    {
      key: 'install',
      title: '安装 Koishi 与 OneBot 适配器',
      hint: '网络慢就手动进 runtimes\\koishi 跑 npm i --registry=https://registry.npmmirror.com koishi @koishijs/plugin-console @koishijs/plugin-adapter-onebot',
      async run(ctx) {
        const dir = ctx.paths.runtimeDir(RUNTIME_ID);
        ctx.state.dir = dir;
        fs.mkdirSync(dir, { recursive: true });
        const pkgFile = path.join(dir, 'package.json');
        const installed = fs.existsSync(path.join(dir, 'node_modules', '@koishijs', 'plugin-adapter-onebot'));
        if (installed) return { status: 'skip', detail: '依赖已在，跳过安装' };
        if (!fs.existsSync(pkgFile)) {
          fs.writeFileSync(pkgFile, JSON.stringify({ name: 'qqbot-koishi', private: true, version: '0.0.0' }, null, 2) + '\n');
        }
        /* adapter-onebot 必须用 5.x：6.x 与 koishi 4.18 的 @satorijs/core 版本要求互相冲突，
         * 2026-10-28 实测装 6.x 起来就报 Session2 is not a constructor */
        const pkgs = ['koishi', '@koishijs/plugin-console', '@koishijs/plugin-adapter-onebot@5'];
        const tries = [
          ['--registry=https://registry.npmmirror.com'],
          [],
        ];
        let last = '';
        for (const extra of tries) {
          ctx.log(`npm install ${pkgs.join(' ')} ${extra.join(' ')}`);
          const r = await ctx.exec(ctx.state.npm, ['install', '--no-audit', '--no-fund', ...pkgs, ...extra], { cwd: dir, timeoutMs: 540000 });
          if (r.code === 0 && fs.existsSync(path.join(dir, 'node_modules', 'koishi'))) {
            ctx.record({ kind: 'dir', value: dir, why: '本次部署创建的 Koishi 目录' });
            return { status: 'ok', detail: `安装完成（${extra.length ? 'npmmirror 镜像' : '官方源'}）` };
          }
          last = String(r.stderr || r.stdout).slice(-400);
        }
        return { status: 'fail', detail: 'npm 安装失败：' + last };
      },
    },
    {
      key: 'config',
      title: '生成 koishi.yml',
      hint: '把 NapCat 的网络配置改成 WebSocket 服务端（3001），或在控制台里手动加适配器',
      async run(ctx) {
        const dir = ctx.state.dir;
        const file = path.join(dir, 'koishi.yml');
        if (fs.existsSync(file)) return { status: 'skip', detail: '已有 koishi.yml，保留你的配置不动' };
        const sl = (ctx.cfg() || {}).snowluma || {};
        const selfId = String(ctx.params.selfId || sl.selfId || '');
        const token = String(ctx.params.onebotToken || (ctx.cfg().onebot || {}).accessToken || '');
        fs.writeFileSync(file, yml({ selfId, token, endpoint: 'ws://127.0.0.1:3001' }));
        ctx.state.needSelfId = !selfId;
        if (!selfId) {
          return { status: 'manual', detail: '已生成配置，但不知道这个 QQ 号（协议端还没登录过）', hint: '在 Koishi 控制台 5140 的「适配器」里把 selfId 填成你的机器人 QQ 号' };
        }
        return { status: 'ok', detail: `已生成（selfId ${selfId}，token ${token ? '已填' : '空'}）` };
      },
    },
    {
      key: 'start',
      title: '启动 Koishi 控制台',
      hint: '看 runtimes\\koishi 下有没有报错；端口冲突就改 koishi.yml 的 port',
      async run(ctx) {
        if (await ctx.portOpen('127.0.0.1', CONSOLE_PORT)) return { status: 'skip', detail: `${CONSOLE_PORT} 已在监听` };
        const dir = ctx.state.dir;
        const logFile = path.join(dir, 'koishi.log');
        /* cmd.exe 拿不到 Node 传的 fd，输出重定向必须写进命令行里，否则日志是空的 */
        const line = `node_modules\\.bin\\koishi.cmd start >> "${logFile}" 2>&1`;
        const r = ctx.isWin
          ? ctx.spawnDetached('cmd.exe', ['/d', '/s', '/c', line], { cwd: dir })
          : ctx.spawnDetached('./node_modules/.bin/koishi', ['start'], { cwd: dir });
        if (!r.ok) return { status: 'fail', detail: '启动失败：' + r.error };
        for (let i = 0; i < 20; i++) {
          await new Promise((res) => setTimeout(res, 1500));
          if (await ctx.portOpen('127.0.0.1', CONSOLE_PORT)) {
            return { status: 'ok', detail: `控制台已启动：http://127.0.0.1:${CONSOLE_PORT}（pid ${r.pid}）` };
          }
        }
        const tail = (() => { try { return fs.readFileSync(logFile, 'utf8').slice(-400); } catch { return ''; } })();
        return { status: 'fail', detail: `起来了但 30 秒内没监听 ${CONSOLE_PORT}`, hint: '日志尾部：' + (tail || '（空）') };
      },
    },
    {
      key: 'verify',
      title: '自检',
      async run(ctx) {
        const consoleOk = await ctx.portOpen('127.0.0.1', CONSOLE_PORT);
        const ob = await ctx.portOpen('127.0.0.1', 3000);
        if (!consoleOk) return { status: 'fail', detail: `控制台 ${CONSOLE_PORT} 不通` };
        if (!ob) return { status: 'manual', detail: `Koishi 已就绪（${CONSOLE_PORT}），但 NapCat 3000 没通`, hint: '先装 NapCat 并登录 QQ' };
        return { status: 'ok', detail: `Koishi 控制台 ${CONSOLE_PORT} 通 · NapCat 3000 通` };
      },
    },
  ],
};
