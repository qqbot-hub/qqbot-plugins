/* ============================================================
 * test-methods.mjs —— Phase 1 的自检
 *
 * 跑法：node scripts/test-methods.mjs
 * 通过标准：全部 ok，任何一项 fail 都会以非 0 退出。
 *
 * 覆盖：
 *   1. methods.json 结构完整（10 条方法、字段齐全、id 唯一、链接可解析）
 *   2. 权限清单没有过期（跟 plugins/*.mjs 的源码哈希对得上）
 *   3. 兼容矩阵的逻辑（bridge 插件只兼容 OneBot v11 + DSH 宿主；纯本地多兼容官方通道）
 *   4. secrets 加密往返 + 日志脱敏（加密后不含明文，能解回来）
 *   5. compose/nonebot/koishi recipe 能被加载（结构对，不会一点就炸）
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

console.log('\n[1] methods.json 结构');
const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog', 'methods.json'), 'utf8'));
const methods = doc.methods || [];
ok(methods.length === 10, '10 条部署方法', `实际 ${methods.length}`);
ok(new Set(methods.map((m) => m.id)).size === methods.length, 'id 无重复');
const requiredFields = ['id', 'name', 'account', 'os', 'runtime', 'stack', 'protocols', 'host', 'pluginApi', 'ports', 'keyConfig', 'deploy', 'risks', 'links'];
const badField = methods.filter((m) => requiredFields.some((f) => !(f in m)));
ok(!badField.length, '每条方法字段齐全', badField.length ? '缺：' + badField.map((m) => m.id).join(',') : '');
ok(methods.every((m) => ['personal', 'official'].includes(m.account)), '账号类型只有 个人号/官方号');
const one = methods.filter((m) => m.deploy.level === 'oneclick');
ok(one.length >= 2, '至少 2 条真·一键部署（oneclick）', one.map((m) => m.id).join(', '));
ok(methods.filter((m) => m.deploy.verified).every((m) => m.deploy.verifiedNote), '标了"已验证"的方法都有验证记录');
ok(methods.filter((m) => !m.deploy.verified).every((m) => m.deploy.verifiedNote), '标了"未验证"的方法也写明原因');
const guideWithBtn = methods.filter((m) => m.deploy.level === 'guide' && m.deploy.recipe);
ok(!guideWithBtn.length, 'guide 级别的方法不给 recipe（避免假按钮）');
for (const m of methods) {
  if (m.deploy.compose) {
    const p = path.join(ROOT, m.deploy.compose);
    ok(fs.existsSync(p), `compose 文件存在：${m.deploy.compose}`);
  }
}

console.log('\n[2] 权限清单与源码同步');
const permsFile = path.join(ROOT, 'data', 'catalog', 'permissions.json');
const permsDoc = JSON.parse(fs.readFileSync(permsFile, 'utf8'));
const pluginFiles = fs.readdirSync(path.join(ROOT, 'plugins')).filter((f) => f.endsWith('.mjs') && !f.startsWith('_'));
ok(Object.keys(permsDoc.plugins).length === pluginFiles.length,
  `权限清单覆盖 ${pluginFiles.length} 个插件`, `实际 ${Object.keys(permsDoc.plugins).length}`);
const crypto = await import('node:crypto');
const stale = pluginFiles.filter((f) => {
  const id = f.replace(/\.mjs$/, '');
  const src = fs.readFileSync(path.join(ROOT, 'plugins', f), 'utf8');
  const hash = crypto.createHash('sha1').update(src).digest('hex').slice(0, 12);
  return permsDoc.sourceHashes[id] !== hash;
});
ok(!stale.length, '权限清单没有过期', stale.length ? '过期：' + stale.join(',') : 'node scripts/build-permissions.mjs 可更新');

console.log('\n[3] 兼容性矩阵逻辑');
const ml = await import('../scripts/lib/methods.mjs');
const lib = await import('../scripts/lib/paths.mjs');
void lib;
const bridgeCase = ml.pluginCompatMethods({ needsBridge: true }, methods);
const localCase = ml.pluginCompatMethods({ needsBridge: false }, methods);
ok(JSON.stringify(bridgeCase.methods) === JSON.stringify(['snowluma-dsh']),
  '要协议端的插件只兼容 snowluma-dsh', bridgeCase.methods.join(','));
ok(bridgeCase.methods.includes('snowluma-dsh') && !bridgeCase.methods.includes('dsh-official'),
  '官方通道（无 OneBot v11）装不了要协议端的插件');
ok(localCase.methods.includes('snowluma-dsh') && localCase.methods.includes('dsh-official'),
  '纯本地工具兼容所有 DSH 宿主方法', localCase.methods.join(','));
ok(!localCase.methods.some((id) => ['astrbot', 'koishi', 'nonebot'].some((k) => id.includes(k))),
  '本市场插件不能虚标进 AstrBot/Koishi/NoneBot');
const runtime = await ml.probeRuntime(true);
ok(runtime.node.ok, '本机 Node 可探测', runtime.node.version);
ok(typeof runtime.docker.ok === 'boolean', '本机 Docker 可探测', runtime.docker.ok ? runtime.docker.version : '未安装（如实上报）');
const compat = await ml.buildCompat();
ok(compat.methods.length === 10, 'buildCompat 输出 10 条');
ok(compat.methods.every((m) => typeof m.ready === 'boolean' && Array.isArray(m.missing)), '每条方法都给出本机可用性');

console.log('\n[3b] 主链路标记（SnowLuma + qq-bridge + DSH）');
const primaries = methods.filter((m) => m.primary);
ok(primaries.length === 1 && primaries[0].id === 'snowluma-dsh',
  '只有一条主链路，而且是 snowluma-dsh', primaries.map((m) => m.id).join(','));
ok(!!(primaries[0] && String(primaries[0].primaryNote || '').length > 10),
  '主链路写清了「为什么是主推」，不是空口推荐');
ok(compat.primaryMethodId === 'snowluma-dsh', 'buildCompat 暴露 primaryMethodId', compat.primaryMethodId);
ok(compat.methods[0].primary === true && compat.methods[0].id === 'snowluma-dsh',
  '主链路永远排第一（不依赖 JSON 书写顺序）', compat.methods[0].id);
ok(compat.methods.filter((m) => !m.primary).length === 9,
  '其他 9 条路线一条没少（只是排到后面）', `实际 ${compat.methods.filter((m) => !m.primary).length}`);
ok(bridgeCase.primary === true && localCase.primary === true,
  '兼容性结果带 primary 标记，插件卡片据此显示为主链路直连');
const officialOnly = ml.pluginCompatMethods({ needsBridge: false }, methods.filter((m) => m.account === 'official'));
ok(officialOnly.primary === false, '只走官方通道时不算主链路（不冒充）');

console.log('\n[4] secrets 加密与脱敏');
const sec = await import('../scripts/lib/secrets.mjs');
const plain = 'sk-test-1234567890-abcdef';
const enc = sec.encrypt(plain);
ok(sec.isEncrypted(enc) && !enc.includes(plain), '密文里不含明文');
ok(sec.decrypt(enc) === plain, '能解回原文');
ok(sec.decrypt('enc:v1:bad:bad:bad') === '', '坏密文解不出值（返回空，不崩）');
ok(sec.redact(`key=${plain} ok`, [plain]) === 'key=*** ok', '日志脱敏生效');

console.log('\n[5] 新 recipe 可加载');
const installer = await import('../scripts/installer.mjs');
for (const id of ['compose', 'nonebot', 'koishi']) {
  const r = await installer.loadRecipe(id).catch((e) => null);
  ok(!!r && Array.isArray(r.steps) && r.steps.length >= 3, `recipe ${id} 结构正确`, r ? `${r.steps.length} 步` : '加载失败');
}
ok(typeof installer.rollbackJob === 'function', 'installer 暴露 rollbackJob（回滚能力）');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
