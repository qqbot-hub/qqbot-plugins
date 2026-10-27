/* bombgame —— 数字炸弹 */
'use strict';
import { sessionOf, storage, randInt, num } from './_lib.mjs';

export default {
  meta: { id: 'bombgame', name: 'bombgame', description: '数字炸弹：1-100 暗藏一个炸弹，猜中就炸，越猜范围越小', category: '小游戏' },
  tools: [
    {
      name: 'qq_bomb_start',
      description: '埋一颗炸弹（1-100）',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' } },
      },
      run: (args) => {
        const sess = sessionOf(args);
        storage('bombgame').set('game:' + sess.key, { bomb: randInt(1, 100), low: 1, high: 100 });
        return `💣 数字炸弹已埋好（1-100）。\n规则：轮流报数，猜中炸弹的人原地爆炸。现在范围是 1~100，谁先来？`;
      },
    },
    {
      name: 'qq_bomb_try',
      description: '猜一个数字',
      inputSchema: {
        type: 'object',
        properties: {
          number: { type: 'number', description: '猜的数字' },
          group_id: { type: 'number' }, user_id: { type: 'number' },
        },
        required: ['number'],
      },
      run: (args) => {
        const sess = sessionOf(args);
        const st = storage('bombgame');
        const g = st.get('game:' + sess.key);
        if (!g) return '还没埋炸弹，先开一局。';
        const n = Math.trunc(num(args.number));
        if (n < g.low || n > g.high) return `当前范围是 ${g.low}~${g.high}，别猜外面。`;
        if (n === g.bomb) { st.set('game:' + sess.key, undefined); return `💥 轰！${n} 就是炸弹！游戏结束，重新「埋一颗炸弹」再来。`; }
        if (n < g.bomb) g.low = n + 1; else g.high = n - 1;
        st.set('game:' + sess.key, g);
        return `没炸。${n < g.bomb ? '比它大' : '比它小'}，现在范围 ${g.low}~${g.high}。`;
      },
    },
  ],
};
