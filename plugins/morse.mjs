/* morse —— 摩斯电码互转 */
'use strict';
const M2C = { '.-': 'A', '-...': 'B', '-.-.': 'C', '-..': 'D', '.': 'E', '..-.': 'F', '--.': 'G', '....': 'H', '..': 'I', '.---': 'J', '-.-': 'K', '.-..': 'L', '--': 'M', '-.': 'N', '---': 'O', '.--.': 'P', '--.-': 'Q', '.-.': 'R', '...': 'S', '-': 'T', '..-': 'U', '...-': 'V', '.--': 'W', '-..-': 'X', '-.--': 'Y', '--..': 'Z', '-----': '0', '.----': '1', '..---': '2', '...--': '3', '....-': '4', '.....': '5', '-....': '6', '--...': '7', '---..': '8', '----.': '9' };
const C2M = Object.fromEntries(Object.entries(M2C).map(([k, v]) => [v, k]));

export default {
  meta: { id: 'morse', name: 'morse', description: '摩斯电码：文字与 ·— 互转', category: '工具' },
  tools: [{
    name: 'qq_morse',
    description: '把文字转成摩斯电码（或反过来）',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要转换的内容：普通文字 → 电码；电码（用空格分组）→ 文字' },
      },
      required: ['text'],
    },
    run: async ({ text }) => {
      const s = String(text || '').trim();
      if (!s) return '给我点内容呀。';
      if (/^[.\- ]+$/.test(s)) {
        const out = s.split(/\s+/).map((c) => M2C[c] || '?').join('');
        return `📱 解码结果：${out}`;
      }
      const out = s.toUpperCase().split('').map((ch) => (ch === ' ' ? '/' : C2M[ch] || '')).filter(Boolean).join(' ');
      return `📡 摩斯电码：${out}`;
    },
  }],
};
