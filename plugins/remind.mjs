/* remind —— 定时提醒（到点由 Hub 运行时主动通过 OneBot 发消息） */
'use strict';
import { sessionOf, storage, num, str } from './_lib.mjs';
import { bridgeOf } from './_lib.mjs';

/* 主动消息通道由 mcp-server 注入：mcp-server 会调用本插件的 fireDue(ctx) */
let TIMER_STARTED = false;

export function fireDue(ctx) {
  const st = storage('remind');
  const db = st.get('db', {});
  const now = Date.now();
  let changed = false;
  for (const [key, list] of Object.entries(db)) {
    const keep = [];
    for (const r of list) {
      if (r.at <= now) {
        changed = true;
        const [type, id] = key.split(':');
        const msg = `⏰ 提醒到点：${r.text}`;
        try {
          const target = type === 'group' ? { groupId: +id } : { userId: +id };
          bridgeOf(ctx).sendText(target, msg).catch(() => {});
        } catch { /* 没有协议端连接时静默跳过 */ }
      } else keep.push(r);
    }
    if (keep.length) db[key] = keep; else delete db[key];
  }
  if (changed) st.set('db', db);
}

export default {
  meta: { id: 'remind', name: 'remind', description: '定时提醒', category: '工具' },
  fireDue,
  tools: [
    {
      name: 'qq_remind',
      description: '给当前会话设一个定时提醒，到点我会主动发一条消息。适合"20 分钟后提醒我喝水"这类。',
      inputSchema: {
        type: 'object',
        properties: {
          minutes: { type: 'number', description: '多少分钟后提醒（也可以用 seconds/时间点，见下）' },
          seconds: { type: 'number', description: '多少秒后提醒（小间隔时用）' },
          text: { type: 'string', description: '提醒内容' },
          group_id: { type: 'number', description: '群号（群聊时传）' },
          user_id: { type: 'number', description: '提醒谁（私聊时传）' },
        },
        required: ['text'],
      },
      run: (args) => {
        const ms = (num(args.minutes) || 0) * 60000 + (num(args.seconds) || 0) * 1000;
        if (ms <= 0) return '告诉我多少分钟后提醒（minutes 或 seconds）。';
        if (ms > 7 * 86400000) return '最多定 7 天内的提醒。';
        const sess = sessionOf(args);
        const st = storage('remind');
        const db = st.get('db', {});
        const list = db[sess.key] || (db[sess.key] = []);
        list.push({ at: Date.now() + ms, text: str(args.text).slice(0, 60) || '时间到了' });
        st.set('db', db);
        const mins = Math.round(ms / 60000);
        return `⏰ 好的，${mins >= 1 ? mins + ' 分钟' : Math.round(ms / 1000) + ' 秒'}后我会提醒你：「${str(args.text)}」`;
      },
    },
    {
      name: 'qq_remind_list',
      description: '看看当前会话还挂着哪些提醒。',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' } },
      },
      run: (args) => {
        const sess = sessionOf(args);
        const list = storage('remind').get('db', {})[sess.key] || [];
        if (!list.length) return '当前会话没有待触发的提醒。';
        return '⏰ 待触发的提醒：\n' + list.map((r) => {
          const left = Math.max(0, Math.round((r.at - Date.now()) / 60000));
          return `· ${left >= 1 ? left + ' 分钟后' : '马上'}：${r.text}`;
        }).join('\n');
      },
    },
  ],
};
