#!/usr/bin/env node
/* ============================================================
 * doctor.mjs —— 链路体检：按 PDF 教程的四关顺序逐项探测
 *   ① DSH 本体        http://127.0.0.1:3080
 *   ② SnowLuma OneBot HTTP 3000 / WebSocket 3001
 *   ③ qq-bridge 控制台 3100
 *   ④ Hub MCP 工具数量
 * 用法：node scripts/doctor.mjs
 * ============================================================ */
'use strict';

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOneBot, classifyError } from '../plugins/_bridge.mjs';
import { dataPath } from './lib/paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {}

const tcp = (host, port, timeoutMs = 1500) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
  s.setTimeout(timeoutMs); s.on('connect', () => done(true)); s.on('timeout', () => done(false)); s.on('error', () => done(false));
});

const dshUrl = cfg.dsh?.baseUrl || 'http://127.0.0.1:3080';
const slHttp = cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000';
const slWs = Number(cfg.snowluma?.wsPort || (cfg.snowluma?.wsUrl || '').match(/:(\d+)/)?.[1] || 3001);

/* 协议端：走适配层心跳，能顺带报出「是哪个实现 / 哪个 QQ / 延迟多少」 */
const ob = cfg.onebot || {};
const client = createOneBot({
  impl: ob.impl || 'auto',
  httpUrl: ob.httpUrl || slHttp,
  accessToken: String(ob.accessToken != null && ob.accessToken !== '' ? ob.accessToken : (cfg.snowluma?.accessToken || '')),
  authMode: ob.authMode || 'header',
  pathPrefix: ob.pathPrefix || '',
  timeoutMs: 2500,
});

const [dsh, http3000, ws3001, bridge3100, hb] = await Promise.all([
  fetch(dshUrl, { signal: AbortSignal.timeout(2500) }).then((r) => r.status < 500).catch(() => false),
  tcp('127.0.0.1', Number(new URL(slHttp).port) || 3000),
  tcp('127.0.0.1', slWs),
  tcp('127.0.0.1', 3100),
  client.heartbeat({ force: true }),
]);

let installed = 0, tools = 0;
try {
  const cat = JSON.parse(fs.readFileSync(dataPath('plugins'), 'utf8'));
  const st = JSON.parse(fs.readFileSync(dataPath('state'), 'utf8'));
  for (const p of cat) if (st[p.id]?.installed) { installed++; tools += (p.tools || []).length; }
} catch {}

const row = (ok, label, detail, fix) => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '　' + detail : ''}`);
  if (!ok && fix) console.log(`   └─ ${fix}`);
};

console.log('── qqbot-plugins 链路体检 ──');
row(dsh, '① DSH 本体', dshUrl, '先打开 DSH 发一句话有回复，再谈搭桥');
row(http3000, '② 协议端 HTTP', client.base, '去协议端 WebUI 打开 HTTP API（SnowLuma 是 3000）');
row(hb.online,
  '② 协议端身份',
  hb.online
    ? `${hb.app || hb.impl} ${hb.version || ''} · 「${hb.nickname || '未知昵称'}」· QQ ${hb.selfId || '未知'} · ${hb.latencyMs}ms`
    : (hb.error || '没响应'),
  classifyError({ message: hb.error || '' }).kind === 'auth'
    ? '网页「连接设置」里填 AccessToken（协议端怎么校验就选 header / query），填完点刷新'
    : '确认协议端已登录 QQ、HTTP 接口已开启；地址和端口按实际填');
row(ws3001, '② 协议端 WebSocket', '端口 ' + slWs, '去协议端 WebUI 打开 WebSocket 服务端（SnowLuma 是 3001）');
row(bridge3100, '③ qq-bridge 控制台', '端口 3100', 'qq-bridge 没在运行？双击它的 start.bat');
row(installed > 0, '④ Hub 已安装插件', `${installed} 个插件 / ${tools} 个工具`, '在市场里装几个插件再试');

if (dsh && http3000 && ws3001 && hb.online) {
  console.log('\n链路正常。执行 node scripts/register-dsh.mjs <profile> 后重启 DSH 即完成搭桥。');
} else {
  console.log('\n还有关卡没过，按 PDF 教程排查表先修标 ❌ 的项（一次只改一处）。');
  process.exit(1);
}
