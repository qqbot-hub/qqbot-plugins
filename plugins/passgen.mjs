/* passgen —— 随机密码生成 */
'use strict';
import { randInt } from './_lib.mjs';

const SETS = { lower: 'abcdefghijkmnpqrstuvwxyz', upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ', digit: '23456789', symbol: '!@#$%^&*?' };

export default {
  meta: { id: 'passgen', name: 'passgen', description: '随机密码生成：长度可调，避开容易看混的字符', category: '工具' },
  tools: [{
    name: 'qq_passgen',
    description: '生成一个随机密码',
    inputSchema: {
      type: 'object',
      properties: {
        length: { type: 'number', description: '密码长度，默认 16，范围 8-64' },
        symbols: { type: 'boolean', description: '是否包含符号，默认 true' },
      },
    },
    run: async ({ length, symbols }) => {
      const len = Math.min(Math.max(Math.trunc(length || 16), 8), 64);
      const pool = SETS.lower + SETS.upper + SETS.digit + (symbols === false ? '' : SETS.symbol);
      let out = '';
      for (let i = 0; i < len; i++) out += pool[randInt(0, pool.length - 1)];
      return `🔐 随机密码（${len} 位，已排除 0/O/1/l 等易混字符）：\n${out}\n（发完记得删聊天记录，别用在重要账号上）`;
    },
  }],
};
