/* draw —— 抽签 */
'use strict';
import { pick, randInt } from './_lib.mjs';

const LEVELS = ['上上签', '上签', '中签', '中平签', '下签'];
const LINES = [
  '春风得意马蹄疾，一日看尽长安花。',
  '山重水复疑无路，柳暗花明又一村。',
  '宝剑锋从磨砺出，梅花香自苦寒来。',
  '行到水穷处，坐看云起时。',
  '长风破浪会有时，直挂云帆济沧海。',
  '不积跬步，无以至千里。',
  '宁可枝头抱香死，何曾吹落北风中。',
  '竹外桃花三两枝，春江水暖鸭先知。',
];

export default {
  meta: { id: 'draw', name: 'draw', description: '抽签：上上签到大凶，一句解释，图个乐', category: '娱乐' },
  tools: [{
    name: 'qq_draw',
    description: '抽一支签',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const level = pick(LEVELS);
      return `🎋 抽到了【${level}】\n「${pick(LINES)}」\n（图个乐，事在人为）`;
    },
  }],
};
