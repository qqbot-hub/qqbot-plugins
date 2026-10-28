/* ============================================================
 * _protocol.mjs —— 统一协议抽象层
 *
 * 目标：插件只认一套语义方法（sendText / banMember / getMembers …），
 * 底下跑的是 OneBot v11 还是 Satori，由配置决定，插件代码一行都不用改。
 *
 * 现在的两个后端：
 *   onebot  → _bridge.mjs 的 createBridge（SnowLuma / NapCat / LLOneBot / Lagrange / go-cqhttp）
 *   satori  → _satori.mjs 的 createSatori（Koishi / Chronocat 等 Satori 生态）
 *
 * 能力表 capabilities 的意义：
 *   两个协议不是全等价的。Satori 没有群公告、没有全员禁言、没有群名片。
 *   与其让插件调了以后抛一个看不懂的错，不如提前把"这个协议能不能做"摆出来，
 *   前端可以据此把按钮置灰并说明原因，而不是点了才失败。
 * ============================================================ */
'use strict';

import { createBridge, createOneBot } from './_bridge.mjs';
import { createSatori, SATORI_CAPABILITIES } from './_satori.mjs';

/** OneBot v11 侧的能力：这些动作它都有（个别实现缺某个，由动作别名表兜底） */
export const ONEBOT_CAPABILITIES = {
  sendText: true,
  sendImage: true,
  sendRecord: true,
  recall: true,
  banMember: true,
  kickMember: true,
  groupList: true,
  memberList: true,
  setCard: true,
  setTitle: true,
  wholeBan: true,
  setAdmin: true,
  notice: true,
};

export const PROTOCOLS = {
  onebot: {
    id: 'onebot',
    label: 'OneBot v11',
    note: 'SnowLuma / NapCat / LLOneBot / Lagrange / go-cqhttp 都讲这套，端口一般是 3000',
    capabilities: ONEBOT_CAPABILITIES,
  },
  satori: {
    id: 'satori',
    label: 'Satori',
    note: 'Koishi / Chronocat 生态的通用协议，HTTP 走 POST {baseUrl}/v1/资源.方法',
    capabilities: SATORI_CAPABILITIES,
  },
};

/** 从配置里判断该用哪个协议（默认 onebot，保持老配置行为不变） */
export function protocolKind(cfg = {}) {
  const raw = String(cfg.protocol || (cfg.satori && cfg.satori.enabled ? 'satori' : 'onebot')).toLowerCase();
  return raw === 'satori' ? 'satori' : 'onebot';
}

/**
 * 创建统一协议客户端。
 * 返回对象的语义方法与 OneBot 版完全一致，另外多两个字段：
 *   .protocol     'onebot' | 'satori'
 *   .capabilities 能力表（见上）
 */
export function createProtocol(cfg = {}) {
  const kind = protocolKind(cfg);
  if (kind === 'satori') {
    const s = cfg.satori || cfg;
    return createSatori({
      baseUrl: s.baseUrl || s.url || 'http://127.0.0.1:5141/satori',
      token: s.token || s.accessToken || '',
      platform: s.platform || 'onebot',
      selfId: s.selfId || '',
      timeoutMs: s.timeoutMs || cfg.timeoutMs,
    });
  }
  const b = createBridge(cfg);
  b.protocol = 'onebot';
  b.capabilities = ONEBOT_CAPABILITIES;
  return b;
}

/** 只做体检（不需要完整客户端时用，比如页面顶部状态条） */
export function createProbe(cfg = {}) {
  const kind = protocolKind(cfg);
  if (kind === 'satori') {
    const s = cfg.satori || cfg;
    return createSatori({
      baseUrl: s.baseUrl || s.url || 'http://127.0.0.1:5141/satori',
      token: s.token || s.accessToken || '',
      platform: s.platform || 'onebot',
      selfId: s.selfId || '',
      timeoutMs: s.timeoutMs || cfg.timeoutMs,
    });
  }
  return createOneBot(cfg);
}
