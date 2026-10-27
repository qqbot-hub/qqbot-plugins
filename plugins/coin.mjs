/* coin —— 抛硬币 */
'use strict';
import { randInt } from './_lib.mjs';

export default {
  meta: { id: 'coin', name: 'coin', description: '抛硬币：正反面，也可以抛多枚统计', category: '工具' },
  tools: [{
    name: 'qq_coin',
    description: '抛硬币决定一件事',
    inputSchema: {
      type: 'object',
      properties: { count: { type: 'number', description: '抛几枚，默认 1，最多 100' } },
    },
    run: async ({ count }) => {
      const n = Math.min(Math.max(Math.trunc(count || 1), 1), 100);
      let heads = 0;
      const faces = [];
      for (let i = 0; i < n; i++) { const h = randInt(0, 1) === 0; if (h) heads++; faces.push(h ? '正' : '反'); }
      if (n === 1) return `🪙 抛出了「**${faces[0]}**」面！`;
      return `🪙 抛了 ${n} 枚：正面 ${heads} 次，反面 ${n - heads} 次。`;
    },
  }],
};
