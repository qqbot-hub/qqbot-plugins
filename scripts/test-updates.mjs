/* 插件更新检查的测试
 *
 * 重点不是「能查到最新版」，而是「查不到/读不到的时候别乱说」：
 *   - 读不到本机实际版本 → 必须 unknown，不许拿登记表凑一个「已是最新」
 *   - 远端查不到 → unknown，附原因
 * 读版本的三个分支用临时目录造，不碰真实 runtimes。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installedVersion, decideState } from '../scripts/lib/updates.mjs';

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log('  ✓ ' + name); };
const bad = (name, why) => { fail++; console.log('  ✗ ' + name + (why ? ' —— ' + why : '')); };
const eq = (name, got, want) => (String(got) === String(want) ? ok(name) : bad(name, `期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`));
const truthy = (name, got) => (got ? ok(name) : bad(name, '期望为真，实际 ' + JSON.stringify(got)));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-test-'));
const mk = (...p) => { const f = path.join(tmp, ...p); fs.mkdirSync(path.dirname(f), { recursive: true }); return f; };

console.log('\n读了本机真实版本');

/* Koishi：node_modules/<pkg>/package.json */
const kp = mk('koishi', 'node_modules', 'koishi-plugin-demo', 'package.json');
fs.writeFileSync(kp, JSON.stringify({ name: 'koishi-plugin-demo', version: '2.7.8' }));
let r = await installedVersion('koishi', { key: 'koishi-plugin-demo' }, tmp);
eq('koishi 从 package.json 读到 2.7.8', r.ver, '2.7.8');

r = await installedVersion('koishi', { key: 'koishi-plugin-missing' }, tmp);
eq('koishi 包不存在时版本为空', r.ver, '');
truthy('koishi 包不存在时给出原因', /node_modules/.test(r.error));

/* Koishi：package.json 里没有 version 字段 */
const kp2 = mk('koishi', 'node_modules', 'koishi-plugin-nover', 'package.json');
fs.writeFileSync(kp2, JSON.stringify({ name: 'koishi-plugin-nover' }));
r = await installedVersion('koishi', { key: 'koishi-plugin-nover' }, tmp);
eq('koishi 缺 version 字段时版本为空', r.ver, '');

/* AstrBot：metadata.yaml 的 version，带 v 前缀和行尾注释 */
const ap = mk('astrbot', 'data', 'plugins', 'helloworld', 'metadata.yaml');
fs.writeFileSync(ap, 'name: helloworld\ndisplay_name: helloworld\nversion: v1.3.0 # 插件版本号\nauthor: Soulter\n');
r = await installedVersion('astrbot', { key: 'helloworld' }, tmp);
eq('astrbot 读到 v1.3.0（去掉注释）', r.ver, 'v1.3.0');

const ap2 = mk('astrbot', 'data', 'plugins', 'noversion', 'metadata.yaml');
fs.writeFileSync(ap2, 'name: noversion\ndisplay_name: noversion\n');
r = await installedVersion('astrbot', { key: 'noversion' }, tmp);
eq('astrbot 没写 version 时版本为空', r.ver, '');
truthy('astrbot 没写 version 时给出原因', /没写 version/.test(r.error));

r = await installedVersion('astrbot', { key: 'nope' }, tmp);
truthy('astrbot 插件目录不存在时给出原因', /metadata\.yaml/.test(r.error));

/* NoneBot：没有 venv 时直接说清楚，不要去跑不存在的 python */
r = await installedVersion('nonebot', { key: 'nonebot-plugin-apscheduler' }, tmp);
eq('nonebot 无 venv 时版本为空', r.ver, '');
truthy('nonebot 无 venv 时原因提到 venv', /venv/.test(r.error));

r = await installedVersion('weird', { key: 'x' }, tmp);
truthy('未知生态返回原因', /未知生态/.test(r.error));

console.log('\n三态判定：读不到就不许说「已是最新」');

let d = decideState({ latest: '1.0.0', current: '1.0.0', fromInstalled: true, recordVersion: '1.0.0' });
eq('真实版本相同 → latest', d.state, 'latest');
eq('真实版本相同 → 不算有更新', d.hasUpdate, false);

d = decideState({ latest: '1.2.0', current: '1.0.0', fromInstalled: true, recordVersion: '1.0.0' });
eq('真实版本更旧 → update', d.state, 'update');
eq('真实版本更旧 → hasUpdate 为真', d.hasUpdate, true);

d = decideState({ latest: '1.0.0', current: '', fromInstalled: false, instError: 'node_modules 里没有这个包', recordVersion: '1.0.0' });
eq('读不到本机版本 → unknown（不是 latest）', d.state, 'unknown');
eq('读不到本机版本 → 不报有更新', d.hasUpdate, false);
truthy('原因里带上登记表版本', /登记表记的是 1\.0\.0/.test(d.error));
truthy('原因里保留原始错误', /node_modules 里没有这个包/.test(d.error));

/* 这条是最关键的回归点：登记表恰好等于远端最新版时，最容易手滑说成「已是最新」 */
d = decideState({ latest: '9.9.9', current: '9.9.9', fromInstalled: false, instError: '本机没有 NoneBot 的 venv', recordVersion: '9.9.9' });
eq('登记表版本恰好等于最新版，但读不到实装 → 仍然 unknown', d.state, 'unknown');

d = decideState({ latest: '', current: '1.0.0', fromInstalled: true, fetchError: '仓库没有 release 也没有版本 tag' });
eq('远端查不到 → unknown', d.state, 'unknown');
truthy('远端查不到 → 带上原因', /没有 release/.test(d.error));

d = decideState({ latest: '1.5.0', current: '', fromInstalled: true });
eq('读到了安装现场但版本为空 → unknown', d.state, 'unknown');

/* 预发布版本方向：1.0.0-rc.1 不算比 1.0.0 新 */
d = decideState({ latest: '1.0.0-rc.1', current: '1.0.0', fromInstalled: true });
eq('rc 版本不当作更新', d.state, 'latest');

fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n────────────────────────────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
