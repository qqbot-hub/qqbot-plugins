/* group_admin —— 群管理动作（全部通过 OneBot v11 HTTP API 执行，需机器人有管理员权限） */
'use strict';
import { num } from './_lib.mjs';

const need = (v, name) => {
  const n = num(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`缺少参数 ${name}`);
  return n;
};
const guard = (confirm) => { if (confirm !== true) throw new Error('这是危险操作，需要 confirm=true 才会执行。'); };

export default {
  meta: { id: 'group_admin', name: 'group_admin', description: '群管理动作：禁言、解禁、踢人、撤回消息、改群名片/头衔、全体禁言、设管理员', category: '群管理' },
  tools: [
    {
      name: 'qq_group_ban', description: '禁言某人（分钟，0=解禁）',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' }, minutes: { type: 'number', description: '禁言时长（分钟），0 表示解禁' } },
        required: ['group_id', 'user_id'],
      },
      run: async (a, ctx) => {
        const duration = Math.min(Math.max(Math.trunc(num(a.minutes) || 10), 0), 43200) * 60;
        await ctx.onebot('set_group_ban', { group_id: need(a.group_id, 'group_id'), user_id: need(a.user_id, 'user_id'), duration });
        return duration === 0 ? `🔊 已解除 QQ${a.user_id} 的禁言。` : `🔇 已禁言 QQ${a.user_id} ${Math.round(duration / 60)} 分钟。`;
      },
    },
    {
      name: 'qq_group_kick', description: '踢人（危险，需 confirm=true）',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' }, confirm: { type: 'boolean', description: '必须为 true 才执行' } },
        required: ['group_id', 'user_id', 'confirm'],
      },
      run: async (a, ctx) => {
        guard(a.confirm);
        await ctx.onebot('set_group_kick', { group_id: need(a.group_id, 'group_id'), user_id: need(a.user_id, 'user_id'), reject_add_request: false });
        return `👢 已将 QQ${a.user_id} 移出群聊。`;
      },
    },
    {
      name: 'qq_group_recall', description: '撤回一条消息（需要 message_id）',
      inputSchema: {
        type: 'object',
        properties: { message_id: { type: 'number', description: '要撤回的消息 ID' } },
        required: ['message_id'],
      },
      run: async (a, ctx) => {
        await ctx.onebot('delete_msg', { message_id: need(a.message_id, 'message_id') });
        return '🗑️ 已撤回该消息。';
      },
    },
    {
      name: 'qq_group_card', description: '改群名片（空字符串=清除）',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' }, card: { type: 'string', description: '新群名片，空串=清除' } },
        required: ['group_id', 'user_id'],
      },
      run: async (a, ctx) => {
        await ctx.onebot('set_group_card', { group_id: need(a.group_id, 'group_id'), user_id: need(a.user_id, 'user_id'), card: String(a.card || '') });
        return `💳 已把 QQ${a.user_id} 的群名片改为「${a.card || '（清除）'}」。`;
      },
    },
    {
      name: 'qq_group_title', description: '给群友设专属头衔（空=清除）',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' }, title: { type: 'string', description: '头衔，空串=清除' } },
        required: ['group_id', 'user_id'],
      },
      run: async (a, ctx) => {
        await ctx.onebot('set_group_special_title', { group_id: need(a.group_id, 'group_id'), user_id: need(a.user_id, 'user_id'), special_title: String(a.title || '') });
        return `🏷️ 已把 QQ${a.user_id} 的头衔改为「${a.title || '（清除）'}」。`;
      },
    },
    {
      name: 'qq_group_whole_ban', description: '全体禁言开/关（需 confirm=true）',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, enable: { type: 'boolean', description: 'true=开启全体禁言' }, confirm: { type: 'boolean' } },
        required: ['group_id', 'enable', 'confirm'],
      },
      run: async (a, ctx) => {
        guard(a.confirm);
        await ctx.onebot('set_group_whole_ban', { group_id: need(a.group_id, 'group_id'), enable: a.enable !== false });
        return a.enable !== false ? '🔇 已开启全体禁言。' : '🔊 已解除全体禁言。';
      },
    },
    {
      name: 'qq_group_set_admin', description: '设/撤管理员（需 confirm=true）',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' }, enable: { type: 'boolean', description: 'true=设为管理员' }, confirm: { type: 'boolean' } },
        required: ['group_id', 'user_id', 'enable', 'confirm'],
      },
      run: async (a, ctx) => {
        guard(a.confirm);
        await ctx.onebot('set_group_admin', { group_id: need(a.group_id, 'group_id'), user_id: need(a.user_id, 'user_id'), enable: a.enable !== false });
        return a.enable !== false ? `⭐ 已设 QQ${a.user_id} 为管理员。` : `已撤销 QQ${a.user_id} 的管理员。`;
      },
    },
    {
      name: 'qq_group_notice', description: '发群公告',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, content: { type: 'string', description: '公告内容' } },
        required: ['group_id', 'content'],
      },
      run: async (a, ctx) => {
        await ctx.onebot('_send_group_notice', { group_id: need(a.group_id, 'group_id'), content: String(a.content || '').slice(0, 500) });
        return '📢 群公告已发布。';
      },
    },
  ],
};
