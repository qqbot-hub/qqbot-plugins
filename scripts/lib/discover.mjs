import fs from 'node:fs';
import path from 'node:path';
import { createOneBot } from '../../plugins/_bridge.mjs';
import { decrypt, encrypt } from './secrets.mjs';
export function setBridgeAllowlist(cfg, values) {
  const file = path.join(cfg.bridge?.dir || '', 'config.json');
  if (!cfg.bridge?.dir || !fs.existsSync(file)) throw new Error('请先部署 qq-bridge');
  const parse = value => {
    if (typeof value !== 'string' || value.length > 4000) throw new Error('白名单必须是 QQ 号或群号列表');
    const ids = [...new Set(value.split(/[\s,，;；]+/).filter(Boolean))];
    if (ids.some(id => !/^[1-9]\d{4,15}$/.test(id))) throw new Error('QQ 号或群号格式不正确');
    return ids;
  };
  const privateIds = parse(values.private || ''), groups = parse(values.groups || '');
  if (!privateIds.length && !groups.length) throw new Error('至少填写一个允许回复的 QQ 号或群号');
  const next = JSON.parse(fs.readFileSync(file, 'utf8'));
  next.allow = { ...next.allow, private: privateIds, groups };
  next.allowAllWhenEmpty = false;
  fs.copyFileSync(file, file + '.allow-backup');
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return { ok: true, privateCount: privateIds.length, groupCount: groups.length };
}
export async function discoverSnowLuma(cfg, { root, probe = c => createOneBot(c).heartbeat({ force: true }) } = {}) {
  const sl = cfg.snowluma || {}, ob = cfg.onebot || {};
  const homeDir = sl.installDir || sl.homeDir || path.join(root, 'runtimes/snowluma');
  const candidates = [{ httpUrl: ob.httpUrl || sl.httpUrl || 'http://127.0.0.1:3000', accessToken: decrypt(cfg.secrets?.['snowluma-dsh.onebotToken'] || ob.accessToken || sl.accessToken || ''), wsUrl: sl.wsUrl || `ws://127.0.0.1:${sl.wsPort || 3001}`, wsToken: '' }];
  let files = []; try { files = fs.readdirSync(path.join(homeDir, 'config')).filter(f => /^onebot_\d+\.json$/.test(f)); } catch {}
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(homeDir, 'config', f), 'utf8')), nets = j.networks || j;
      const ws = (nets.wsServers || []).find(s => s.enable !== false && s.enabled !== false);
      for (const http of nets.httpServers || []) {
        if (http.enable === false || http.enabled === false) continue;
        const port = Number(http.port); if (!(port > 0 && port < 65536)) continue;
        candidates.push({ httpUrl: `http://127.0.0.1:${port}`, accessToken: String(http.accessToken || ''), wsUrl: ws ? `ws://127.0.0.1:${Number(ws.port) || 3001}` : '', wsToken: String(ws?.accessToken || ''), account: f.match(/\d+/)[0] });
      }
    } catch {}
  }
  // Account files include separate HTTP/WS credentials; prefer them over the cached HTTP endpoint.
  for (const c of [...candidates.slice(1), candidates[0]]) {
    try {
      const u = new URL(c.httpUrl);
      if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) continue;
      const hb = await probe({ ...ob, ...c, timeoutMs: 1500 });
      if (hb.online && hb.selfId && (!c.account || String(hb.selfId) === c.account) && (!sl.selfId || String(hb.selfId) === String(sl.selfId))) return { ...c, homeDir, heartbeat: hb };
    } catch {}
  }
  return { homeDir, heartbeat: { online: false } };
}
export function applySnowLuma(cfg, found) {
  if (!found.heartbeat?.online) return false;
  const existing = cfg.secrets?.['snowluma-dsh.onebotToken'];
  const token = existing && decrypt(existing) === (found.accessToken || '') ? existing : encrypt(found.accessToken || '');
  cfg.snowluma = { ...cfg.snowluma, installDir: found.homeDir, httpUrl: found.httpUrl, wsUrl: found.wsUrl, wsPort: found.wsUrl ? Number(new URL(found.wsUrl).port) : 0 };
  cfg.onebot = { ...cfg.onebot, httpUrl: found.httpUrl };
  cfg.secrets = { ...cfg.secrets, 'snowluma-dsh.onebotToken': token };
  return true;
}
export function syncBridgeConfig(cfg, { dsh, snow, write = true } = {}) {
  if (!cfg.bridge?.dir) return { changed: false, whitelistReady: false };
  const file = path.join(cfg.bridge.dir, 'config.json');
  let old; try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { changed: false, whitelistReady: false }; }
  const next = structuredClone(old);
  if (dsh?.running && dsh.webPort) next.dsh = { ...next.dsh, baseUrl: `http://127.0.0.1:${dsh.webPort}` };
  if (snow?.heartbeat?.online) next.snowluma = { ...next.snowluma, homeDir: snow.homeDir, launcherPath: path.join(snow.homeDir, 'launcher.bat'), httpUrl: snow.httpUrl, wsUrl: snow.wsUrl || next.snowluma?.wsUrl, accessToken: snow.accessToken, wsAccessToken: snow.wsToken };
  const allow = next.allow || {};
  const whitelistReady = (allow.private || []).length > 0 || (allow.groups || []).length > 0;
  // Never turn an empty allowlist into permission for all chats.
  const changed = JSON.stringify(old) !== JSON.stringify(next);
  if (write && changed) { fs.copyFileSync(file, file + '.market-backup'); fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }); }
  return { changed, whitelistReady, testMode: next.allowAllWhenEmpty === true };
}
