/* joke —— 冷笑话 */
'use strict';
import { pick } from './_lib.mjs';

const JOKES = [
  '有一天绿豆跳楼了，变成了红豆。',
  '为什么海是蓝的？因为鱼在里面吐泡泡：blue blue blue。',
  '小明去面试，面试官问他有什么特长，他说会心算。面试官：1234×5678？小明：等于 7百万零六千六百五十二。面试官按了按计算器：不对啊。小明：我说的是心算，你别用计算器验证。',
  '医生：你这病要少吃辣。患者：那火锅算辣吗？医生：算。患者：那麻辣烫呢？医生：……你这是来治病的还是来报菜名的。',
  '橘子：我为什么是酸的？橙子：因为你是橘子。',
  '两个人比赛谁先跑到山顶，结果他们打的同一辆出租。',
];

export default {
  meta: { id: 'joke', name: 'joke', description: '冷笑话：一句一个，别指望多好笑', category: '娱乐' },
  tools: [{
    name: 'qq_joke',
    description: '来一个冷笑话',
    inputSchema: { type: 'object', properties: {} },
    run: async () => '🥶 ' + pick(JOKES),
  }],
};
