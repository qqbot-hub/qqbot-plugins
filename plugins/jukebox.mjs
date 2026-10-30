/* jukebox —— 点歌：把歌名变成音乐平台搜索链接（不抓版权音频） */
'use strict';
import { bridgeOf } from './_lib.mjs';

export default {
  meta: { permissions:['file:read','message:send'], id: 'jukebox', name: 'jukebox', description: '点歌：把歌名变成网易云 / QQ音乐 / 酷狗的搜索链接', category: '工具' },
  settings:{title:'本地音乐',intro:'仅分享你有权使用的音乐；不抓取平台音频。',fields:[{key:'musicDir',label:'允许的本地音乐目录',type:'text'},{key:'ffmpegPath',label:'可选ffmpeg路径',type:'text'}]},
  tools: [{
    name: 'qq_jukebox',
    description: '点歌：已配置本地音乐目录且提供发送目标时按歌名匹配音频发送；未匹配则返回平台搜索链接。不抓平台音频。也可用local_file精确文件名。',
    inputSchema: {
      type: 'object',
      properties: { local_file:{type:'string',description:'允许目录中的mp3/wav/ogg文件名，最多8MB'},group_id:{type:'number'},user_id:{type:'number'},song: { type: 'string', description: '歌名（可带歌手，如 晴天 周杰伦）' } },
      required: [],
    },
    run: async (args,ctx) => {
      const {song}=args;
      if(args.local_file || (ctx?.cfg?.musicDir && song && (args.group_id || args.user_id))){
        if(ctx.localMusic){const result=await ctx.localMusic(args);if(result)return result;}else{
        const {localMusic}=await import('../scripts/lib/local-music.mjs');
        const result=await localMusic(ctx.cfg||{},args,(action,params)=>bridgeOf(ctx).raw(action,params));if(result)return result;
        }
      }
      const s = String(song || '').trim();
      if (!s) return '想听什么歌？报个歌名。';
      const q = encodeURIComponent(s);
      return `🎵 「${s}」在这儿听：\n网易云：https://music.163.com/#/search/m/?s=${q}\nQQ音乐：https://y.qq.com/n/ryqq/search?w=${q}\n酷狗：https://www.kugou.com/yy/html/search.html#searchType=song&searchKeyword=${q}`;
    },
  }],
};
