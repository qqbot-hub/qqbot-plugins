/* ============================================================
 * _satori.mjs —— Satori 协议适配器（Koishi 生态通用协议）
 *
 * 为什么要有它：
 *   现在插件只能跑在 OneBot v11 协议端（SnowLuma / NapCat / LLOneBot）。
 *   想跑在 Koishi、Chronocat 这类 Satori 生态里，就得有第二个协议后端。
 *   这个文件把 Satori 的 HTTP API 翻译成和 _bridge.mjs 完全相同的一套语义方法，
 *   插件一个字都不用改就能换协议。
 *
 * 协议事实（均来自本机真实运行的服务端，不是凭印象写的）：
 *   · 路由：POST {base}/v1/{resource}.{method}，例如 /v1/message.create
 *     —— 注意 meta 也是 POST；用 GET 会拿到 405 "Please use POST method"
 *   · 鉴权：Authorization: Bearer <token>，不符时返回 403 "invalid token"
 *   · 选实例：必须带 satori-platform + satori-user-id 两个请求头，
 *     服务端靠它们找到对应 bot；找不到返回 403 "login not found"
 *   · 方法不存在：404 "method not found"
 *   · 成功：200 + JSON（键名 snake_case）
 *   · 失败响应是纯文本，不是 JSON —— 所以不能无脑 res.json()
 *
 * 能力差异（Satori 原生没有的动作，这里明确报 unsupported，绝不假装成功）：
 *   没有：群公告、群名片、专属头衔、全员禁言、设置管理员
 *   有：发文本、发图片、发语音元素、撤回、禁言成员、踢人、群列表、成员列表
 * ============================================================ */
'use strict';

/* Satori 里没有等价 API 的动作，统一在这里登记，调用时直接报"不支持" */
const UNSUPPORTED = {
  setNotice: 'Satori 协议没有群公告接口（OneBot v11 独有）',
  getNotice: 'Satori 协议没有读群公告接口（OneBot v11 独有）',
  setCard: 'Satori 协议没有设置群名片接口（OneBot v11 独有）',
  setTitle: 'Satori 协议没有专属头衔接口（OneBot v11 独有）',
  wholeBan: 'Satori 协议没有全员禁言接口；只有按成员禁言 guild.member.mute',
  setAdmin: 'Satori 只有 guild.member.role.set（需要角色 ID），与 OneBot 的 set_group_admin 不等价，未实现',
};

export const SATORI_CAPABILITIES = {
  sendText: true,
  sendImage: true,
  sendRecord: true,
  recall: true,
  banMember: true,
  kickMember: true,
  groupList: true,
  memberList: true,
  setCard: false,
  setTitle: false,
  wholeBan: false,
  setAdmin: false,
  notice: false,
};

function fail(action, msg, extra) {
  const e = new Error('satori.' + action + ' 失败：' + msg);
  e.action = 'satori.' + action;
  e.protocol = 'satori';
  if (extra) Object.assign(e, extra);
  return e;
}

/** 把纯文本错误体翻译成可读原因，并归类 */
function classify(status, body) {
  const t = String(body || '').trim();
  if (/invalid token/i.test(t)) return { kind: 'auth', msg: '令牌不对（服务端返回 invalid token），检查 Satori 的 token 配置' };
  if (/login not found/i.test(t)) {
    return {
      kind: 'notlogin',
      msg: '服务端没有这个实例（login not found）：检查 platform 与 selfId 是否填对，以及该适配器是否已登录',
    };
  }
  if (/method not found/i.test(t)) return { kind: 'unsupported', msg: '服务端没有这个方法（method not found）' };
  if (status === 403) return { kind: 'auth', msg: '被拒绝（403）：' + (t.slice(0, 120) || '无说明') };
  if (status === 404) return { kind: 'unsupported', msg: '接口不存在（404）：' + (t.slice(0, 120) || '检查 baseUrl 与 path 配置') };
  if (status === 405) return { kind: 'business', msg: '请求方法不对（405）：Satori 全部用 POST' };
  return { kind: 'business', msg: `返回 ${status}：` + (t.slice(0, 200) || '无内容') };
}

