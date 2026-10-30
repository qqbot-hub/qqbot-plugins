import fs from 'node:fs';
import path from 'node:path';
import {findFfmpeg} from '../scripts/lib/ffmpeg.mjs';
export default {id:'ffmpeg',title:'可选音频转码器',kind:'companion',steps:[{key:'verify',title:'发现并自检 ffmpeg',async run(ctx){
 const found=findFfmpeg(ctx.cfg().plugins?.jukebox || {});
 if(!found)return {status:'manual',detail:'未发现通过 -version 自检的 ffmpeg；音乐可降级为搜索链接',hint:'在系统软件管理器安装 FFmpeg 并加入 PATH 后继续；也可配置 plugins.jukebox.ffmpegPath。不会下载未验证的二进制。'};
 const file=ctx.cfg().bridge?.dir && path.join(ctx.cfg().bridge.dir,'config.json');
 if(file && fs.existsSync(file)){const j=JSON.parse(fs.readFileSync(file,'utf8'));j.socialV2={...j.socialV2,voice:{...j.socialV2?.voice,ffmpegPath:found.path}};fs.copyFileSync(file,file+'.ffmpeg-backup');fs.writeFileSync(file,JSON.stringify(j,null,2));}
 return {status:'ok',detail:found.version};
}}]};
