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
 *     · 动作名：send_group_msg 之外，个别实现叫 send_group_msg_async 等
 *   这一层就是把这些差异吃掉，插件只写 ctx.bridge.banMember(...) 这种语义调用。
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

/* ---------- 响应归一化：三种常见形态都吃掉 ---------- */
function unwrap(data, action) {
  if (data == null) return null;
  /* OneBot v11 标准：{status:'ok'|'failed', retcode, data, wording} */
  if (typeof data === 'object' && ('status' in data || 'retcode' in data)) {
    const ok = data.status === 'ok' || data.status === 'async' || data.retcode === 0 || data.retcode === 1;
    if (!ok) {
      const why = data.wording || data.message || data.msg || ('retcode ' + data.retcode);
      throw new Error(action + ' 失败：' + why);
    }
    return 'data' in data ? data.data : data;
  }
  /* 裸数据（个别实现直接返回结果） */
  return data;
}

/* ============================================================
 * createOneBot(cfg) —— 低层客户端，ctx.onebot(action, params) 就是它
 * ============================================================ */
export function createOneBot(cfg = {}) {
  const base = String(cfg.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg.accessToken || '');
  const authMode = String(cfg.authMode || 'header'); // header | query | none
  const prefix = String(cfg.pathPrefix || '').replace(/\/+$/, ''); // 有些实现挂在 /onebot 下

  async function onebot(action, params = {}) {
    let url = base + prefix + '/' + action;
    const headers = { 'Content-Type': 'application/json' };
    if (token && authMode === 'header') headers.Authorization = 'Bearer ' + token;
    if (token && authMode === 'query') url += (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(token);

    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(params) });
    } catch (e) {
      /* 把底层网络错误翻译成"人话"，模型和用户都能看懂 */
      const hint = /ECONNREFUSED|fetch failed/i.test(e.message || '')
        ? `连不上协议端（${base}）：确认协议端已启动、HTTP 接口已开启、地址和端口没写错`
        : e.message;
      throw new Error(hint);
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(`${action} 被拒绝（${res.status}）：AccessToken 不对或没带，检查协议端的鉴权设置`);
    }
    let data;
    try { data = JSON.parse(text); } catch {
      if (!res.ok) throw new Error(`${action} 返回 ${res.status}：` + text.slice(0, 120));
      return text;
    }
    return unwrap(data, action);
  }

  /* 探测：拿登录信息，用来识别当前跑的是哪个实现 */
  async function probe() {
    try {
      const info = await onebot('get_login_info', {});
      const ver = await onebot('get_version_info', {}).catch(() => null);
      return { ok: true, selfId: info && (info.user_id || info.uin), nickname: info && info.nickname, version: ver || null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return { onebot, probe, base, authMode, hasToken: !!token };
}

/* ============================================================
 * createBridge(cfg) —— 高层语义接口，插件优先用它
 *   优点：动作名、参数、错误处理都收敛在这里，换协议端不用改插件
 * ============================================================ */
export function createBridge(cfg = {}) {
  const client = createOneBot(cfg);
  return makeBridge(client.onebot, client.probe);
}

/** 用任意 raw 函数包一层高层接口（测试环境 / 只有 ctx.onebot 时用） */
export function wrapOnebot(fn) {
  return makeBridge(fn, async () => ({ ok: false, error: '未提供探测能力' }));
}

function makeBridge(onebot, probe) {
  const seg = (type, data) => [{ type, data }];

  return {
    /* 基础 */
    raw: onebot,
    probe,
    selfId: null,

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
    /* 群公告：不同实现动作名不一样，依次尝试 */
    async setNotice(groupId, content) {
      const names = ['_send_group_notice', 'send_group_notice', 'set_group_notice'];
      let lastErr = null;
      for (const n of names) {
        try { return await onebot(n, { group_id: groupId, content }); }
        catch (e) { lastErr = e; if (!/未知|not found|不支持|retcode/i.test(e.message)) break; }
      }
      throw lastErr || new Error('当前协议端不支持发群公告');
    },
  };
}
