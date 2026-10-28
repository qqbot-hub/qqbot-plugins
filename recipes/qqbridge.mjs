/* qq-bridge 桥接（3100）：可选中间层
 * 它自己的安装脚本（setup）不归本市场管；这里负责：找到它 → 起进程 → 验证端口。
 */
import path from 'node:path';
import fs from 'node:fs';

const CANDIDATES = [
  'D:\\deepseek harness工作区\\qq-bridge',
  'C:\\qq-bridge',
];

const findInstall = (ctx) => {
  const cfgDir = ctx.cfg()?.bridge?.dir;
  const list = [cfgDir, ...CANDIDATES, ctx.paths.runtimeDir('qqbridge')].filter(Boolean);
  for (const dir of list) {
    if (fs.existsSync(path.join(dir, 'src', 'bridge.js')) || fs.existsSync(path.join(dir, 'start.bat'))) return dir;
  }
  return '';
};

export default {
  id: 'qqbridge',
  title: 'qq-bridge 桥接',
  kind: 'bridge',
  steps: [
    {
      key: 'detect',
      title: '找安装位置',
      hint: 'qq-bridge 是独立项目：从 https://github.com/qqbot-hub/qq-bridge 拉下来，跑它自己的 setup，再回来点安装',
      async run(ctx) {
        const dir = findInstall(ctx);
        if (!dir) return { status: 'fail', detail: '没找到 qq-bridge（找过 D:\\deepseek harness工作区\\qq-bridge、C:\\qq-bridge）' };
        ctx.state.dir = dir;
        ctx.saveCfg({ bridge: Object.assign({}, ctx.cfg().bridge, { dir }) });
        return { status: 'ok', detail: dir };
      },
    },
    {
      key: 'deps',
      title: '检查依赖是否装过',
      async run(ctx) {
        const nm = path.join(ctx.state.dir, 'node_modules');
        if (!fs.existsSync(nm)) {
          return { status: 'fail', detail: 'node_modules 不存在，说明它的依赖还没装', hint: `在 ${ctx.state.dir} 里跑 npm install，再点一次安装` };
        }
        return { status: 'ok', detail: '依赖目录存在' };
      },
    },
    {
      key: 'running',
      title: '检查 3100 是否在监听',
      async run(ctx) {
        if (await ctx.portOpen('127.0.0.1', 3100)) { ctx.state.running = true; return { status: 'ok', detail: '3100 已在运行' }; }
        return { status: 'skip', detail: '没起来，下一步启动' };
      },
    },
    {
      key: 'start',
      title: '启动桥接',
      hint: '双击 qq-bridge 目录里的 start.bat 手动启动，看它窗口报什么错',
      async run(ctx) {
        if (ctx.state.running) return { status: 'skip', detail: '已在运行' };
        const bat = path.join(ctx.state.dir, 'start.bat');
        if (fs.existsSync(bat) && ctx.isWin) ctx.spawnDetached('cmd.exe', ['/c', 'start', '', bat], { cwd: ctx.state.dir });
        else ctx.spawnDetached(process.execPath, [path.join('src', 'bridge.js')], { cwd: ctx.state.dir });
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          if (await ctx.portOpen('127.0.0.1', 3100)) return { status: 'ok', detail: '已在后台启动，3100 监听中' };
        }
        return { status: 'fail', detail: '启动了但 30 秒内没监听 3100' };
      },
    },
    {
      key: 'verify',
      title: '验证控制台',
      async run(ctx) {
        const open = await ctx.portOpen('127.0.0.1', 3100);
        return open ? { status: 'ok', detail: '3100 可用' } : { status: 'fail', detail: '3100 不通', hint: '看桥接窗口日志；端口被别的程序占了就改它的配置' };
      },
    },
  ],
};
