/* ============================================================
 * test-router.mjs —— 消息路由层测试（plugins/_router.mjs）
 *
 *   node scripts/test-router.mjs
 *
 * 覆盖：两种协议的事件归一化、匹配规则、权限边界、限流、
 *       多插件互不影响、插件抛错不拖垮别人、统计计数。
 * 全部用假事件，不需要真 QQ。
 * ============================================================ */
'use strict';

import {
  normalizeOneBot, normalizeSatori, normalizeEvent,
  matchHandler, checkPermission, createRouter,
} from '../plugins/_router.mjs';

let pass = 0;
let fail = 0;
const eq = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log(`  ✗ ${label}（期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}）`); }
};
const truthy = (v, label) => eq(!!v, true, label);

/* ---------- 假事件 ---------- */
const obGroup = (text, opt = {}) => ({
  post_type: 'message', message_type: 'group', sub_type: 'normal',
  group_id: 123456, user_id: 10001, self_id: 99999, message_id: 55,
  raw_message: text, time: 1700000000,
  sender: { user_id: 10001, nickname: '小李', card: '', role: opt.role || 'member' },
  message: opt.at
    ? [{ type: 'at', data: { qq: 99999 } }, { type: 'text', data: { text } }]
    : [{ type: 'text', data: { text } }],
});
const obPrivate = (text) => ({
  post_type: 'message', message_type: 'private', sub_type: 'friend',
  user_id: 10001, self_id: 99999, message_id: 56, raw_message: text, time: 1700000000,
  sender: { user_id: 10001, nickname: '小李' },
  message: [{ type: 'text', data: { text } }],
});
const saGroup = (content, opt = {}) => ({
  id: 7, type: 'message-created', platform: 'onebot', self_id: '99999', timestamp: 1700000000,
  channel: { id: '123456', type: 1 },
  guild: { id: '123456' },
  user: { id: '10001', name: '小李' },
  member: { id: '10001', name: '小李', roles: opt.roles || [] },
  message: { id: 'm1', content },
});
const saDirect = (content) => ({
  id: 8, type: 'message-created', platform: 'onebot', self_id: '99999', timestamp: 1700000000,
  channel: { id: '10001', type: 0 },
  user: { id: '10001', name: '小李' },
  message: { id: 'm2', content },
});

console.log('1) OneBot 归一化');
const g = normalizeOneBot(obGroup('你好'));
eq(g.scope, 'group', '群消息 → scope=group');
eq(g.groupId, '123456', '群号转成字符串');
eq(g.userId, '10001', '用户号转成字符串');
eq(g.text, '你好', '文本从 message 段里拼出来');
eq(g.role, 'member', 'role 来自 sender.role');
eq(g.atMe, false, '没有 at 段 → atMe=false');
eq(g.messageId, '55', 'message_id 保留');
eq(normalizeOneBot(obGroup('在吗', { at: true })).atMe, true, '有 at 我的段 → atMe=true');
eq(normalizeOneBot(obGroup('hi', { role: 'admin' })).role, 'admin', '管理员身份被保留');
const pv = normalizeOneBot(obPrivate('悄悄话'));
eq(pv.scope, 'private', '私聊 → scope=private');
eq(pv.groupId, '', '私聊没有 groupId');
eq(normalizeOneBot({ ...obGroup('我自己的'), user_id: 99999 }), null, '自己发的消息被丢弃（防死循环）');
eq(normalizeOneBot({ post_type: 'notice', notice_type: 'group_increase' }), null, '非消息事件被丢弃');
eq(normalizeOneBot({ post_type: 'message', message_type: 'group' }), null, '没有 user_id 的脏事件被丢弃');
eq(normalizeOneBot({ ...obGroup('x'), message: '纯字符串' }).text, '纯字符串', 'message 是字符串时也能取文本');

console.log('2) Satori 归一化');
const sg = normalizeSatori(saGroup('你好'));
eq(sg.protocol, 'satori', 'protocol 标记为 satori');
eq(sg.scope, 'group', 'channel.type=1 → group');
eq(sg.groupId, '123456', '群号来自 channel.id');
eq(sg.text, '你好', '文本来自 message.content');
eq(sg.role, 'member', '没有角色 → member（不放大权限）');
eq(normalizeSatori(saGroup('x', { roles: ['admin'] })).role, 'admin', 'roles 含 admin → admin');
eq(normalizeSatori(saGroup('x', { roles: ['owner'] })).role, 'owner', 'roles 含 owner → owner');
const sd = normalizeSatori(saDirect('私聊'));
eq(sd.scope, 'private', 'channel.type=0 → private');
eq(sd.groupId, '', '私聊无 groupId');
eq(normalizeSatori({ type: 'message-created', self_id: '99999', user: { id: '99999' }, channel: { id: '1', type: 1 }, message: {} }), null, '自己发的消息被丢弃');
eq(normalizeSatori({ type: 'guild-added' }), null, '非消息事件被丢弃');
eq(normalizeSatori(saGroup('<at id="99999"/> 在吗')).atMe, true, 'content 里有 at 自己 → atMe=true');
eq(normalizeEvent(saGroup('x'), 'satori').protocol, 'satori', 'normalizeEvent 按协议派发（satori）');
eq(normalizeEvent(obGroup('x'), 'onebot').protocol, 'onebot', 'normalizeEvent 按协议派发（onebot）');

