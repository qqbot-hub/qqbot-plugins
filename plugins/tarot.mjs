/* tarot —— 塔罗牌（大阿卡纳 22 张，含正逆位） */
'use strict';
import { randInt, pick } from './_lib.mjs';

const CARDS = {
  愚者: '新的开始、冒险、无限可能', 魔术师: '创造力、行动力、资源在手', 女祭司: '直觉、内在智慧、静观其变',
  皇后: '丰盛、滋养、感官享受', 皇帝: '秩序、掌控、权威', 教皇: '传统、指引、学习',
  恋人: '选择、结合、价值观契合', 战车: '意志力、前进、克服阻力', 力量: '勇气、耐心、以柔克刚',
  隐者: '独处、反思、寻找答案', 命运之轮: '转折、机遇、周期轮转', 正义: '公平、因果、权衡',
  倒吊人: '换位思考、暂停、牺牲', 死神: '结束与新生、放下旧事', 节制: '平衡、调和、中庸',
  恶魔: '诱惑、束缚、直面欲望', 高塔: '突变、打破、警醒', 星星: '希望、灵感、疗愈',
  月亮: '迷茫、潜意识、别被表象骗', 太阳: '成功、活力、光明正大', 审判: '觉醒、复盘、重新出发',
  世界: '圆满、达成、阶段性收官',
};

export default {
  meta: { id: 'tarot', name: 'tarot', description: '抽一张塔罗牌（大阿卡纳，含正逆位与一句话解读）', category: '娱乐' },
  tools: [{
    name: 'qq_tarot',
    description: '抽一张塔罗牌，回答"今天/这件事怎么样"这类问题',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const [name, meaning] = pick(Object.entries(CARDS));
      const upright = randInt(0, 1) === 0;
      return `🃏 抽到【${name}】· ${upright ? '正位' : '逆位'}\n${upright ? meaning : '能量受阻：' + meaning + '——换个角度或先缓一缓。'}\n（塔罗是镜子不是预言，参考即可）`;
    },
  }],
};
