/* roulette —— 轮盘点名（纯娱乐） */
'use strict';
import { sessionOf } from './_lib.mjs';
import { bridgeOf } from './_lib.mjs';

export default {
  meta: { id: 'roulette', name: 'roulette', description: '轮盘禁言（纯娱乐）：随机点一个人，看谁运气差', category: '小游戏' },
  tools: [{
    name: 'qq_roulette',
    description: '转一次轮盘，点名一个倒霉蛋',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'number', description: '群号' },
        user_id: { type: 'number', description: '谁在转（QQ 号）' },
      },
      required: ['group_id'],
    },
    run: async (args, ctx) => {
      const sess = sessionOf(args);
      if (sess.type !== 'group') return '轮盘要在群里玩才有意思。';
      let members = null;
      if (ctx && ctx.onebot) {
        try { const r = await bridgeOf(ctx).getMembers(sess.groupId); if (Array.isArray(r)) members = r; } catch { /* 降级 */ }
      }
      let victim;
      if (members && members.length) {
        victim = members[Math.floor(Math.random() * members.length)];
      } else {
        victim = { user_id: sess.userId || 10000 + Math.floor(Math.random() * 89999), nickname: '神秘群友' };
      }
      const name = victim.card || victim.nickname || ('QQ' + victim.user_id);
      const line = victim.user_id === sess.userId ? '……转来转去还是你自己，认命吧。' : '愿赌服输，别跑！';
      return `🔫 轮盘停下——中弹的是【${name}】！${line}`;
    },
  }],
};
