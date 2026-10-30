import { registered, registrationCount, profileFile } from '../scripts/lib/dsh-registration.mjs';
/* 本插件市场自己：把 MCP 服务器注册进 DSH，让插件真的出现在对话里
 * 这一步是「装完插件却用不了」的分水岭 —— 注册了才算打通。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export default {
  id: 'market',
  title: '本插件市场',
  kind: 'market',
  steps: [
    {
      key: 'self',
      title: '确认市场本体完整',
      async run(ctx) {
        const need = ['server.js', 'mcp-server.mjs', 'plugins/_bridge.mjs', 'plugins/_lib.mjs'];
        const miss = need.filter((f) => !fs.existsSync(path.join(ctx.paths.root, f)));
        if (miss.length) return { status: 'fail', detail: '缺少文件：' + miss.join(', '), hint: '重新拉取本仓库（git pull）再试' };
        return { status: 'ok', detail: `${need.length} 个核心文件就位` };
      },
    },
    {
      key: 'register',
      title: '把 MCP 注册进 DSH',
      hint: '手动在终端跑：node scripts/register-dsh.mjs desktop，然后完全退出 DSH 再打开',
      async run(ctx) {
        const profile = (ctx.cfg().dsh && ctx.cfg().dsh.profile) || 'desktop';
        const dir = path.dirname(profileFile(profile));
        if (!fs.existsSync(dir)) {
          return { status: 'manual', detail: `还没装 DSH（没有 ${dir}），先装 DSH 再回来注册` };
        }
        const r = await ctx.exec(process.execPath, [path.join('scripts', 'register-dsh.mjs'), profile], { timeoutMs: 30000 });
        const out = (r.stdout + r.stderr).trim();
        if (r.code !== 0) return { status: 'fail', detail: '注册失败：' + out.slice(0, 300) };
        const yml = path.join(dir, 'cordis.patch.yml');
        const ok = registered(profile);
        if (!ok) return { status: 'fail', detail: '注册脚本跑完了，但配置里没看到条目', hint: '把 ' + yml + ' 发我看一眼' };
        ctx.state.registered = true;
        return { status: 'ok', detail: `已写入 ${profile} 的 cordis.patch.yml` };
      },
    },
    {
      key: 'verify',
      title: '确认 DSH 侧配置无重复',
      hint: '完全退出 DSH（不是关窗口，是退出进程）再启动，新会话里搜 mcp__qqbot__ 才能看到工具',
      async run(ctx) {
        const profile = (ctx.cfg().dsh && ctx.cfg().dsh.profile) || 'desktop';
        const yml = profileFile(profile);
        if (!fs.existsSync(yml)) return { status: 'skip', detail: '没有配置文件，跳过' };
        const text = fs.readFileSync(yml, 'utf8');
        const times = registrationCount(text);
        if (times !== 1) return { status: 'fail', detail: `配置里有 ${times} 份重复注册`, hint: `跑 node scripts/register-dsh.mjs --remove 清掉后重新安装` };
        return { status: 'ok', detail: '只有 1 份注册，干净' };
      },
    },
    {
      key: 'sample',
      title: '准备只读示例工具',
      async run(ctx) {
        const state = ctx.readJson('state', {});
        if (Object.values(state).some(s => s.installed && s.enabled)) return { status: 'skip', detail: '已有启用插件，保留用户选择' };
        state.clock = { installed: true, enabled: true, installedAt: new Date().toISOString() };
        ctx.writeJson('state', state);
        return { status: 'ok', detail: '已启用 clock 只读示例，供 DSH 工具加载验收' };
      },
    },
    {
      key: 'restart',
      title: '记录生效条件',
      async run(ctx) {
        return {
          status: 'ok',
          detail: '注册已写好；首次注册请在 DSH 重载 MCP 连接或配置。已连接的新版市场支持插件热更新；最终以 DSH tools/list 和插件只读检查为准',
        };
      },
    },
  ],
};
