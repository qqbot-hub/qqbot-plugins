/* dice —— 掷骰子、随机数与多选一 */
'use strict';
import { randInt, pick, num } from './_lib.mjs';

export default {
  meta: { id: 'dice', name: 'dice', description: '掷骰子、随机数与多选一', category: '娱乐' },
  tools: [
    {
      name: 'qq_dice',
      description: '掷骰子（群里有人喊"骰子/比大小/roll 一个"时用）。默认 1 个 6 面骰子。',
      inputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number', description: '骰子个数，默认 1，最多 10' },
          sides: { type: 'number', description: '面数，默认 6，常用 6/20/100' },
        },
      },
      run: async ({ count, sides }) => {
        const n = Math.min(Math.max(Math.trunc(num(count) || 1), 1), 10);
        const f = Math.min(Math.max(Math.trunc(num(sides) || 6), 2), 1000);
        const rolls = Array.from({ length: n }, () => randInt(1, f));
        const total = rolls.reduce((a, b) => a + b, 0);
        return n === 1 ? `🎲 ${f} 面骰掷出了 **${rolls[0]}**` : `🎲 ${n}d${f}：${rolls.join(' + ')} = **${total}**`;
      },
    },
    {
      name: 'qq_choose',
      description: '从几个选项里随机挑一个（"吃什么/去哪个"这类纠结时用）。至少给 2 个选项。',
      inputSchema: {
        type: 'object',
        properties: { options: { type: 'array', items: { type: 'string' }, description: '候选选项，2 个以上' } },
        required: ['options'],
      },
      run: async ({ options }) => {
        const list = (options || []).map((o) => String(o).trim()).filter(Boolean);
        if (list.length < 2) return '至少给 2 个选项吧。';
        return `就让命运决定吧——选「**${pick(list)}**」！`;
      },
    },
  ],
};
