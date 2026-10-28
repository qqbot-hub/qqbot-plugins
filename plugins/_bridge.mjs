/* ============================================================
 * _bridge.mjs —— 协议端适配层（插件只依赖这里，不直接拼 HTTP）
 *
 * 为什么要这一层：
 *   插件真正依赖的不是"qq-bridge 还是 SurfCore"，而是**协议端的 OneBot v11 接口**。
 *   桥接（qq-bridge / SurfCore）属于 DSH 那一侧，换掉它们不影响插件；
 *   真正会影响插件的，是底层跑的是 SnowLuma / NapCat / Lagrange / LLOneBot / go-cqhttp。
 *   它们都讲 OneBot v11，但细节有差异：
 *     · 鉴权：Authorization: Bearer xxx  /  ?access_token=xxx  /  完全不校验
 *     · 响应：{status:'ok'|'failed', data}  /  {retcode:0, data}  /  裸数据
 *     · 动作名：同一件事，个别实现叫 _send_group_notice / send_group_notice
 *   这一层就是把这些差异吃掉，插件只写 ctx.bridge.banMember(...) 这种语义调用。
 *
 * 三层结构：
 *   ① createOneBot(cfg)   低层：拼 URL、带鉴权、归一化响应、动作名兜底、错误分类
 *   ② createBridge(cfg)   高层：语义方法（禁言/踢人/发语音…），插件只用这层
 *   ③ heartbeat/probe     体检：协议端在线？是哪个实现？QQ 号昵称？延迟多少？
 * ============================================================ */
'use strict';

/* ---------- 常见协议端预设：只用来"猜"端口和鉴权习惯，猜错了也能手动改 ---------- */
export const IMPLS = {
  snowluma: { label: 'SnowLuma', httpUrl: 'http://127.0.0.1:3000', authMode: 'header', note: 'HTTP:3000 / WS:3001' },
  napcat:   { label: 'NapCatQQ', httpUrl: 'http://127.0.0.1:3000', authMode: 'header', note: 'HTTP:3000（默认）' },
  llonebot: { label: 'LLOneBot', httpUrl: 'http://127.0.0.1:3000', authMode: 'header', note: 'HTTP:3000（默认）' },
  lagrange: { label: 'Lagrange.OneBot', httpUrl: 'http://127.0.0.1:8080', authMode: 'header', note: 'HTTP 端口可配，常见 8080' },
  gocqhttp: { label: 'go-cqhttp', httpUrl: 'http://127.0.0.1:5700', authMode: 'header', note: 'HTTP:5700（默认）' },
  other:    { label: '其他 OneBot v11 实现', httpUrl: 'http://127.0.0.1:3000', authMode: 'header', note: '按你的配置填' },
};

/* ============================================================
 * 动作名差异表
 *
 * 绝大多数动作名是 OneBot v11 标准，各实现一致，不需要在这里登记。
 * 只登记**确实存在不同写法**的动作；适配层按顺序尝试，第一个通的就记住，
 * 之后同类调用直接用它（见 createOneBot 里的 aliasCache）。
 *
 * 新增一条差异的规矩：
 *   1. 只写实现方文档/源码里真实存在的名字，不要凭感觉造；
 *   2. verified: true 表示在本项目 test-bridge.mjs 的假协议端里验证过序列，
 *      没验证过的写 false，docs/PROTOCOLS.md 里也要标明；
 *   3. 顺序 = 尝试顺序，把覆盖面最广的放前面。
 * ============================================================ */
export const ACTION_ALIASES = {
  /* 发群公告 */
  send_notice: {
    candidates: ['_send_group_notice', 'send_group_notice', 'set_group_notice'],
    verified: true,
    note: 'go-cqhttp / NapCat / LLOneBot 系用下划线开头；部分实现只认不带下划线的名字',
  },
  /* 读群公告 */
  get_notice: {
    candidates: ['_get_group_notice', 'get_group_notice'],
    verified: false,
    note: '与发公告同理，下划线 / 无下划线两种写法',
  },
};

