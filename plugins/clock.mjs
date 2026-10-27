/* clock —— 报时：现在几点、今天/本周还剩多少 */
'use strict';

export default {
  meta: { id: 'clock', name: 'clock', description: '报时：现在几点、今天还剩多少、本周还剩多少', category: '工具' },
  tools: [{
    name: 'qq_clock',
    description: '看看现在几点、离下班还有多久',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999);
      const day = now.getDay();
      const daysLeft = day === 0 || day === 6 ? 0 : 5 - day;
      const mins = Math.round((endOfDay - now) / 60000);
      const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][day];
      return `🕒 现在是 ${week} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}\n今天还剩 ${Math.floor(mins / 60)} 小时 ${mins % 60} 分钟\n距离周末还有 ${daysLeft} 个工作日`;
    },
  }],
};
