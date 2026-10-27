/* signin —— 群签到：积分、连续天数、排行榜 */
'use strict';
import { sessionOf, todayKey, storage } from './_lib.mjs';

export default {
  meta: { id: 'signin', name: 'signin', description: '群签到：每天签一次攒积分、连续签到天数、积分排行榜', category: '群互动' },
  tools: [
    {
      name: 'qq_signin',
      description: '帮群友签到（同一个人一天只能签一次，连续签到加分更多）',
      inputSchema: {
        type: 'object',
        properties: {
          group_id: { type: 'number', description: '群号' },
          user_id: { type: 'number', description: '签到的人的 QQ 号' },
        },
        required: ['group_id', 'user_id'],
      },
      run: async (args) => {
        const sess = sessionOf(args);
        if (!sess.userId) return '缺 user_id，签到要记到人头上。';
        const st = storage('signin');
        const db = st.get('db', {});
        const gkey = sess.key;
        const uk = String(sess.userId);
        const db2 = db[gkey] || (db[gkey] = {});
        const today = todayKey();
        const rec = db2[uk] || { points: 0, streak: 0, last: '' };
        if (rec.last === today) return '今天已经签过啦，明天再来（当前积分 ' + rec.points + '）。';
        rec.streak = rec.last ? (rec.streak || 0) + 1 : 1;
        const gain = 5 + Math.min(rec.streak, 10) * 2;
        rec.points += gain;
        rec.last = today;
        db2[uk] = rec;
        st.set('db', db);
        return `✅ 签到成功！+${gain} 积分（连续 ${rec.streak} 天）\n当前总积分：${rec.points}`;
      },
    },
    {
      name: 'qq_signin_rank',
      description: '看群里的签到积分排行榜',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number', description: '群号' } },
        required: ['group_id'],
      },
      run: async ({ group_id }) => {
        const db = storage('signin').get('db', {})['group:' + group_id] || {};
        const rows = Object.entries(db).sort((a, b) => b[1].points - a[1].points).slice(0, 10);
        if (!rows.length) return '这个群还没人签到过。';
        return '🏆 签到积分榜\n' + rows.map(([uk, r], i) => `${i + 1}. QQ${uk} — ${r.points} 分（连续 ${r.streak} 天）`).join('\n');
      },
    },
  ],
};
