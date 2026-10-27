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

const [dsh, http3000, ws3001, bridge3100] = await Promise.all([
  fetch(dshUrl, { signal: AbortSignal.timeout(2500) }).then((r) => r.status < 500).catch(() => false),
  tcp('127.0.0.1', Number(new URL(slHttp).port) || 3000),
  tcp('127.0.0.1', slWs),
  tcp('127.0.0.1', 3100),
]);

let installed = 0, tools = 0;
try {
  const cat = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'plugins.json'), 'utf8'));
  const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'state.json'), 'utf8'));
  for (const p of cat) if (st[p.id]?.installed) { installed++; tools += (p.tools || []).length; }
} catch {}

const row = (ok, label, detail, fix) => {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? '　' + detail : ''}`);
  if (!ok && fix) console.log(`   └─ ${fix}`);
};

console.log('── qqbot-plugins 链路体检 ──');
row(dsh, '① DSH 本体', dshUrl, '先打开 DSH 发一句话有回复，再谈搭桥');
row(http3000, '② SnowLuma OneBot HTTP', slHttp, '去 SnowLuma WebUI 打开 HTTP API（端口 3000）');
row(ws3001, '② SnowLuma WebSocket', '端口 ' + slWs, '去 SnowLuma WebUI 打开 WebSocket 服务端（端口 3001）');
row(bridge3100, '③ qq-bridge 控制台', '端口 3100', 'qq-bridge 没在运行？双击它的 start.bat');
row(installed > 0, '④ Hub 已安装插件', `${installed} 个插件 / ${tools} 个工具`, '在市场里装几个插件再试');

if (dsh && http3000 && ws3001) {
  console.log('\n链路正常。执行 node scripts/register-dsh.mjs <profile> 后重启 DSH 即完成搭桥。');
} else {
  console.log('\n还有关卡没过，按 PDF 教程排查表先修标 ❌ 的项（一次只改一处）。');
  process.exit(1);
}
