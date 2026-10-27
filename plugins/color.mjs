/* color —— 随机颜色卡 */
'use strict';
import { randInt } from './_lib.mjs';
const NAMES = ['樱粉', '天青', '薄荷', '鹅黄', '藕荷', '黛蓝', '橘橙', '竹青', '绯红', '月白'];

export default {
  meta: { id: 'color', name: 'color', description: '随机颜色卡：给一个颜色和 hex/RGB 值', category: '工具' },
  tools: [{
    name: 'qq_color',
    description: '随机生成一个颜色',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const r = randInt(0, 255), g = randInt(0, 255), b = randInt(0, 255);
      const hex = '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
      return `🎨 ${hex}\nRGB(${r}, ${g}, ${b})\n色名随缘：${NAMES[randInt(0, NAMES.length - 1)]}`;
    },
  }],
};
