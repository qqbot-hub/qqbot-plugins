/* meihua —— 梅花易数（按当下时间起卦，娱乐向） */
'use strict';
import { pick } from './_lib.mjs';

const TRIGRAMS = [['乾', '☰'], ['兑', '☱'], ['离', '☲'], ['震', '☳'], ['巽', '☴'], ['坎', '☵'], ['艮', '☶'], ['坤', '☷']];
const JUDGES = [
  '动中有静，宜守不宜攻。',
  '先难后易，贵人将在东南。',
  '水到渠成，不必强求。',
  '雷声大雨点小，听完就做。',
  '静极思动，正是出手时。',
  '虚实相生，眼见未必为实。',
  '止于当止，退一步海阔天空。',
  '厚德载物，宽人即宽己。',
];

export default {
  meta: { id: 'meihua', name: 'meihua', description: '梅花易数：按当下时间起卦，给个卦象和一句断语', category: '娱乐' },
  tools: [{
    name: 'qq_meihua',
    description: '起一卦（可带想问的事）',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string', description: '想问的事，可留空' } },
    },
    run: async ({ question }) => {
      const now = Date.now();
      const upper = TRIGRAMS[Math.floor(now / 3600000) % 8];
      const lower = TRIGRAMS[Math.floor(now / 60000) % 8];
      const dong = TRIGRAMS[Math.floor(now / 1000) % 8];
      const q = question ? `所问之事：「${String(question).slice(0, 30)}」\n` : '';
      return `☯ ${q}上卦 ${upper[0]}${upper[1]}　下卦 ${lower[0]}${lower[1]}\n动爻应在【${dong[0]}${dong[1]}】\n断语：${pick(JUDGES)}\n（起卦以娱乐为主，大事还是靠人自己判断）`;
    },
  }],
};
