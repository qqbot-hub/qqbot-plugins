/* sensoji —— 赛博浅草寺 */
'use strict';
import { pick } from './_lib.mjs';

const FORTUNES = ['大吉', '吉', '半吉', '小吉', '末小吉', '末吉', '凶', '大凶'];
const WISHES = [
  '愿望会实现的，先把它写下来。',
  '风起时去许愿，灵验概率 +10%。',
  '再等等，时机未到。',
  '缺的不是运气，是行动。',
  '去人少的地方许愿，雷同愿望不作数。',
];
const FINDS = [
  '遗失物会在老地方等你。',
  '要找的东西，其实一直没丢。',
  '问问朋友，答案就在群里。',
];

export default {
  meta: { id: 'sensoji', name: 'sensoji', description: '赛博浅草寺：摇一支签，带一点日式仪式感', category: '娱乐' },
  tools: [{
    name: 'qq_sensoji',
    description: '在赛博浅草寺抽签',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      return `⛩️ 赛博浅草寺 · 御神签\n\n【${pick(FORTUNES)}】\n愿望：${pick(WISHES)}\n遗失物：${pick(FINDS)}\n\n願わくは、良き一日を。`;
    },
  }],
};
