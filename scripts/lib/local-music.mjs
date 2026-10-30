import fs from 'node:fs';
import path from 'node:path';
export async function localMusic(cfg,args,onebot){
 if(!cfg.musicDir)throw new Error('先在点歌插件配置 musicDir（你有权分享的本地音乐目录）');
 const root=fs.realpathSync(cfg.musicDir);let name=String(args.local_file || '');
 if(!name && args.song){const q=String(args.song).trim().toLocaleLowerCase();if(!q)return null;name=fs.readdirSync(root).filter(n=>/\.(mp3|wav|ogg)$/i.test(n) && n.toLocaleLowerCase().includes(q)).sort((a,b)=>a.localeCompare(b))[0] || '';if(!name)return null;}
 if(!name || /[:\\/]/.test(name) || path.basename(name)!==name || !/\.(mp3|wav|ogg)$/i.test(name))throw new Error('只允许音乐目录内的 mp3/wav/ogg 文件名');
 const target=fs.realpathSync(path.join(root,name)), rel=path.relative(root,target);
 if(rel.startsWith('..') || path.isAbsolute(rel))throw new Error('拒绝访问音乐目录外文件');
 const fd=fs.openSync(target,'r');let data;
 try {const stat=fs.fstatSync(fd);if(!stat.isFile() || stat.size>8*1024*1024)throw new Error('音乐须为不超过8MB的普通文件');data=Buffer.alloc(stat.size);let offset=0;while(offset<data.length){const n=fs.readSync(fd,data,offset,data.length-offset,null);if(!n)break;offset+=n;}data=data.subarray(0,offset);} finally{fs.closeSync(fd);}
 const gid=Number(args.group_id)||0,uid=Number(args.user_id)||0;
 if(!Number.isSafeInteger(gid>0?gid:uid) || (gid<=0 && uid<=0))throw new Error('缺少有效 group_id 或 user_id');
 const message=[{type:'record',data:{file:'base64://'+data.toString('base64')}}];
 await onebot(gid>0?'send_group_msg':'send_private_msg',gid>0?{group_id:gid,message}:{user_id:uid,message});
 return '音乐已提交协议端：'+name+'；播放与转码仍取决于协议端支持';
}
