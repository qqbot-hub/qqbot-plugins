/* ledger —— 群记账 */
'use strict';
import { sessionOf, todayKey, storage, num } from './_lib.mjs';

export default {
  meta: { id: 'ledger', name: 'ledger', description: '群记账：记一笔花销或收入，随时看这个月花了多少', category: '工具' },
  tools: [
    {
      name: 'qq_ledger_add',
      description: '记一笔账（正数=花销，负数=收入）',
      inputSchema: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: '金额' },
          note: { type: 'string', description: '用途，如 午饭' },
          group_id: { type: 'number' }, user_id: { type: 'number' },
        },
        required: ['amount'],
      },
      run: async (args) => {
        const a = num(args.amount);
        if (!Number.isFinite(a) || a === 0) return '金额要是个不为 0 的数。';
        const sess = sessionOf(args);
        const st = storage('ledger');
        const db = st.get('db', {});
        const list = db[sess.key] || (db[sess.key] = []);
        list.push({ amount: a, note: String(args.note || '').slice(0, 30), by: sess.userId || 0, day: todayKey() });
        st.set('db', db);
        return `💰 已记账：${a > 0 ? '支出' : '收入'} ${Math.abs(a)} 元${args.note ? '（' + args.note + '）' : ''}`;
      },
    },
    {
      name: 'qq_ledger_list',
      description: '看这个月的账目汇总',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' } },
      },
      run: async (args) => {
        const sess = sessionOf(args);
        const list = storage('ledger').get('db', {})[sess.key] || [];
        const month = todayKey().slice(0, 7);
        const rows = list.filter((r) => r.day.startsWith(month));
        if (!rows.length) return `这个月（${month}）还没记过账。`;
        const spend = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
        const income = rows.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0);
        return `📒 ${month} 账单\n支出合计 ${spend.toFixed(2)} 元，收入合计 ${income.toFixed(2)} 元，净 ${(-spend + income).toFixed(2)} 元\n最近 5 笔：\n` +
          rows.slice(-5).map((r) => `· ${r.day} ${r.amount > 0 ? '-' : '+'}${Math.abs(r.amount)} ${r.note || ''}`).join('\n');
      },
    },
  ],
};