console.log('3) 匹配规则');
const msg = (text) => ({ text, scope: 'group', role: 'member', groupId: '1', userId: '2' });
eq(matchHandler({ match: /^\/ping$/ }, msg('/ping')), true, '正则命中');
eq(matchHandler({ match: /^\/ping$/ }, msg('/ping 啊')), false, '正则不命中');
eq(matchHandler({ match: 'ping' }, msg(' ping ')), true, '字符串完全相等（忽略首尾空格）');
eq(matchHandler({ match: { prefix: '/ping' } }, msg('/ping now')), true, '前缀命中');
eq(matchHandler({ match: { contains: 'ping' } }, msg('我要 ping 一下')), true, '包含命中');
eq(matchHandler({ match: (m) => m.text.length >= 3 }, msg('三个字')), true, '自定义函数命中');
eq(matchHandler({ match: () => { throw new Error('boom'); } }, msg('x')), false, '匹配函数抛错 → 当作不匹配（不崩路由）');
eq(matchHandler({}, msg('x')), false, '没声明 match → 不匹配');

console.log('4) 权限');
eq(checkPermission('everyone', { role: 'member' }).ok, true, 'everyone 放行所有人');
eq(checkPermission('admin', { role: 'member' }).ok, false, 'member 不满足 admin');
eq(checkPermission('admin', { role: 'admin' }).ok, true, 'admin 满足 admin');
eq(checkPermission('admin', { role: 'owner' }).ok, true, 'owner 也满足 admin');
eq(checkPermission('owner', { role: 'admin' }).ok, false, 'admin 不满足 owner');
eq(checkPermission('owner', { role: undefined }).ok, false, '拿不到角色时按最低权限算');

console.log('5) 分发');
const mkRouter = (handlers, sent) => createRouter({
  listHandlers: () => handlers,
  send: async (t, text) => { sent.push({ t, text }); return { ok: true }; },
});
{
  const sent = [];
  const rt = mkRouter([{ pluginId: 'a', handler: { id: 'p', match: { prefix: '/ping' }, run: async (m, api) => api.reply('pong') } }], sent);
  const r = await rt.dispatch(normalizeOneBot(obGroup('/ping')));
  eq(r.handled, 1, '命中并被处理');
  eq(sent.length, 1, '发出了一条回复');
  eq(sent[0].t.groupId, '123456', '回复回到原群');
}
{
  const sent = [];
  const rt = mkRouter([{ pluginId: 'a', handler: { id: 'p', match: { prefix: '/ping' }, scope: ['group'], run: async (m, api) => api.reply('x') } }], sent);
  await rt.dispatch(normalizeOneBot(obPrivate('/ping')));
  eq(sent.length, 0, '只声明 group 的插件收不到私聊');
}
{
  const sent = [];
  const rt = mkRouter([{ pluginId: 'a', handler: { id: 'p', match: () => true, requireAtMe: true, run: async (m, api) => api.reply('x') } }], sent);
  await rt.dispatch(normalizeOneBot(obGroup('没 @ 你')));
  eq(sent.length, 0, 'requireAtMe 时未 @ 不触发');
  await rt.dispatch(normalizeOneBot(obGroup('@ 你了', { at: true })));
  eq(sent.length, 1, 'requireAtMe 且 @ 了才触发');
}
{
  const sent = [];
  const rt = mkRouter([{ pluginId: 'a', handler: { id: 'p', match: { prefix: '/cd' }, cooldownMs: 60000, run: async (m, api) => api.reply('x') } }], sent);
  await rt.dispatch(normalizeOneBot(obGroup('/cd')));
  await rt.dispatch(normalizeOneBot(obGroup('/cd')));
  eq(sent.length, 1, '限流窗口内只执行一次');
  eq(rt.stats.throttled >= 1, true, '被限流的次数有统计');
}
{
  const sent = [];
  const rt = mkRouter([
    { pluginId: 'boom', handler: { id: 'b', match: () => true, run: async () => { throw new Error('插件炸了'); } } },
    { pluginId: 'ok', handler: { id: 'o', match: () => true, run: async (m, api) => api.reply('我还是好的') } },
  ], sent);
  await rt.dispatch(normalizeOneBot(obGroup('任意')));
  eq(sent.length, 1, '前面的插件抛错，后面的插件照样执行');
  eq(rt.stats.failed, 1, '失败次数有统计');
  truthy(rt.stats.lastError.includes('插件炸了'), '最后一次错误能说清是谁、什么问题');
}
{
  const sent = [];
  const rt = mkRouter([{ pluginId: 'a', handler: { id: 'd', match: () => true, permission: 'admin', run: async (m, api) => api.reply('x') } }], sent);
  await rt.dispatch(normalizeOneBot(obGroup('命令', { role: 'member' })));
  eq(sent.length, 0, '权限不够 → 不执行');
  eq(rt.stats.denied, 1, '被拒绝的次数有统计');
  await rt.dispatch(normalizeOneBot(obGroup('命令', { role: 'admin' })));
  eq(sent.length, 1, '管理员发同样的话就执行');
}
{
  const rt = mkRouter([], []);
  const r = await rt.dispatch(null);
  eq(r.ok, false, '空事件不当作消息处理');
  eq((await rt.dispatch(normalizeOneBot(obGroup('没人听')))).handled, 0, '没有插件匹配时返回 handled=0（不报错）');
  eq(rt.stats.received, 1, '空事件不计入 received（只统计真正的消息）');
}
{
  /* listHandlers 抛错（插件加载崩了）不能让整个路由挂掉 */
  const rt = createRouter({ listHandlers: () => { throw new Error('读插件失败'); }, send: async () => ({ ok: true }) });
  const r = await rt.dispatch(normalizeOneBot(obGroup('x')));
  eq(r.ok, false, '处理器列表读取失败时明确返回失败，而不是假装处理了');
  truthy(rt.stats.lastError.includes('读插件失败'), '记录读取失败的原因');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
