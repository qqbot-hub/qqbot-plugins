/* pomodoro —— 番茄钟（到点由 fireDue 主动通知） */
'use strict';
import { sessionOf, storage, num } from './_lib.mjs';

export function fireDue(ctx) {
  const st = storage('pomodoro');
  const db = st.get('db', {});
  const now = Date.now();
  let changed = false;
  for (const [key, p] of Object.entries(db)) {
    if (p.endAt && p.endAt <= now) {
      changed = true;
      p.endAt = 0;
      const [type, id] = key.split(':');
      if (ctx && ctx.onebot) {
        const action = type === 'group' ? 'send_group_msg' : 'send_private_msg';
        const params = type === 'group' ? { group_id: +id, message: '🍅 番茄钟到点！休息 5 分钟吧。' } : { user_id: +id, message: '🍅 番茄钟到点！休息 5 分钟吧。' };
        ctx.onebot(action, params).catch(() => {});
      }
    }
  }
  if (changed) st.set('db', db);
}

export default {
  meta: { id: 'pomodoro', name: 'pomodoro', description: '番茄钟：定一个专注时间，问它还剩多久（到点会告诉你）', category: '工具' },
  fireDue,
  tools: [
    {
      name: 'qq_pomodoro_start',
      description: '开始一个番茄钟（默认 25 分钟）',
      inputSchema: {
        type: 'object',
        properties: {
          minutes: { type: 'number', description: '专注时长（分钟），默认 25，范围 5-90' },
          group_id: { type: 'number' }, user_id: { type: 'number' },
        },
      },
      run: (args) => {
        const mins = Math.min(Math.max(Math.trunc(num(args.minutes) || 25), 5), 90);
        const sess = sessionOf(args);
        storage('pomodoro').set('db', { ...storage('pomodoro').get('db', {}), [sess.key]: { endAt: Date.now() + mins * 60000 } });
        return `🍅 番茄钟启动：专注 ${mins} 分钟，到点我叫你。开始吧！`;
      },
    },
    {
      name: 'qq_pomodoro_check',
      description: '看番茄钟还剩多久',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' } },
      },
      run: (args) => {
        const sess = sessionOf(args);
        const p = storage('pomodoro').get('db', {})[sess.key];
        if (!p || !p.endAt) return '没有进行中的番茄钟。说一声就帮你开一个。';
        const left = Math.round((p.endAt - Date.now()) / 60000);
        return left > 0 ? `🍅 还剩约 ${left} 分钟，稳住。` : '🍅 刚好到点，休息一下吧！';
      },
    },
  ],
};
