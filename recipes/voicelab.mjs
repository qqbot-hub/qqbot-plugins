/* 调音台（Voice Lab）：本地语音工作台，可选配套
 * 它是独立小服务（默认 3120），本市场只负责起进程 + 验证接口。
 */
import path from 'node:path';
import fs from 'node:fs';

const CANDIDATES = ['D:\\tts\\voicelab', 'C:\\tts\\voicelab'];

const findInstall = (ctx) => {
  const cfgDir = ctx.cfg()?.lab?.dir;
  for (const dir of [cfgDir, ...CANDIDATES, ctx.paths.runtimeDir('voicelab')].filter(Boolean)) {
    if (fs.existsSync(path.join(dir, 'server.mjs'))) return dir;
  }
  return '';
};

export default {
  id: 'voicelab',
  title: '调音台 · Voice Lab',
  kind: 'companion',
  steps: [
    {
      key: 'detect',
      title: '找安装位置',
      hint: '调音台是本机独立程序（不属于本仓库）。没有它不影响主链路，装上才能调音色',
      async run(ctx) {
        const dir = findInstall(ctx);
        if (!dir) return { status: 'manual', detail: '没有找到外部调音台；它不是主链路必需组件', hint: '自行安装后配置 lab.dir；当前没有可验证安装来源，不自动下载' };
        ctx.state.dir = dir;
        ctx.saveCfg({ lab: Object.assign({}, ctx.cfg().lab, { dir, url: 'http://127.0.0.1:3120' }) });
        return { status: 'ok', detail: dir };
      },
    },
    {
      key: 'running',
      title: '检查 3120 是否在监听',
      async run(ctx) {
        if (await ctx.portOpen('127.0.0.1', 3120)) { ctx.state.running = true; return { status: 'ok', detail: '3120 已在运行' }; }
        return { status: 'skip', detail: '没起来，下一步启动' };
      },
    },
    {
      key: 'start',
      title: '启动调音台',
      hint: '在 D:\\tts\\voicelab 里跑 node server.mjs，看它报什么错',
      async run(ctx) {
        if (ctx.state.running) return { status: 'skip', detail: '已在运行' };
        ctx.spawnDetached(process.execPath, ['server.mjs'], { cwd: ctx.state.dir });
        for (let i = 0; i < 12; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          if (await ctx.portOpen('127.0.0.1', 3120)) return { status: 'ok', detail: '已在后台启动' };
        }
        return { status: 'fail', detail: '启动了但 18 秒内没监听 3120' };
      },
    },
    {
      key: 'verify',
      title: '验证接口',
      async run(ctx) {
        try {
          const r = await ctx.httpGet('http://127.0.0.1:3120/api/state', 3000);
          if (r.ok) return { status: 'ok', detail: '调音台接口正常，可以在市场里点「在市场里打开」直接用' };
          return { status: 'fail', detail: `接口返回 ${r.status}` };
        } catch (e) {
          return { status: 'fail', detail: '接口不通：' + e.message };
        }
      },
    },
  ],
};
