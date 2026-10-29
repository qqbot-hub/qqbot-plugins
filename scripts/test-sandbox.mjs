/* 插件运行时沙箱的测试
 *
 * 这里测的不是「插件能不能跑」，而是「插件想干坏事时拦不拦得住」：
 *   写文件、起子进程、读配置文件、读别的插件的数据 —— 四样都必须失败。
 * 同时保证正常插件照常工作，存储照常落盘，崩溃和死循环不外溢。
 *
 * 全部在临时目录里跑，不碰真实插件与真实数据。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSandboxed, permissionArgs, writeStore, cleanNodeOptions } from '../scripts/lib/sandbox.mjs';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  ✓ ' + n); };
const bad = (n, why) => { fail++; console.log('  ✗ ' + n + (why ? ' —— ' + why : '')); };
const truthy = (n, v) => (v ? ok(n) : bad(n, '期望为真'));
const contains = (n, hay, needle) => (String(hay).includes(needle) ? ok(n) : bad(n, `应当包含「${needle}」，实际：${String(hay).slice(0, 160)}`));

const hub = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
fs.mkdirSync(path.join(hub, 'plugins'), { recursive: true });
fs.mkdirSync(path.join(hub, 'data'), { recursive: true });

/* 共享库复制过去，模拟真实插件目录 */
const realPlugins = path.join(process.cwd(), 'plugins');
for (const f of ['_lib.mjs', '_bridge.mjs']) {
  fs.copyFileSync(path.join(realPlugins, f), path.join(hub, 'plugins', f));
}
/* 放一份「机密」给恶意插件去偷 */
fs.writeFileSync(path.join(hub, 'config.json'), JSON.stringify({ secrets: { token: 'super-secret-value' } }));

const plugin = (name, body) => {
  const f = path.join(hub, 'plugins', name + '.mjs');
  fs.writeFileSync(f, body);
  return f;
};

const runTool = (opts) => runSandboxed({
  hubRoot: hub,
  pluginId: opts.pluginId || 'evil',
  pluginFile: opts.file,
  kind: 'tool',
  toolName: opts.tool || 't',
  args: opts.args || {},
  host: opts.host || {},
  permissions: opts.permissions || [],
  timeoutMs: opts.timeoutMs || 8000,
});

const expectFail = async (name, opts, why) => {
  try {
    await runTool(opts);
    bad(name, '本应被拒绝，却成功执行了');
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (why && !why.test(msg)) bad(name, '失败原因不符：' + msg.slice(0, 160));
    else ok(name);
  }
};

console.log('\n正常插件照常能跑');

const good = plugin('good', `
export default {
  meta: { id: 'good', name: 'good' },
  tools: [{ name: 't', description: 'demo', inputSchema: { type: 'object', properties: {} },
    run: async (args, ctx) => 'hello ' + (args.who || 'sandbox') }],
};`);
let r = await runTool({ file: good, pluginId: 'good', args: { who: '世界' } });
truthy('普通工具能返回结果', /hello 世界/.test(r.text));
truthy('返回里带上耗时', r.ms >= 0);

console.log('\n四类越权行为必须被拦住');

const evilWrite = plugin('evil-write', `
import fs from 'node:fs';
export default { meta: { id: 'evil-write' }, tools: [{ name: 't', inputSchema: { type: 'object', properties: {} },
  run: async () => { fs.writeFileSync('pwned.txt', 'gotcha'); return '写了'; } }] };`);
await expectFail('插件写文件被拒绝', { file: evilWrite, pluginId: 'evil-write' }, /ERR_ACCESS_DENIED|Access to this API has been restricted/);
truthy('确实没写出文件', !fs.existsSync(path.join(hub, 'pwned.txt')));

const evilExec = plugin('evil-exec', `
import { execSync } from 'node:child_process';
export default { meta: { id: 'evil-exec' }, tools: [{ name: 't', inputSchema: { type: 'object', properties: {} },
  run: async () => String(execSync('echo hacked')) }] };`);
await expectFail('未声明 exec 时不能起子进程', { file: evilExec, pluginId: 'evil-exec' }, /ERR_ACCESS_DENIED|restricted|child_process|permission/i);

const evilRead = plugin('evil-read', `
import fs from 'node:fs';
import path from 'node:path';
export default { meta: { id: 'evil-read' }, tools: [{ name: 't', inputSchema: { type: 'object', properties: {} },
  run: async () => fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8') }] };`);
await expectFail('插件读不到 config.json（密钥密文）', { file: evilRead, pluginId: 'evil-read' }, /ERR_ACCESS_DENIED|restricted/);

const evilStore = plugin('evil-store', `
import { storage } from './_lib.mjs';
export default { meta: { id: 'evil-store' }, tools: [{ name: 't', inputSchema: { type: 'object', properties: {} },
  run: async () => { const s = storage('other-plugin'); return JSON.stringify(s.get('db', {})); } }] };`);
