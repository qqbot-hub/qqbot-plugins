/* riddle —— 脑筋急转弯 */
'use strict';
import { pick, str } from './_lib.mjs';

const RIDDLES = [
  ['什么东西越洗越脏？', '水'],
  ['小明的妈妈有三个儿子，大儿子叫大毛，二儿子叫二毛，三儿子叫什么？', '小明'],
  ['什么车永远寸步难行？', '风车'],
  ['一个人从飞机上掉下来为什么没摔死？', '飞机还停在地上'],
  ['什么东西打破了大家都高兴？', '世界纪录'],
  ['什么门永远关不上？', '球门'],
  ['为什么大雁秋天要飞到南方去？', '因为走太慢了'],
];

export default {
  meta: { id: 'riddle', name: 'riddle', description: '脑筋急转弯：它出题，你来猜，答错可以看答案', category: '娱乐' },
  tools: [{
    name: 'qq_riddle',
    description: '出一个脑筋急转弯（answer 字段留着别给群友看）',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const [q, a] = pick(RIDDLES);
      return `🧠 ${q}\n（答案我先收着，猜不出来再喊我看答案：${a}）`;
    },
  }],
};
