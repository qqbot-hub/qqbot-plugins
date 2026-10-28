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
const PORT = Number(cfg.port || 3210);
const PASSWORD = String(cfg.password || '');
const STATE_FILE = path.join(ROOT, 'data', 'state.json');

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

/* ---------- 插件数据 ---------- */
function catalog() {
  try { return JSON.parse(read(path.join('data', 'plugins.json'))); } catch { return []; }
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
/* 识别当前协议端实现：探测 get_login_info，再按版本号/端口猜名字 */
async function probeOnebot() {
  const ob = cfg.onebot || {};
  const sl = cfg.snowluma || {};
  const httpUrl = String(ob.httpUrl || sl.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(ob.accessToken != null && ob.accessToken !== '' ? ob.accessToken : (sl.accessToken || ''));
  const authMode = String(ob.authMode || 'header');
  const call = async (action) => {
    let url = httpUrl + '/' + action;
    const headers = { 'Content-Type': 'application/json' };
    if (token && authMode === 'header') headers.Authorization = 'Bearer ' + token;
    if (token && authMode === 'query') url += '?access_token=' + encodeURIComponent(token);
    const t = setTimeout(() => {}, 1);
    try {
      const r = await fetch(url, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(2500) });
      if (!r.ok) return { ok: false, status: r.status };
      return { ok: true, data: await r.json().catch(() => null) };
    } catch (e) { return { ok: false, error: e.message }; } finally { clearTimeout(t); }
  };
  const login = await call('get_login_info');
  if (!login.ok) {
    return { ok: false, httpUrl, impl: 'unknown', hint: login.status === 401 ? 'AccessToken 不对' : '协议端没响应' };
  }
  const ver = await call('get_version_info');
  const appName = (ver.ok && ver.data && (ver.data.data && (ver.data.data.app_name || ver.data.data.app_full_name))) || '';
  const verStr = (ver.ok && ver.data && (ver.data.data && ver.data.data.version)) || '';
  const blob = String(appName + ' ' + verStr).toLowerCase();
  const impl = /snowluma/.test(blob) ? 'snowluma'
    : /napcat/.test(blob) ? 'napcat'
    : /lagrange/.test(blob) ? 'lagrange'
    : /llonebot|llob/.test(blob) ? 'llonebot'
    : /go-cqhttp|gocq/.test(blob) ? 'gocqhttp'
    : 'onebot';
  const info = (login.data && login.data.data) || {};
  return {
    ok: true, httpUrl, impl,
    app: appName || impl, version: verStr,
    selfId: info.user_id || info.uin || null,
    nickname: info.nickname || '',
  };
}

async function doctor() {
  const sl = Object.assign({ httpUrl: 'http://127.0.0.1:3000', wsPort: 3001 }, cfg.snowluma);
  const dsh = Object.assign({ baseUrl: 'http://127.0.0.1:3080' }, cfg.dsh);
  const bg = Object.assign({ consoleUrl: 'http://127.0.0.1:3100' }, cfg.bridge);
  const httpHost = new URL(sl.httpUrl);
  const [snowlumaHttp, snowlumaWs, dshOk, bridgeOk] = await Promise.all([
    tcpProbe(httpHost.hostname, Number(httpHost.port) || 80),
    tcpProbe('127.0.0.1', Number(sl.wsPort) || 3001),
    httpProbe(dsh.baseUrl.replace(/\/$/, '') + '/'),
    tcpProbe('127.0.0.1', Number(new URL(bg.consoleUrl).port) || 3100),
  ]);
  const tools = await installedTools();
  const ob = await probeOnebot();
  return {
    onebot: ob,
    dsh: { ok: dshOk, url: dsh.baseUrl },
    snowluma: { ok: snowlumaHttp && snowlumaWs, http: snowlumaHttp, ws: snowlumaWs, httpUrl: sl.httpUrl },
    bridge: { ok: bridgeOk, url: bg.consoleUrl },
    mcp: { tools: tools.length },
    installed: currentPlugins().filter((p) => p.installed).length,
    uptime: uptime(),
    node: process.version,
    port: PORT,
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
      return sendJson(res, 200, {
        ok: true, bridge: d.bridge.ok, snowluma: d.snowluma.ok, dsh: d.dsh.ok,
        onebot: { ok: d.onebot.ok, impl: d.onebot.impl, app: d.onebot.app || '', selfId: d.onebot.selfId || null },
        installed: d.installed, tools: d.mcp.tools, uptime: d.uptime, node: d.node, port: d.port,
      });
    }
    if (method === 'GET' && p === '/api/doctor') return sendJson(res, 200, { ok: true, ...(await doctor()) });
    if (method === 'GET' && p === '/api/tools') return sendJson(res, 200, { ok: true, tools: await installedTools() });
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

    return sendJson(res, 404, { ok: false, error: 'not found' });
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
