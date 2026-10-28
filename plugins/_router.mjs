/* ============================================================
 * _router.mjs —— 消息接入与分发（统一插件抽象层的「收消息」这一半）
 *
 * 之前这套东西只有「发」没有「收」：插件都是等 AI 来调的工具，
 * 群里的消息一条也进不来，所谓「插件响应消息」是空的。
 * 这个文件补的就是这一环：
 *
 *   QQ 消息事件 ──► 归一化成统一 msg 结构 ──► 按插件声明的 handlers 匹配
 *                                            ──► 权限判断 ──► 限流 ──► 执行
 *
 * 归一化的意义：OneBot v11 和 Satori 的事件字段完全不一样（group_id / channel.id，
 * raw_message / message.content，sender.role / member.roles）。插件作者只认一种
 * msg 结构，换协议不用改代码 —— 这就是「统一抽象层」在收消息侧的落地。
 *
 * 明确不做的事（写在代码里，免得以后有人以为它做了）：
 *   · 不替你把消息存库；要存档自己在新插件里做
 *   · 不做 NLP/意图识别；匹配就是正则/前缀/函数，简单可预期
 *   · 不伪造权限：拿不到 role 就当普通成员，绝不默认给管理员
 * ============================================================ */
'use strict';

/** OneBot v11 消息段 → 纯文本 */
function onebotText(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message
    .filter((s) => s && s.type === 'text' && s.data)
    .map((s) => String(s.data.text || ''))
    .join('');
}

/** 这条消息里有没有 @ 机器人自己 */
function onebotAtMe(message, selfId) {
  if (!Array.isArray(message) || !selfId) return false;
  return message.some((s) => s && s.type === 'at' && String(s.data && s.data.qq) === String(selfId));
}

/**
 * OneBot v11 事件 → 统一 msg；不是消息事件返回 null。
 * 字段依据 OneBot v11 标准（post_type/message_type/sender.role），不是我编的。
 */
export function normalizeOneBot(raw, fallbackSelfId = '') {
  if (!raw || raw.post_type !== 'message') return null;
  const selfId = String(raw.self_id || fallbackSelfId || '');
  const userId = String(raw.user_id || '');
  if (!userId) return null;
  /* 自己发的消息不要回灌，否则插件自己回一句就被自己再触发一次，直接死循环 */
  if (selfId && userId === selfId) return null;
  const isGroup = raw.message_type === 'group';
  const sender = raw.sender || {};
  return {
    protocol: 'onebot',
    kind: 'message',
    scope: isGroup ? 'group' : 'private',
    groupId: isGroup ? String(raw.group_id || '') : '',
    userId,
    nickname: String(sender.card || sender.nickname || ''),
    role: String(sender.role || 'member'),
    text: onebotText(raw.message),
    atMe: onebotAtMe(raw.message, selfId),
    messageId: String(raw.message_id || ''),
    selfId,
    time: Number(raw.time || 0) * 1000 || Date.now(),
    raw,
  };
}

/** Satori 事件 → 统一 msg；不是消息事件返回 null */
export function normalizeSatori(raw, fallbackSelfId = '') {
  if (!raw || !raw.type) return null;
  if (raw.type !== 'message-created') return null;
  const selfId = String(raw.self_id || fallbackSelfId || '');
  const user = raw.user || {};
  const userId = String(user.id || '');
  if (!userId) return null;
  if (selfId && userId === selfId) return null;
  const channel = raw.channel || {};
  /* Satori: channel.type 0=私聊 1=群/文本频道 */
  const isDirect = Number(channel.type) === 0;
  const member = raw.member || {};
  const roles = Array.isArray(member.roles) ? member.roles.map(String) : [];
  /* 只有明确带 owner/admin 角色才给对应权限，其余一律 member（不猜、不放宽） */
  const role = roles.includes('owner') ? 'owner' : (roles.includes('admin') ? 'admin' : 'member');
  const message = raw.message || {};
  return {
    protocol: 'satori',
    kind: 'message',
    scope: isDirect ? 'private' : 'group',
    groupId: isDirect ? '' : String(channel.id || ''),
    userId,
    nickname: String(user.name || member.name || ''),
    role,
    text: String(message.content || ''),
    atMe: /<at\s+id="[^"]*"\s*\/?>/.test(String(message.content || '')) && String(message.content).includes(String(selfId)),
    messageId: String(message.id || ''),
    selfId,
    time: Number(raw.timestamp || 0) || Date.now(),
    raw,
  };
}

/** 按协议自动选归一化函数 */
export function normalizeEvent(raw, protocol, selfId = '') {
  return protocol === 'satori' ? normalizeSatori(raw, selfId) : normalizeOneBot(raw, selfId);
}

/**
 * 匹配规则：支持四种写法，都是显式的，不做「智能猜测」
 *   match: /^ping$/i           正则
 *   match: 'ping'              等价于「去掉首尾空格后完全相等」
 *   match: { prefix: '/ping' } 前缀
 *   match: (msg) => boolean    自己的函数，最灵活
 */
