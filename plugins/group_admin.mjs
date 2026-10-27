/* group_admin —— 群管理动作（全部通过 OneBot v11 HTTP API 执行，需机器人有管理员权限）
 *
 * 权限护栏（在市场页面「配置」里填）：
 *   admins            管理员 QQ 白名单：非空时，只有名单内的人发起才允许执行
 *   allowedGroups     允许操作的群：非空时，只对这些群生效
 *   defaultBanMinutes 未指定时长时的默认禁言分钟数
 *   requireConfirm    危险操作是否强制 confirm=true（建议保持开启）
 */
'use strict';
import { num, str } from './_lib.mjs';

const need = (v, name) => {
  const n = num(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`缺少参数 ${name}`);
  return n;
};

const cfgOf = (ctx) => (ctx && ctx.cfg) || {};

/* 校验群白名单 + 管理员白名单；不通过直接抛错，AI 会把原因转给群友 */
function guard(ctx, a) {
  const cfg = cfgOf(ctx);
  const gid = num(a.group_id);
  const allowed = Array.isArray(cfg.allowedGroups) ? cfg.allowedGroups.map(Number).filter(Boolean) : [];
  if (allowed.length && !allowed.includes(gid)) {
    throw new Error(`群 ${gid} 不在「允许操作的群」名单里。请在市场页面的插件配置中添加该群号。`);
  }
  const admins = Array.isArray(cfg.admins) ? cfg.admins.map(Number).filter(Boolean) : [];
  if (admins.length) {
    const op = num(a.operator_id);
    if (!Number.isFinite(op) || !op) {
      throw new Error('管理员白名单已开启：需要把发起这次操作的群友 QQ 号传给 operator_id。');
    }
    if (!admins.includes(op)) {
      throw new Error(`QQ ${op} 不在管理员白名单里，无权执行群管理操作。`);
    }
  }
}

/* 危险操作二次确认 */
function confirmGuard(ctx, a, what) {
  const cfg = cfgOf(ctx);
  if (cfg.requireConfirm === false) return;
  if (a.confirm !== true) throw new Error(`${what}是危险操作，需要 confirm=true 才会执行。`);
}

const OP_FIELD = { operator_id: { type: 'number', description: '发起这次操作的群友 QQ 号（用于管理员白名单校验，必须如实填写）' } };

