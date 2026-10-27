/* bilihot —— B 站热门排行（B 站公开 popular API） */
'use strict';
import { httpJson } from './_lib.mjs';

export default {
  meta: { id: 'bilihot', name: 'bilihot', description: 'B站热搜/热门排行，看看今天大家在刷什么', category: '工具' },
  tools: [{
    name: 'qq_bilihot',
    description: '看 B 站热门前几名',
    inputSchema: {
      type: 'object',
      properties: { count: { type: 'number', description: '列几条，默认 5，最多 10' } },
    },
    run: async ({ count }) => {
      const n = Math.min(Math.max(Math.trunc(count || 5), 1), 10);
      try {
        const r = await httpJson('https://api.bilibili.com/x/web-interface/popular?ps=20', { headers: { Referer: 'https://www.bilibili.com' } });
        const list = r && r.data && r.data.list;
        if (!list || !list.length) return 'B 站接口没返回数据，稍后再试。';
        return '📺 B站热门 TOP' + n + '\n' + list.slice(0, n)
          .map((v, i) => `${i + 1}. ${v.title}\n   ▶ ${v.stat.view.toLocaleString()} 播放  https://b23.tv/av${v.aid}`)
          .join('\n');
      } catch { return 'B 站接口这会儿连不上。'; }
    },
  }],
};
