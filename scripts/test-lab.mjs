import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {ROOT} from './lib/paths.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'market-lab-'));let child,tts;
try{
 for(const name of ['server.js','public','plugins','scripts','data/catalog','node_modules'])fs.cpSync(path.join(ROOT,name),path.join(temp,name),{recursive:true});
 tts=http.createServer(async(req,res)=>{for await(const _ of req){}res.setHeader('content-type','audio/mpeg');res.end(Buffer.alloc(1500,1));});await new Promise(r=>tts.listen(0,'127.0.0.1',r));
 fs.writeFileSync(path.join(temp,'config.json'),JSON.stringify({plugins:{voice:{provider:'openai',baseUrl:'http://127.0.0.1:'+tts.address().port,apiKey:'fixture-secret',speed:1}}}));
 const port=20000+Math.floor(Math.random()*15000),base='http://127.0.0.1:'+port;
 child=spawn(process.execPath,['server.js'],{cwd:temp,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DSH_HOME:path.join(temp,'dsh'),QQBOT_STATE_FILE:path.join(temp,'state.json'),QQBOT_JOBS_FILE:path.join(temp,'jobs.json'),QQBOT_SECRET_PASSPHRASE:'fixture'},stdio:'ignore',windowsHide:true});
 for(let i=0;i<60;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.equal((await fetch(base+'/lab/')).status,200);assert.equal((await (await fetch(base+'/api/lab/status')).json()).mode,'builtin');
 let r=await fetch(base+'/api/lab/config');assert.equal(r.status,200);let j=await r.json();assert.equal(j.apiKey,'');assert.equal(j.__configured.apiKey,true);
 const post=(p,b,origin=base)=>fetch(base+p,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(b)});
 assert.equal((await post('/api/lab/preview',{text:'test'},'https://evil.invalid')).status,403);
 assert.equal((await post('/api/lab/config',{provider:'openai',speed:1.1,apiKey:''})).status,200);
 assert.equal((await (await fetch(base+'/api/lab/config')).json()).__configured.apiKey,true,'blank key preserves secret');
 r=await post('/api/lab/preview',{text:'test'});assert.equal(r.status,200);j=await r.json();assert.equal(Buffer.from(j.audio,'base64').length,1500);
 assert.equal((await post('/api/lab/preview',{text:'test'})).status,429);
 r=await post('/api/deploy/reload',{});assert.equal(r.status,200);
 const page=await (await fetch(base+'/')).text();assert.ok(page.indexOf('class="community-first"')<page.indexOf('<section class="hero"'));assert.equal((page.match(/id="joinBtn"/g)||[]).length,1);
 console.log('PASS isolated lab routes, API-key masking/preservation, Origin checks, preview audio and rate limit, cooperative reload, first-screen markup');
}finally{if(child){const done=once(child,'exit');child.kill();await done;}if(tts){tts.closeAllConnections();await new Promise(r=>tts.close(r));}fs.rmSync(temp,{recursive:true,force:true});}
