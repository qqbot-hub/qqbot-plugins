import path from 'node:path';
import fs from 'node:fs';
import { visit } from 'yaml';
import { patchBridge } from '../scripts/patch-qqbridge.mjs';
import { discoverDsh } from '../scripts/lib/dsh-discover.mjs';
import { discoverSnowLuma, syncBridgeConfig } from '../scripts/lib/discover.mjs';
import { parsePatch, profileFile } from '../scripts/lib/dsh-registration.mjs';

export default { id: 'qqbridge', title: 'qq-bridge 桥接', kind: 'bridge', steps: [
  { key: 'detect', title: '定位或安装 qq-bridge', async run(ctx) {
    const dir = [ctx.cfg().bridge?.dir, ctx.paths.runtimeDir('qqbridge'), 'C:\\qq-bridge'].filter(Boolean).find(d => fs.existsSync(path.join(d, 'src/bridge.js')));
    if (dir) ctx.state.dir = dir;
    else {
      const target = ctx.paths.runtimeDir('qqbridge');
      if (fs.existsSync(target) && fs.readdirSync(target).length) return { status: 'manual', detail: '桥接安装目录非空，保留现有内容', hint: '设置 bridge.dir 指向有效 qq-bridge 目录' };
      const r = await ctx.exec('git', ['clone', '--depth', '1', '--branch', 'v0.2.1-r1', 'https://github.com/Derpyu520/qq-bridge.git', target], { quiet: true, timeoutMs: 180000 });
      if (r.code !== 0) return { status: 'manual', detail: '无法从官方仓库克隆 qq-bridge；检查 Git、网络和证书', hint: '手动下载 https://github.com/Derpyu520/qq-bridge 到 ' + target + '；不需要关闭 SSL 校验' };
      const revision = await ctx.exec('git', ['rev-parse', 'HEAD'], { cwd: target, quiet: true, timeoutMs: 10000 });
      if (revision.code !== 0 || revision.stdout.trim() !== 'a49877f4e58d04e47532d44b803360d0f001160d') return { status: 'manual', detail: '桥接版本未通过固定提交校验，未执行安装脚本', hint: '检查 v0.2.1-r1 标签及官方提交；保留现场供核对' };
      ctx.state.dir = target;
    }
    ctx.saveCfg({ bridge: { ...ctx.cfg().bridge, dir: ctx.state.dir } });
    return { status: 'ok', detail: ctx.state.dir };
  } },
  { key: 'deps', title: '安装桥接依赖', async run(ctx) {
    const dir = ctx.state.dir;
    let pkg; try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return { status: 'fail', detail: '桥接缺少有效 package.json' }; }
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 13)) return { status: 'manual', detail: '当前 qq-bridge 要求 Node >=22.13.0', hint: '升级市场使用的 Node 后重新启动市场' };
    if (fs.existsSync(path.join(dir, 'node_modules/@snowluma/sdk/package.json'))) return { status: 'ok', detail: '桥接 SDK 已安装' };
    let r = await ctx.exec(ctx.isWin ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, quiet: true, timeoutMs: 300000 });
    if (r.code !== 0) return { status: 'manual', detail: '桥接 npm install 未成功；保留现场以便重试', hint: '在 ' + dir + ' 运行 npm install 检查网络、代理、证书与依赖报错' };
    return { status: 'ok', detail: '依赖安装完成' };
  } },
  { key: 'configure', title: '同步 DSH、SnowLuma 及白名单', async run(ctx) {
    const cfg = ctx.cfg(), dir = ctx.state.dir, file = path.join(dir, 'config.json');
    if (!fs.existsSync(file)) fs.copyFileSync(path.join(dir, 'config.example.json'), file);
    const dsh = await discoverDsh(ctx), snow = await discoverSnowLuma(cfg, { root: ctx.paths.root });
    const result = syncBridgeConfig(cfg, { dsh, snow });
    if (!dsh.webPort || !snow.heartbeat.online) return { status: 'manual', detail: '配置已同步，尚需 DSH 与 OneBot 在线', hint: '启动并登录 DSH，完成 SnowLuma 引导和 QQ 登录后继续' };
    if (!result.whitelistReady) return { status: 'manual', detail: '消息白名单为空，尚不能报告机器人可回复', hint: '在 ' + file + ' 的 allow.private 填允许的 QQ 号，或在 allow.groups 填群号；默认不自动开放给所有人。设置后继续。' };
    return { status: 'ok', detail: result.testMode ? '连接配置已同步；注意现有配置启用了空白名单测试模式' : '连接配置与消息白名单已就绪' };
  } },
  { key: 'patch', title: '修复市场工具守卫与预设', async run(ctx) { try { const r=patchBridge(ctx.state.dir); return {status:'ok',detail:'桥接补丁已保存；ownerQQ='+ (r.ownerQQ || '未设置')+'，首次需重新加载 DSH profile'}; } catch(e) { return {status:'manual',detail:e.message,hint:'仅支持已核对的 qq-bridge 0.2.1；保留现有文件，不覆盖未知版本'}; } } },
  { key: 'setup', title: '配置真实 DSH profile', async run(ctx) {
    const profile = ctx.cfg().dsh?.profile || 'desktop', file = profileFile(profile);
    if (!fs.existsSync(path.dirname(file))) return { status: 'manual', detail: '目标 DSH profile 不存在：' + profile, hint: '先在 DSH 登录生成 profile，或在市场配置 dsh.profile' };
    const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '[]';
    const before = parsePatch(original);
    const built=await ctx.exec(process.execPath,['scripts/build-agent-preset-patches.mjs'],{cwd:ctx.state.dir,quiet:true,timeoutMs:30000});
    if(built.code!==0)return {status:'manual',detail:'预设补丁生成失败，未运行setup；请检查依赖和日志'};
    const result = await ctx.exec(process.execPath, ['scripts/setup-dsh.mjs', profile], { cwd: ctx.state.dir, quiet: true, timeoutMs: 180000 });
    // Preserve all foreign AST nodes and comments even if upstream setup dumped the whole YAML.
    const owned = new Set(['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe']);
    if (fs.existsSync(file)) {
      const after = parsePatch(fs.readFileSync(file, 'utf8')), entries = [];
      visit(after, { Map(_k, node) { if (owned.has(node.get('id'))) entries.push(node.toJSON()); } });
      visit(before, { Map(_k, node) { if (owned.has(node.get('id'))) return visit.REMOVE; } });
      for (const entry of entries) before.contents.add(before.createNode({ insert: [entry] }));
      fs.copyFileSync(file, file + '.market-setup-backup'); fs.writeFileSync(file, before.toString());
    }
    if (result.code !== 0 || /返回退出码\s*[1-9]|auto-install failed|cannot resolve profile bundle/i.test(result.stdout + result.stderr)) return { status: 'manual', detail: '桥接 profile 依赖安装未验证成功，不能报告完成', hint: '在桥接目录执行 dsh plugin --profile ' + profile + ' install 并检查报错，再继续' };
    // Verify each declared bundle resolves from the actual target profile.
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'package.json'), 'utf8'));
      for (const name of pkg.dsh?.profile?.bundles || []) {
        if (!fs.existsSync(path.join(path.dirname(file), 'node_modules', name, 'package.json'))) throw new Error('missing bundle');
      }
    } catch { return { status: 'manual', detail: 'DSH profile bundle 尚未全部可解析', hint: '运行 dsh plugin --profile ' + profile + ' install 后继续' }; }
    return { status: 'ok', detail: 'profile 配置和 bundle 已检查；首次接入需在 DSH 加载该 profile' };
  } },
  { key: 'start', title: '启动桥接', async run(ctx) {
    const u = new URL(ctx.cfg().bridge?.consoleUrl || 'http://127.0.0.1:3100');
    if (await ctx.portOpen(u.hostname, Number(u.port) || 3100)) return { status: 'skip', detail: '控制台端口已占用，保留现有进程并在最终检查验证服务' };
    const marker = path.join(ctx.state.dir, '.market-process.json');
    try {
      const previous = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (previous.dir === ctx.state.dir && Number.isInteger(previous.pid) && previous.pid > 0) {
        try { process.kill(previous.pid, 0); return { status: 'manual', detail: '上次启动的桥接仍存活，尚未监听控制台，保留实例', hint: '检查桥接日志后继续，不要重复启动' }; } catch (e) { if (e.code === 'EPERM') return { status: 'manual', detail: '无法确认既有桥接进程，保留实例' }; }
      }
    } catch {}
    const r = ctx.spawnDetached(process.execPath, [path.join(ctx.paths.root, 'scripts/bridge-supervisor.mjs'), ctx.state.dir], { cwd: ctx.state.dir });
    if (!r.ok) return { status: 'fail', detail: '桥接启动失败' };
    if (r.pid) fs.writeFileSync(marker, JSON.stringify({ pid: r.pid, dir: ctx.state.dir, supervisor: true }));
    for (let i = 0; i < 15; i++) { if (await ctx.portOpen(u.hostname, Number(u.port) || 3100)) return { status: 'ok', detail: '控制台已监听，继续验证' }; await new Promise(r => setTimeout(r, 1000)); }
    return { status: 'manual', detail: '桥接进程已启动，控制台尚未就绪', hint: '检查 ' + ctx.state.dir + ' 的启动日志，避免重复启动' };
  } },
  { key: 'verify', title: '验证桥接服务', async run(ctx) {
    const result = await ctx.httpGet(ctx.cfg().bridge?.consoleUrl || 'http://127.0.0.1:3100', 2000);
    return result.ok && /qq.bridge|qq bridge/i.test(result.text) ? { status: 'ok', detail: '桥接控制台可识别；回复能力仍需真实消息验证' } : { status: 'manual', detail: '未取得桥接服务身份验证', hint: '打开控制台确认 DSH、SnowLuma、消息白名单与角色配置' };
  } },
] };
