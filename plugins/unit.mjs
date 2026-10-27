/* unit —— 单位换算 */
'use strict';
import { num } from './_lib.mjs';

/* 各类别：单位 -> 换算到基准的倍数（温度特殊处理） */
const TABLE = {
  长度: { mm: 0.001, cm: 0.01, m: 1, km: 1000, inch: 0.0254, ft: 0.3048, 尺: 1 / 3, 里: 500 },
  重量: { mg: 1e-6, g: 0.001, kg: 1, t: 1000, 斤: 0.5, 两: 0.05, oz: 0.0283495, lb: 0.453592 },
  体积: { ml: 0.001, l: 1, 加仑: 3.78541, 杯: 0.24 },
  温度: { '°C': 1, '°F': 1, K: 1 },
};

function convert(v, from, to) {
  for (const [cat, units] of Object.entries(TABLE)) {
    const fl = Object.keys(units).find((u) => u.toLowerCase() === from.toLowerCase());
    const tl = Object.keys(units).find((u) => u.toLowerCase() === to.toLowerCase());
    if (fl && tl) {
      if (cat === '温度') {
        const c = fl === '°C' ? v : fl === '°F' ? (v - 32) * 5 / 9 : v - 273.15;
        const out = tl === '°C' ? c : tl === '°F' ? c * 9 / 5 + 32 : c + 273.15;
        return { out, cat, fl, tl };
      }
      return { out: (v * units[fl]) / units[tl], cat, fl, tl };
    }
  }
  return null;
}

export default {
  meta: { id: 'unit', name: 'unit', description: '单位换算：长度/重量/体积/温度，比如 5 尺是多少米', category: '工具' },
  tools: [{
    name: 'qq_unit',
    description: '换算一个单位。支持长度(mm/cm/m/km/inch/ft/尺/里)、重量(g/kg/t/斤/两/lb/oz)、体积(ml/l)、温度(°C/°F/K)',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'number', description: '数值' },
        from: { type: 'string', description: '原单位，如 尺' },
        to: { type: 'string', description: '目标单位，如 m' },
      },
      required: ['value', 'from', 'to'],
    },
    run: async ({ value, from, to }) => {
      const v = num(value);
      if (!Number.isFinite(v)) return '数值不合法。';
      const r = convert(v, String(from), String(to));
      if (!r) return `不支持 ${from} → ${to}。可用类别：长度、重量、体积、温度。`;
      const out = parseFloat(r.out.toFixed(6));
      return `${v} ${r.fl} = ${out} ${r.tl}（${r.cat}）`;
    },
  }],
};