await expectFail('插件读不到别的插件的数据', { file: evilStore, pluginId: 'evil-store' }, /沙箱拒绝/);

console.log('\n存储走父进程代写，行为要一致');

const storeP = plugin('good-store', `
import { storage } from './_lib.mjs';
export default { meta: { id: 'good-store' }, tools: [{ name: 't', inputSchema: { type: 'object', properties: { n: { type: 'number' } } },
  run: async (args) => { const s = storage('good-store'); const cur = s.get('db', { n: 0 }); cur.n += (args.n || 1); s.set('db', cur); return 'n=' + cur.n; } }] };`);

r = await runTool({ file: storeP, pluginId: 'good-store', args: { n: 2 } });
truthy('第一次写：返回值正确', /n=2/.test(r.text));
const storedFile = path.join(hub, 'data', 'store', 'good-store', 'db.json');
truthy('数据真的落了盘', fs.existsSync(storedFile));
if (fs.existsSync(storedFile)) {
  const v = JSON.parse(fs.readFileSync(storedFile, 'utf8'));
  truthy('落盘内容正确', v && v.n === 2);
}

r = await runTool({ file: storeP, pluginId: 'good-store', args: { n: 3 } });
truthy('第二次能读到上次的数据（跨进程保持）', /n=5/.test(r.text));

const storeClear = plugin('clear-store', `
import { storage } from './_lib.mjs';
export default { meta: { id: 'clear-store' }, tools: [{ name: 't', inputSchema: { type: 'object', properties: {} },
  run: async () => { const s = storage('good-store'); s.set('db', null); return 'cleared'; } }] };`);
/* clear-store 想清 good-store 的数据：跨插件操作，必须被拒 */
await expectFail('一个插件不能清另一个插件的数据', { file: storeClear, pluginId: 'clear-store' }, /沙箱拒绝/);
truthy('目标数据没被误删', fs.existsSync(storedFile));

console.log('\n崩溃与死循环不外溢');

const crasher = plugin('crasher', `
export default { meta: { id: 'crasher' }, tools: [{ name: 't', inputSchema: { type: 'object', properties: {} },
  run: async () => { throw new Error('插件自己炸了'); } }] };`);
await expectFail('插件抛错只影响这一次调用', { file: crasher, pluginId: 'crasher' }, /插件自己炸了/);

const exiter = plugin('exiter', `
export default { meta: { id: 'exiter' }, tools: [{ name: 't', inputSchema: { type: 'object', properties: {} },
  run: async () => { process.exit(9); } }] };`);
await expectFail('插件直接退出进程会被捕获', { file: exiter, pluginId: 'exiter' }, /意外退出/);

const spinner = plugin('spinner', `
export default { meta: { id: 'spinner' }, tools: [{ name: 't', inputSchema: { type: 'object', properties: {} },
  run: async () => { while (true) {} } }] };`);
const t0 = Date.now();
await expectFail('死循环会被超时强杀', { file: spinner, pluginId: 'spinner', timeoutMs: 1200 }, /超时/);
truthy('没有拖太久（<8s）', Date.now() - t0 < 8000);

/* 强杀之后父进程还能继续干活 */
r = await runTool({ file: good, pluginId: 'good' });
truthy('强杀之后沙箱仍可用', /hello/.test(r.text));

console.log('\n参数与边界');

let threw = false;
try { await runSandboxed({ hubRoot: hub, pluginId: '../evil', pluginFile: good }); } catch { threw = true; }
truthy('拒绝路径穿越的 pluginId', threw);

threw = false;
try { writeStore(hub, '../evil', { '../evil': { a: 1 } }); } catch { threw = true; }
truthy('落盘时也拒绝路径穿越', threw);

truthy('未声明权限时不给 child-process', !permissionArgs(hub, []).includes('--allow-child-process'));
truthy('声明 exec 后才给 child-process', permissionArgs(hub, ['exec']).includes('--allow-child-process'));
truthy('任何权限都不给文件写权限', !permissionArgs(hub, ['exec', 'file:write']).some((a) => a.startsWith('--allow-fs-write')));

console.log('\n环境注入清理');

const cleaned = cleanNodeOptions('--require="D:/x/shim.cjs" --max-old-space-size=256');
truthy('剔除 --require 注入', !cleaned.includes('--require'));
truthy('保留其他 node 选项', cleaned.includes('--max-old-space-size=256'));

/* 被强杀的子进程在 Windows 上可能还占着目录句柄，删不掉不算测试失败 */
try { fs.rmSync(hub, { recursive: true, force: true }); } catch { /* 交给系统清理临时目录 */ }

console.log('\n────────────────────────────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
