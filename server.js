#!/usr/bin/env node
/* ============================================================
 * qqbot-plugins —— AI QQ 机器人插件市场 · 服务端
 *
 * 零第三方依赖（Node 18+，用到全局 fetch）。
 *   node server.js  →  http://127.0.0.1:3210
 *
 * 能力：
 *   · 插件市场（浏览 / 搜索 / 安装 / 卸载 / 启停）
 *   · 运行体检 /api/doctor：探测 DSH(3080) / SnowLuma(3000,3001) / qq-bridge(3100)
 *   · 一键搭桥  /api/bridge/register-dsh：把 Hub 注册进 DSH 的 cordis.patch.yml
 *   · 兼容老市场 API：/api/list /api/health /api/tunnel /api/op
 *
 * 鉴权：访问口令登录，种 HttpOnly Cookie（30 天）
 * ============================================================ */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = __dirname;
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const readBin = (f) => fs.readFileSync(path.join(ROOT, f));

/* ---------- 配置 ---------- */
/* config.json 可写：市场页面里的「连接渠道设置」和「插件配置」都会存回这里 */
const CFG_FILE = path.join(ROOT, 'config.json');
let cfg = { password: '', port: 3210, snowluma: {}, dsh: {}, bridge: {}, plugins: {} };
try { cfg = Object.assign(cfg, JSON.parse(read('config.json'))); } catch (e) { /* 首次运行用默认值 */ }
const PORT = Number(process.env.PORT || cfg.port || 3210);
const PASSWORD = String(cfg.password || '');

/* ---------- 数据文件定位 ----------
 * 目录结构见 scripts/lib/paths.mjs：catalog/ 放清单、sources/ 放源、snapshots/ 放抓取快照、
 * state/ 放安装状态。老的扁平位置作为回退，保证升级上来的部署不会读空。
 */
function pickData(...rels) {
  for (const rel of rels) {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p)) return p;
  }
  return path.join(ROOT, rels[0]);
}
const PLUGINS_FILE = pickData(path.join('data', 'catalog', 'plugins.json'), path.join('data', 'plugins.json'));
const COMPANIONS_FILE = pickData(path.join('data', 'catalog', 'companions.json'));
const COMPONENTS_FILE = pickData(path.join('data', 'catalog', 'components.json'));
const STATE_FILE = pickData(path.join('data', 'state', 'plugins.json'), path.join('data', 'state.json'));

function saveCfg() {
  try {
    const body = Object.assign({}, cfg, { templates: undefined });
    delete body.templates;
    fs.writeFileSync(CFG_FILE, JSON.stringify(body, null, 2) + '\n');
  } catch (e) { /* 写入失败不致命，下次保存再试 */ }
}

/* ---------- 状态 ---------- */
let STATE = {};
try { STATE = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { STATE = {}; }
const saveState = () => { try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); } catch {} fs.writeFileSync(STATE_FILE, JSON.stringify(STATE, null, 2)); };

let UPTIME_START = Date.now();
const uptime = () => Math.floor((Date.now() - UPTIME_START) / 1000);

/* ---------- 鉴权 ---------- */
/* 有口令：口令令牌鉴权；无口令：开放访问（本机自用场景）。 */
const QM_TOKEN = PASSWORD ? crypto.createHash('sha256').update('qm:' + PASSWORD).digest('hex').slice(0, 48) : '';
function authed(req) {
  if (!PASSWORD) return true;
  const m = /(?:^|;\s*)qm=([^;]+)/.exec(req.headers.cookie || '');
  return !!(m && m[1] === QM_TOKEN);
}

/* ---------- 插件数据 ----------
 * 两个清单合并给页面用：
 *   catalog/plugins.json     能装进机器人、走 MCP 暴露工具的插件
 *   catalog/companions.json  独立运行的配套程序（桌面宠物 / TTS 引擎 / 调音台）
 * 前端靠 external:true 区分，渲染成「配套工具与桌面程序」。
 */
function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}
function catalog() {
  return readJsonFile(PLUGINS_FILE).concat(readJsonFile(COMPANIONS_FILE));
}
function components() {
  return readJsonFile(COMPONENTS_FILE);
}
function currentPlugins() {
  return catalog().map((p) => {
    const s = STATE[p.id];
    const out = Object.assign({}, p, s ? { installed: !!s.installed, enabled: !!s.enabled } : {});
    out.toolCount = (p.tools || []).length;
    return out;
  });
}

