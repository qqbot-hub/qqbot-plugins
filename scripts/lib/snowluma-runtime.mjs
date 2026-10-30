import fs from 'node:fs';
import path from 'node:path';
export function snowRuntime(cfg,root,{enableHookAutoLoad=false}={}){
 const dir=cfg.snowluma?.installDir || cfg.snowluma?.homeDir || path.join(root,'runtimes/snowluma');
 const file=path.join(dir,'config/runtime.json');
 if(!fs.existsSync(file))return {installed:false,hookAutoLoad:null,detail:'未找到 SnowLuma runtime.json，请先完成面板初始化'};
 const j=JSON.parse(fs.readFileSync(file,'utf8'));
 if(enableHookAutoLoad===true && j.hookAutoLoad!==true){fs.copyFileSync(file,file+'.hook-backup');j.hookAutoLoad=true;fs.writeFileSync(file,JSON.stringify(j,null,2));}
 return {installed:true,hookAutoLoad:j.hookAutoLoad===true,detail:j.hookAutoLoad===true?'已配置重启后自动接入 QQ；实际状态以 OneBot 心跳为准':'当前未开启自动接入；可在 SnowLuma 面板手动接入 QQ 进程'};
}
