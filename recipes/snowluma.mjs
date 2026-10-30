import { downloadVerified, extractVerified } from '../scripts/lib/download.mjs';
import { discoverSnowLuma, applySnowLuma } from '../scripts/lib/discover.mjs';
﻿/* Program startup and OneBot readiness are separate states (SnowLuma 1.x/2.x). */
import fs from 'node:fs';
import path from 'node:path';
import { createOneBot } from '../plugins/_bridge.mjs';
import { decrypt } from '../scripts/lib/secrets.mjs';

export function createSnowLumaRecipe({ heartbeat = async ctx => {
  const cfg = ctx.cfg();
  const found = await discoverSnowLuma(cfg, { root: ctx.paths?.root || process.cwd() });
  if (found.heartbeat.online && ctx.saveCfg && applySnowLuma(cfg, found)) ctx.saveCfg(cfg);
  return found.heartbeat;
}, sleep = ms => new Promise(r => setTimeout(r, ms)), alive = pid => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
} } = {}) {
  const marker = ctx => path.join(ctx.paths.runtimeDir('snowluma'), '.market-process.json');
  async function panel(ctx) {
    for (const raw of [...new Set([ctx.cfg().snowluma?.webuiUrl, 'http://127.0.0.1:5099', 'http://127.0.0.1:5100'].filter(Boolean))]) {
      let url;
      try { url = new URL(raw); } catch { continue; }
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) continue;
      const result = await ctx.httpGet(url.origin, 1000);
      if ([200, 401, 403].includes(result.status) && /snowluma/i.test(result.text || '')) {
        ctx.state.panel = url.origin;
        return url.origin;
      }
    }
    return '';
  }
  const manual = (ctx, detail) => ({ status: 'manual', detail, hint: `打开 ${ctx.state.panel || 'SnowLuma 面板（通常 http://127.0.0.1:5099）'}，自行同意 EULA/PRIVACY、登录管理面板、启用 OneBot v11 HTTP，然后扫码登录 QQ。HTTP 地址与 AccessToken 须和市场连接设置一致；WebSocket 按桥接需要启用。完成后继续。安装目录：${ctx.state.dir}` });
  async function readiness(ctx) {
    const hb = await heartbeat(ctx);
    let runtime;try{runtime=JSON.parse(fs.readFileSync(path.join(ctx.state.dir,'config/runtime.json'),'utf8'));}catch{}
    if (hb.online) return { status: 'ok', detail: `OneBot 已登录：${hb.nickname || ''} QQ ${hb.selfId || ''}`+(runtime?.hookAutoLoad===false?'；注意 hookAutoLoad=false，重启后需在面板重新接入 QQ 进程':'') };
    await panel(ctx);
    return manual(ctx, ctx.state.panel ? 'SnowLuma 面板已启动，OneBot 尚未就绪；需要完成面板配置和 QQ 登录' : 'OneBot 尚未通过登录验证；请检查地址、鉴权和 QQ 登录状态');
  }
  return { id: 'snowluma', title: 'SnowLuma 协议端', kind: 'protocol', steps: [
    { key: 'detect', title: '找安装位置', async run(ctx) {
      const dirs = [ctx.cfg().snowluma?.installDir, ctx.paths.runtimeDir('snowluma'), 'C:\\SnowLuma'].filter(Boolean);
      let dir = dirs.find(d => fs.existsSync(path.join(d, 'index.mjs')));
      if (!dir) {
        if (!ctx.isWin || process.arch !== 'x64') return { status: 'manual', detail: '此平台需手动安装 SnowLuma 完整发行包', hint: '下载对应系统发行包并配置 snowluma.installDir' };
        const response = await ctx.httpGet('https://api.github.com/repos/SnowLuma/SnowLuma/releases/tags/v2.2.1', 15000);
        const asset = response.json?.assets?.find(a => /win-x64\.zip$/i.test(a.name));
        const digest = asset?.digest?.replace(/^sha256:/, '');
        if (!asset || !/^[a-f0-9]{64}$/i.test(digest || '')) return { status: 'manual', detail: '未取得官方 v2.2.1 安装包及 SHA256，不自动下载未校验的软件', hint: '从官方 Releases 手动下载并解压到 ' + ctx.paths.runtimeDir('snowluma') };
        const target = ctx.paths.runtimeDir('snowluma');
        if (fs.existsSync(target) && fs.readdirSync(target).length) return { status: 'manual', detail: '安装目录非空但缺少 index.mjs，保留已有文件', hint: '请检查解压层级或设置 snowluma.installDir' };
        const archive = ctx.paths.runtimeDir('snowluma-v2.2.1.zip');
        await downloadVerified(asset.browser_download_url, archive, { sha256: digest });
        await extractVerified(ctx, archive, target);
        if (['index.mjs', 'launcher.bat', 'node.exe', 'native'].some(file => !fs.existsSync(path.join(target, file)))) return { status: 'manual', detail: '包已解压，但完整发行包入口、Node 或 native 文件缺失', hint: '检查 ' + target + ' 的解压层级和发行包完整性，再配置 snowluma.installDir' };
        dir = target;
      }
      ctx.state.dir = dir;
      ctx.saveCfg({ snowluma: { ...ctx.cfg().snowluma, installDir: dir } });
      return { status: 'ok', detail: dir };
    } },
    { key: 'running', title: '检查程序及 OneBot 状态', async run(ctx) {
      if ((await heartbeat(ctx)).online) { ctx.state.running = true; return { status: 'ok', detail: 'OneBot 心跳正常，不重复启动' }; }
      if (await panel(ctx)) { ctx.state.running = true; return { status: 'ok', detail: `面板已启动：${ctx.state.panel}；OneBot 状态稍后检查` }; }
      try {
        const record = JSON.parse(fs.readFileSync(marker(ctx), 'utf8'));
        if (record.dir === ctx.state.dir && Number.isInteger(record.pid) && record.pid > 0 && alive(record.pid)) {
          ctx.state.running = true;
          return { status: 'ok', detail: '上次启动的进程仍存活，不重复创建实例；请检查面板或启动日志' };
        }
      } catch {}
      return { status: 'skip', detail: '尚未发现可识别的面板或本工具启动的存活进程，下一步启动' };
    } },
    { key: 'start', title: '启动协议端', async run(ctx) {
      if (ctx.state.running) return { status: 'skip', detail: '已启动，继续检查 OneBot 配置' };
      const dir = ctx.state.dir;
      const bundled = path.join(dir, ctx.isWin ? 'node.exe' : 'node');
      const node = fs.existsSync(bundled) ? bundled : process.execPath;
      const version = await ctx.exec(node, ['--version'], { cwd: dir, quiet: true, timeoutMs: 10000 });
      if (version.code !== 0) return { status: 'fail', detail: `无法运行 ${node}`, hint: '检查发行包自带 Node 是否完整、是否与系统架构匹配。' };
      const checker = path.join(dir, 'check-node-version.cjs');
      if (fs.existsSync(checker)) {
        const check = await ctx.exec(node, [checker], { cwd: dir, quiet: true, timeoutMs: 10000 });
        if (check.code !== 0) return { status: 'fail', detail: `SnowLuma 的 Node 版本检查未通过：${version.stdout.trim()}（${node}）`, hint: '优先使用完整发行包自带的 node.exe；否则安装该 SnowLuma 发行版要求的 Node。2.2.1 要求 ^24.22.1 || >=26.12.1。' };
      }
      fs.mkdirSync(path.dirname(marker(ctx)), { recursive: true });
      const result = ctx.spawnDetached(node, ['index.mjs'], { cwd: dir, logFile: path.join(dir, 'market-startup.log') });
      if (!result.ok || !result.pid) return { status: 'fail', detail: 'SnowLuma 后台启动失败', hint: `在 ${dir} 中用所选 Node 手动运行 index.mjs 查看日志。` };
      fs.writeFileSync(marker(ctx), JSON.stringify({ pid: result.pid, dir }));
      for (let i = 0; i < 20; i++) {
        if (await panel(ctx)) return { status: 'ok', detail: `面板已启动：${ctx.state.panel}；尚不代表 OneBot 就绪` };
        if ((await heartbeat(ctx)).online) return { status: 'ok', detail: 'OneBot 心跳已通过' };
        if (!alive(result.pid)) return { status: 'fail', detail: 'SnowLuma 进程已退出', hint: `查看 ${path.join(dir, 'market-startup.log')} 或在安装目录用所选 Node 运行 index.mjs。日志可能含初始管理员密码，请勿公开上传。` };
        await sleep(2000);
      }
      return manual(ctx, '进程已启动，但尚未发现面板或有效的 OneBot 心跳；保留当前实例，不重复启动');
    } },
    { key: 'login', title: '检查 OneBot 配置和 QQ 登录', async run(ctx) {
      const hb = await heartbeat(ctx);
      if (!hb.online) return readiness(ctx);
      ctx.saveCfg({ snowluma: { ...ctx.cfg().snowluma, selfId: String(hb.selfId || ''), nickname: hb.nickname || '' } });
      return { status: 'ok', detail: `OneBot 已登录：${hb.nickname || ''} QQ ${hb.selfId || ''}` };
    } },
    { key: 'verify', title: '验证 OneBot 协议心跳', run: readiness },
  ] };
}
export default createSnowLumaRecipe();