/* ---------- 工具清单（真实能力来自 plugins/*.mjs） ---------- */
async function installedTools() {
  const tools = [];
  for (const p of currentPlugins()) {
    if (!p.installed) continue;
    const file = path.join(ROOT, 'plugins', p.id + '.mjs');
    if (!fs.existsSync(file)) continue;
    try {
      const mod = await import(pathToFileURL(file).href);
      for (const t of (mod.default && mod.default.tools) || []) {
        tools.push({ name: t.name, description: `[${p.name}] ${t.description}`, plugin: p.id });
      }
    } catch (e) { /* 忽略单个插件的加载错误 */ }
  }
  return tools;
}

/* ---------- 插件配置（schema 由插件自己声明，市场自动生成表单） ---------- */
const schemaCache = new Map();
async function pluginSchema(id) {
  if (schemaCache.has(id)) return schemaCache.get(id);
  const file = path.join(ROOT, 'plugins', id + '.mjs');
  let schema = null;
  if (fs.existsSync(file)) {
    try {
      const mod = await import(pathToFileURL(file).href);
      const s = mod.default && mod.default.settings;
      if (s && Array.isArray(s.fields)) schema = s;
    } catch (e) { /* 插件加载失败就没有配置项 */ }
  }
  schemaCache.set(id, schema);
  return schema;
}

function pluginValues(id) {
  const all = cfg.plugins || {};
  const v = all[id];
  return v && typeof v === 'object' ? v : {};
}

/* 按 schema 校验并清洗提交上来的值，避免脏数据写进配置文件 */
function cleanValues(schema, input) {
  const out = {};
  const src = input && typeof input === 'object' ? input : {};
  for (const f of schema.fields) {
    const raw = src[f.key];
    if (f.type === 'list') {
      const arr = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[\s,，;；]+/);
      out[f.key] = arr.map((x) => String(x).trim()).filter(Boolean);
    } else if (f.type === 'number') {
      const n = Number(raw);
      out[f.key] = Number.isFinite(n) ? n : (f.default != null ? f.default : 0);
    } else if (f.type === 'boolean') {
      out[f.key] = raw === true || raw === 'true' || raw === 1 || raw === '1';
    } else if (f.type === 'select') {
      const opts = (f.options || []).map((o) => (typeof o === 'string' ? o : o.value));
      out[f.key] = opts.includes(raw) ? raw : (f.default || opts[0] || '');
    } else {
      out[f.key] = String(raw == null ? '' : raw).trim().slice(0, 500);
    }
  }
  return out;
}

/* 连接渠道（全局）——只暴露可改的字段，口令类不回传明文 */
function globalSettings() {
  const sl = cfg.snowluma || {};
  const dsh = cfg.dsh || {};
  const bg = cfg.bridge || {};
  const ob = cfg.onebot || {};
  return {
    onebot: {
      impl: ob.impl || 'auto',
      authMode: ob.authMode || 'header',
      pathPrefix: ob.pathPrefix || '',
    },
    snowluma: {
      httpUrl: ob.httpUrl || sl.httpUrl || 'http://127.0.0.1:3000',
      accessToken: '',                 // 不回传
      hasToken: !!(ob.accessToken || sl.accessToken),
      wsPort: Number(sl.wsPort || 3001),
    },
    dsh: { baseUrl: dsh.baseUrl || 'http://127.0.0.1:3080', profile: dsh.profile || 'desktop' },
    bridge: { consoleUrl: bg.consoleUrl || 'http://127.0.0.1:3100' },
    port: PORT,
    hasPassword: !!PASSWORD,
  };
}