/* ---------- 错误分类：把各种失败收敛成 5 类，上层按类型决定要不要换动作名重试 ---------- */
const UNSUPPORTED_RE = /未知|不支持|没有实现|not\s*found|unknown\s*action|unsupported|retcode\s*(1404|404)/i;

export function classifyError(e) {
  const text = String((e && e.message) || e || '');
  const action = (e && e.action) || '';
  if (/连不上协议端|ECONNREFUSED|fetch failed/i.test(text)) return { kind: 'offline', action, text };
  if (/AccessToken|被拒绝（40[13]）/.test(text)) return { kind: 'auth', action, text };
  if (/超时|aborted|timeout/i.test(text)) return { kind: 'timeout', action, text };
  if (UNSUPPORTED_RE.test(text)) return { kind: 'unsupported', action, text };
  return { kind: 'business', action, text };
}

/* ---------- 响应归一化：三种常见形态都吃掉 ---------- */
function fail(action, msg, extra) {
  const e = new Error(action + ' 失败：' + msg);
  e.action = action;
  if (extra) Object.assign(e, extra);
  return e;
}

function unwrap(data, action) {
  if (data == null) return null;
  /* OneBot v11 标准：{status:'ok'|'failed', retcode, data, wording} */
  if (typeof data === 'object' && ('status' in data || 'retcode' in data)) {
    const ok = data.status === 'ok' || data.status === 'async' || data.retcode === 0 || data.retcode === 1;
    if (!ok) {
      const why = data.wording || data.message || data.msg || ('retcode ' + data.retcode);
      throw fail(action, why, { retcode: data.retcode });
    }
    return 'data' in data ? data.data : data;
  }
  /* 裸数据（个别实现直接返回结果） */
  return data;
}

/* ---------- 从版本信息里认实现名 ---------- */
export function detectImpl(blob, hint) {
  const s = String(blob || '').toLowerCase();
  if (/snowluma/.test(s)) return 'snowluma';
  if (/napcat/.test(s)) return 'napcat';
  if (/lagrange/.test(s)) return 'lagrange';
  if (/llonebot|\bllob\b/.test(s)) return 'llonebot';
  if (/go-?cqhttp|\bgocq\b/.test(s)) return 'gocqhttp';
  const h = String(hint || '').toLowerCase();
  return IMPLS[h] && h !== 'other' ? h : 'onebot';
}

/* ============================================================
 * createOneBot(cfg) —— 低层客户端，ctx.onebot(action, params) 就是它
 * ============================================================ */
