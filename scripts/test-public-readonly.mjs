import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-public-test-'));
const port = 3800 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: { ...process.env, HOST: '0.0.0.0', PORT: String(port), QQBOT_STATE_FILE: path.join(temp, 'state.json'), QQBOT_JOBS_FILE: path.join(temp, 'jobs.json') },
  stdio: 'ignore',
});

try {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { ready = true; break; } } catch {}
    await sleep(100);
  }
  assert.equal(ready, true, 'public test server starts');
  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(health.status, 200, 'public health endpoint remains readable');
  const settings = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(settings.status, 403, 'public settings mutation is blocked without a password');
  const operation = await fetch(`http://127.0.0.1:${port}/api/op`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'install', id: 'clock' }) });
  assert.equal(operation.status, 403, 'public plugin operations are blocked without a password');
  console.log('公网无口令时健康读取可用，设置和插件操作均拒绝。');
} finally {
  child.kill();
  fs.rmSync(temp, { recursive: true, force: true });
}
