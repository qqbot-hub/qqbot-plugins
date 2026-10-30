import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createSnowLumaRecipe } from '../recipes/snowluma.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-recipe-'));
let count = 0;
try {
  async function scenario({ panel = false, online = false, checkCode = 0, bundled = true, live = true } = {}) {
    const dir = path.join(root, String(++count)); fs.mkdirSync(dir);
    for (const f of ['index.mjs', 'check-node-version.cjs', ...(bundled ? ['node.exe'] : [])]) fs.writeFileSync(path.join(dir, f), '');
    let cfg = { snowluma: { httpUrl: 'http://127.0.0.1:9000' } };
    const launches = [], commands = [];
    const ctx = { state: {}, isWin: true, cfg: () => cfg, saveCfg: patch => Object.assign(cfg, patch), paths: { runtimeDir: () => dir },
      httpGet: async () => ({ status: 200, text: panel ? '<title>SnowLuma</title>' : '<title>Unrelated site</title>' }),
      exec: async (exe, args) => { commands.push([exe, args]); return { code: args[0] === '--version' ? 0 : checkCode, stdout: 'v24.18.0' }; },
      spawnDetached: (...args) => { launches.push(args); return { ok: true, pid: 999999 }; },
    };
    const recipe = createSnowLumaRecipe({ heartbeat: async () => ({ online, selfId: online ? 123 : null }), sleep: async () => {}, alive: () => live });
    const step = key => recipe.steps.find(s => s.key === key).run(ctx);
    assert.equal((await step('detect')).status, 'ok');
    return { ctx, step, launches, commands, dir };
  }
  const web = await scenario({ panel: true });
  assert.equal((await web.step('running')).status, 'ok');
  assert.equal((await web.step('start')).status, 'skip');
  assert.equal(web.launches.length, 0);
  assert.equal((await web.step('login')).status, 'manual');
  assert.equal((await web.step('verify')).status, 'manual');
  const good = await scenario({ online: true });
  await good.step('running'); assert.equal((await good.step('start')).status, 'skip');
  assert.equal((await good.step('verify')).status, 'ok');
  const boot = await scenario();
  assert.equal((await boot.step('running')).status, 'skip');
  assert.equal((await boot.step('start')).status, 'manual');
  assert.equal(boot.launches[0][0], path.join(boot.dir, 'node.exe'));
  assert.deepEqual(boot.launches[0][1], ['index.mjs']);
  boot.ctx.state = { dir: boot.dir }; await boot.step('running');
  assert.equal((await boot.step('start')).status, 'skip'); assert.equal(boot.launches.length, 1);
  const badNode = await scenario({ bundled: false, checkCode: 1 });
  assert.equal((await badNode.step('start')).status, 'fail'); assert.equal(badNode.launches.length, 0);
  assert.equal(badNode.commands[0][0], process.execPath);
  const exited = await scenario({ live: false }); assert.equal((await exited.step('start')).status, 'fail');
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push([req.url, req.headers.authorization]);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: req.url.endsWith('get_login_info') ? { user_id: 123, nickname: 'test' } : { app_name: 'SnowLuma', app_version: '2.2.1' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const ctx = { state: {}, cfg: () => ({ snowluma: { httpUrl: `http://127.0.0.1:${server.address().port}` }, onebot: { accessToken: 'test-only-token' } }) };
    assert.equal((await createSnowLumaRecipe().steps.find(s => s.key === 'verify').run(ctx)).status, 'ok');
    assert.ok(requests.some(([url, auth]) => url === '/get_login_info' && auth === 'Bearer test-only-token'));
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('SnowLuma: panel-only manual state, existing instance reuse, bundled Node, failed version preflight, process exit and protocol readiness passed.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
