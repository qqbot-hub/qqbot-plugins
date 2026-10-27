/* jukebox —— 点歌：把歌名变成音乐平台搜索链接（不抓版权音频） */
'use strict';

export default {
  meta: { id: 'jukebox', name: 'jukebox', description: '点歌：把歌名变成网易云 / QQ音乐 / 酷狗的搜索链接', category: '工具' },
  tools: [{
    name: 'qq_jukebox',
    description: '点歌，返回可以直接点开的搜索链接（不抓音频版权内容）',
    inputSchema: {
      type: 'object',
      properties: { song: { type: 'string', description: '歌名（可带歌手，如 晴天 周杰伦）' } },
      required: ['song'],
    },
    run: async ({ song }) => {
      const s = String(song || '').trim();
      if (!s) return '想听什么歌？报个歌名。';
      const q = encodeURIComponent(s);
      return `🎵 「${s}」在这儿听：\n网易云：https://music.163.com/#/search/m/?s=${q}\nQQ音乐：https://y.qq.com/n/ryqq/search?w=${q}\n酷狗：https://www.kugou.com/yy/html/search.html#searchType=song&searchKeyword=${q}`;
    },
  }],
};
