/* 离线自测用的假模型：不花钱、不出网。
 * 用法：node tools/mock-upstream.mjs  （监听 8799）
 * 然后把 gateway.config.json 的 upstream.baseUrl 指到 http://127.0.0.1:8799/v1
 * 它会把你发给它的请求体原样存到 captured-upstream.json，用来检查记忆有没有注入。
 */
import http from 'node:http';
import fs from 'node:fs';
http.createServer((req,res)=>{
  let b=''; req.on('data',c=>b+=c);
  req.on('end',()=>{
    fs.writeFileSync('captured-upstream.json', b||'{}');
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({id:'mock',object:'chat.completion',model:'mock',
      choices:[{index:0,message:{role:'assistant',content:'好呀'},finish_reason:'stop'}],
      usage:{prompt_tokens:50,completion_tokens:5,total_tokens:55}}));
  });
}).listen(8799,'127.0.0.1',()=>console.log('mock upstream 8799'));
