/* quote —— 一句话：毒鸡汤/语录，本地词库不联网 */
'use strict';
import { pick } from './_lib.mjs';

const QUOTES = [
  '你以为有钱人很快乐吗？他们的快乐你根本想象不到。',
  '条条大路通罗马，但有人就生在罗马。',
  '只要功夫深，铁杵磨成针——可你磨它干嘛？',
  'Failure is the mother of success. 你失败这么多次，也该当外婆了。',
  '比你优秀的人还在努力，所以你努力有什么用？',
  '每天叫醒你的不是梦想，是闹钟。',
  '万事开头难，中间难，结尾也难。',
  '运气也是实力的一部分，而你没有。',
];

export default {
  meta: { id: 'quote', name: 'quote', description: '一句话：毒鸡汤 / 冷笑话 / 随机语录，全部本地词库不联网', category: '娱乐' },
  tools: [{
    name: 'qq_quote',
    description: '来一句毒鸡汤或者语录',
    inputSchema: { type: 'object', properties: {} },
    run: async () => '🥤 ' + pick(QUOTES),
  }],
};
