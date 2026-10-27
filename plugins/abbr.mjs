/* abbr —— 拼音缩写查询（nbnhhsh 能不能好好说话 API） */
'use strict';
import { httpJson } from './_lib.mjs';

export default {
  meta: { id: 'abbr', name: 'abbr', description: '缩写查询：yyds、xswl 这种拼音缩写是什么意思', category: '工具' },
  tools: [{
    name: 'qq_abbr',
    description: '查一个拼音缩写的意思',
    inputSchema: {
      type: 'object',
      properties: { abbr: { type: 'string', description: '缩写，如 yyds' } },
      required: ['abbr'],
    },
    run: async ({ abbr }) => {
      const a = String(abbr || '').trim().toLowerCase();
      if (!/^[a-z0-9]{2,10}$/.test(a)) return '缩写一般是 2-10 个字母，比如 yyds。';
      try {
        const r = await httpJson('https://lab.magiconch.com/api/nbnhhsh/guess/', { method: 'POST', body: 'text=' + a, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const hit = Array.isArray(r) && r[0];
        const trans = hit && hit.trans && hit.trans.length ? hit.trans : null;
        if (trans) return `🔤 ${a} = ${trans.slice(0, 5).join(' / ')}`;
        const input = hit && hit.inputting && hit.inputting.length ? hit.inputting : null;
        if (input) return `🔤 ${a} 可能是：${input.slice(0, 5).join(' / ')}（不太确定）`;
        return `没查到「${a}」，可能太新了。`;
      } catch { return '缩写库这会儿连不上。'; }
    },
  }],
};
