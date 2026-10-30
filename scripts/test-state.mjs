/* ============================================================
 * test-state.mjs —— 安装状态的一致性
 *
 * 跑法：node scripts/test-state.mjs
 *
 * 为什么单独测这个：
 *   安装任务是 recipes/plugin.mjs 直接写 data/state/plugins.json 的，
 *   而市场进程把状态缓存在内存里。两边不同步就会出现「装完了页面还显示未安装、
 *   MCP 也列不出工具」——用户看到的是"装了但没用"，最难查。
 *   所以这里真起一个市场进程（用临时状态文件，完全不碰你的真实数据），
 *   在进程外面改文件，再问它一次。
 * ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

const PORT = 3300 + Math.floor(Math.random() * 200);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-state-'));
const STATE = path.join(TMP, 'plugins.json');
const BASE = `http://127.0.0.1:${PORT}`;

const readState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const writeState = (o) => fs.writeFileSync(STATE, JSON.stringify(o, null, 2));
const api = async (p, init) => (await fetch(BASE + p, init)).json();

console.log('\n[1] 启动一个用临时状态文件的市场进程');
fs.writeFileSync(STATE, JSON.stringify({ clock: { installed: true, enabled: true } }, null, 2));
const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { HOST: '127.0.0.1', PORT: String(PORT), QQBOT_STATE_FILE: STATE }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let boot = '';
child.stdout.on('data', (c) => { boot += c; });
child.stderr.on('data', (c) => { boot += c; });

let up = false;
for (let i = 0; i < 40; i++) {
  await sleep(300);
  try {
    const h = await api('/api/health');
    if (h && h.ok) { up = true; break; }
  } catch { /* 还没起来 */ }
}
ok(up, '市场进程起来了', up ? BASE : boot.slice(0, 200));
if (!up) { child.kill(); process.exit(1); }

console.log('\n[2] 初始状态：只认文件里写的那一个插件');
const list0 = await api('/api/list');
const byId = (r, id) => (r.plugins || []).find((p) => p.id === id) || {};
ok(byId(list0, 'clock').installed === true, 'clock 显示已安装');
ok(byId(list0, 'qzone').installed === false, 'qzone 显示未安装');

console.log('\n[3] 在进程外面改状态文件（模拟 recipes/plugin.mjs 装完写盘）');
const st = readState();
st.qzone = { installed: true, enabled: true, installedAt: new Date().toISOString() };
writeState(st);
const list1 = await api('/api/list');
ok(byId(list1, 'qzone').installed === true,
  '不用重启市场，再查就已经是已安装（mtime 变更触发重读）');
const tools1 = await api('/api/tools');
ok((tools1.tools || []).some((t) => t.name === 'qq_qzone_post'),
  '装完立刻出现在工具列表里', `${(tools1.tools || []).length} 个工具`);

console.log('\n[4] 反向：进程内卸载要真的写回文件');
const op = await api('/api/op', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'uninstall', id: 'qzone' }),
});
ok(op.ok === true, '卸载接口返回成功');
await sleep(120);
ok(readState().qzone && readState().qzone.installed === false, '文件里已写成未安装');
const list2 = await api('/api/list');
ok(byId(list2, 'qzone').installed === false, '再查也是未安装');
const tools2 = await api('/api/tools');
ok(!(tools2.tools || []).some((t) => t.name === 'qq_qzone_post'), '工具列表里没了');

console.log('\n[5] 文件被写坏时不要把内存状态清空');
fs.writeFileSync(STATE, '{ 这不是 JSON');
const list3 = await api('/api/list');
ok(Array.isArray(list3.plugins) && list3.plugins.length > 0,
  '坏文件不至于让接口 500 / 返回空', `${(list3.plugins || []).length} 个插件`);
ok(byId(list3, 'clock').installed === true, '仍按上一次读到的状态回答（不清空）');

child.kill();
await sleep(300);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录删不掉不致命 */ }

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
