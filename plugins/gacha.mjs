/* gacha —— 抽群友卡（稀有度 SSR/SR/R/N） */
'use strict';
import { pick, randInt, sessionOf } from './_lib.mjs';
import { bridgeOf } from './_lib.mjs';

export default {
  meta: { id: 'gacha', name: 'gacha', description: '抽卡：随机抽一张群友卡，带稀有度（SSR / SR / R / N）', category: '娱乐' },
  tools: [{
    name: 'qq_gacha',
    description: '抽一张卡（纯娱乐，稀有度越高越好）。群里用时会随机点到一位群友。',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'number', description: '群号（群里用时传入）' },
        user_id: { type: 'number', description: '谁在抽（QQ 号）' },
      },
    },
    run: async (args, ctx) => {
      const sess = sessionOf(args);
      let member = '';
      if (sess.type === 'group' && ctx && ctx.onebot) {
        try {
          const r = await bridgeOf(ctx).getMembers(sess.groupId);
          if (Array.isArray(r) && r.length) member = `\n抽中了群友：${pick(r).nickname || pick(r).card || '神秘群友'}`;
        } catch { /* 拿不到成员列表就只抽稀有度 */ }
      }
      const roll = randInt(1, 100);
      const rarity = roll <= 2 ? 'SSR' : roll <= 15 ? 'SR' : roll <= 50 ? 'R' : 'N';
      const stars = { SSR: '★★★★★', SR: '★★★★', R: '★★★', N: '★★' }[rarity];
      return `🎰 ${rarity} 卡！${stars}${member}\n${rarity === 'SSR' ? '欧皇附体，今天适合买彩票！' : rarity === 'N' ? '谢谢惠顾，再来一次？' : '还不错哦。'}`;
    },
  }],
};