function saveGlobal(input) {
  const src = input && typeof input === 'object' ? input : {};
  cfg.snowluma = Object.assign({}, cfg.snowluma);
  cfg.dsh = Object.assign({}, cfg.dsh);
  cfg.bridge = Object.assign({}, cfg.bridge);
  if (src.onebot) {
    cfg.onebot = Object.assign({}, cfg.onebot);
    const o = src.onebot;
    if (typeof o.impl === 'string' && o.impl.trim()) cfg.onebot.impl = o.impl.trim();
    if (typeof o.authMode === 'string' && ['header', 'query', 'none'].includes(o.authMode)) cfg.onebot.authMode = o.authMode;
    if (typeof o.pathPrefix === 'string') cfg.onebot.pathPrefix = o.pathPrefix.trim();
  }
  if (src.snowluma) {
    const s = src.snowluma;
    if (typeof s.httpUrl === 'string' && s.httpUrl.trim()) {
      cfg.snowluma.httpUrl = s.httpUrl.trim().replace(/\/+$/, '');
      cfg.onebot = Object.assign({}, cfg.onebot, { httpUrl: cfg.snowluma.httpUrl });
    }
    /* 空字符串=保持原样；只有明确填了新值才覆盖 */
    if (typeof s.accessToken === 'string' && s.accessToken.trim()) {
      cfg.snowluma.accessToken = s.accessToken.trim();
      cfg.onebot = Object.assign({}, cfg.onebot, { accessToken: cfg.snowluma.accessToken });
    }
    if (s.clearToken === true) {
      cfg.snowluma.accessToken = '';
      cfg.onebot = Object.assign({}, cfg.onebot, { accessToken: '' });
    }
    const ws = Number(s.wsPort);
    if (Number.isFinite(ws) && ws > 0 && ws < 65536) cfg.snowluma.wsPort = ws;
  }
  if (src.dsh) {
    if (typeof src.dsh.baseUrl === 'string' && src.dsh.baseUrl.trim()) {
      cfg.dsh.baseUrl = src.dsh.baseUrl.trim().replace(/\/+$/, '');
    }
    if (typeof src.dsh.profile === 'string' && src.dsh.profile.trim()) {
      cfg.dsh.profile = src.dsh.profile.trim();
    }
  }
  if (src.bridge && typeof src.bridge.consoleUrl === 'string' && src.bridge.consoleUrl.trim()) {
    cfg.bridge.consoleUrl = src.bridge.consoleUrl.trim().replace(/\/+$/, '');
  }
  saveCfg();
  return globalSettings();
}

/* ---------- 体检：TCP/HTTP 探测 ---------- */
function tcpProbe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => { try { s.destroy(); } catch {} resolve(ok); };
    s.setTimeout(timeoutMs);
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
  });
}
async function httpProbe(url, timeoutMs = 2000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    return r.ok || (r.status >= 300 && r.status < 400);
  } catch { return false; } finally { clearTimeout(t); }
}
/* 识别协议端：**复用适配层**（plugins/_bridge.mjs），
   保证「网页显示的协议端」和「插件实际说话的协议端」是同一套判断，
   差异（动作名/鉴权/响应格式）只在适配层维护一份。 */
