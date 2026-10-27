/* poem —— 古诗（本地名篇库，可按关键词找） */
'use strict';
import { pick, str } from './_lib.mjs';

const POEMS = [
  ['静夜思', '李白', '床前明月光，疑是地上霜。举头望明月，低头思故乡。'],
  ['春晓', '孟浩然', '春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。'],
  ['登鹳雀楼', '王之涣', '白日依山尽，黄河入海流。欲穷千里目，更上一层楼。'],
  ['江雪', '柳宗元', '千山鸟飞绝，万径人踪灭。孤舟蓑笠翁，独钓寒江雪。'],
  ['悯农', '李绅', '锄禾日当午，汗滴禾下土。谁知盘中餐，粒粒皆辛苦。'],
  ['相思', '王维', '红豆生南国，春来发几枝。愿君多采撷，此物最相思。'],
  ['枫桥夜泊', '张继', '月落乌啼霜满天，江枫渔火对愁眠。姑苏城外寒山寺，夜半钟声到客船。'],
  ['游子吟', '孟郊', '慈母手中线，游子身上衣。临行密密缝，意恐迟迟归。谁言寸草心，报得三春晖。'],
];

export default {
  meta: { id: 'poem', name: 'poem', description: '古诗：随机来一首，也可按关键词找', category: '娱乐' },
  tools: [{
    name: 'qq_poem',
    description: '来一首古诗',
    inputSchema: {
      type: 'object',
      properties: { keyword: { type: 'string', description: '关键词（标题/作者/诗句），可留空随机' } },
    },
    run: async ({ keyword }) => {
      const k = str(keyword);
      const hit = k ? POEMS.filter((p) => p.some((f) => f.includes(k))) : POEMS;
      if (!hit.length) return `词库里没找到带「${k}」的诗，换一个关键词试试。`;
      const [title, author, text] = pick(hit);
      return `📜《${title}》 ${author}\n${text}`;
    },
  }],
};