export function matchHandler(handler, msg) {
  const m = handler && handler.match;
  if (m == null) return false;
  if (m instanceof RegExp) return m.test(msg.text);
  if (typeof m === 'function') {
    try { return !!m(msg); } catch { return false; }
  }
  if (typeof m === 'string') return msg.text.trim() === m;
  if (typeof m === 'object') {
    if (m.prefix != null) return msg.text.trim().startsWith(String(m.prefix));
    if (m.contains != null) return msg.text.includes(String(m.contains));
    if (m.exact != null) return msg.text.trim() === String(m.exact);
  }
  return false;
}

const ROLE_RANK = { member: 0, admin: 1, owner: 2 };

/**
 * 权限判断。need 默认 everyone。
 * 拿不到角色信息时按 member 算 —— 宁可少给权限，也不能默认放宽。
 */
export function checkPermission(need, msg) {
  const req = String(need || 'everyone');
  if (req === 'everyone') return { ok: true };
  const have = ROLE_RANK[String(msg.role || 'member')] ?? 0;
  const want = ROLE_RANK[req] ?? 0;
  if (have >= want) return { ok: true };
  const label = { admin: '管理员', owner: '群主' }[req] || req;
  return { ok: false, why: `需要${label}权限（当前身份：${msg.role || 'member'}）` };
}

/**
 * 创建路由器。
 *   listHandlers()  → [{ pluginId, handler }]  每次分发时实时取，插件启停立刻生效
 *   send(target, text) → Promise 发消息（由调用方注入协议客户端）
 */
export function createRouter({ listHandlers, send, log = () => {} } = {}) {
  const stats = {
    received: 0,
    matched: 0,
    handled: 0,
    denied: 0,
    throttled: 0,
    failed: 0,
    lastAt: 0,
    lastError: '',
    recent: [],                 // 最近 20 条触发记录，给前端「运行监控」看
  };
  const cooldowns = new Map();  // key: pluginId#handlerId#target#user → 到期时间

  const note = (rec) => {
    stats.recent.unshift(Object.assign({ at: Date.now() }, rec));
    if (stats.recent.length > 20) stats.recent.length = 20;
  };

  async function dispatch(msg) {
    if (!msg) return { ok: false, reason: 'not-a-message' };
    stats.received += 1;
    stats.lastAt = Date.now();
    let handlers = [];
    try { handlers = (listHandlers && listHandlers()) || []; } catch (e) {
      stats.lastError = '读取插件处理器失败：' + e.message;
      return { ok: false, reason: 'list-failed' };
    }
    const target = msg.scope === 'group' ? msg.groupId : msg.userId;
    const hits = [];

    for (const item of handlers) {
      const h = item && item.handler;
      if (!h) continue;
      /* 作用域：插件可以声明只听群消息或只听私聊 */
      const scopes = h.scope ? [].concat(h.scope) : ['group', 'private'];
      if (!scopes.includes(msg.scope)) continue;
      /* 只听 @我 的插件（官方机器人路线常见要求） */
      if (h.requireAtMe && !msg.atMe) continue;
      if (!matchHandler(h, msg)) continue;
      stats.matched += 1;
      const perm = checkPermission(h.permission, msg);
      if (!perm.ok) {
        stats.denied += 1;
        note({ plugin: item.pluginId, handler: h.id || '', scope: msg.scope, user: msg.userId, denied: perm.why });
        continue;
      }
      const ck = [item.pluginId, h.id || '', target, msg.userId].join('#');
      const cd = Number(h.cooldownMs || 0);
      if (cd > 0) {
        const until = cooldowns.get(ck) || 0;
        if (Date.now() < until) {
          stats.throttled += 1;
          continue;
        }
        cooldowns.set(ck, Date.now() + cd);
      }
      hits.push({ item, h });
    }

    if (!hits.length) return { ok: true, handled: 0 };

    /* 依次执行：一个插件抛错不影响后面的插件收消息 */
    for (const { item, h } of hits) {
      const api = {
        reply: (text) => send({ scope: msg.scope, groupId: msg.groupId, userId: msg.userId }, String(text)),
        sendText: (to, text) => send(to, String(text)),
        cfg: h.__cfg || {},
        log: (m) => log(`[${item.pluginId}${h.id ? '/' + h.id : ''}] ${m}`),
      };
      try {
        await h.run(msg, api);
        stats.handled += 1;
        note({ plugin: item.pluginId, handler: h.id || '', scope: msg.scope, user: msg.userId, ok: true });
      } catch (e) {
        stats.failed += 1;
        stats.lastError = `${item.pluginId}/${h.id || ''}: ${e.message}`;
        note({ plugin: item.pluginId, handler: h.id || '', scope: msg.scope, user: msg.userId, error: e.message });
        log(`处理消息失败（${item.pluginId}）：${e.message}`);
      }
    }
    return { ok: true, handled: hits.length };
  }

  return { dispatch, stats };
}
