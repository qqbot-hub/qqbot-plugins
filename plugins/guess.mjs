/* guess —— 猜数字 */
'use strict';
import { sessionOf, storage, randInt, num } from './_lib.mjs';

export default {
  meta: { id: 'guess', name: 'guess', description: '猜数字小游戏：出题后群友猜 1-100，会提示大了小了', category: '小游戏' },
  tools: [
    {
      name: 'qq_guess_start',
      description: '开一局猜数字（1-100）',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' } },
      },
      run: (args) => {
        const sess = sessionOf(args);
        storage('guess').set('game:' + sess.key, { answer: randInt(1, 100), tries: 0 });
        return '🔢 我想好了一个 1-100 的数，猜猜看！（说"猜 X"就行）';
      },
    },
    {
      name: 'qq_guess_try',
      description: '猜一个数字，返回大了/小了/猜对了',
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
        const st = storage('guess');
        const g = st.get('game:' + sess.key);
        if (!g) return '还没出题，先说"开始猜数字"。';
        g.tries++;
        const n = Math.trunc(num(args.number));
        if (n === g.answer) { st.set('game:' + sess.key, undefined); return `🎉 猜对了！答案就是 ${n}，一共用了 ${g.tries} 次。`; }
        st.set('game:' + sess.key, g);
        return n < g.answer ? `${n} 小了，再大点。（第 ${g.tries} 次尝试）` : `${n} 大了，再小点。（第 ${g.tries} 次尝试）`;
      },
    },
  ],
};
