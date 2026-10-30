import voice from '../../plugins/voice.mjs';
export async function previewVoice(cfg, text) {
  if(typeof text !== 'string' || !text.trim() || text.length>100) throw new Error('试听文字须为1至100字');
  let audio;
  const result=await voice.tools[0].run({text,user_id:1},{cfg,bridge:{sendRecord:async(_target,b64)=>{const buffer=Buffer.from(b64,'base64');if(buffer.length>8*1024*1024)throw new Error('音频超过8MB');audio=buffer;}}});
  if(!audio)throw new Error(result || '没有生成音频');
  return {audio:audio.toString('base64'),mime:(cfg.provider || 'baidu')==='baidu'?'audio/mpeg':cfg.provider==='voxd' || cfg.format==='wav'?'audio/wav':cfg.format==='opus'?'audio/ogg':'audio/mpeg'};
}
export async function localBackends(fetcher=fetch){
  const candidates=[{id:'ollama',url:'http://127.0.0.1:11434/api/tags',valid:j=>Array.isArray(j.models),models:j=>j.models.map(m=>m.name)}, {id:'breeze',url:'http://127.0.0.1:8080/v1/models',valid:j=>Array.isArray(j.data),models:j=>j.data.map(m=>m.id)}, {id:'voxd',url:'http://127.0.0.1:8765/health',valid:j=>j.status==='ok' && /voxd|surfcore/i.test(JSON.stringify(j)),models:()=>[]}];
  return Promise.all(candidates.map(async c=>{try{const r=await fetcher(c.url,{signal:AbortSignal.timeout(1500)});const j=await r.json();return {id:c.id,online:r.ok && c.valid(j),models:c.models(j)};}catch{return {id:c.id,online:false,models:[]};}}));
}
