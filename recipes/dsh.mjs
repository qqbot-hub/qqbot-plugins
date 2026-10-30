/* DSH（DeepSeek Harness）：插件宿主
 * 它本身是桌面程序，但进程能被脚本拉起来：先探测端口，没开就去常见安装位置找
 * 「DeepSeek Harness.exe」并后台启动，然后轮询等它响应。
 * 仍然需要人工的只剩「首次登录账号」——这一步任何脚本都替代不了。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { profileFile } from '../scripts/lib/dsh-registration.mjs';

const HOME = process.env.USERPROFILE || os.homedir();

import { discoverDsh, findDshExe } from '../scripts/lib/dsh-discover.mjs';

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
        const dir = path.dirname(path.dirname(profileFile('desktop')));
        if (!fs.existsSync(dir)) return { status: 'manual', detail: '还没有 DSH profile，需要先手动启动并登录一次', hint: '打开 DeepSeek Harness 并完成首次登录，确认生成 ~/.dsh/profiles 后，再重新运行部署' };
        const profiles = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory());
        if (!profiles.length) return { status: 'manual', detail: 'DSH profiles 目录为空，需要先手动启动并登录一次', hint: '打开 DeepSeek Harness 并完成首次登录，确认生成 profile 后，再重新运行部署' };
        const want = (ctx.cfg().dsh && ctx.cfg().dsh.profile) || 'desktop';
        if (!profiles.includes(want)) return { status: 'manual', detail: '目标 profile 不存在：' + want, hint: '请启动目标 DSH profile 或修改 dsh.profile；不会静默改用其他 profile' };
        const profile = want;
        ctx.state.profile = profile;
        const hasYml = fs.existsSync(profileFile(profile));
        return { status: 'ok', detail: `profile: ${profile}（共 ${profiles.length} 个）${hasYml ? '，配置文件就绪' : '，还没有 cordis.patch.yml（首次注册时自动建）'}` };
      },
    },
    {
      key: 'running',
      title: '探测 DSH 是否在运行',
      hint: 'DSH 的端口是动态的（不一定是 3080）：脚本会按进程找到它真正在听哪个端口',
      async run(ctx) {
        const d = await discoverDsh(ctx);
        ctx.state.dsh = d;
        if (!d.running) {
          return { status: 'ok', detail: '没发现运行中的 DSH 进程，下一步尝试自动启动' };
        }
        const base = d.webPort ? `http://127.0.0.1:${d.webPort}` : (d.apiPort ? `http://127.0.0.1:${d.apiPort}` : '');
        if (base) {
          ctx.saveCfg({ dsh: Object.assign({ baseUrl: 'http://127.0.0.1:3080' }, ctx.cfg().dsh || {}, { baseUrl: base, apiUrl: d.apiPort ? `http://127.0.0.1:${d.apiPort}` : '', detectedAt: new Date().toISOString() }) });
        }
        const bits = [];
        if (d.webPort) bits.push(`网页端 ${d.webPort}`);
        if (d.apiPort) bits.push(`API ${d.apiPort}`);
        return { status: 'ok', detail: `DSH 正在运行（${bits.join(' · ') || '端口 ' + d.ports.map((x) => x.port).join(',')}）` };
      },
    },
    {
      key: 'start',
      title: '启动 DSH 进程',
      hint: '自动启动没成功的话：手动打开「DeepSeek Harness」桌面程序，登录后回到这里再点一次安装',
      async run(ctx) {
        let d = ctx.state.dsh || (await discoverDsh(ctx));
        if (d.running) return { status: 'skip', detail: `已经在运行（${d.webPort ? '网页端 ' + d.webPort : '进程在'}），不用重启` };

        const configured = (ctx.cfg().dsh || {}).exe || '';
        const exe = findDshExe(configured);
        if (!exe) {
          return {
            status: 'manual',
            detail: '没在这台机器上找到「DeepSeek Harness.exe」',
            hint: '如果你装了 DSH，把它的 exe 完整路径填到「连接设置 → DSH 可执行文件」，或者在配置里写 dsh.exe，脚本下次就能自动拉起它',
          };
        }
        ctx.saveCfg({ dsh: Object.assign({ baseUrl: 'http://127.0.0.1:3080' }, ctx.cfg().dsh || {}, { exe }) });
        const r = ctx.spawnDetached(exe, [], { cwd: path.dirname(exe) });
        if (!r.ok) return { status: 'manual', detail: `启动失败：${r.error}`, hint: `手动双击 ${exe}` };

        /* Electron 冷启动要几秒，而且端口是动态的：每 2 秒重新发现一次 */
        for (let i = 0; i < 15; i++) {
          await new Promise((res) => setTimeout(res, 2000));
          d = await discoverDsh(ctx);
          if (d.running) {
            ctx.state.dsh = d;
            const base = d.webPort ? `http://127.0.0.1:${d.webPort}` : `http://127.0.0.1:${d.apiPort || 3080}`;
            ctx.saveCfg({ dsh: Object.assign({ baseUrl: 'http://127.0.0.1:3080' }, ctx.cfg().dsh || {}, { baseUrl: base, apiUrl: d.apiPort ? `http://127.0.0.1:${d.apiPort}` : '', exe }) });
            return { status: 'ok', detail: `已启动（${path.basename(exe)}）· 端口 ${d.webPort || d.apiPort}，用时约 ${(i + 1) * 2} 秒` };
          }
        }
        return {
          status: 'manual',
          detail: '进程起来了但 30 秒内没在已知端口上响应',
          hint: '可能是首次启动要登录账号。看 DSH 窗口登录一次，再回来点「部署」重试（脚本会自动接上它已开的端口）',
        };
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
