import fs from 'node:fs';
import path from 'node:path';
export default {id:'voicelab',title:'内置语音调音台',kind:'companion',steps:[{key:'verify',title:'检查调音台',async run(ctx){
if(ctx.cfg().lab?.url && ctx.cfg().lab?.mode!=='builtin'){const r=await ctx.httpGet(ctx.cfg().lab.url+'/api/state',3000);return {status:r.ok?'ok':'manual',detail:r.ok?'外部调音台在线':'外部调音台未通过接口检查；移除 lab.url 可用内置版本'};}
const file=path.join(ctx.paths.root,'public/voice-lab.html');return {status:fs.existsSync(file)?'ok':'fail',detail:fs.existsSync(file)?'内置调音台随市场运行，打开 /lab/ 即可':'发布包缺少调音台页面'};
}}]};
