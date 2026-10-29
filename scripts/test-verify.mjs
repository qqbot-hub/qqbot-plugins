/* ============================================================
 * test-verify.mjs —— 「页面上的数字是真数」+「HTML 里没有重复 id」
 *
 * 跑法：node scripts/test-verify.mjs
 *
 * 为什么单独测这两个：
 *
 *   1) 首屏那句「64 项已实测通过」以前是写死的。实测通过数天生会浮动
 *      （QQ 在线 64、没开就 63，联网那批还会被限流），写死必然在另一种
 *      状态下变成假话——而且首页说 64、下面正文又承认「会是 63 或 64」，
 *      自己跟自己对不上。现在改成服务端真跑一遍 verify-plugins 并缓存，
 *      前端读真实值。这里测的是这条链路别悄悄退化回写死。
 *
 *   2) 页面里出现过两个 id="mHint"（部署区的环境提示 和 弹窗的配置提示）。
 *      id 重复时 getElementById 只会拿到文档里第一个，于是弹窗一开就把
 *      「保存后立即生效」写进了部署区，把「本机环境：Node 22…」冲掉，
 *      而弹窗自己的提示反而不更新——两处都错。这类 bug 肉眼看不出来，
 *      只能靠静态检查钉住。
 * ============================================================ */
import fs from 'node:fs';
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

const PORT = 3500 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const api = async (p) => (await fetch(BASE + p)).json();

console.log('\n[1] 起一个市场进程');
const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { PORT: String(PORT) }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let boot = '';
child.stdout.on('data', (c) => { boot += c; });
child.stderr.on('data', (c) => { boot += c; });
let up = false;
for (let i = 0; i < 40; i++) {
  await sleep(300);
  try { const h = await api('/api/health'); if (h && h.ok) { up = true; break; } } catch { /* 还没起来 */ }
}
ok(up, '市场进程起来了', up ? BASE : boot.slice(0, 200));
if (!up) { child.kill(); process.exit(1); }

console.log('\n[2] /api/verify：结构对、且没跑完时不编造数字');
const v0 = await api('/api/verify');
ok(v0 && v0.ok === true, '接口存在并返回 ok', JSON.stringify(v0).slice(0, 90));
ok(typeof v0.ready === 'boolean' && typeof v0.running === 'boolean', '带 ready / running 状态位');
/* 还没跑完时必须承认没数，绝不能拿写死的 64 先顶上 */
ok(v0.ready === false ? v0.pass === undefined : true,
  '没跑完就不返回 pass（不拿写死的数冒充实测结果）',
  v0.ready ? '这次已经有缓存了，跳过' : `ready=${v0.ready} running=${v0.running}`);

console.log('\n[3] /api/stars：拿不到就认栽，且不重复卡超时');
const t0 = Date.now();
const s1 = await api('/api/stars');
const cost1 = Date.now() - t0;
ok(s1 && s1.ok === true, '接口存在并返回 ok', JSON.stringify(s1).slice(0, 90));
ok(s1.stars === null || Number.isFinite(s1.stars), 'stars 是数字或明确的 null（不是 undefined/NaN）', String(s1.stars));
const t1 = Date.now();
await api('/api/stars');
const cost2 = Date.now() - t1;
/* 没网时会 6 秒超时；第二次必须命中冷却立刻返回，否则每个访客都陪着等 6 秒 */
ok(cost2 < 1500, '第二次命中缓存/冷却，不再卡网络超时', `首次 ${cost1}ms → 二次 ${cost2}ms`);

console.log('\n[4] 页面 HTML：不能有重复 id');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
const ids = [...body.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
ok(dup.length === 0, '没有重复的 id', dup.length ? '重复：' + dup.join(', ') : `${ids.length} 个 id 全部唯一`);

console.log('\n[5] 实测数字是动态读的，不是写死在 HTML 里');
/* 承载实测通过数的元素必须有 id，JS 才能更新它；没有 id 就意味着这个值永远改不了 */
ok(/id="statPass"/.test(html), '首屏实测数有 id（可被 JS 更新）');
ok(/id="provPass"/.test(html), '来源与实测区的实测数有 id');
ok(/loadVerify\s*\(/.test(html), '页面启动时会去读实测结果');
ok((html.match(/api\.github\.com/g) || []).length === 0,
  '前端不再直连 api.github.com（避免 CORS 和 60 次/小时限流）');

child.kill();
await sleep(300);
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
