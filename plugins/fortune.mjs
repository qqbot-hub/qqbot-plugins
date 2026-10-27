/* fortune —— 今日运势（娱乐向），同一天同一人结果固定 */
'use strict';
import { dayHash } from './_lib.mjs';

const LEVELS = [
  ['大吉', '今天做什么都顺，冲！'],
  ['中吉', '稳中向好，适合把攒着的事办了。'],
  ['小吉', '小有惊喜，留意身边的小确幸。'],
  ['吉', '平平常常的一天，稳住就好。'],
  ['末吉', '先苦后甜，晚上会顺一些。'],
  ['凶', '今天低调点，别立 flag。'],
];
const LUCKY = ['红色', '蓝色', '绿色', '白色', '黑色', '黄色', '紫色', '橙色'];
const ITEMS = ['奶茶', '泡面', '耳机', '键盘', '逗猫棒', '保温杯', '无线充电器', '雨伞'];

export default {
  meta: { id: 'fortune', name: 'fortune', description: '今日运势（娱乐向）', category: '娱乐' },
  tools: [{
    name: 'qq_fortune',
    description: '看今天的运势（娱乐，别当真）。有人问"我今天运势/运气怎么样"时用。',
    inputSchema: {
      type: 'object',
      properties: { user_id: { type: 'number', description: '问运势的人的 QQ 号' } },
      required: ['user_id'],
    },
    run: async ({ user_id }) => {
      const h = dayHash('fortune', user_id);
      const [level, text] = LEVELS[h % LEVELS.length];
      const luck = LUCKY[(h >> 3) % LUCKY.length];
      const item = ITEMS[(h >> 6) % ITEMS.length];
      const score = 50 + (h >> 9) % 51;
      return `🔮 今日运势（${level}，${score} 分）\n${text}\n幸运色：${luck}　幸运物：${item}\n（娱乐而已，好运要靠自己攒）`;
    },
  }],
};
