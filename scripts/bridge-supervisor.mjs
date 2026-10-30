import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
// Restart only the child created here. Never search/kill user processes.
const dir = path.resolve(process.argv[2] || '.');
const file = path.join(dir, 'config.json'), entry = path.join(dir, 'src/bridge.js');
if (!fs.existsSync(entry)) throw new Error('Bridge entry missing');
let child, stopped = false, restarting = false, failures = 0, changedAt = 0;
let signature = fs.readFileSync(file, 'utf8');
function start() {
  const fd = fs.openSync(path.join(dir, 'market-startup.log'), 'a', 0o600);
  child = spawn(process.execPath, [entry], { cwd: dir, windowsHide: true, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  child.once('error', () => { stopped = true; clearInterval(timer); process.exitCode = 1; });
  child.once('exit', () => {
    if (stopped) return;
    if (restarting) { restarting = false; failures = 0; start(); return; }
    if (++failures <= 2) setTimeout(() => { if (!stopped) start(); }, 3000);
    else { stopped = true; clearInterval(timer); process.exitCode = 1; }
  });
}
const timer = setInterval(() => {
  try {
    const text = fs.readFileSync(file, 'utf8'); JSON.parse(text);
    if (text !== signature) { signature = text; changedAt = Date.now(); }
    if (changedAt && Date.now() - changedAt > 1000 && child && !restarting) {
      changedAt = 0; restarting = true; child.kill();
    }
  } catch { /* Invalid JSON edits leave the active child unchanged. */ }
}, 1000);
function stop() { stopped = true; clearInterval(timer); child?.kill(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
start();
