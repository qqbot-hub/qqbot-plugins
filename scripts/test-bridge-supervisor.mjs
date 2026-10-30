import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { ROOT } from './lib/paths.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-supervisor-'));
fs.mkdirSync(path.join(temp, 'src'));
fs.writeFileSync(path.join(temp, 'config.json'), '{}');
fs.writeFileSync(path.join(temp, 'src/bridge.js'), "const fs=require('node:fs');fs.appendFileSync('starts.txt',process.pid+'\\n');setInterval(()=>{},1000);");
const child = spawn(process.execPath, ['scripts/bridge-supervisor.mjs', temp], { cwd: ROOT, stdio: 'ignore', windowsHide: true });
const wait = async count => {
  for (let i = 0; i < 100; i++) {
    try { const ids = fs.readFileSync(path.join(temp, 'starts.txt'), 'utf8').trim().split('\n'); if (ids.length >= count) return ids; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Supervisor did not start/reload');
};
let ids = [];
try {
  ids = await wait(1);
  fs.writeFileSync(path.join(temp, 'config.json'), '{bad-json');
  await new Promise(r => setTimeout(r, 2200));
  assert.equal(fs.readFileSync(path.join(temp, 'starts.txt'), 'utf8').trim().split('\n').length, 1);
  fs.writeFileSync(path.join(temp, 'config.json'), '{"changed":true}');
  ids = await wait(2);
  assert.notEqual(ids[0], ids[1]);
  assert.throws(() => process.kill(Number(ids[0]), 0));
  console.log('PASS: bridge supervisor preserves child on invalid JSON and restarts only its own child after valid config changes.');
} finally {
  const done = once(child, 'exit'); child.kill(); await done;
  // Windows force-termination cannot run signal handlers; clean up only this test child.
  for (const pid of ids) { try { process.kill(Number(pid)); } catch {} }
  await new Promise(r => setTimeout(r, 150));
  fs.rmSync(temp, { recursive: true, force: true });
}
