/* ============================================================
 * test-nav.mjs —— 侧栏导航 vs 页面真实区块的一致性自检
 *
 * 跑法：node scripts/test-nav.mjs
 * 通过标准：全部 ok，任何一项 fail 都会以非 0 退出。
 *
 * 为什么要这个测试：
 *   侧栏看着是一回事，页面滚下去是另一回事——曾经顺序完全对不上
 *   （导航第 1 项是「主链路直连」，可它排在页面第 6 位），
 *   滚动高亮于是乱跳。这里把「导航顺序 == 页面顺序」钉成硬约束。
 *
 * 覆盖：
 *   1. 导航项与页面区块一一对应（不多不少，都能对上 id）
 *   2. 导航顺序与页面 DOM 顺序完全一致（这才是「对应得上」的关键）
 *   3. 导航项目文字 / title 与区块<h2>标题语义对得上（不是各叫各的）
 *   4. 页面里所有 href="#xxx" 锚点都有真实落点（无死链）
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

/* ---------- 提取侧栏导航项（按出现顺序） ---------- */
const navRe = /<a\s+href="#([^"]+)"\s+data-nav="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g;
const navs = [];
for (const m of html.matchAll(navRe)) {
  const attrs = m[3];
  const title = (attrs.match(/title="([^"]*)"/) || [, ''])[1];
  const text = m[4].replace(/<[^>]+>/g, '').trim();
  navs.push({ href: m[1], nav: m[2], title, text });
}

/* ---------- 提取页面顶层区块（按 DOM 顺序） ---------- */
const secRe = /<section\b([^>]*)>([\s\S]*?)<\/section>/g;
const secs = [];
for (const m of html.matchAll(secRe)) {
  const attrs = m[1];
  const id = (attrs.match(/id="([^"]+)"/) || [, null])[1];
  /* hero 用 <h1>，其余区块用 <h2>，都算「有标题」 */
  const head = (m[2].match(/<h([12])[^>]*>([\s\S]*?)<\/h\1>/) || [, null, null])[2];
  const innerSec = /<section\b/.test(m[2]);
  secs.push({ id, h2: head ? head.replace(/<[^>]+>/g, '').trim() : null, innerSec });
}

console.log('\n[1] 区块完整性');
ok(secs.length > 0, '页面里读到了区块', `${secs.length} 个`);
ok(!secs.some((s) => s.innerSec), '没有嵌套 section（否则重排会错乱）');
const withId = secs.filter((s) => s.id);
ok(withId.length === secs.length, '每个区块都有 id（锚点不是写死的才能重排）');
ok(withId.every((s) => s.h2), '每个区块都有 <h2> 标题（导航要跟它对得上）');
const dupId = withId.map((s) => s.id).filter((v, i, a) => a.indexOf(v) !== i);
ok(!dupId.length, '区块 id 无重复', dupId.length ? '重复：' + dupId.join(',') : '');

console.log('\n[2] 导航 vs 区块：一一对应');
ok(navs.length > 0, '侧栏读到了带 data-nav 的导航项', `${navs.length} 项`);
const dupNav = navs.map((n) => n.nav).filter((v, i, a) => a.indexOf(v) !== i);
ok(!dupNav.length, 'data-nav 无重复', dupNav.length ? '重复：' + dupNav.join(',') : '');
const missing = navs.filter((n) => !secs.some((s) => s.id === n.nav));
ok(!missing.length, '每个导航项都指向真实存在的区块', missing.length ? '找不到：' + missing.map((n) => n.nav).join(',') : '');
const unreached = withId.filter((s) => s.id !== 'hero' && !navs.some((n) => n.nav === s.id));
ok(!unreached.length, '每个非 hero 区块都能从侧栏直达', unreached.length ? '进不去：' + unreached.map((s) => s.id).join(',') : '');
const mismatched = navs.filter((n) => n.href !== n.nav);
ok(!mismatched.length, 'href 与 data-nav 一致（不会出现点了跳别处）', mismatched.map((n) => n.nav).join(','));

console.log('\n[3] 顺序一致：侧栏看到的就是页面滚过看到的');
const domOrder = withId.map((s) => s.id).filter((id) => id !== 'hero');
const navOrder = navs.map((n) => n.nav);
ok(
  JSON.stringify(domOrder) === JSON.stringify(navOrder),
  '导航顺序 == 页面区块顺序',
  `导航：${navOrder.join(' → ')}\n      页面：${domOrder.join(' → ')}`
);

console.log('\n[4] 名字对得上：导航项叫的和区块标题是一回事');
const clean = (s) => (s || '').replace(/[\s（）()🔌★◎▤⤓▦↑⊞◇⇢✓⇄]/g, '');
const nameBad = [];
for (const n of navs) {
  const sec = secs.find((s) => s.id === n.nav);
  if (!sec || !sec.h2) continue;
  const h2c = clean(sec.h2);
  const cands = [clean(n.text), clean(n.title)].filter(Boolean);
  const hit = cands.some((c) => h2c.includes(c) || c.includes(h2c));
  if (!hit) nameBad.push(`${n.nav}：导航「${n.text}」vs 页面「${sec.h2}」`);
}
ok(!nameBad.length, '每个导航项的名字都和区块标题对得上', nameBad.length ? '\n      ' + nameBad.join('\n      ') : '');

console.log('\n[5] 站内锚点无死链');
const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
const allIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const dead = [...new Set(anchors)].filter((a) => a !== 'top' && !allIds.has(a));
ok(!dead.length, `页面内 ${new Set(anchors).size} 个锚点全部有落点`, dead.length ? '死链：#' + dead.join(', #') : '');

console.log(`\n${fail ? '✗' : '✓'} 导航自检：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
