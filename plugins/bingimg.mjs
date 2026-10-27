/* bingimg —— Bing 每日一图（微软公开 HPImageArchive） */
'use strict';
import { httpJson } from './_lib.mjs';

export default {
  meta: { id: 'bingimg', name: 'bingimg', description: 'Bing 每日一图：给你当天的壁纸直链', category: '工具' },
  tools: [{
    name: 'qq_bingimg',
    description: '拿今天的 Bing 每日一图',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      try {
        const r = await httpJson('https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1');
        const img = r && r.images && r.images[0];
        if (!img) return '今天没拿到图，稍后再试。';
        const url = 'https://cn.bing.com' + img.url;
        return `🖼️ Bing 每日一图（${img.enddate}）\n「${img.copyright}」\n${url}`;
      } catch { return 'Bing 接口这会儿连不上。'; }
    },
  }],
};