export function createOneBot(cfg = {}) {
  const base = String(cfg.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg.accessToken || '');
  const authMode = String(cfg.authMode || 'header'); // header | query | none
  const prefix = String(cfg.pathPrefix || '').replace(/\/+$/, ''); // 有些实现挂在 /onebot 下
  const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 20000;

  /* 动作名记忆：canonical -> 已确认可用的真实动作名 */
  const aliasCache = new Map();
  /* 已知不可用的名字：canonical -> Set(名字)，避免每次调用都白撞一遍 */
  const aliasDead = new Map();

  async function call(action, params = {}) {
    let url = base + prefix + '/' + action;
    const headers = { 'Content-Type': 'application/json' };
    if (token && authMode === 'header') headers.Authorization = 'Bearer ' + token;
    if (token && authMode === 'query') url += (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(params), signal: ac.signal });
    } catch (e) {
      /* 把底层网络错误翻译成"人话"，模型和用户都能看懂 */
      if (ac.signal.aborted) {
        throw fail(action, `超时（${timeoutMs}ms 没响应）——协议端可能卡住了，或接口地址不对：${base}${prefix}`, { kind: 'timeout' });
      }
      const hint = /ECONNREFUSED|fetch failed/i.test(e.message || '')
        ? `连不上协议端（${base}${prefix}）：确认协议端已启动、HTTP 接口已开启、地址和端口没写错`
        : e.message;
      throw fail(action, hint, { kind: 'offline' });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw fail(action, `被拒绝（${res.status}）：AccessToken 不对或没带，检查协议端的鉴权设置`, { kind: 'auth', status: res.status });
    }
    let data;
    try { data = JSON.parse(text); } catch {
      if (!res.ok) throw fail(action, `返回 ${res.status}：` + text.slice(0, 120), { status: res.status });
      return text;
    }
    return unwrap(data, action);
  }

  /* 按"已记住的名字 → 未试过的名字 → 全部重来"排顺序 */
  function order(action, candidates) {
    const cached = aliasCache.get(action);
    const dead = aliasDead.get(action) || new Set();
    const rest = candidates.filter((n) => n !== cached && !dead.has(n));
    if (cached) return [cached, ...rest];
    return rest.length ? rest : candidates.slice();
  }

  /* 对外只认语义名（如 send_notice），差异在这里吃掉 */
  async function onebot(action, params = {}) {
    const spec = ACTION_ALIASES[action];
    if (!spec) return call(action, params);

    const list = order(action, spec.candidates);
    let lastErr = null;
    for (const name of list) {
      try {
        const r = await call(name, params);
        aliasCache.set(action, name);
        aliasDead.delete(action);
        return r;
      } catch (e) {
        lastErr = e;
        const { kind } = classifyError(e);
        if (kind !== 'unsupported') throw e;      // 网络/鉴权/业务错，换名字也没用
        if (!aliasDead.has(action)) aliasDead.set(action, new Set());
        aliasDead.get(action).add(name);
      }
    }
    throw fail(action, `当前协议端没有这个动作（已依次试过 ${list.join(' → ')}）`
      + (lastErr ? '；最后一次报错：' + lastErr.message : ''));
  }

  /* 探测：拿登录信息和版本，用来识别当前跑的是哪个实现 */
  async function probe() {
    const t0 = Date.now();
    try {
      const info = await onebot('get_login_info', {});
      const latencyMs = Date.now() - t0;
      const ver = await onebot('get_version_info', {}).catch(() => null);
      const v = (ver && ver.data) || ver || {};
      const app = String(v.app_name || v.app_full_name || v.impl || '');
      const version = String(v.app_version || v.version || '');
      return {
        ok: true,
        impl: detectImpl(app + ' ' + version, cfg.impl),
        app: app || IMPLS[detectImpl('', cfg.impl)]?.label || 'OneBot v11',
        version,
        selfId: (info && (info.user_id ?? info.uin)) ?? null,
        nickname: (info && (info.nickname || info.nick)) || '',
        latencyMs,
      };
    } catch (e) {
      const { kind } = classifyError(e);
      return { ok: false, kind, error: e.message, latencyMs: Date.now() - t0 };
    }
  }

  /* 心跳：带 TTL 缓存，页面/体检频繁调用不会把协议端打爆 */
  let hb = { at: 0, value: null };
  async function heartbeat(opts = {}) {
    const ttlMs = Number(opts.ttlMs != null ? opts.ttlMs : cfg.hbTtlMs) || 5000;
    if (!opts.force && hb.value && Date.now() - hb.at < ttlMs) return hb.value;
    const p = await probe();
    const value = {
      online: !!p.ok,
      impl: p.impl || 'unknown',
      app: p.app || '',
      version: p.version || '',
      selfId: p.selfId ?? null,
      nickname: p.nickname || '',
      latencyMs: p.latencyMs,
      checkedAt: new Date().toISOString(),
      httpUrl: base + prefix,
      authMode,
      hasToken: !!token,
      error: p.ok ? '' : p.error,
    };
    hb = { at: Date.now(), value };
    return value;
  }

  return {
    onebot, probe, heartbeat, base, prefix, authMode,
    hasToken: !!token,
    /* 给测试和排查用：当前记住了哪些动作名 */
    aliases: () => Object.fromEntries(aliasCache),
  };
}

