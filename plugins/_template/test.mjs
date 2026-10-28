/* ============================================================
 * test.mjs —— 模板插件自检（不连 QQ 也能跑）
 *
 *   node plugins/_template/test.mjs
 *
 * 它干的事：造几条假消息 → 走真实的归一化 + 匹配 + 权限 + 限流 → 打印结果。
 * 这样你改完 match 规则，不用真开 QQ 就能确认逻辑对不对。
 * ============================================================ */
'use strict';

import { normalizeOneBot, createRouter, matchHandler, checkPermission } from '../_router.mjs';
import plugin from './index.mjs';

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label); }
};

/* 造一条收到消息的假事件（字段照 OneBot v11 标准来） */
const makeEvent = (text, { group = '10001', user = '20002', role = 'member', self = '99999', at = false } = {}) => ({
  post_type: 'message',
  message_type: group ? 'group' : 'private',
  group_id: group ? Number(group) : undefined,
  user_id: Number(user),
  self_id: Number(self),
  message_id: 30003,
  raw_message: text,
  time: Math.floor(Date.now() / 1000),
  sender: { user_id: Number(user), nickname: '测试群友', role },
  message: at
    ? [{ type: 'at', data: { qq: self } }, { type: 'text', data: { text: ' ' + text } }]
    : [{ type: 'text', data: { text } }],
});

console.log('1) 归一化');
const m1 = normalizeOneBot(makeEvent('/hi'));
ok(m1 && m1.text === '/hi', '从 OneBot 事件取出文本');
ok(m1.scope === 'group' && m1.groupId === '10001', '群消息的 scope/groupId 正确');
ok(normalizeOneBot(makeEvent('自己说的', { user: '99999' })) === null, '机器人自己发的消息被过滤（防自触发）');
const m2 = normalizeOneBot(makeEvent('hi', { group: '', user: '20002' }));
ok(m2.scope === 'private' && m2.groupId === '', '私聊消息识别为 private');
ok(normalizeOneBot(makeEvent('@机器人 你好呢', { at: true })).atMe === true, '识别出 @机器人');

console.log('2) 匹配规则');
const [hHi, hAt, hAdmin] = plugin.handlers;
ok(matchHandler(hHi, m1) === true, '{prefix:"/hi"} 命中 /hi');
ok(matchHandler(hHi, normalizeOneBot(makeEvent('你好'))) === false, '{prefix:"/hi"} 不误命中普通聊天');
ok(matchHandler({ match: /^ping$/i }, normalizeOneBot(makeEvent('PING'))) === true, '正则匹配不区分大小写');
ok(matchHandler({ match: 'ping' }, normalizeOneBot(makeEvent(' ping '))) === true, '字符串匹配忽略首尾空格');

console.log('3) 权限判断');
ok(checkPermission('everyone', m1).ok === true, 'everyone 放行');
ok(checkPermission('admin', m1).ok === false, '普通成员用 admin 命令被拦');
ok(checkPermission('admin', { role: 'admin' }).ok === true, '管理员放行');
ok(checkPermission('admin', { role: 'owner' }).ok === true, '群主也满足 admin');
ok(checkPermission('owner', { role: 'admin' }).ok === false, '管理员不满足 owner（不越权）');

console.log('4) 分发与回复');
const replies = [];
const rt = createRouter({
  listHandlers: () => plugin.handlers.map((h) => ({ pluginId: plugin.meta.id, handler: Object.assign({ __cfg: { greeting: '在的' } }, h) })),
  send: async (target, text) => { replies.push({ target, text }); return { ok: true }; },
});
await rt.dispatch(normalizeOneBot(makeEvent('/hi')));
ok(replies.length === 1, '/hi 触发一次回复');
ok(replies[0].target.groupId === '10001', '回复回到原群');
ok(replies[0].text.includes('在的'), '回复用了配置里的打招呼语');

replies.length = 0;
await rt.dispatch(normalizeOneBot(makeEvent('/hi')));          // 同一个人立刻再发一次
ok(replies.length === 0, '限流生效（3 秒内重复触发被忽略）');

replies.length = 0;
await rt.dispatch(normalizeOneBot(makeEvent('/mute-test', { role: 'member' })));
ok(replies.length === 0, '普通成员触发管理命令没有任何反应（被权限拦下）');
await rt.dispatch(normalizeOneBot(makeEvent('/mute-test', { role: 'admin', user: '55555' })));
ok(replies.length === 1, '管理员触发管理命令成功');

replies.length = 0;
await rt.dispatch(normalizeOneBot(makeEvent('随便聊聊')));
ok(replies.length === 0, '不匹配任何规则的闲聊不会触发');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
