/* baseconv —— 进制转换 */
'use strict';
import { num, str } from './_lib.mjs';

export default {
  meta: { id: 'baseconv', name: 'baseconv', description: '进制转换：2/8/10/16 进制互转', category: '工具' },
  tools: [{
    name: 'qq_base',
    description: '把数字在进制之间转换',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string', description: '要转换的值，如 ff 或 255' },
        from: { type: 'number', description: '原进制（2/8/10/16），默认 10' },
        to: { type: 'number', description: '目标进制（2/8/10/16），默认 16' },
      },
      required: ['value'],
    },
    run: async ({ value, from, to }) => {
      const f = num(from) || 10, t = num(to) || 16;
      if (![2, 8, 10, 16].includes(f) || ![2, 8, 10, 16].includes(t)) return '只支持 2/8/10/16 进制。';
      const n = parseInt(String(value).trim(), f);
      if (Number.isNaN(n)) return `「${value}」不是合法的 ${f} 进制数。`;
      return `${value}（${f} 进制）= ${n.toString(t).toUpperCase()}（${t} 进制）`;
    },
  }],
};
