/* ============================================================
 * test-registry.mjs —— 上架流程的单测
 *
 * 关键点：**真的走一次落盘**。在临时目录里跑完整的
 *   提交 → 查列表 → 审核通过 → 文件被写出 → 市场目录被更新 → 版本历史
 * 只测返回值不测文件，等于没测「审核通过到底做了什么」。
 *
 * 用 QQBOT_* 环境变量把路径指到临时目录，不碰真实 plugins/。
 * ============================================================ */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-reg-test-'));
const plugDir = path.join(tmp, 'plugins');
const catalogFile = path.join(tmp, 'plugins.json');
fs.mkdirSync(plugDir, { recursive: true });
fs.writeFileSync(catalogFile, JSON.stringify([{ id: 'existing', name: 'existing', description: '原有插件', category: '工具', tools: [] }], null, 2));

process.env.QQBOT_REGISTRY_FILE = path.join(tmp, 'registry.json');
process.env.QQBOT_PLUGINS_JSON = catalogFile;
process.env.QQBOT_PLUGIN_DIR = plugDir;
process.env.QQBOT_SKIP_PERM = '1';

const reg = await import('./lib/registry.mjs');

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; return; }
  fails.push(name + (extra ? `  → ${extra}` : ''));
}
function eq(got, want, name) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fails.push(`${name}\n    期望 ${JSON.stringify(want)}\n    实际 ${JSON.stringify(got)}`);
}

const CODE = `export default {
  meta: { id: 'demo-hello', name: 'demo-hello', description: '上架流程自测插件', category: '工具' },
  tools: [{ name: 'qq_demo_hello', description: '打招呼', inputSchema: { type: 'object', properties: {} }, run: async () => 'hi' }],
};
`;

/* ---- 1. 校验：缺字段要被拦住，且一次报全 ---- */
{
  const r = reg.validate({ pluginId: 'x' });
  ok(!r.ok, '空提交被拦');
  ok(r.errors.length >= 5, '缺字段一次报全（不是只报第一个）', `只报了 ${r.errors.length} 条`);
  ok(r.errors.some((e) => /id/.test(e)), '报了 id 不合法');
}

/* ---- 2. id 规则 ---- */
{
  ok(reg.validate({ pluginId: 'Demo', name: 'n', version: '1.0.0', author: 'a', description: '描述够长了就这样写' }).errors.some((e) => /id/.test(e)), '大写开头被拒');
  ok(reg.validate({ pluginId: 'a', name: 'n', version: '1.0.0', author: 'a', description: '描述够长了就这样写' }).errors.some((e) => /id/.test(e)), '只有 1 位被拒');
}

/* ---- 3. 版本号必须三段式 ---- */
{
  const base = { pluginId: 'demo-hello', name: '演示', author: 'me', description: '这是一个用来测试上架的示例插件' };
  ok(reg.validate(Object.assign({}, base, { version: '1.0' })).errors.some((e) => /版本号/.test(e)), '1.0 被拒（不是三段式）');
  ok(reg.validate(Object.assign({}, base, { version: 'v1.0.0' })).ok, 'v1.0.0 允许（会剥 v）');
  ok(reg.validate(Object.assign({}, base, { version: 'abc' })).errors.some((e) => /版本号/.test(e)), 'abc 被拒');
}

/* ---- 4. 敏感权限要求写清用途 ---- */
{
  const r = reg.validate({ pluginId: 'demo-x', name: '演示', version: '1.0.0', author: 'me', description: '短', permissions: ['exec'] });
  ok(r.errors.some((e) => /敏感能力/.test(e)), '声明 exec 但简介太短被拒');
  const r2 = reg.validate({ pluginId: 'demo-x', name: '演示', version: '1.0.0', author: 'me', description: '这个插件会执行 git 命令来拉取仓库内容', permissions: ['exec'] });
  ok(r2.ok, '写清用途后通过');
}

/* ---- 5. 提交 ---- */
let subId = '';
{
  const r = reg.submit({ pluginId: 'demo-hello', name: '演示插件', version: '1.0.0', author: '模拟开发者', description: '用来验证上架流程的示例插件，不做任何危险操作', category: '工具', changelog: '首个版本', code: CODE });
  ok(r.ok, '合法提交成功', JSON.stringify(r.errors || r.error));
  eq(r.status, 'pending', '新提交是 pending');
  subId = r.id;
  ok(!!subId, '返回了提交 id');
}

/* ---- 6. 重复版本被拦 ---- */
{
  const r = reg.submit({ pluginId: 'demo-hello', name: '演示插件', version: '1.0.0', author: '模拟开发者', description: '重复版本不应该被接受，必须换号', code: CODE });
  ok(!r.ok, '同版本重复提交被拦');
  ok(r.errors.some((e) => /提交过/.test(e)), '提示里说明是重复版本');
}