let bridgeMod = null;
async function bridgeModule() {
  if (!bridgeMod) bridgeMod = await import(pathToFileURL(path.join(ROOT, 'plugins', '_bridge.mjs')).href);
  return bridgeMod;
}
function onebotCfg() {
  const ob = cfg.onebot || {};
  const sl = cfg.snowluma || {};
  return {
    impl: String(ob.impl || 'auto'),
    httpUrl: String(ob.httpUrl || sl.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    accessToken: String(ob.accessToken != null && ob.accessToken !== '' ? ob.accessToken : (sl.accessToken || '')),
    authMode: String(ob.authMode || 'header'),
    pathPrefix: String(ob.pathPrefix || ''),
    timeoutMs: 2500,          // 体检要快，不能卡住页面
  };
}
/* 3 秒缓存：页面轮询 /api/health 时不至于每次都去打协议端 */
let hbCache = { key: '', at: 0, value: null };
async function probeOnebot(force = false) {
  const c = onebotCfg();
  const key = JSON.stringify(c);
  if (!force && hbCache.value && hbCache.key === key && Date.now() - hbCache.at < 3000) return hbCache.value;
  const { createOneBot } = await bridgeModule();
  const hb = await createOneBot(c).heartbeat({ force: true, ttlMs: 0 });
  hbCache = { key, at: Date.now(), value: hb };
  return hb;
}

async function doctor() {
  const ob = onebotCfg();
  const sl = Object.assign({ wsPort: 3001 }, cfg.snowluma);
  const dsh = Object.assign({ baseUrl: 'http://127.0.0.1:3080' }, cfg.dsh);
  const bg = Object.assign({ consoleUrl: 'http://127.0.0.1:3100' }, cfg.bridge);
  let httpHost;
  try { httpHost = new URL(ob.httpUrl); } catch { httpHost = new URL('http://127.0.0.1:3000'); }
  const [snowlumaHttp, snowlumaWs, dshOk, bridgeOk] = await Promise.all([
    tcpProbe(httpHost.hostname, Number(httpHost.port) || 80),
    tcpProbe('127.0.0.1', Number(sl.wsPort) || 3001),
    httpProbe(dsh.baseUrl.replace(/\/$/, '') + '/'),
    tcpProbe('127.0.0.1', Number(new URL(bg.consoleUrl).port) || 3100),
  ]);
  const tools = await installedTools();
  const hb = await probeOnebot();
  return {
    onebot: hb,
    dsh: { ok: dshOk, url: dsh.baseUrl },
    snowluma: { ok: snowlumaHttp && snowlumaWs, http: snowlumaHttp, ws: snowlumaWs, httpUrl: ob.httpUrl },
    bridge: { ok: bridgeOk, url: bg.consoleUrl },
    mcp: { tools: tools.length },
    installed: currentPlugins().filter((p) => p.installed).length,
    uptime: uptime(),
    node: process.version,
    port: PORT,
  };
}

/* ---------- 调音台（配套本地服务）接入 ----------
 * 调音台是 D:\tts\voicelab 里的独立小服务（默认 127.0.0.1:3120），
 * 用来调语音音色、试听、直接把音色写进机器人的 voice 插件。
 * 它不属于本仓库，也不复制它的代码 —— 这里只做**反向代理**，让它出现在市场里。
 * 它页面里的请求是绝对路径（/api/state、/audio/x.wav），所以这几个前缀在市场根上转给它；
 * 市场自己的 /api/* 优先匹配，两者不冲突。
 */
function labTarget() {
  const raw = String((cfg.lab && cfg.lab.url) || 'http://127.0.0.1:3120');
  try { return new URL(raw); } catch { return new URL('http://127.0.0.1:3120'); }
}
const LAB_PATHS = [
  /^\/audio\//,
  /^\/api\/(state|synth|voices|presets|upload|save-voice|send|bot\/voice)(\/|\?|$)/,
];
const isLabPath = (p) => LAB_PATHS.some((re) => re.test(p));

function labDownPage() {
  const t = labTarget();
  return `<!doctype html><meta charset="utf-8"><title>调音台没启动</title>
<style>body{background:#0d1014;color:#e6edf3;font:15px/1.7 system-ui,"Microsoft YaHei";padding:40px;max-width:640px;margin:auto}
code{background:#1c232c;padding:2px 6px;border-radius:4px;color:#5eead4}a{color:#38bdf8}</style>
<h1>调音台没启动</h1>
<p>市场连不上 <code>${t.origin}</code>。调音台是独立进程，需要先启动它：</p>
<p><code>node D:\\tts\\voicelab\\server.mjs</code></p>
<p>启动后刷新本页即可。想看它自己的界面也可以直接开
<a href="${t.origin}" target="_blank" rel="noopener">${t.origin}</a>。</p>`;
}

function proxyTo(target, req, res, stripPrefix = '') {
  let p = req.url && req.url.startsWith('/') ? req.url : '/' + (req.url || '');
  if (stripPrefix && p.startsWith(stripPrefix)) {
    p = p.slice(stripPrefix.length) || '/';
    if (!p.startsWith('/')) p = '/' + p;
  }
  const headers = Object.assign({}, req.headers, { host: target.host });
  delete headers.cookie;                       // 市场的登录口令不带给调音台
  delete headers['accept-encoding'];           // 让上游回明文，省得我们解压
  const up = http.request({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: p,
    method: req.method,
    headers,
    timeout: 180000,
  }, (r) => {
    const out = Object.assign({}, r.headers);
    delete out['transfer-encoding'];
    delete out.connection;
    res.writeHead(r.statusCode || 502, out);
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('上游超时')));
  up.on('error', () => { if (!res.headersSent) sendHtml(res, 502, labDownPage()); else res.end(); });
  req.pipe(up);
}

/* ---------- 全网插件源（聚合目录） ---------- */
const HUB_FILE = pickData(path.join('data', 'snapshots', 'hub.json'), path.join('data', 'hub.json'));
const HUB_STATE = { syncing: false, startedAt: 0, lastError: '', lastResult: null };

function hubSnapshot() {
  try { return JSON.parse(fs.readFileSync(HUB_FILE, 'utf8')); } catch { return null; }
}
function hubSyncStatus() {
  return {
    syncing: HUB_STATE.syncing,
    lastSyncAt: HUB_STATE.startedAt ? new Date(HUB_STATE.startedAt).toISOString() : '',
    lastError: HUB_STATE.lastError,
    lastResult: HUB_STATE.lastResult,
  };
}
async function startHubSync() {
  if (HUB_STATE.syncing) return { ok: true, started: false, msg: '正在同步中，稍等' };
  /* 冷却一分钟：GitHub 未登录时搜索接口只有 10 次/分钟 */
  if (HUB_STATE.startedAt && Date.now() - HUB_STATE.startedAt < 60000) {
    const wait = Math.ceil((60000 - (Date.now() - HUB_STATE.startedAt)) / 1000);
    return { ok: false, error: `刚同步过，${wait} 秒后再试（GitHub 限流保护）` };
  }
  HUB_STATE.syncing = true;
  HUB_STATE.startedAt = Date.now();
  HUB_STATE.lastError = '';
  (async () => {
    try {
      const { syncAll } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'hub-sync.mjs')).href);
      const snap = await syncAll();
      fs.writeFileSync(HUB_FILE, JSON.stringify(snap, null, 1) + '\n');
      HUB_STATE.lastResult = { counts: snap.counts, fetchedAt: snap.fetchedAt, sources: snap.sources };
    } catch (e) {
      HUB_STATE.lastError = String((e && e.message) || e);
    } finally {
      HUB_STATE.syncing = false;
    }
  })();
  return { ok: true, started: true };
}
function hubQuery(params) {
  const snap = hubSnapshot();
  const all = (snap && snap.entries) || [];
  const q = String(params.get('q') || '').trim().toLowerCase();
  const platform = String(params.get('platform') || '');
  const source = String(params.get('source') || '');
  const sort = String(params.get('sort') || 'stars');
  const page = Math.max(1, Number(params.get('page')) || 1);
  const perPage = Math.min(60, Math.max(6, Number(params.get('perPage')) || 18));

  const hit = (e) => {
    if (platform && e.platform !== platform) return false;
    if (source && !(e.sources || [e.sourceId]).includes(source)) return false;
    if (!q) return true;
    return [e.repo, e.name, e.desc, e.platform, (e.topics || []).join(' ')].join(' ').toLowerCase().includes(q);
  };
  const list = all.filter(hit);
  const cmp = sort === 'updated' ? (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))
    : sort === 'name' ? (a, b) => String(a.repo).localeCompare(String(b.repo))
    : (a, b) => (b.stars || 0) - (a.stars || 0);
  list.sort(cmp);

  const facets = {};
  for (const e of all) facets[e.platform] = (facets[e.platform] || 0) + 1;

  return {
    ok: true,
    fetchedAt: (snap && snap.fetchedAt) || '',
    via: (snap && snap.via) || '',
    counts: (snap && snap.counts) || { entries: 0, sources: 0, okSources: 0 },
    sourceDefs: (snap && snap.sources) || [],
    facets,
    total: all.length,
    matched: list.length,
    page,
    perPage,
    entries: list.slice((page - 1) * perPage, page * perPage),
    ...hubSyncStatus(),
  };
}

