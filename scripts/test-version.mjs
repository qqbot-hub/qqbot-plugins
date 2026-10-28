/* ============================================================
 * test-version.mjs —— 版本比较与生态分类的单测
 *
 * 这两块最容易被"看起来对"骗过：字符串直接比大小，
 * 1.10.0 会被判成比 1.9.9 旧；pre-release 会被当成比正式版新。
 * 所以这里把边界情况逐条钉住。
 * ============================================================ */
import { normalizeVer, parseVer, cmpVer, isNewer, fmtVer, grabVersion } from './lib/version.mjs';

let pass = 0;
const fails = [];
function eq(got, want, name) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fails.push(`${name}\n    期望 ${JSON.stringify(want)}\n    实际 ${JSON.stringify(got)}`);
}
function ok(cond, name) {
  if (cond) { pass++; return; }
  fails.push(name);
}

/* ---- normalizeVer ---- */
eq(normalizeVer('1.2.3'), '1.2.3', '普通版本号原样');
eq(normalizeVer('v1.2.3'), '1.2.3', '剥掉 v 前缀');
eq(normalizeVer('V2.0'), '2.0', '大写 V 也剥');
eq(normalizeVer('^1.2.3'), '1.2.3', '剥掉 npm caret');
eq(normalizeVer('>=1.2.3'), '1.2.3', '剥掉比较符');
eq(normalizeVer(' 1.2.3 '), '1.2.3', '去空白');
eq(normalizeVer(''), '', '空字符串');
eq(normalizeVer(null), '', 'null 不炸');

/* ---- parseVer ---- */
eq(parseVer('1.2.3').nums, [1, 2, 3], '三段式');
eq(parseVer('1.2').nums, [1, 2, 0], '两段式补齐');
eq(parseVer('1').nums, [1, 0, 0], '单段补齐');
eq(parseVer('1.2.3rc1').pre, 'rc1', 'rc 作为 pre-release');
eq(parseVer('1.2.3-beta.1').pre, 'beta.1', 'beta 作为 pre-release');
eq(parseVer('1.2.3+build99').pre, '', 'build metadata 丢掉');
eq(parseVer('abc'), null, '非版本号返回 null');
eq(parseVer(''), null, '空串返回 null');

/* ---- cmpVer：字符串比较会错的地方 ---- */
eq(cmpVer('1.10.0', '1.9.9'), 1, '1.10.0 > 1.9.9（字符串比会判反）');
eq(cmpVer('1.9.9', '1.10.0'), -1, '反过来是 -1');
eq(cmpVer('2.0.0', '2.0.0'), 0, '相同为 0');
eq(cmpVer('v2.0.0', '2.0.0'), 0, '前缀不影响相等');
eq(cmpVer('1.0.0', '1.0.0-rc1'), 1, '正式版大于同号 rc');
eq(cmpVer('1.0.0-rc1', '1.0.0'), -1, 'rc 小于正式版');
eq(cmpVer('1.0.0-rc2', '1.0.0-rc1'), 1, 'rc2 大于 rc1');
eq(cmpVer('1.0.0-beta', '1.0.0-rc1'), -1, 'beta 小于 rc（字典序）');
eq(cmpVer('abc', '1.0.0'), null, '一侧解析不了返回 null');

/* ---- isNewer ---- */
ok(isNewer('0.5.0', '0.4.0'), '0.5.0 比 0.4.0 新');
ok(!isNewer('0.5.0', '0.5.0'), '同版本不算新');
ok(!isNewer('0.4.0', '0.5.0'), '旧版不算新');
ok(isNewer('1.0.0', ''), '没装过视为有新版本');
ok(isNewer('1.0.0', null), 'current 为 null 也视为可装');
ok(!isNewer('', '1.0.0'), 'latest 为空时绝不提示更新');
ok(!isNewer('abc', '1.0.0'), '比不了就不提示（宁可漏报）');

/* ---- fmtVer ---- */
eq(fmtVer('1.3.0'), 'v1.3.0', '展示带 v');
eq(fmtVer('v1.3.0'), 'v1.3.0', '不重复加 v');
eq(fmtVer(''), '', '空版本展示为空');

/* ---- grabVersion ---- */
eq(grabVersion('Name: x\nVersion: 2.7.8\n', 'Version'), '2.7.8', '从 pip show 输出抓版本');
eq(grabVersion('nothing here'), '', '抓不到返回空');
eq(grabVersion('v1.2.3 something'), '1.2.3', '从杂文本抓第一段版本');

/* ---- 生态分类（关键词是脏的，必须整词匹配） ---- */
const { classify } = await import('./lib/ecosystem.mjs');
eq(classify(['ChatGPT'], 'application'), 'AI', 'ChatGPT 关键词 → AI');
eq(classify(['chatbot'], 'application'), '功能', 'chatbot 不该被当成 AI（第一版就在这里误分类 436 条）');
eq(classify(['ai-chat'], 'application'), 'AI', '复合词拆开能命中 ai');
eq(classify(['qq-bot'], 'application'), 'QQ 适配', 'qq-bot → QQ 适配');
eq(classify([], 'adapter'), 'QQ 适配', 'type=adapter 兜底');
eq(classify([], 'application'), '功能', 'type=application 兜底');
eq(classify(['完全无关的词'], ''), '其它', '认不出来落其它');

/* ---- 结果 ---- */
if (fails.length) {
  console.log(`\n失败 ${fails.length} 项：`);
  for (const f of fails) console.log('  ✗ ' + f);
  console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
  process.exit(1);
}
console.log(`结果：${pass} 通过 / 0 失败`);
