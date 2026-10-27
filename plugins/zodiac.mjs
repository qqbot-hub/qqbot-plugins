/* zodiac —— 星座运势（按日期确定性生成，同一天同星座结果固定） */
'use strict';
import { dayHash } from './_lib.mjs';

const ZODIAC = ['白羊', '金牛', '双子', '巨蟹', '狮子', '处女', '天秤', '天蝎', '射手', '摩羯', '水瓶', '双鱼'];
const SCOPES = ['事业', '学业', '感情', '财运', '健康'];
const ADJ = ['起飞', '看涨', '平稳', '有点飘', '需要充电', '高开低走', '稳中有喜'];

export default {
  meta: { id: 'zodiac', name: 'zodiac', description: '星座运势：按日期生成，同一天同星座结果固定', category: '娱乐' },
  tools: [{
    name: 'qq_zodiac',
    description: '看某个星座今天怎么样',
    inputSchema: {
      type: 'object',
      properties: { zodiac: { type: 'string', description: '星座名，如 天蝎 / 水瓶座' } },
      required: ['zodiac'],
    },
    run: async ({ zodiac }) => {
      const z = String(zodiac || '').replace('座', '');
      const idx = ZODIAC.indexOf(z);
      if (idx < 0) return '没认出这个星座，给我 12 星座之一：' + ZODIAC.join('、') + '。';
      const h = dayHash('zodiac', idx);
      const lines = SCOPES.map((s, i) => `${s}：${ADJ[(h >> (i * 3)) % ADJ.length]}`);
      return `✨ ${z}座今日运势\n${lines.join('\n')}\n今日关键词：${['摸鱼', '搞钱', '早睡', '多喝水', '别嘴硬', '冲'][(h >> 16) % 6]}`;
    },
  }],
};