/* ---------- 搭桥：注册进 DSH ---------- */
function registerDsh(profile) {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!home) return { ok: false, error: '拿不到用户目录' };
  const name = String(profile || cfg.dsh?.profile || 'desktop');
  const yml = path.join(home, '.dsh', 'profiles', name, 'cordis.patch.yml');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'register-dsh.mjs'), name], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ ok: code === 0, profile: name, file: yml, output: (out + err).trim() }));
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

/* ---------- HTTP 基础 ---------- */
function sendJson(res, status, obj, extraHeaders) {
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, extraHeaders || {}));
  res.end(JSON.stringify(obj));
}
function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}
function sendRedirect(res, to, extra) { res.writeHead(302, Object.assign({ Location: to, 'Cache-Control': 'no-store' }, extra || {})); res.end(); }
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}

/* ---------- 操作 ---------- */
function performOp(action, id, extra) {
  const exists = !!id && catalog().some((p) => p.id === id);
  if (!exists) return { ok: false, error: '插件不存在' };
  if (action === 'install') {
    STATE[id] = Object.assign({}, STATE[id], { installed: true, enabled: true });
    saveState();
    return { ok: true, msg: '已安装。重启 DSH 后（或跑 scripts/register-dsh.mjs 后重启 DSH）工具生效。' };
  }
  if (action === 'uninstall') {
    STATE[id] = Object.assign({}, STATE[id], { installed: false, enabled: false });
    saveState();
    return { ok: true, msg: '已卸载。重启 DSH 后工具从 AI 的工具列表消失。' };
  }
  if (action === 'toggle') {
    const cur = currentPlugins().filter((p) => p.id === id)[0] || {};
    const want = extra && extra.enabled != null ? !!extra.enabled : !cur.enabled;
    STATE[id] = Object.assign({}, STATE[id], { enabled: want, installed: want || (STATE[id] || {}).installed });
    saveState();
    return { ok: true, msg: want ? '已启用' : '已停用' };
  }
  if (action === 'restart') {
    UPTIME_START = Date.now();
    return { ok: true, msg: '市场服务运行时间已重置（如需重启 qq-bridge 请双击其 restart.bat）' };
  }
  return { ok: false, error: '未知操作' };
}

