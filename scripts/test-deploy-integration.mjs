import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { updateRegistration, registrationCount, registerMarket, profileFile } from './lib/dsh-registration.mjs';
import { discoverSnowLuma, syncBridgeConfig, setBridgeAllowlist } from './lib/discover.mjs';
import { downloadVerified, extractVerified } from './lib/download.mjs';
import { pluginHealth, observedTools } from './lib/plugin-health.mjs';
import { ROOT } from './lib/paths.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-fresh-'));
process.env.DSH_HOME = path.join(temp, '.dsh');
process.env.QQBOT_STATE_FILE = path.join(temp, 'state/plugins.json');
process.env.QQBOT_JOBS_FILE = path.join(temp, 'state/jobs.json');
process.env.QQBOT_STORE = path.join(temp, 'store');
process.env.QQBOT_SECRET_PASSPHRASE = 'isolated-test-only';
let child;
try {
  fs.mkdirSync(path.dirname(process.env.QQBOT_STATE_FILE), { recursive: true });
  const original = '# user comment\n- insert:\n    - id: foreign\n      name: preserve-me # keep comment\n    - id: mcp-qqbot\n      name: old\n- { insert: [{ id: mcp-qqbot, name: duplicate }] }\n';
  const entry = { id: 'mcp-qqbot', name: 'market' };
  const next = updateRegistration(original, entry);
  assert.equal(registrationCount(next), 1);
  assert.match(next, /preserve-me # keep comment/);
  assert.equal(updateRegistration(next, entry), next);
  assert.equal(registrationCount(updateRegistration(next, null)), 0);
  assert.throws(() => updateRegistration('not: a-sequence', entry));
  assert.throws(() => profileFile('../other'));
  const yml = profileFile(); fs.mkdirSync(path.dirname(yml), { recursive: true });
  fs.writeFileSync(yml, original);
  registerMarket({ script: path.join(ROOT, 'mcp-server.mjs') });
  assert.equal(registrationCount(fs.readFileSync(yml, 'utf8')), 1);

  const snow = path.join(temp, 'runtimes/snowluma'); fs.mkdirSync(path.join(snow, 'config'), { recursive: true });
  fs.writeFileSync(path.join(snow, 'config/onebot_123.json'), JSON.stringify({ networks: { httpServers: [{ enable: true, port: 45678, accessToken: 'http-secret' }], wsServers: [{ enable: true, port: 45679, accessToken: 'ws-secret' }] } }));
  const found = await discoverSnowLuma({ snowluma: { installDir: snow } }, { root: temp, probe: async c => ({ online: c.accessToken === 'http-secret', selfId: 123 }) });
  assert.equal(found.wsToken, 'ws-secret'); assert.equal(found.accessToken, 'http-secret');
  const wrong = await discoverSnowLuma({ snowluma: { installDir: snow, selfId: '456' } }, { root: temp, probe: async () => ({ online: true, selfId: 123 }) });
  assert.equal(wrong.heartbeat.online, false);
  const bridge = path.join(temp, 'bridge'); fs.mkdirSync(bridge);
  fs.writeFileSync(path.join(bridge, 'config.json'), JSON.stringify({ dsh: { authToken: 'keep' }, allow: { private: [], groups: [] }, allowAllWhenEmpty: false, other: { keep: true } }));
  const sync = syncBridgeConfig({ bridge: { dir: bridge } }, { dsh: { running: true, webPort: 54166 }, snow: found });
  assert.equal(sync.whitelistReady, false);
  const bc = JSON.parse(fs.readFileSync(path.join(bridge, 'config.json')));
  assert.equal(bc.dsh.baseUrl, 'http://127.0.0.1:54166'); assert.equal(bc.dsh.authToken, 'keep');
  assert.equal(bc.snowluma.homeDir, snow); assert.equal(bc.snowluma.wsAccessToken, 'ws-secret');
  assert.equal(bc.allowAllWhenEmpty, false); assert.equal(bc.other.keep, true);
  assert.throws(() => setBridgeAllowlist({ bridge: { dir: bridge } }, { private: 'bad-input' }));
  assert.throws(() => setBridgeAllowlist({ bridge: { dir: bridge } }, {}));
  setBridgeAllowlist({ bridge: { dir: bridge } }, { private: '12345,12345', groups: '67890' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(bridge, 'config.json'))).allow, { private: ['12345'], groups: ['67890'] });
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('verified-content');
    const sha256 = crypto.createHash('sha256').update('verified-content').digest('hex');
    const file = path.join(temp, 'archive.zip');
    await downloadVerified('https://example.invalid/release.zip', file, { sha256 });
    assert.equal(fs.readFileSync(file, 'utf8'), 'verified-content');
    await assert.rejects(downloadVerified('https://example.invalid/release.zip', file, { sha256: '0'.repeat(64) }), /checksum/);
    assert.equal(fs.existsSync(file + '.partial'), false);
    await assert.rejects(downloadVerified('http://example.invalid/release.zip', file, { sha256 }), /HTTPS/);
    for (const unsafe of ['../outside', 'C:/outside', 'dir/file:stream', 'dir/CON.txt']) {
      await assert.rejects(extractVerified({ exec: async () => ({ code: 0, stdout: unsafe }) }, file, path.join(temp, 'unpack')), /Unsafe/);
    }
  } finally { globalThis.fetch = realFetch; }

  const ids = ['voice','vision','qzone','group_info'];
  fs.writeFileSync(process.env.QQBOT_STATE_FILE, JSON.stringify(Object.fromEntries(ids.map(id => [id, { installed: true, enabled: true }]))));
  const opts = { root: ROOT, loaded: new Set(), probe: async () => ({ online: true, app: 'SnowLuma', version: '2.2.1' }), call: async () => ({}) };
  assert.equal((await pluginHealth('voice', {}, opts)).code, 'configured');
  assert.equal((await pluginHealth('vision', {}, opts)).code, 'config');
  assert.equal((await pluginHealth('qzone', {}, opts)).code, 'checked');
  assert.equal((await pluginHealth('group_info', {}, opts)).code, 'checked');
  assert.equal((await pluginHealth('group_info', {}, { ...opts, probe: async () => ({ online: false }) })).code, 'offline');

  fs.writeFileSync(process.env.QQBOT_STATE_FILE, '{}');
  child = spawn(process.execPath, ['mcp-server.mjs'], { cwd: ROOT, env: { ...process.env }, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  let seq = 0, buffer = '', notifications = 0;
  const pending = new Map();
  child.stderr.resume();
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === 'notifications/tools/list_changed') notifications++;
      if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timeout ' + method)); }, 8000);
    pending.set(id, msg => { clearTimeout(timer); if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await rpc('initialize', { clientInfo: { name: 'dsh-integration-test', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  assert.equal((await rpc('tools/list')).tools.length, 0);
  fs.writeFileSync(process.env.QQBOT_STATE_FILE, JSON.stringify({ clock: { installed: true, enabled: true } }));
  await new Promise(r => setTimeout(r, 1800));
  assert.ok(notifications >= 1);
  assert.equal(observedTools(ROOT).size, 0, 'a stale list cannot establish loaded state');
  const tools = (await rpc('tools/list')).tools;
  assert.ok(tools.length > 0);
  assert.equal(observedTools(ROOT).size, tools.length);
  const reloadDir=path.join(path.dirname(process.env.QQBOT_STATE_FILE),'mcp-observers');
  fs.writeFileSync(path.join(reloadDir,'reload-request.json'),JSON.stringify({root:ROOT,at:Date.now()}));
  const previousNotifications=notifications;await new Promise(r=>setTimeout(r,1800));
  assert.ok(notifications>previousNotifications);assert.equal(observedTools(ROOT).size,0,'reload invalidates delivered list until client asks again');
  await rpc('tools/list');assert.equal(observedTools(ROOT).size,tools.length);
  fs.writeFileSync(process.env.QQBOT_STATE_FILE, '{}');
  assert.equal((await rpc('tools/list')).tools.length, 0);
  const done = once(child, 'exit'); child.stdin.end(); await done; child = null;
  console.log('PASS: isolated profile registration/dedup/comments, account credentials, dynamic DSH sync, fail-closed allowlist, truthful health, live MCP add/remove and tools/list observations.');
} finally {
  if (child) { const done = once(child, 'exit'); child.kill(); await done; }
  fs.rmSync(temp, { recursive: true, force: true });
}