export default {
  meta: { id: 'group_admin', name: 'group_admin', description: '群管理动作：禁言、解禁、踢人、撤回消息、改群名片/头衔、全体禁言、设管理员', category: '群管理' },

  settings: {
    title: '群管理权限',
    intro: '不填 = 不做限制（只靠机器人自身的群权限）。填了就在每次执行前校验。',
    fields: [
      { key: 'admins', label: '管理员 QQ 白名单', type: 'list', placeholder: '每行一个 QQ 号\n123456789\n987654321', help: '非空时，只有名单内的人发起的群管理操作才会执行' },
      { key: 'allowedGroups', label: '允许操作的群号', type: 'list', placeholder: '每行一个群号\n123456789', help: '非空时，只对这个名单里的群生效（防止 AI 在别的群误操作）' },
      { key: 'defaultBanMinutes', label: '默认禁言时长（分钟）', type: 'number', default: 10, help: '群友没说具体多久时用这个值' },
      { key: 'requireConfirm', label: '危险操作需 AI 二次确认', type: 'boolean', default: true, help: '踢人、全体禁言、设管理员必须带 confirm=true；建议保持开启' },
    ],
  },

  tools: [
    {
      name: 'qq_group_ban', description: '禁言某人（分钟，0=解禁）',
      inputSchema: {
        type: 'object',
        properties: {
          group_id: { type: 'number' }, user_id: { type: 'number' },
          minutes: { type: 'number', description: '禁言时长（分钟），0 表示解禁；不填用配置里的默认值' },
          ...OP_FIELD,
        },
        required: ['group_id', 'user_id'],
      },
      run: async (a, ctx) => {
        guard(ctx, a);
        const def = num(cfgOf(ctx).defaultBanMinutes);
        const mins = a.minutes == null ? (Number.isFinite(def) ? def : 10) : num(a.minutes);
        const duration = Math.min(Math.max(Math.trunc(mins) || 0, 0), 43200) * 60;
        await ctx.onebot('set_group_ban', { group_id: need(a.group_id, 'group_id'), user_id: need(a.user_id, 'user_id'), duration });
        return duration === 0 ? `🔊 已解除 QQ${a.user_id} 的禁言。` : `🔇 已禁言 QQ${a.user_id} ${Math.round(duration / 60)} 分钟。`;
      },
    },
    {
      name: 'qq_group_kick', description: '踢人（危险，需 confirm=true）',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' }, confirm: { type: 'boolean', description: '必须为 true 才执行' }, ...OP_FIELD },
        required: ['group_id', 'user_id', 'confirm'],
      },
      run: async (a, ctx) => {
        guard(ctx, a);
        confirmGuard(ctx, a, '踢人');
        await ctx.onebot('set_group_kick', { group_id: need(a.group_id, 'group_id'), user_id: need(a.user_id, 'user_id'), reject_add_request: false });
        return `👢 已将 QQ${a.user_id} 移出群聊。`;
      },
    },
    {
      name: 'qq_group_recall', description: '撤回一条消息（需要 message_id）',
      inputSchema: {
        type: 'object',
        properties: { message_id: { type: 'number', description: '要撤回的消息 ID' }, group_id: { type: 'number' }, ...OP_FIELD },
        required: ['message_id'],
      },
      run: async (a, ctx) => {
        if (a.group_id != null) guard(ctx, a);
        await ctx.onebot('delete_msg', { message_id: need(a.message_id, 'message_id') });
        return '🗑️ 已撤回该消息。';
      },
    },
    {
      name: 'qq_group_card', description: '改群名片（空字符串=清除）',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' }, card: { type: 'string', description: '新群名片，空串=清除' }, ...OP_FIELD },
        required: ['group_id', 'user_id'],
      },
      run: async (a, ctx) => {
        guard(ctx, a);
        await ctx.onebot('set_group_card', { group_id: need(a.group_id, 'group_id'), user_id: need(a.user_id, 'user_id'), card: str(a.card) });
        return `💳 已把 QQ${a.user_id} 的群名片改为「${str(a.card) || '（清除）'}」。`;
      },
    },
    {
      name: 'qq_group_title', description: '给群友设专属头衔（空=清除）',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' }, title: { type: 'string', description: '头衔，空串=清除' }, ...OP_FIELD },
        required: ['group_id', 'user_id'],
      },
      run: async (a, ctx) => {
        guard(ctx, a);
        await ctx.onebot('set_group_special_title', { group_id: need(a.group_id, 'group_id'), user_id: need(a.user_id, 'user_id'), special_title: str(a.title) });
        return `🏷️ 已把 QQ${a.user_id} 的头衔改为「${str(a.title) || '（清除）'}」。`;
      },
    },
    {
      name: 'qq_group_whole_ban', description: '全体禁言开/关（需 confirm=true）',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, enable: { type: 'boolean', description: 'true=开启全体禁言' }, confirm: { type: 'boolean' }, ...OP_FIELD },
        required: ['group_id', 'enable', 'confirm'],
      },
      run: async (a, ctx) => {
        guard(ctx, a);
        confirmGuard(ctx, a, '全体禁言');
        await ctx.onebot('set_group_whole_ban', { group_id: need(a.group_id, 'group_id'), enable: a.enable !== false });
        return a.enable !== false ? '🔇 已开启全体禁言。' : '🔊 已解除全体禁言。';
      },
    },
    {
      name: 'qq_group_set_admin', description: '设/撤管理员（需 confirm=true）',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' }, enable: { type: 'boolean', description: 'true=设为管理员' }, confirm: { type: 'boolean' }, ...OP_FIELD },
        required: ['group_id', 'user_id', 'enable', 'confirm'],
      },
      run: async (a, ctx) => {
        guard(ctx, a);
        confirmGuard(ctx, a, '设置管理员');
        await ctx.onebot('set_group_admin', { group_id: need(a.group_id, 'group_id'), user_id: need(a.user_id, 'user_id'), enable: a.enable !== false });
        return a.enable !== false ? `⭐ 已设 QQ${a.user_id} 为管理员。` : `已撤销 QQ${a.user_id} 的管理员。`;
      },
    },
    {
      name: 'qq_group_notice', description: '发群公告',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, content: { type: 'string', description: '公告内容' }, ...OP_FIELD },
        required: ['group_id', 'content'],
      },
      run: async (a, ctx) => {
        guard(ctx, a);
        await ctx.onebot('_send_group_notice', { group_id: need(a.group_id, 'group_id'), content: str(a.content).slice(0, 500) });
        return '📢 群公告已发布。';
      },
    },
  ],
};