/* ---------- 一键安装：把 installer.mjs 的步骤实时推给页面 ---------- */
let installerPromise = null;
function installer() {
  if (!installerPromise) {
    installerPromise = import(pathToFileURL(path.join(ROOT, 'scripts', 'installer.mjs')).href);
  }
  return installerPromise;
}

/* SSE 订阅者：所有安装任务的日志都从这里流出去，页面按 jobId 过滤 */
const INSTALL_SUBS = new Set();
function broadcastInstall(ev) {
  const line = 'data: ' + JSON.stringify(ev) + '\n\n';
  for (const r of INSTALL_SUBS) { try { r.write(line); } catch { INSTALL_SUBS.delete(r); } }
}

/* done/fail 事件里的 job 很大（带全部步骤和日志），只留页面需要的字段 */
function slimEvent(type, p) {
  if (type === 'log' || type === 'step' || type === 'start') return p;
  return p ? { id: p.id, status: p.status, title: p.title } : {};
}

async function startInstallJob(target, params) {
  const mod = await installer();
  const jobId = 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  mod.runInstall(target, {
    params: params || {},
    jobId,
    onEvent: (type, payload) => broadcastInstall({ jobId, type, payload: slimEvent(type, payload) }),
  }).catch((e) => broadcastInstall({ jobId, type: 'fail', payload: { id: jobId, status: 'failed', error: e.message } }));
  return jobId;
}

/* 组件的实时状态：端口开没开，页面用来显示「已运行 / 未安装」 */
async function componentsWithState() {
  return Promise.all(components().map(async (c) => {
    const ports = c.ports || [];
    const portsOpen = {};
    await Promise.all(ports.map(async (n) => { portsOpen[n] = await tcpProbe('127.0.0.1', n, 700); }));
    const running = ports.length ? Object.values(portsOpen).some(Boolean) : null;
    return Object.assign({}, c, { portsOpen, running });
  }));
}

