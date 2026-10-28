/* DSH（DeepSeek Harness）：插件宿主
 * 它是桌面程序，市场只能「检测 + 引导 + 注册 MCP」，装包本身得你点安装器。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const profileFile = (profile) => path.join(process.env.USERPROFILE || os.homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml');

export default {
  id: 'dsh',
  title: 'DSH（DeepSeek Harness）',
  kind: 'host',
  steps: [
    {
      key: 'profile',
      title: '检查 DSH 配置目录',
      hint: 'DSH 是桌面程序：装好并启动一次（登录你的账号），它才会生成 ~/.dsh/profiles',
      async run(ctx) {
        const home = process.env.USERPROFILE || os.homedir();
        const dir = path.join(home, '.dsh', 'profiles');
        if (!fs.existsSync(dir)) return { status: 'fail', detail: '没找到 ' + dir + '，说明这台机器没装过 DSH' };
        const profiles = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory());
        if (!profiles.length) return { status: 'fail', detail: 'profiles 目录是空的，先启动一次 DSH' };
        const want = (ctx.cfg().dsh && ctx.cfg().dsh.profile) || 'desktop';
        const profile = profiles.includes(want) ? want : profiles[0];
        ctx.state.profile = profile;
        const hasYml = fs.existsSync(profileFile(profile));
        return { status: 'ok', detail: `profile: ${profile}（共 ${profiles.length} 个）${hasYml ? '，配置文件就绪' : '，还没有 cordis.patch.yml（首次注册时自动建）'}` };
      },
    },
    {
      key: 'running',
      title: '检查 DSH 是否在运行',
      hint: '打开 DSH 桌面程序，登录后能正常对话再回来',
      async run(ctx) {
        const dsh = ctx.cfg().dsh || {};
        const base = String(dsh.baseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, '');
        const port = Number((base.match(/:(\d+)/) || [])[1] || 3080);
        if (!(await ctx.portOpen('127.0.0.1', port))) {
          return { status: 'manual', detail: `DSH 没在 ${port} 端口上响应（可能没启动，或它换了端口）` };
        }
        return { status: 'ok', detail: `DSH 在 ${port} 端口响应` };
      },
    },
    {
      key: 'record',
      title: '记录 DSH 地址与 profile',
      async run(ctx) {
        const dsh = ctx.cfg().dsh || {};
        ctx.saveCfg({ dsh: Object.assign({ baseUrl: 'http://127.0.0.1:3080' }, dsh, { profile: ctx.state.profile }) });
        return { status: 'ok', detail: `已记录 profile=${ctx.state.profile}` };
      },
    },
  ],
};
