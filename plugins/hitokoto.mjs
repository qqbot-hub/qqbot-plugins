/* hitokoto —— 一言 */
'use strict';
import { httpJson } from './_lib.mjs';
const FALLBACK = ['山水万程，皆要好运。', '凡是过往，皆为序章。', '慢慢来，比较快。', '人间烟火气，最抚凡人心。', '今日事，今日毕。'];

export default {
  meta: { id: 'hitokoto', name: 'hitokoto', description: '一言：随机一句语录，动漫/文学/网络都有', category: '娱乐' },
  tools: [{
    name: 'qq_hitokoto',
    description: '来一句一言',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      try {
        const r = await httpJson('https://v1.hitokoto.cn/?max_length=40');
        if (r && r.hitokoto) return `💬 ${r.hitokoto}\n—— ${r.from_work || r.from || '佚名'}`;
      } catch { /* 落到本地词库 */ }
      return '💬 ' + FALLBACK[Math.floor(Math.random() * FALLBACK.length)];
    },
  }],
};
