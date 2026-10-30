import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-public-test-'));
const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, HOST: '0.0.0.0', PORT: String(port), QQBOT_STATE_FILE: path.join(temp, 'state.json'), QQBOT_JOBS_FILE: path.join(temp, 'jobs.json') },
  stdio: ['ignore','pipe','pipe'],
});
let startup='';child.stdout.on('data',c=>startup+=c);child.stderr.on('data',c=>startup+=c);

try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if(child.exitCode!==null)break;
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { ready = true; break; } } catch {}
    await sleep(100);
  }
  assert.equal(ready, true, 'public test server starts: '+startup.slice(-1500));
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.status, 200, 'public health endpoint remains readable');
  const settings = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(settings.status, 403, 'public settings mutation is blocked without a password');
  const operation = await fetch(`http://127.0.0.1:${port}/api/op`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'install', id: 'clock' }) });
  assert.equal(operation.status, 403, 'public plugin operations are blocked without a password');
  for(const endpoint of ['/api/lab/config','/api/lab/preview','/api/deploy/reload','/api/deploy/qzone-probe','/api/deploy/snowluma-runtime']){
    const response=await fetch(`http://127.0.0.1:${port}`+endpoint,{method:'POST',headers:{'Content-Type':'application/json',origin:`http://127.0.0.1:${port}`},body:'{}'});assert.equal(response.status,403,endpoint+' blocked on public binding');
  }
  console.log('公网无口令时健康读取可用，设置和插件操作均拒绝。');
} finally {
  child.kill();
  fs.rmSync(temp, { recursive: true, force: true });
}