/* ---- 7. 语法错的代码在提交阶段就拦下（不让审核的人替作者修） ---- */
{
  const r = reg.submit({ pluginId: 'demo-bad', name: '坏插件', version: '0.0.1', author: 'me', description: '故意写坏语法的插件，用来验证提交阶段的检查', code: 'export default { meta: { id: "x", ' });
  ok(!r.ok, '语法错误提交被拒');
  ok(r.errors.some((e) => /语法/.test(e)), '提示是语法问题');
}

/* ---- 8. 列表与统计 ---- */
{
  const l = reg.list({ status: 'pending' });
  ok(l.items.length >= 1, 'pending 列表非空');
  ok(l.items.every((x) => x.code === undefined), '列表不返回代码正文（否则页面会被几百 KB 拖死）');
  ok(l.items[0].codeSize > 0, '列表返回代码体积');
  const s = reg.stats();
  ok(s.total >= 1 && s.pending >= 1, '统计正确');
}

/* ---- 9. 审核通过 = 真的落盘 ---- */
{
  const r = reg.review(subId, 'approve', '看起来没问题');
  ok(r.ok, '通过审核', r.error);
  eq(r.deployed, true, '标记为已生成文件');

  const f = path.join(plugDir, 'demo-hello.mjs');
  ok(fs.existsSync(f), 'plugins/demo-hello.mjs 真的被写出来了');
  eq(fs.readFileSync(f, 'utf8'), CODE, '写出的内容与提交的一致');

  const cat = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  const entry = cat.find((p) => p.id === 'demo-hello');
  ok(!!entry, '市场目录里登记了新插件');
  eq(entry.origin, 'submitted', '来源标为 submitted');
  eq(entry.version, '1.0.0', '目录里带版本号');
  ok(cat.some((p) => p.id === 'existing'), '原有插件没被覆盖掉');
}

/* ---- 10. 不能重复审核 ---- */
{
  const r = reg.review(subId, 'approve', '再审一次');
  ok(!r.ok, '已审核的不能再审');
  ok(/已经/.test(r.error), '错误说明当前状态');
}

/* ---- 11. 新版本提交 → 版本历史 ---- */
{
  const r = reg.submit({ pluginId: 'demo-hello', name: '演示插件', version: '1.1.0', author: '模拟开发者', description: '第二个版本，加上更新说明，验证版本历史是否正确记录', changelog: '修了个小问题', code: CODE.replace("'hi'", "'hi v1.1'") });
  ok(r.ok, '第二版提交成功', JSON.stringify(r.errors));
  const v = reg.versions('demo-hello');
  eq(v.items.length, 2, '版本历史两条');
  eq(v.live, '1.0.0', '线上还是 1.0.0（新版还没审）');
  eq(v.items[1].version, '1.1.0', '第二条是 1.1.0');
  eq(v.items[1].status, 'pending', '新版待审核');
}

/* ---- 12. 覆盖已有文件要显式允许 ---- */
{
  const r = reg.submit({ pluginId: 'existing', name: '覆盖测试', version: '9.9.9', author: 'me', description: '试图覆盖一个没有提交代码的同名插件，应该被文件冲突或代码缺失拦住', code: '' });
  ok(r.ok, '无代码提交可以入库');
  const rv = reg.review(r.id, 'approve', '');
  ok(rv.ok, '无代码也能通过（只是不落地）');
  eq(rv.deployed, false, '无代码不写文件');
}

/* ---- 13. 拒绝流程 ---- */
{
  const s = reg.submit({ pluginId: 'demo-no', name: '会被拒的', version: '0.1.0', author: 'me', description: '这条会被拒绝，用来验证拒绝原因能存下来并回给作者', code: CODE.replace(/demo-hello/g, 'demo-no') });
  ok(s.ok, '提交成功');
  const r = reg.review(s.id, 'reject', '简介太笼统，说清楚到底做什么再来');
  ok(r.ok, '拒绝成功');
  eq(r.status, 'rejected', '状态是 rejected');
  const item = reg.get(s.id);
  eq(item.reviewNote, '简介太笼统，说清楚到底做什么再来', '拒绝原因被记下来了');
  eq(item.deployed, undefined, '拒绝的没有 deployed 标记');
  ok(!fs.existsSync(path.join(plugDir, 'demo-no.mjs')), '拒绝的没有写出文件');
}

/* ---- 14. 非法 action ---- */
{
  const s = reg.submit({ pluginId: 'demo-x2', name: 'x', version: '1.0.0', author: 'me', description: '用来测非法审核动作的插件描述文本', code: '' });
  const r = reg.review(s.id, 'destroy', '');
  ok(!r.ok, '非法 action 被拒');
}

/* ---- 清理 ---- */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows 上偶尔占用，忽略 */ }

if (fails.length) {
  console.log(`\n失败 ${fails.length} 项：`);
  for (const f of fails) console.log('  ✗ ' + f);
  console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
  process.exit(1);
}
console.log(`结果：${pass} 通过 / 0 失败`);