/* ---------- 静态文件 ---------- */
const STATIC = { '/': 'public/index.html', '/login': 'public/login.html' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

/* ---------- 服务器 ---------- */
const server = http.createServer(async (req, res) => {
  let p;
  try { p = new URL(req.url, 'http://x').pathname; } catch { p = '/'; }
  const method = req.method;

  /* 登录 */
  if (p === '/login' && method === 'POST') {
    const params = new URLSearchParams(await readBody(req));
    if (!PASSWORD || params.get('password') === PASSWORD) {
      const cookie = PASSWORD
        ? 'qm=' + QM_TOKEN + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000'
        : 'qm=1; Path=/; Max-Age=600';
      return sendRedirect(res, '/', { 'Set-Cookie': cookie });
    }
    const html = read('public/login.html').replace('</form>', '<p class="err">口令不对</p></form>');
    return sendHtml(res, 401, html);
  }

  /* API */
  if (p.startsWith('/api/')) {
    if (!authed(req)) return sendJson(res, 401, { ok: false, error: '未登录' });
    if (method === 'GET' && p === '/api/list') {
      const plugins = currentPlugins();
      /* 标出哪些插件有可配置项（schema 由插件自己声明），前端据此显示「配置」按钮 */
      const flags = {};
      await Promise.all(plugins.map(async (pl) => { flags[pl.id] = !!(await pluginSchema(pl.id)); }));
      return sendJson(res, 200, { ok: true, plugins: plugins.map((pl) => Object.assign({}, pl, { hasSettings: !!flags[pl.id] })) });
    }
    if (method === 'GET' && p === '/api/health') {
      const d = await doctor();
      const o = d.onebot || {};
      return sendJson(res, 200, {
        ok: true, bridge: d.bridge.ok, snowluma: d.snowluma.ok, dsh: d.dsh.ok,
        onebot: {
          ok: !!o.online, impl: o.impl || 'unknown', app: o.app || '', version: o.version || '',
          selfId: o.selfId ?? null, nickname: o.nickname || '',
          latencyMs: o.latencyMs ?? null, checkedAt: o.checkedAt || '', error: o.error || '',
        },
        installed: d.installed, tools: d.mcp.tools, uptime: d.uptime, node: d.node, port: d.port,
      });
    }
    /* 轻量状态：只做心跳，不逐个 import 插件 —— 页面定时刷新用这个 */
    if (method === 'GET' && p === '/api/status') {
      const force = new URL(req.url, 'http://x').searchParams.get('force') === '1';
      const [hb, dshOk, bridgeOk] = await Promise.all([
        probeOnebot(force),
        httpProbe(String((cfg.dsh || {}).baseUrl || 'http://127.0.0.1:3080').replace(/\/$/, '') + '/'),
        tcpProbe('127.0.0.1', Number(new URL(String((cfg.bridge || {}).consoleUrl || 'http://127.0.0.1:3100')).port) || 3100),
      ]);
      const installed = currentPlugins().filter((pl) => pl.installed);
      return sendJson(res, 200, {
        ok: true,
        onebot: hb,
        dsh: { ok: dshOk },
        bridge: { ok: bridgeOk },
        installed: installed.length,
        tools: installed.reduce((n, pl) => n + (pl.toolCount || 0), 0),
      });
    }
    if (method === 'GET' && p === '/api/doctor') return sendJson(res, 200, { ok: true, ...(await doctor()) });
    if (method === 'GET' && p === '/api/tools') return sendJson(res, 200, { ok: true, tools: await installedTools() });

    /* ---------- 链路组件与一键安装 ---------- */
    if (method === 'GET' && p === '/api/components') {
      return sendJson(res, 200, { ok: true, components: await componentsWithState() });
    }
    if (method === 'GET' && p === '/api/install/recipes') {
      const mod = await installer();
      const ids = mod.recipeIds();
      const list = [];
      for (const id of ids) {
        const r = await mod.loadRecipe(id).catch(() => null);
        if (r) list.push({ id: r.id || id, title: r.title || id, kind: r.kind || '', steps: r.steps.length });
      }
      return sendJson(res, 200, { ok: true, recipes: list });
    }
    if (method === 'GET' && p === '/api/install/jobs') {
      const mod = await installer();
      return sendJson(res, 200, { ok: true, jobs: mod.recentJobs() });
    }
    if (method === 'GET' && p === '/api/install/job') {
      const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
      const mod = await installer();
      const job = mod.getJob(id);
      return job ? sendJson(res, 200, { ok: true, job }) : sendJson(res, 404, { ok: false, error: '没有这个任务' });
    }
    /* SSE：安装日志实时流（页面 EventSource 连这个） */
    if (method === 'GET' && p === '/api/install/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      INSTALL_SUBS.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* 连接已断 */ } }, 20000);
      req.on('close', () => { clearInterval(ping); INSTALL_SUBS.delete(res); });
      return;
    }
    if (method === 'POST' && p === '/api/install') {
      const rawInstall = await readBody(req);
      const body = (() => { try { return JSON.parse(rawInstall || '{}'); } catch { return {}; } })();
      const target = String(body.target || '').trim();
      if (!target) return sendJson(res, 400, { ok: false, error: '缺少 target（要装什么）' });
      const jobId = await startInstallJob(target, body.params || {});
      return sendJson(res, 200, { ok: true, jobId, target });
    }

    /* 全网插件源：读快照 + 过滤/分页；POST 触发一次重新抓取（后台跑，带冷却） */
    if (method === 'GET' && p === '/api/hub') {
      return sendJson(res, 200, hubQuery(new URL(req.url, 'http://x').searchParams));
    }
    if (method === 'POST' && p === '/api/hub/sync') {
      return sendJson(res, 200, await startHubSync());
    }
    /* 配套服务：调音台是否在跑 */
    if (method === 'GET' && p === '/api/lab/status') {
      const t = labTarget();
      const online = await tcpProbe(t.hostname, Number(t.port) || 80, 800);
      return sendJson(res, 200, { ok: true, online, url: t.origin, proxy: '/lab/' });
    }
    if (method === 'GET' && p === '/api/tunnel') {
      return sendJson(res, 200, { ok: true, enabled: !!cfg.tunnelEnabled, alive: !!cfg.tunnelAlive, url: cfg.tunnelUrl || '' });
    }
    if (method === 'POST' && p === '/api/op') {
      const raw = await readBody(req);
      const obj = (() => { try { return JSON.parse(raw || '{}'); } catch { return {}; } })();
      return sendJson(res, 200, performOp(obj.action, obj.id, obj));
    }
    if (method === 'POST' && p === '/api/bridge/register-dsh') {
      const raw = await readBody(req);
      const obj = (() => { try { return JSON.parse(raw || '{}'); } catch { return {}; } })();
      return sendJson(res, 200, await registerDsh(obj.profile));
    }

    /* 设置：连接渠道（全局） */
    if (method === 'GET' && p === '/api/settings') {
      return sendJson(res, 200, { ok: true, global: globalSettings() });
    }
    if (method === 'POST' && p === '/api/settings') {
      const raw = await readBody(req);
      const obj = (() => { try { return JSON.parse(raw || '{}'); } catch { return {}; } })();
      return sendJson(res, 200, { ok: true, global: saveGlobal(obj) });
    }

    /* 设置：插件配置 */
    if (method === 'GET' && p === '/api/plugin-config') {
      const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
      const schema = await pluginSchema(id);
      if (!schema) return sendJson(res, 404, { ok: false, error: '这个插件没有可配置项' });
      return sendJson(res, 200, { ok: true, id, schema, values: pluginValues(id) });
    }
    if (method === 'POST' && p === '/api/plugin-config') {
      const raw = await readBody(req);
      const obj = (() => { try { return JSON.parse(raw || '{}'); } catch { return {}; } })();
      const schema = await pluginSchema(obj.id);
      if (!schema) return sendJson(res, 404, { ok: false, error: '这个插件没有可配置项' });
      cfg.plugins = Object.assign({}, cfg.plugins);
      cfg.plugins[obj.id] = cleanValues(schema, obj.values);
      saveCfg();
      return sendJson(res, 200, { ok: true, id: obj.id, values: cfg.plugins[obj.id], msg: '配置已保存，立即生效' });
    }

    /* 调音台的接口（/api/state、/api/synth、/api/voices…）：市场没有同名的，原样转给它 */
    if (isLabPath(p)) return proxyTo(labTarget(), req, res);

    return sendJson(res, 404, { ok: false, error: 'not found' });
  }

  /* 调音台：整站在 /lab/ 下代理（页面 + 资源），打开 /lab/ 就像市场自己的页面 */
  if (p === '/lab') return sendRedirect(res, '/lab/');
  if (p.startsWith('/lab/')) {
    if (!authed(req)) return sendRedirect(res, '/login');
    return proxyTo(labTarget(), req, res, '/lab');
  }
  /* 调音台的音频是根路径 /audio/xxx.wav */
  if (p.startsWith('/audio/')) {
    if (!authed(req)) return sendJson(res, 401, { ok: false, error: '未登录' });
    return proxyTo(labTarget(), req, res);
  }

  /* 静态页 */
  const file = STATIC[p];
  if (file) {
    if (!authed(req)) {
      if (p === '/login') return sendHtml(res, 200, read(file));
      return sendRedirect(res, '/login');
    }
    return sendHtml(res, 200, read(file));
  }
  const ext = path.extname(p);
  if (ext && MIME[ext] && fs.existsSync(path.join(ROOT, p))) {
    res.writeHead(200, { 'Content-Type': MIME[ext] });
    return res.end(readBin(p));
  }
  if (!authed(req)) return sendRedirect(res, '/login');
  return sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><h1>404</h1>');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('qqbot-plugins 插件市场已启动');
  console.log('地址: http://127.0.0.1:' + PORT + (PASSWORD ? '' : '（未设口令，本机开放访问）'));
});
