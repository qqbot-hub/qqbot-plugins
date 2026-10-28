/* ============================================================
 * sync-ecosystem.mjs —— 把三个生态的插件索引拉到 data/sources/ecosystem.json
 *
 *   node scripts/sync-ecosystem.mjs            拉全部源
 *   node scripts/sync-ecosystem.mjs --status   只看缓存状态，不联网
 *
 * 这个文件**要入库**：它是目录数据（谁家有哪些插件），不是本机状态。
 * ============================================================ */
import { syncAll, readEcosystem, isStale } from './lib/ecosystem.mjs';

const argv = process.argv.slice(2);
const statusOnly = argv.includes('--status');

function human(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

if (statusOnly) {
  const doc = readEcosystem();
  if (!doc.fetchedAt) {
    console.log('还没有缓存。跑一次 node scripts/sync-ecosystem.mjs');
    process.exit(0);
  }
  console.log(`缓存时间：${doc.fetchedAt}${isStale() ? '（已过期，建议刷新）' : ''}`);
  console.log(`条目总数：${human(doc.items.length)}`);
  for (const [k, v] of Object.entries(doc.sources)) {
    console.log(`  ${k.padEnd(9)} ${v.ok ? human(v.count) + ' 条' : '失败：' + v.error}`);
  }
  const byFw = {};
  for (const it of doc.items) byFw[it.framework] = (byFw[it.framework] || 0) + 1;
  console.log('按框架：', byFw);
  process.exit(0);
}

console.log('开始拉取生态插件索引…');
const t0 = Date.now();
const doc = await syncAll();
console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
for (const [k, v] of Object.entries(doc.sources)) {
  console.log(`  ${k.padEnd(9)} ${v.ok ? human(v.count) + ' 条' : '失败：' + v.error}`);
}
console.log(`合计 ${human(doc.items.length)} 条 → data/sources/ecosystem.json`);
if (doc.errors.length) {
  console.log('\n有源失败（其余照常可用）：');
  for (const e of doc.errors) console.log('  - ' + e);
  process.exitCode = doc.items.length ? 0 : 1;
}
