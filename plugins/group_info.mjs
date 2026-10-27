/* group_info —— 群资料与成员信息（OneBot v11 查询 API） */
'use strict';
import { num } from './_lib.mjs';

export default {
  meta: { id: 'group_info', name: 'group_info', description: '看群资料、成员列表（谁在、谁是管理），也能看某个人的群资料', category: '群管理' },
  tools: [
    {
      name: 'qq_group_info', description: '本群资料（人数上限、群主等）',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number', description: '群号' } },
        required: ['group_id'],
      },
      run: async (a, ctx) => {
        const g = await ctx.onebot('get_group_info', { group_id: num(a.group_id) });
        if (!g || !g.group_id) return '没查到这个群（机器人可能不在群里）。';
        return `👥 群 ${g.group_id}\n群名：${g.group_name || '未知'}\n人数：${g.member_count}/${g.max_member_count}`;
      },
    },
    {
      name: 'qq_group_members', description: '成员列表（默认前 20 个，可给 limit）',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, limit: { type: 'number', description: '列几个，默认 20，最多 50' } },
        required: ['group_id'],
      },
      run: async (a, ctx) => {
        const list = await ctx.onebot('get_group_member_list', { group_id: num(a.group_id) });
        if (!Array.isArray(list) || !list.length) return '拿不到成员列表（机器人可能不在群里）。';
        const n = Math.min(Math.max(Math.trunc(a.limit || 20), 1), 50);
        const admins = list.filter((m) => m.role === 'admin').map((m) => m.card || m.nickname);
        const rows = list.slice(0, n).map((m, i) => `${i + 1}. ${m.card || m.nickname}${m.role === 'admin' ? '（管理）' : m.role === 'owner' ? '（群主）' : ''}`);
        return `👥 共 ${list.length} 人，其中管理员 ${admins.length} 名\n前 ${Math.min(n, list.length)} 位：\n` + rows.join('\n');
      },
    },
    {
      name: 'qq_group_member', description: '看某个人的群资料',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' } },
        required: ['group_id', 'user_id'],
      },
      run: async (a, ctx) => {
        const m = await ctx.onebot('get_group_member_info', { group_id: num(a.group_id), user_id: num(a.user_id) });
        if (!m || !m.user_id) return '查不到这个人。';
        return `👤 ${m.card || m.nickname}（QQ ${m.user_id}）\n身份：${m.role === 'owner' ? '群主' : m.role === 'admin' ? '管理员' : '成员'}\n头衔：${m.title || '无'}\n入群时间戳：${m.join_time}`;
      },
    },
  ],
};
