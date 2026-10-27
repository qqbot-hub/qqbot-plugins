/* birthday —— 生日/纪念日倒计时 */
'use strict';
import { sessionOf, storage, str, num } from './_lib.mjs';

function daysUntil(month, day) {
  const now = new Date();
  let target = new Date(now.getFullYear(), month - 1, day);
  if (target < new Date(now.getFullYear(), now.getMonth(), now.getDate())) target = new Date(now.getFullYear() + 1, month - 1, day);
  return Math.round((target - now) / 86400000);
}

export default {
  meta: { id: 'birthday', name: 'birthday', description: '生日/纪念日倒计时：记下来，随时问还有几天', category: '工具' },
  tools: [
    {
      name: 'qq_birthday_add',
      description: '记一个生日或纪念日（月-日）',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '给这个日子起个名，如 老王生日' },
          date: { type: 'string', description: '日期，格式 月-日，如 3-14' },
          group_id: { type: 'number' }, user_id: { type: 'number' },
        },
        required: ['name', 'date'],
      },
      run: (args) => {
        const m = /^(\d{1,2})[-/月](\d{1,2})/.exec(str(args.date));
        if (!m) return '日期格式是 月-日，比如 3-14。';
        const month = +m[1], day = +m[2];
        if (month < 1 || month > 12 || day < 1 || day > 31) return '这个日期不合法。';
        const sess = sessionOf(args);
        const st = storage('birthday');
        const db = st.get('db', {});
        const list = db[sess.key] || (db[sess.key] = []);
        list.push({ name: str(args.name).slice(0, 20), month, day });
        st.set('db', db);
        return `🎂 已记下「${args.name}」：每年 ${month} 月 ${day} 日（今年还有 ${daysUntil(month, day)} 天）`;
      },
    },
    {
      name: 'qq_birthday_list',
      description: '看记过的日子还有几天',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' } },
      },
      run: (args) => {
        const sess = sessionOf(args);
        const list = storage('birthday').get('db', {})[sess.key] || [];
        if (!list.length) return '还没记过任何日子。';
        const rows = list.map((r) => ({ ...r, left: daysUntil(r.month, r.day) })).sort((a, b) => a.left - b.left);
        return '🎂 倒计时\n' + rows.map((r) => `· ${r.name}（${r.month}-${r.day}）：还有 ${r.left} 天`).join('\n');
      },
    },
  ],
};
