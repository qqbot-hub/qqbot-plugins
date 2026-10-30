import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
export function findFfmpeg(cfg={},env=process.env,run=spawnSync){
 const candidates=[cfg.ffmpegPath,...String(env.PATH || '').split(path.delimiter).map(p=>path.join(p,process.platform==='win32'?'ffmpeg.exe':'ffmpeg'))].filter(Boolean);
 for(const file of candidates){if(!fs.existsSync(file))continue;try{const r=run(file,['-version'],{encoding:'utf8',timeout:3000,windowsHide:true});if(r.status===0 && /^ffmpeg version /m.test(r.stdout || ''))return {path:file,version:r.stdout.split('\n')[0]};}catch{}}
 return null;
}
