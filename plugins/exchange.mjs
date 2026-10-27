/* exchange —— 汇率换算（open.er-api.com 免费接口） */
'use strict';
import { httpJson, num } from './_lib.mjs';

export default {
  meta: { id: 'exchange', name: 'exchange', description: '汇率换算：CNY/USD/EUR/JPY/GBP/HKD 等十余种货币', category: '工具' },
  tools: [{
    name: 'qq_rate',
    description: '换算货币，如 100 USD 换成 CNY',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: '金额，默认 1' },
        from: { type: 'string', description: '原币种代码，如 CNY' },
        to: { type: 'string', description: '目标币种代码，如 USD' },
      },
      required: ['from', 'to'],
    },
    run: async ({ amount, from, to }) => {
      const f = String(from || '').toUpperCase().trim();
      const t = String(to || '').toUpperCase().trim();
      const a = Number.isFinite(num(amount)) ? num(amount) : 1;
      try {
        const r = await httpJson('https://open.er-api.com/v6/latest/' + f);
        const rate = r && r.rates && r.rates[t];
        if (!rate) return `没查到 ${f} → ${t}，确认下币种代码（CNY/USD/EUR/JPY/GBP/HKD/KRW...）。`;
        const out = parseFloat((a * rate).toFixed(4));
        return `💱 ${a} ${f} ≈ ${out} ${t}（汇率 ${rate}，来源 er-api 当日中间价）`;
      } catch { return '汇率服务这会儿连不上。'; }
    },
  }],
};