/* 元素构造：Satori 的消息内容是元素数组 */
export const el = {
  text: (content) => ({ type: 'text', attrs: { content: String(content) } }),
  image: (src) => ({ type: 'img', attrs: { src } }),
  audio: (src) => ({ type: 'audio', attrs: { src } }),
  at: (id) => ({ type: 'at', attrs: { id: String(id) } }),
};

/**
 * createSatori(cfg)
 *   baseUrl  例如 http://127.0.0.1:5141/satori（含 path）
 *   token    Satori 服务端配置的 token
 *   platform 例如 onebot / qq（服务端 satori-platform 头）
 *   selfId   实例账号（服务端 satori-user-id 头）
 */
export function createSatori(cfg = {}) {
  const base = String(cfg.baseUrl || cfg.httpUrl || 'http://127.0.0.1:5141/satori').replace(/\/+$/, '');
  const token = String(cfg.token || cfg.accessToken || '');
  const platform = String(cfg.platform || 'onebot');
  let selfId = String(cfg.selfId || '');
  const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 20000;

  /** 调一个 Satori API：POST {base}/v1/{name} */
  async function api(name, params = {}) {
    const url = base + '/v1/' + name;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    /* 这两个头是 Satori 选实例的关键，漏了必然 login not found */
    headers['satori-platform'] = platform;
    if (selfId) headers['satori-user-id'] = selfId;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(params), signal: ac.signal });
    } catch (e) {
      if (ac.signal.aborted) {
        throw fail(name, `超时（${timeoutMs}ms 没响应）——Satori 服务端可能卡住，或地址不对：${base}`, { kind: 'timeout' });
      }
      const offline = /ECONNREFUSED|fetch failed/i.test(e.message || '');
      throw fail(name, offline
        ? `连不上 Satori 服务端（${base}）：确认服务端在跑、端口和 path 没写错`
        : e.message, { kind: 'offline' });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    if (!res.ok) {
      const c = classify(res.status, text);
      throw fail(name, c.msg, { kind: c.kind, status: res.status });
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch {
      throw fail(name, '返回的不是 JSON：' + text.slice(0, 160), { kind: 'business' });
    }
  }

  /* ---------- 体检 ---------- */
  async function probe() {
    const t0 = Date.now();
    try {
      const r = await api('login.get', {});
      const latencyMs = Date.now() - t0;
      const login = (r && (r.login || r)) || {};
      const user = login.user || {};
      return {
        ok: true,
        impl: 'satori',
        app: 'Satori（' + (login.adapter || platform) + ' 适配器）',
        version: '',
        selfId: user.id != null ? String(user.id) : (selfId || null),
        nickname: user.name || user.nick || '',
        latencyMs,
        platform: login.platform || platform,
      };
    } catch (e) {
      return { ok: false, kind: e.kind || 'business', error: e.message, latencyMs: Date.now() - t0 };
    }
  }

  let hb = { at: 0, value: null };
  async function heartbeat(opts = {}) {
    const ttlMs = Number(opts.ttlMs != null ? opts.ttlMs : cfg.hbTtlMs) || 5000;
    if (!opts.force && hb.value && Date.now() - hb.at < ttlMs) return hb.value;
    const p = await probe();
    const value = {
      online: !!p.ok,
      protocol: 'satori',
      impl: 'satori',
      app: p.app || 'Satori',
      version: '',
      selfId: p.selfId ?? null,
      nickname: p.nickname || '',
      latencyMs: p.latencyMs,
      checkedAt: new Date().toISOString(),
      httpUrl: base,
      platform,
      hasToken: !!token,
      error: p.ok ? '' : p.error,
      errorKind: p.ok ? '' : p.kind,
    };
    hb = { at: Date.now(), value };
    return value;
  }

  /** 统一动作调用：供上层按语义调用，也可直接传 Satori 原始方法名 */
  async function raw(name, params = {}) {
    return api(name, params);
  }

  /* ---------- 发消息：群与私聊在 Satori 里都是 channel_id ---------- */
  function channelOf(target) {
    if (!target) throw fail('channel', '缺少发送目标');
    const id = target.channelId || target.groupId || target.userId;
    if (id == null || id === '') throw fail('channel', '缺少 channelId / groupId / userId');
    return String(id);
  }

  async function sendElements(target, elements, action) {
    const channelId = channelOf(target);
    const r = await api('message.create', { channel_id: channelId, content: elements });
    return {
      messageId: (r && (r.id || r.messageId)) || null,
      channelId,
      raw: r,
    };
  }

  /* 把 Satori 的 Login 结果归一成 OneBot 形状，让上层代码无感 */
  async function getLoginInfo() {
    const r = await api('login.get', {});
    const login = (r && (r.login || r)) || {};
    const user = login.user || {};
    const id = user.id != null ? String(user.id) : (selfId || null);
    if (id) selfId = id;
    return { selfId: id, nickname: user.name || user.nick || '', raw: r };
  }

  return {
    protocol: 'satori',
    capabilities: SATORI_CAPABILITIES,
    raw,
    api,
    probe,
    heartbeat,
    getLoginInfo,
    base,
    platform,
    selfId,
    hasToken: !!token,

    /* 发消息 */
    sendText: (target, text) => sendElements(target, [el.text(text)], 'sendText'),
    sendImage: (target, base64OrUrl) => {
      const src = /^(data:|https?:)/.test(String(base64OrUrl))
        ? String(base64OrUrl)
        : 'data:image/png;base64,' + base64OrUrl;
      return sendElements(target, [el.image(src)], 'sendImage');
    },
    sendRecord: (target, base64OrUrl) => {
      const src = /^(data:|https?:)/.test(String(base64OrUrl))
        ? String(base64OrUrl)
        : 'data:audio/silk;base64,' + base64OrUrl;
      return sendElements(target, [el.audio(src)], 'sendRecord');
    },

    /* 群 / 频道 */
    async listGroups() {
      const r = await api('guild.list', {});
      const items = (r && (r.data || r.list || r)) || [];
      return Array.isArray(items) ? items.map((g) => ({ groupId: g.id, name: g.name || '' })) : [];
    },
    getGroupInfo: async (groupId) => {
      const r = await api('guild.get', { guild_id: String(groupId) });
      return (r && (r.guild || r)) || r;
    },
    async getMembers(groupId) {
      const r = await api('guild.member.list', { guild_id: String(groupId) });
      const items = (r && (r.data || r)) || [];
      return Array.isArray(items)
        ? items.map((m) => ({
          userId: (m.user && m.user.id) || m.id,
          nickname: (m.user && (m.user.name || m.user.nick)) || m.nick || '',
          card: m.nick || '',
          role: m.roles && m.roles.length ? 'admin' : 'member',
        }))
        : [];
    },
    getMember: async (groupId, userId) => {
      const r = await api('guild.member.get', { guild_id: String(groupId), user_id: String(userId) });
      return (r && (r.member || r)) || r;
    },

    /* 群管理 */
    banMember: (groupId, userId, minutes) => api('guild.member.mute', {
      guild_id: String(groupId),
      user_id: String(userId),
      /* Satori 的 duration 单位是毫秒，OneBot 是秒 —— 这里必须换 */
      duration: Math.max(0, Math.round(Number(minutes) * 60000)),
    }),
    kickMember: (groupId, userId, permanent = false) => api('guild.member.kick', {
      guild_id: String(groupId),
      user_id: String(userId),
      permanent: !!permanent,
    }),
    recall: (messageId, channelId) => api('message.delete', {
      message_id: String(messageId),
      ...(channelId != null ? { channel_id: String(channelId) } : {}),
    }),

    /* 明确不支持的动作：报清楚，不假装成功 */
    setNotice: () => { throw fail('setNotice', UNSUPPORTED.setNotice, { kind: 'unsupported' }); },
    getNotice: () => { throw fail('getNotice', UNSUPPORTED.getNotice, { kind: 'unsupported' }); },
    setCard: () => { throw fail('setCard', UNSUPPORTED.setCard, { kind: 'unsupported' }); },
    setTitle: () => { throw fail('setTitle', UNSUPPORTED.setTitle, { kind: 'unsupported' }); },
    wholeBan: () => { throw fail('wholeBan', UNSUPPORTED.wholeBan, { kind: 'unsupported' }); },
    setAdmin: () => { throw fail('setAdmin', UNSUPPORTED.setAdmin, { kind: 'unsupported' }); },
    unsupported: UNSUPPORTED,
  };
}
