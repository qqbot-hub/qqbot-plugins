/* memo —— 群备忘（按会话分开存） */
'use strict';
import { sessionOf, storage } from './_lib.mjs';

export default {
  meta: { id: 'memo', name: 'memo', description: '群备忘：记待办、看列表、标记完成（按会话分开存）', category: '工具' },
  tools: [
    {
      name: 'qq_memo_add',
      description: '记一条备忘/待办到当前会话',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '备忘内容' },
          group_id: { type: 'number', description: '群号（群聊时传）' },
          user_id: { type: 'number', description: '谁在记（QQ 号）' },
        },
        required: ['text'],
      },
      run: async (args) => {
        const text = String(args.text || '').trim();
        if (!text) return '要记什么呀？';
        const sess = sessionOf(args);
        const st = storage('memo');
        const db = st.get('db', {});
        const list = db[sess.key] || (db[sess.key] = []);
        list.push({ text, done: false, by: sess.userId || 0, at: Date.now() });
        st.set('db', db);
        return `📝 已记下第 ${list.length} 条：「${text}」`;
      },
    },
    {
      name: 'qq_memo_list',
      description: '看当前会话的备忘清单',
      inputSchema: {
        type: 'object',
        properties: { group_id: { type: 'number' }, user_id: { type: 'number' } },
      },
      run: async (args) => {
        const sess = sessionOf(args);
        const list = storage('memo').get('db', {})[sess.key] || [];
        if (!list.length) return '这个会话还没有备忘。';
        return '📋 备忘清单\n' + list.map((m, i) => `${i + 1}. [${m.done ? 'x' : ' '}] ${m.text}`).join('\n');
      },
    },
    {
      name: 'qq_memo_done',
      description: '把第 N 条备忘标记为完成',
      inputSchema: {
        type: 'object',
        properties: {
          index: { type: 'number', description: '第几条（从 1 开始）' },
          group_id: { type: 'number' }, user_id: { type: 'number' },
        },
        required: ['index'],
      },
      run: async (args) => {
        const sess = sessionOf(args);
        const st = storage('memo');
        const db = st.get('db', {});
        const list = db[sess.key] || [];
        const i = Math.trunc(args.index) - 1;
        if (i < 0 || i >= list.length) return `没有第 ${i + 1} 条备忘（现在共 ${list.length} 条）。`;
        list[i].done = true;
        st.set('db', db);
        return `✅ 已完成：「${list[i].text}」`;
      },
    },
  ],
};