/* ============================================================
 * createBridge(cfg) —— 高层语义接口，插件优先用它
 *   优点：动作名、参数、错误处理都收敛在这里，换协议端不用改插件
 * ============================================================ */
export function createBridge(cfg = {}) {
  return makeBridge(createOneBot(cfg));
}

/** 用任意 raw 函数包一层高层接口（测试环境 / 只有 ctx.onebot 时用） */
export function wrapOnebot(fn) {
  return makeBridge({
    onebot: fn,
    probe: async () => ({ ok: false, error: '未提供探测能力' }),
    heartbeat: async () => ({ online: false, error: '未提供探测能力', checkedAt: new Date().toISOString() }),
  });
}

function makeBridge(client) {
  const onebot = client.onebot;
  const seg = (type, data) => [{ type, data }];

  return {
    /* 基础 */
    raw: onebot,
    probe: client.probe,
    heartbeat: client.heartbeat || (async () => ({ online: false, error: '未提供探测能力' })),
    selfId: null,

    /* 主动拿一次登录信息，顺便把 selfId 记住 */
    async getLoginInfo() {
      const info = await onebot('get_login_info', {});
      const selfId = (info && (info.user_id ?? info.uin)) ?? null;
      if (selfId != null) this.selfId = selfId;
      return { selfId, nickname: (info && (info.nickname || info.nick)) || '', raw: info };
    },

    /* 发消息 —— text / image(b64) / record(b64) */
    async sendText(target, text) {
      const msg = [{ type: 'text', data: { text: String(text) } }];
      return target.groupId
        ? onebot('send_group_msg', { group_id: target.groupId, message: msg })
        : onebot('send_private_msg', { user_id: target.userId, message: msg });
    },
    async sendImage(target, base64) {
      const msg = seg('image', { file: 'base64://' + base64 });
      return target.groupId
        ? onebot('send_group_msg', { group_id: target.groupId, message: msg })
        : onebot('send_private_msg', { user_id: target.userId, message: msg });
    },
    async sendRecord(target, base64) {
      const msg = seg('record', { file: 'base64://' + base64 });
      return target.groupId
        ? onebot('send_group_msg', { group_id: target.groupId, message: msg })
        : onebot('send_private_msg', { user_id: target.userId, message: msg });
    },

    /* 群成员 */
    getGroupInfo: (groupId) => onebot('get_group_info', { group_id: groupId }),
    getMembers: (groupId) => onebot('get_group_member_list', { group_id: groupId }),
    getMember: (groupId, userId) => onebot('get_group_member_info', { group_id: groupId, user_id: userId }),

    /* 群管理 */
    banMember: (groupId, userId, minutes) =>
      onebot('set_group_ban', { group_id: groupId, user_id: userId, duration: Math.round(minutes * 60) }),
    kickMember: (groupId, userId, rejectAdd = false) =>
      onebot('set_group_kick', { group_id: groupId, user_id: userId, reject_add_request: rejectAdd }),
    recall: (messageId) => onebot('delete_msg', { message_id: messageId }),
    setCard: (groupId, userId, card) => onebot('set_group_card', { group_id: groupId, user_id: userId, card }),
    setTitle: (groupId, userId, title) =>
      onebot('set_group_special_title', { group_id: groupId, user_id: userId, special_title: title }),
    wholeBan: (groupId, enable) => onebot('set_group_whole_ban', { group_id: groupId, enable: !!enable }),
    setAdmin: (groupId, userId, enable) =>
      onebot('set_group_admin', { group_id: groupId, user_id: userId, enable: !!enable }),

    /* 群公告：动作名差异交给 ACTION_ALIASES，这里只写语义 */
    setNotice: (groupId, content) => onebot('send_notice', { group_id: groupId, content }),
    getNotice: (groupId) => onebot('get_notice', { group_id: groupId }),
  };
}
