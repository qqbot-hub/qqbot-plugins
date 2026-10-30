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
/* 监听地址：本机直接跑仍然只听 127.0.0.1（不暴露局域网）；
 * 部署平台会注入 PORT 环境变量（也可显式给 HOST），这时对外监听 0.0.0.0 才能被反代访问。 */
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const deployAgentPromise = import(pathToFileURL(path.join(ROOT, 'scripts/lib/deploy-agent.mjs')).href)
  .then(mod => ({ mod, service: mod.createDeployAgent({ doctor, port: PORT }) }));
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
const STATE_FILE = process.env.QQBOT_STATE_FILE || pickData(path.join('data', 'state', 'plugins.json'), path.join('data', 'state.json'));

function saveCfg() {
  try {
    const body = Object.assign({}, cfg, { templates: undefined });
    delete body.templates;
    fs.writeFileSync(CFG_FILE, JSON.stringify(body, null, 2) + '\n');
  } catch (e) { /* 写入失败不致命，下次保存再试 */ }
}

/* ---------- 状态 ---------- */
let STATE = {};
let STATE_MTIME = 0;
try {
  STATE = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  STATE_MTIME = fs.statSync(STATE_FILE).mtimeMs;
} catch (e) { STATE = {}; }
const saveState = () => {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); } catch { /* 目录已存在 */ }
  fs.writeFileSync(STATE_FILE, JSON.stringify(STATE, null, 2));
  try { STATE_MTIME = fs.statSync(STATE_FILE).mtimeMs; } catch { /* 拿不到 mtime 就下次再对 */ }
};
/* 安装任务是子模块（recipes/plugin.mjs）直接写 state 文件的，不经过这块内存。
 * 只信内存会出现「装完了页面还显示未安装、MCP 也列不出工具」——所以读之前先对一次 mtime。 */
function stateFresh() {
  try {
    const m = fs.statSync(STATE_FILE).mtimeMs;
    if (m === STATE_MTIME) return;
    const disk = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    STATE = disk && typeof disk === 'object' && !Array.isArray(disk) ? disk : {};
    STATE_MTIME = m;
  } catch { /* 文件读不到或被删了：保留内存副本，不要因为一次读失败把状态清空 */ }
}

/* ---------- ESM 模块（本仓库的 lib/recipe 都是 ESM，按需加载并缓存） ---------- */
const esmCache = new Map();
function esm(rel) {
  if (!esmCache.has(rel)) {
    esmCache.set(rel, import(pathToFileURL(path.join(ROOT, rel)).href));
  }
  return esmCache.get(rel);
}
const methodsLib = () => esm(path.join('scripts', 'lib', 'methods.mjs'));
const secretsLib = () => esm(path.join('scripts', 'lib', 'secrets.mjs'));

/* ---------- 密钥：只存密文，只回"有没有配" ---------- */
/* cfg.secrets 形如 { "napcat-astrbot.modelApiKey": "enc:v1:..." }，永远不出现在 API 明文里。
 * 解密结果只留在本进程内存（SECRET_CACHE），启动时一次性解出来，之后同步读取。 */
const SECRET_CACHE = new Map();
/* secrets 模块是 ESM，只能异步 import 一次；缓存下来给同步路径用 */
let SEC = null;
function decryptSync(v) { return SEC ? SEC.decrypt(v) : ''; }
const secretSlot = (methodId, key) => String(methodId || 'global') + '.' + String(key || '');
const slotOfOnebot = () => secretSlot('snowluma-dsh', 'onebotToken');
const slotOfSatori = () => secretSlot('satori', 'token');

async function initSecrets() {
  const { decrypt, encrypt } = await secretsLib();
  SEC = await secretsLib();
  for (const [slot, enc] of Object.entries(cfg.secrets || {})) {
    const v = decrypt(enc);
    if (v) SECRET_CACHE.set(slot, v);
  }
  /* 历史明文迁移：老版本把 AccessToken 直接写在 onebot.accessToken 里，搬进加密存储 */
  const legacy = String((cfg.onebot || {}).accessToken || '');
  if (!legacy) return;
  if (!SECRET_CACHE.has(slotOfOnebot())) {
    SECRET_CACHE.set(slotOfOnebot(), legacy);
    try {
      const backup = path.join(ROOT, 'config.backup-' + Date.now() + '.json');
      fs.copyFileSync(CFG_FILE, backup);
      cfg.secrets = Object.assign({}, cfg.secrets, { [slotOfOnebot()]: encrypt(legacy) });
      if (cfg.onebot) delete cfg.onebot.accessToken;
      if (cfg.snowluma) delete cfg.snowluma.accessToken;
      saveCfg();
      console.log('[secrets] 明文 AccessToken 已迁入加密存储，原文件备份为 ' + path.basename(backup));
    } catch (e) {
      console.log('[secrets] 迁移失败（不影响运行）：' + e.message);
    }
  }
}

async function setSecret(methodId, key, value) {
  const { encrypt } = await secretsLib();
  cfg.secrets = Object.assign({}, cfg.secrets);
  const slot = secretSlot(methodId, key);
  const v = String(value == null ? '' : value);
  if (!v) {
    delete cfg.secrets[slot];
    SECRET_CACHE.delete(slot);
    saveCfg();
    return { cleared: true };
  }
  cfg.secrets[slot] = encrypt(v);
  SECRET_CACHE.set(slot, v);
  saveCfg();
  return { saved: true };
}

function secretStatus(methodId, keys) {
  const out = {};
  for (const k of keys || []) {
    out[k.key] = { has: SECRET_CACHE.has(secretSlot(methodId, k.key)) };
  }
  return out;
}

/* 把某条方法已存的密钥交给安装脚本用（只在本进程内存里，不回前端） */
async function secretsForMethod(methodId) {
  const out = {};
  const prefix = String(methodId || '') + '.';
  for (const [slot, v] of SECRET_CACHE.entries()) {
    if (!slot.startsWith(prefix)) continue;
    out[slot.slice(prefix.length)] = v;
  }
  /* 兼容：没按方法存过 token 时，用老的全局 token */
  if (!out.onebotToken) {
    const legacy = SECRET_CACHE.get(slotOfOnebot()) || String((cfg.onebot || {}).accessToken || '');
    if (legacy) out.onebotToken = legacy;
  }
  return out;
}

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
/* 权限清单：由 scripts/build-permissions.mjs 扫真实代码生成，按 mtime 缓存 */
const PERMS_FILE = path.join(ROOT, 'data', 'catalog', 'permissions.json');
let permsCache = { at: 0, data: {} };
function permissionsMap() {
  try {
    const st = fs.statSync(PERMS_FILE);
    if (permsCache.at !== st.mtimeMs) {
      const doc = JSON.parse(fs.readFileSync(PERMS_FILE, 'utf8'));
      permsCache = { at: st.mtimeMs, data: doc.plugins || {} };
    }
    return permsCache.data;
  } catch { return {}; }
}
/* ---------- 生态插件目录（NoneBot / AstrBot / Koishi 的真实索引） ----------
 * 数据来自 scripts/sync-ecosystem.mjs 抓回来的第三方注册表，不是我们编的。
 * 条目里带 install.target/params，点「安装」就是把它们交给对应的 recipe。 */
const ECO_FILE = path.join(ROOT, 'data', 'sources', 'ecosystem.json');
let ecoCache = { at: 0, data: { fetchedAt: '', sources: {}, errors: [], items: [] } };
let ecoSyncing = null;

function ecosystemDoc() {
  try {
    const st = fs.statSync(ECO_FILE);
    if (ecoCache.at !== st.mtimeMs) {
      const doc = JSON.parse(fs.readFileSync(ECO_FILE, 'utf8'));
      ecoCache = {
        at: st.mtimeMs,
        data: {
          fetchedAt: doc.fetchedAt || '',
          sources: doc.sources || {},
          errors: doc.errors || [],
          items: Array.isArray(doc.items) ? doc.items : [],
        },
      };
    }
  } catch { /* 还没抓过就返回空目录，页面显示「点同步」 */ }
  return ecoCache.data;
}

/** 生态目录查询：搜索 + 框架/分类过滤 + 分页（1368 条不能一次全发） */
function ecoQuery(opt) {
  const q = String(opt.q || '').trim().toLowerCase();
  const fw = String(opt.framework || '').trim();
  const cat = String(opt.category || '').trim();
  let items = ecosystemDoc().items;
  if (fw) items = items.filter((x) => x.framework === fw);
  if (cat) items = items.filter((x) => x.category === cat);
  if (q) {
    items = items.filter((x) => (
      String(x.name || '').toLowerCase().includes(q)
      || String(x.description || '').toLowerCase().includes(q)
      || String(x.author || '').toLowerCase().includes(q)
      || String(x.id || '').includes(q)
      || (x.install && String(x.install.params && (x.install.params.package || x.install.params.repo) || '').toLowerCase().includes(q))
    ));
  }
  /* 排序：官方优先 → star 多的在前 → 名字；纯 JS 排序，量级只有千条，不用建索引 */
  items = items.slice().sort((a, b) => {
    if (!!b.official !== !!a.official) return b.official ? 1 : -1;
    if ((b.stars || 0) !== (a.stars || 0)) return (b.stars || 0) - (a.stars || 0);
    return String(a.name).localeCompare(String(b.name));
  });
  const total = items.length;
  const offset = Math.max(0, Number(opt.offset) || 0);
  const limit = Math.min(200, Math.max(1, Number(opt.limit) || 60));
  return { total, offset, limit, items: items.slice(offset, offset + limit) };
}

/** 触发同步（同一时刻只允许一个，重复点复用同一个 Promise） */
function ecoSync() {
  if (ecoSyncing) return ecoSyncing;
  ecoSyncing = (async () => {
    const mod = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'ecosystem.mjs')).href);
    const doc = await mod.syncAll();
    ecoCache.at = 0;                       /* 让下次读重新 stat，别拿到旧缓存 */
    return { items: doc.items.length, sources: doc.sources, errors: doc.errors };
  })();
  ecoSyncing.catch(() => {}).finally(() => { ecoSyncing = null; });
  return ecoSyncing;
}

function currentPlugins() {
  stateFresh();
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
    /* enabled 也得看：以前只判 installed，结果页面上点了「停用」，群消息确实不回了，
     * 但 AI 侧的工具列表里它还在——停用变成只管一半，等于骗人。 */
    if (!p.installed || !p.enabled) continue;
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

/* 插件配置里的 password 字段（voice / imagine 的 API Key）以前是明文躺在 config.json
 * 里的，接口也原样回给页面——和方法级 token（onebot/satori）的加密存储不一致。
 * 现在统一加密存储，并且拆成两个读法：
 *   · 给界面：password 字段不回值，只告诉前端"配过没有"
 *   · 给插件：解密后的真值（插件本来就需要它去请求接口） */
const SECRET_FIELD = (f) => f && f.type === 'password';

async function pluginValuesForUi(id) {
  const v = Object.assign({}, pluginValues(id));
  let schema = null;
  try { schema = await pluginSchema(id); } catch { /* 插件加载失败就按原样回 */ }
  const configured = {};
  for (const f of (schema && schema.fields) || []) {
    if (!SECRET_FIELD(f)) continue;
    configured[f.key] = !!v[f.key];
    v[f.key] = '';           // 明文/密文都不回给浏览器
  }
  return Object.assign(v, { __configured: configured });
}

/* 插件运行时拿到的配置：密文解开再给（认 enc:v1: 前缀，比靠 schema 更稳——
 * 老配置里可能是明文，decrypt 会原样返回，不会把能用的配置读坏） */
function pluginValuesForRun(id) {
  const v = Object.assign({}, pluginValues(id));
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string' && val.startsWith('enc:v1:')) {
      try { v[k] = decryptSync(val); } catch { v[k] = ''; }
    }
  }
  return v;
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
  const sa = cfg.satori || {};
  return {
    protocol: String(cfg.protocol || 'onebot') === 'satori' ? 'satori' : 'onebot',
    satori: {
      baseUrl: (sa.baseUrl || 'http://127.0.0.1:5142/satori'),
      platform: sa.platform || 'onebot',
      selfId: sa.selfId || '',
      token: '',                       // 不回传
      hasToken: SECRET_CACHE.has(slotOfSatori()),
    },
    onebot: {
      impl: ob.impl || 'auto',
      authMode: ob.authMode || 'header',
      pathPrefix: ob.pathPrefix || '',
    },
    snowluma: {
      httpUrl: ob.httpUrl || sl.httpUrl || 'http://127.0.0.1:3000',
      accessToken: '',                 // 不回传
      hasToken: SECRET_CACHE.has(slotOfOnebot()),
      wsPort: Number(sl.wsPort || 3001),
    },
    dsh: { baseUrl: dsh.baseUrl || 'http://127.0.0.1:3080', profile: dsh.profile || 'desktop' },
    bridge: { consoleUrl: bg.consoleUrl || 'http://127.0.0.1:3100' },
    port: PORT,
    hasPassword: !!PASSWORD,
  };
}

async function saveGlobal(input) {
  const src = input && typeof input === 'object' ? input : {};
  cfg.snowluma = Object.assign({}, cfg.snowluma);
  cfg.dsh = Object.assign({}, cfg.dsh);
  cfg.bridge = Object.assign({}, cfg.bridge);
  /* 协议切换：onebot | satori。切错了会让插件说不上话，所以只接受这两个值 */
  if (typeof src.protocol === 'string') {
    const p = src.protocol.trim().toLowerCase();
    if (p === 'onebot' || p === 'satori') cfg.protocol = p;
  }
  if (src.satori && typeof src.satori === 'object') {
    cfg.satori = Object.assign({}, cfg.satori);
    const s = src.satori;
    if (typeof s.baseUrl === 'string' && s.baseUrl.trim()) cfg.satori.baseUrl = s.baseUrl.trim().replace(/\/+$/, '');
    if (typeof s.platform === 'string' && s.platform.trim()) cfg.satori.platform = s.platform.trim();
    if (typeof s.selfId === 'string' && s.selfId.trim()) cfg.satori.selfId = s.selfId.trim();
    if (typeof s.token === 'string' && s.token.trim()) await setSecret('satori', 'token', s.token.trim());
    if (s.clearToken === true) await setSecret('satori', 'token', '');
  }
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
    /* 空字符串=保持原样；只有明确填了新值才覆盖。token 走加密存储，不进 config.json 明文 */
    if (typeof s.accessToken === 'string' && s.accessToken.trim()) {
      await setSecret('snowluma-dsh', 'onebotToken', s.accessToken.trim());
    }
    if (s.clearToken === true) {
      await setSecret('snowluma-dsh', 'onebotToken', '');
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
    /* 401/403 也算「服务活着」：DSH 的网页端没带令牌时就回 401，
       要判断的是链路通不通，不是有没有登录 */
    return r.ok || (r.status >= 300 && r.status < 500);
  } catch { return false; } finally { clearTimeout(t); }
}
/* 识别协议端：**复用适配层**（plugins/_bridge.mjs），
   保证「网页显示的协议端」和「插件实际说话的协议端」是同一套判断，
   差异（动作名/鉴权/响应格式）只在适配层维护一份。 */
let bridgeMod = null;
let protocolMod = null;
async function bridgeModule() {
  if (!bridgeMod) bridgeMod = await import(pathToFileURL(path.join(ROOT, 'plugins', '_bridge.mjs')).href);
  return bridgeMod;
}
/* 统一协议层：按配置在 OneBot v11 / Satori 之间切换，插件与页面都不用改 */
async function protocolModule() {
  if (!protocolMod) protocolMod = await import(pathToFileURL(path.join(ROOT, 'plugins', '_protocol.mjs')).href);
  return protocolMod;
}
function onebotCfg() {
  const ob = cfg.onebot || {};
  const sl = cfg.snowluma || {};
  const sa = cfg.satori || {};
  return {
    /* 当前使用的协议：onebot（默认）| satori */
    protocol: String(cfg.protocol || 'onebot').toLowerCase() === 'satori' ? 'satori' : 'onebot',
    impl: String(ob.impl || 'auto'),
    httpUrl: String(ob.httpUrl || sl.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    /* token 只在内存里：加密存盘，接口不回传 */
    accessToken: String(SECRET_CACHE.get(slotOfOnebot()) || ob.accessToken || sl.accessToken || ''),
    authMode: String(ob.authMode || 'header'),
    pathPrefix: String(ob.pathPrefix || ''),
    satori: {
      baseUrl: String(sa.baseUrl || 'http://127.0.0.1:5142/satori').replace(/\/+$/, ''),
      token: String(SECRET_CACHE.get(slotOfSatori()) || sa.token || ''),
      platform: String(sa.platform || 'onebot'),
      selfId: String(sa.selfId || ''),
      timeoutMs: 2500,
    },
    timeoutMs: 2500,          // 体检要快，不能卡住页面
  };
}
/* 3 秒缓存：页面轮询 /api/health 时不至于每次都去打协议端 */
let hbCache = { key: '', at: 0, value: null };
async function probeOnebot(force = false) {
  const c = onebotCfg();
  /* 缓存键只放"会影响结果"的字段，token 只记有没有，不落进键里 */
  const key = JSON.stringify({
    p: c.protocol,
    u: c.protocol === 'satori' ? c.satori.baseUrl : c.httpUrl,
    s: c.protocol === 'satori' ? (c.satori.platform + '|' + c.satori.selfId + '|' + (c.satori.token ? 1 : 0)) : '',
    t: c.protocol === 'satori' ? 0 : (c.accessToken ? 1 : 0),
  });
  if (!force && hbCache.value && hbCache.key === key && Date.now() - hbCache.at < 3000) return hbCache.value;
  const { createProbe } = await protocolModule();
  const hb = await createProbe(c).heartbeat({ force: true, ttlMs: 0 });
  /* 补上协议名，页面据此显示"当前走 OneBot v11 还是 Satori" */
  const value = Object.assign({ protocol: c.protocol }, hb);
  hbCache = { key, at: Date.now(), value };
  return value;
}

/* ---------- 消息接入：让插件真的能「收消息」 ----------
 * 之前插件只是等 AI 调用的工具，群里的消息一条也进不来。
 * 这里做三件事：
 *   1. 收集已安装且已启用插件的 handlers（插件自己声明匹配规则/权限）
 *   2. 把 OneBot v11 的上报事件归一化后分发给它们
 *   3. 把统计暴露给前端，让「收到了几条、谁被触发了、谁被权限拦了」看得见
 * 明确不支持：Satori 收消息（Satori 规范只有 WS /v1/events，要用自定义头鉴权，
 * 而 Node 内置 WebSocket 不支持自定义头；宁可不做，也不装一个假的能收）
 */
let msgMod = null;
let msgRouter = null;
let handlerCache = [];
let handlerLoading = null;
let msgStats = { received: 0, matched: 0, handled: 0, denied: 0, throttled: 0, failed: 0, lastAt: 0, lastError: '', recent: [] };

async function messageModule() {
  if (!msgMod) msgMod = await import(pathToFileURL(path.join(ROOT, 'plugins', '_router.mjs')).href);
  return msgMod;
}

/** 读已装 + 已启用插件的 handlers；单插件报错不影响其它插件 */
async function collectHandlers() {
  const out = [];
  for (const p of currentPlugins()) {
    if (!p.installed || !p.enabled) continue;
    const file = path.join(ROOT, 'plugins', p.id + '.mjs');
    if (!fs.existsSync(file)) continue;
    try {
      const mod = await import(pathToFileURL(file).href);
      const list = (mod.default && mod.default.handlers) || [];
      for (const h of [].concat(list)) {
        if (!h || typeof h.run !== 'function') continue;
        /* 权限在 runHandler 里现查（build-permissions 扫出来的那份），
         * 不在这里缓存，免得换了权限文件还得重启 */
        /* 插件运行时拿到的配置要解密过（密钥字段存的是密文） */
        out.push({ pluginId: p.id, file, handler: Object.assign({ __cfg: await pluginValuesForRun(p.id) }, h) });
      }
    } catch (e) {
      console.log(`[msg] 插件 ${p.id} 的 handler 加载失败：${e.message}`);
    }
  }
  return out;
}

async function refreshHandlers() {
  if (handlerLoading) return handlerLoading;
  handlerLoading = (async () => {
    try {
      handlerCache = await collectHandlers();
    } catch (e) {
      console.log('[msg] 刷新 handler 失败：' + e.message);
    }
  })().finally(() => { handlerLoading = null; });
  return handlerLoading;
}

/** 发消息走统一协议层：插件不需要知道底下是 OneBot 还是 Satori */
async function sendViaProtocol(target, text) {
  const { createProtocol } = await protocolModule();
  const proto = createProtocol(onebotCfg());
  const to = target && target.groupId ? { groupId: target.groupId } : { userId: target.userId };
  return proto.sendText(to, text);
}

async function messageRuntime() {
  if (msgRouter) return msgRouter;
  const { createRouter } = await messageModule();
  await refreshHandlers();
  msgRouter = createRouter({
    listHandlers: () => handlerCache,
    send: sendViaProtocol,
    log: (m) => console.log('[msg] ' + m),
    /* 插件的 handler 也进沙箱：它跟工具调用一样是第三方代码，
     * 一条群消息就能触发，没理由比 AI 调工具多一份信任。 */
    runHandler: async (item, h, msg, api) => {
      const { runSandboxed, permsFor, sanitizeConfig } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'sandbox.mjs')).href);
      if (String(process.env.QQBOT_SANDBOX || '1') === '0') { await h.run(msg, api); return; }
      await runSandboxed({
        hubRoot: ROOT,
        pluginId: item.pluginId,
        pluginFile: item.file,
        kind: 'handler',
        handlerId: h.id || '',
        msg,
        cfg: h.__cfg || {},
        config: sanitizeConfig(cfg),
        permissions: permsFor(ROOT, item.pluginId),
        host: {
          reply: (text) => sendViaProtocol({ scope: msg.scope, groupId: msg.groupId, userId: msg.userId }, text),
          sendText: (to, text) => sendViaProtocol(to, text),
          log: (m) => console.log(`[plugin:${item.pluginId}] ${m}`),
        },
        timeoutMs: 20000,
      });
    },
  });
  return msgRouter;
}

/** OneBot v11 上报的入口：鉴权走「只认本机 + 可选 token」，因为协议端不会带登录 Cookie */
async function handleOnebotEvent(req, res) {
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!/^(127\.0\.0\.1|::1|0:0:0:0:0:0:0:1)$/.test(ip)) {
    return sendJson(res, 403, { ok: false, error: '只接受本机上报（协议端应与本服务同机）' });
  }
  const raw = await readBody(req);
  let evt;
  try { evt = JSON.parse(raw || '{}'); } catch { return sendJson(res, 400, { ok: false, error: '不是合法 JSON' }); }

  const c = onebotCfg();
  const need = String(c.accessToken || '');
  if (need) {
    const got = String(new URL(req.url, 'http://x').searchParams.get('token') || req.headers['x-onebot-token'] || '');
    if (got !== need) return sendJson(res, 403, { ok: false, error: 'token 不匹配（请把上报地址写成 ?token=你的 AccessToken）' });
  }

  const { normalizeOneBot } = await messageModule();
  const msg = normalizeOneBot(evt, c.selfId || '');
  if (!msg) {
    /* 不是消息事件（群成员变动/心跳/自己发的消息）→ 明确忽略，不报错 */
    return sendJson(res, 200, { ok: true, ignored: true });
  }
  const rt = await messageRuntime();
  const r = await rt.dispatch(msg);
  msgStats = rt.stats;
  return sendJson(res, 200, Object.assign({ ok: true }, r));
}

/* ---------- 运行监控 ----------
 * 只报**探测到的事实**：端口通不通、协议端心跳活不活。
 * 探测不到就明确说没在跑，不做"看起来像在跑"的推断。
 * 一个服务可能有多个候选端口（比如 NoneBot 默认 8080，被占时用 20080），
 * 所以每个服务给一个端口列表，全都不通才算没起来。
 */
const MONITOR_SERVICES = [
  { id: 'market', label: '插件市场', role: '网页 + API + MCP 注册', ports: [3210], method: 'market' },
  { id: 'snowluma', label: 'SnowLuma', role: '协议端（OneBot v11）', ports: [3000, 3001], method: 'snowluma-dsh' },
  { id: 'dsh', label: 'DeepSeek Harness', role: 'AI 运行时', ports: [11762, 8326, 3080], method: 'snowluma-dsh' },
  { id: 'qqbridge', label: 'qq-bridge', role: 'AI ⇄ QQ 桥', ports: [3100], method: 'snowluma-dsh' },
  { id: 'nonebot', label: 'NoneBot2', role: '机器人框架', ports: [8080, 20080], method: 'napcat-nonebot' },
  { id: 'koishi', label: 'Koishi', role: '机器人框架 + 控制台', ports: [5140], method: 'napcat-koishi' },
  { id: 'satori', label: 'Satori Server', role: 'Satori 协议服务端', ports: [5142, 5141], method: 'napcat-koishi' },
  { id: 'voicelab', label: '调音台', role: '语音音色', ports: [3120], method: 'voicelab' },
];

/* 光看端口通还不够：8080 很可能被本机别的程序占着。
 * 这里对几个常见服务做"内容指纹"，认不出来就如实说"端口被占但不是它"，
 * 免得用户看到绿灯以为机器人跑起来了。 */
async function fetchText(url, timeoutMs = 1500, opts = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: opts.body, signal: ac.signal });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch {
    return { ok: false, status: 0, text: '' };
  } finally { clearTimeout(timer); }
}

const VERIFY = {
  /* NoneBot2 用 FastAPI/uvicorn，但**新版默认不开放 docs**，openapi.json 直接 404
   * （本机实测：20080 上明明跑着 NoneBot，/openapi.json 与 /docs 都是 404，
   *  于是监控把健康服务报成"离线、端口被别的程序占着"——这是误报，必须两条路都认）。
   * 退路认 onebot v11 适配器的应答特征：缺 X-Self-ID 头时它固定回这三个词，
   * 这比"端口开着"可靠得多，又不像 openapi 那样依赖部署方开没开 docs。 */
  nonebot: async (port) => {
    const r = await fetchText(`http://127.0.0.1:${port}/openapi.json`, 1200);
    if (r.ok) {
      try {
        const j = JSON.parse(r.text);
        if (j.openapi || j.swagger) return { ok: true, note: 'FastAPI openapi 指纹通过' };
      } catch { /* 不是 JSON 就继续往下认 */ }
    }
    const p = await fetchText(`http://127.0.0.1:${port}/onebot/v11/`, 1200, { method: 'POST', body: '{}' });
    if (/X-Self-ID|Authorization|Missing .*[Hh]eader/i.test(p.text || '')) {
      return { ok: true, note: 'OneBot v11 适配器指纹通过（缺 X-Self-ID 头时的固定应答）' };
    }
    return null;
  },
  /* Koishi 控制台页面里带 koishi 字样 */
  koishi: async (port) => {
    const r = await fetchText(`http://127.0.0.1:${port}/`, 1500);
    if (!r.ok) return null;
    return /koishi/i.test(r.text) ? { ok: true, note: 'Koishi 控制台指纹通过' } : null;
  },
  /* Satori 服务端对任意方法都回固定几句文本，认这个比认端口可靠。
   * 路径必须跟配置里的 path 一致（默认 /satori），漏了前缀会拿到 koa 的 404。
   * 注意不能把泛化的 "Not Found" 算通过 —— koa 默认 404 也是这句话，会误判。 */
  satori: async (port) => {
    let prefix = '/satori';
    try {
      const u = new URL(String((cfg.satori || {}).baseUrl || ''));
      prefix = u.pathname.replace(/\/+$/, '') || '';
    } catch { /* 配置里没有 baseUrl 时用默认前缀 */ }
    const r = await fetchText(`http://127.0.0.1:${port}${prefix}/v1/login.get`, 1500, { method: 'POST', body: '{}' });
    if (!r.text) return null;
    return /login not found|invalid token|method not found|Please use POST method/i.test(r.text)
      ? { ok: true, note: `Satori 协议指纹通过（HTTP ${r.status}）` }
      : null;
  },
};

async function monitor() {
  const services = await Promise.all(MONITOR_SERVICES.map(async (s) => {
    const ports = await Promise.all(s.ports.map(async (port) => ({ port, open: await tcpProbe('127.0.0.1', port, 900) })));
    const openPorts = ports.filter((p) => p.open).map((p) => p.port);
    let verified = null;
    let note = '';
    const verify = VERIFY[s.id];
    if (!openPorts.length) {
      note = '端口都不通，没在跑';
    } else if (!verify) {
      note = `端口 ${openPorts.join('/')} 在监听（未做内容指纹，只确认端口）`;
    } else {
      for (const p of openPorts) {
        const r = await verify(p);
        if (r) { verified = true; note = r.note + ` @${p}`; break; }
      }
      if (verified === null) {
        verified = false;
        note = `端口 ${openPorts.join('/')} 被别的程序占着，指纹对不上，不是 ${s.label}`;
      }
    }
    return {
      id: s.id,
      label: s.label,
      role: s.role,
      method: s.method,
      ports,
      openPorts,
      /* running 只认"端口通 且 指纹对得上（或该服务未做指纹）" */
      running: openPorts.length > 0 && verified !== false,
      verified,
      note,
    };
  }));
  const hb = await probeOnebot();
  /* 协议端那一栏不能只认端口。
   * 端口通但心跳不通时（典型现场：3000 端口挂着别的程序，返回 HTML 404），
   * services 会把它标成"在跑"亮绿灯，同一屏里协议端卡却写着"离线"、主链路卡片
   * 写着"未启动"——一个画面三种说法。这里统一以心跳探测为准，跟另外两处同一份结论。 */
  const protoSvcId = hb.protocol === 'satori' ? 'satori' : 'snowluma';
  for (const s of services) {
    if (s.id !== protoSvcId) continue;
    if (hb.online) {
      s.running = true;
      s.verified = true;
      s.note = `${hb.app || s.label} 心跳正常${hb.latencyMs != null ? ` · ${hb.latencyMs}ms` : ''}`;
    } else {
      s.running = false;
      s.verified = false;
      /* 原因不在这里重复一遍：同一区块上方的协议端卡已经把完整原因写出来了，
       * 再拼一段就变成「端口通但心跳失败：get_login_info 失败：HTTP 404：…」的三层套娃 */
      s.note = '端口通但心跳失败，原因见「协议端」那一行';
    }
  }
  let jobs = [];
  try {
    const mod = await installer();
    jobs = (mod.recentJobs ? mod.recentJobs() : []).slice(0, 6).map((j) => ({
      id: j.id, target: j.target, title: j.title, status: j.status,
      startedAt: j.startedAt, endedAt: j.endedAt,
      steps: j.steps ? j.steps.length : 0,
      done: j.steps ? j.steps.filter((s) => s.status === 'ok' || s.status === 'skip').length : 0,
      manual: j.steps ? j.steps.filter((s) => s.status === 'manual').length : 0,
      failed: j.steps ? j.steps.filter((s) => s.status === 'fail').length : 0,
    }));
  } catch { jobs = []; }
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    services,
    running: services.filter((s) => s.running).length,
    total: services.length,
    protocol: {
      id: hb.protocol || 'onebot',
      online: !!hb.online,
      app: hb.app || '',
      impl: hb.impl || '',
      selfId: hb.selfId ?? null,
      nickname: hb.nickname || '',
      latencyMs: hb.latencyMs ?? null,
      error: hb.error || '',
      errorKind: hb.errorKind || '',
      checkedAt: hb.checkedAt || '',
    },
    jobs,
    uptime: uptime(),
  };
}

let healthCache = { key: '', at: 0, data: {} };
async function primaryHealth(plugins, lib) {
  const key = JSON.stringify([cfg.plugins, plugins.map(p => [p.id, p.installed, p.enabled])]);
  if (healthCache.key === key && Date.now() - healthCache.at < 10000) return healthCache.data;
  const data = {};
  const ids = ['qzone','voice','vision','video','sticker','group_admin','group_info'];
  await Promise.all(plugins.filter(p => p.installed && ids.includes(p.id)).map(async p => {
    data[p.id] = await lib.pluginHealth(p.id, cfg, { root: ROOT });
  }));
  healthCache = { key, at: Date.now(), data };
  return data;
}
let connectionRefreshAt = 0, connectionRefresh = null, discoveredDsh = { running: false, webPort: 0 };
async function refreshConnections() {
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) return;
  if (connectionRefresh) return connectionRefresh;
  if (Date.now() - connectionRefreshAt < 10000) return;
  connectionRefreshAt = Date.now();
  connectionRefresh = (async () => {
    try { cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'))); } catch {}
    const [discovery, dshLib, engine] = await Promise.all([esm('scripts/lib/discover.mjs'), esm('scripts/lib/dsh-discover.mjs'), installer()]);
    const dsh = await dshLib.discoverDsh({ cfg: () => cfg, isWin: process.platform === 'win32', exec: engine.exec });
    discoveredDsh = dsh;
    let changed = false;
    if (dsh.webPort && cfg.dsh?.baseUrl !== 'http://127.0.0.1:' + dsh.webPort) { cfg.dsh = { ...cfg.dsh, baseUrl: 'http://127.0.0.1:' + dsh.webPort }; changed = true; }
    if ((cfg.onebot?.protocol || 'onebot') === 'satori') { if (changed) saveCfg(); return; }
    const snow = await discovery.discoverSnowLuma(cfg, { root: ROOT });
    if (snow.heartbeat.online) {
      const before = JSON.stringify(cfg); discovery.applySnowLuma(cfg, snow); changed ||= before !== JSON.stringify(cfg);
      SECRET_CACHE.set(slotOfOnebot(), snow.accessToken || '');
    }
    discovery.syncBridgeConfig(cfg, { dsh, snow });
    if (changed) saveCfg();
  })().catch(e => console.error('[discovery] ' + e.message)).finally(() => { connectionRefresh = null; });
  return connectionRefresh;
}
async function doctor() {
  await refreshConnections();
  const ob = onebotCfg();
  const isSatori = ob.protocol === 'satori';
  const sl = Object.assign({ wsPort: 3001 }, cfg.snowluma);
  const dsh = Object.assign({ baseUrl: 'http://127.0.0.1:3080' }, cfg.dsh);
  const bg = Object.assign({ consoleUrl: 'http://127.0.0.1:3100' }, cfg.bridge);
  /* 走 Satori 时，"协议端地址"是 satori 的 baseUrl，不是 OneBot 的 3000 */
  const targetUrl = isSatori ? ob.satori.baseUrl : ob.httpUrl;
  let httpHost;
  try { httpHost = new URL(targetUrl); } catch { httpHost = new URL('http://127.0.0.1:3000'); }
  const [snowlumaHttp, snowlumaWs, dshOk, bridgeOk] = await Promise.all([
    tcpProbe(httpHost.hostname, Number(httpHost.port) || 80),
    tcpProbe('127.0.0.1', Number(sl.wsPort) || 3001),
    httpProbe(dsh.baseUrl.replace(/\/$/, '') + '/'),
    tcpProbe('127.0.0.1', Number(new URL(bg.consoleUrl).port) || 3100),
  ]);
  const tools = await installedTools();
  const hb = await probeOnebot();
  const { PROTOCOLS } = await protocolModule();
  const proto = PROTOCOLS[ob.protocol] || PROTOCOLS.onebot;
  return {
    onebot: hb,
    protocol: { id: ob.protocol, label: proto.label, note: proto.note, capabilities: proto.capabilities },
    protocols: Object.values(PROTOCOLS).map((x) => ({ id: x.id, label: x.label, note: x.note, capabilities: x.capabilities })),
    dsh: { ok: dshOk && !!discoveredDsh.webPort, url: dsh.baseUrl },
    /* 走 Satori 时 SnowLuma 那一栏没有意义，如实标 null，不让页面显示假绿点 */
    snowluma: isSatori
      ? { ok: null, skipped: '当前协议是 Satori，不经 SnowLuma' }
      : { ok: snowlumaHttp && snowlumaWs, http: snowlumaHttp, ws: snowlumaWs, httpUrl: ob.httpUrl },
    bridge: { ok: bridgeOk, url: bg.consoleUrl },
    mcp: { tools: tools.length, loadedTools: (await esm('scripts/lib/plugin-health.mjs')).observedTools(ROOT).size },
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

/* 注入到调音台页面右下角的「返回市场」浮标 */
const LAB_BACK_SNIPPET = `<div id="__labBack" style="position:fixed;right:14px;bottom:46px;z-index:9999;display:flex;gap:8px">
<a href="/" style="background:#1c232c;color:#9fb3c8;border:1px solid #2b3542;border-radius:8px;padding:6px 12px;font:12px/1.4 system-ui,'Microsoft YaHei';text-decoration:none">← 返回市场</a></div>`;

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
  const isHtmlPage = (stripPrefix === '/lab') && (p === '/' || p === '/index.html');
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
    /* 给调音台首页注入「返回市场」浮标（小页面整体缓存后再回，不影响其它请求） */
    if (isHtmlPage && String(out['content-type'] || '').includes('text/html')) {
      const parts = [];
      r.on('data', (c) => parts.push(c));
      r.on('end', () => {
        let html = Buffer.concat(parts).toString('utf8');
        html = html.replace(/<\/body>/i, LAB_BACK_SNIPPET + '</body>');
        out['content-length'] = Buffer.byteLength(html);
        res.writeHead(r.statusCode || 502, out);
        res.end(html);
      });
      return;
    }
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

/* ============ 实测结果 ============
 * verify-plugins 会真跑 84 个工具，其中一批要联网、一批要有 QQ 在线，
 * 所以通过数天生是浮动的（QQ 没开时 63，开了 64）。页面写死任何一个数都会在
 * 另一种状态下变成假话，这里改成后台跑、缓存 30 分钟、前端拿真实值。 */
const VERIFY_SCRIPT = path.join(ROOT, 'scripts', 'verify-plugins.mjs');
const VERIFY_TTL = 30 * 60 * 1000;
const VERIFY_TIMEOUT = 120000;
const VERIFY_STATE = { running: false, at: 0, data: null, error: '' };
/* 环境不完整时（比如公网那份没有 config.json、没有协议端）跑出来是全军覆没，
 * 这种结果展示出去等于自曝家丑，而且每次访问都重跑一遍纯属浪费。
 * 一旦跑出「一项都没通过」，就歇 60 分钟别再折腾。 */
const VERIFY_BAD_COOL = 60 * 60 * 1000;
let VERIFY_COOL_UNTIL = 0;
const verifyCredible = (d) => !!d && d.pass > 0 && d.fail === 0;

function runVerify() {
  if (VERIFY_STATE.running) return false;
  VERIFY_STATE.running = true;
  VERIFY_STATE.error = '';
  let child;
  try {
    child = spawn(process.execPath, [VERIFY_SCRIPT, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT });
  } catch (e) {
    VERIFY_STATE.running = false;
    VERIFY_STATE.error = String((e && e.message) || e);
    return false;
  }
  let out = '', timer = null;
  const finish = () => {
    if (timer) clearTimeout(timer);
    let j = null;
    try { j = JSON.parse(out); } catch { /* 输出被日志打断时宁可不算，也不报假数 */ }
    if (j && Number.isFinite(j.pass)) {
      VERIFY_STATE.data = {
        pass: j.pass, total: j.total, plugins: j.plugins,
        needBot: j.needBot || 0, needCfg: j.needCfg || 0, needNet: j.needNet || 0, fail: j.fail || 0,
      };
      VERIFY_STATE.at = Date.now();
      /* 全军覆没说明这台机器缺东西，别再反复跑，也别拿它当真实水平展示 */
      if (!verifyCredible(VERIFY_STATE.data)) VERIFY_COOL_UNTIL = Date.now() + VERIFY_BAD_COOL;
      else VERIFY_COOL_UNTIL = 0;
    } else if (!j) {
      VERIFY_STATE.error = '实测脚本没返回可解析的结果';
    }
    VERIFY_STATE.running = false;
  };
  timer = setTimeout(() => { try { child.kill(); } catch {} finish(); }, VERIFY_TIMEOUT);
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', () => {});
  child.on('error', (e) => { VERIFY_STATE.error = String((e && e.message) || e); if (timer) clearTimeout(timer); VERIFY_STATE.running = false; });
  child.on('close', finish);
  return true;
}

/* ============ Star 数 ============
 * 前端直接 fetch api.github.com 会被 CORS 拦，而且未登录限流只有 60 次/小时/IP，
 * 公网上一有人访问就打满了。挪到服务端：拿到缓存 10 分钟，拿不到（没网/被限流）
 * 就冷却 5 分钟不再重试，免得每个访客都陪着干等 6 秒超时。 */
const STAR_TTL = 10 * 60 * 1000;
const STAR_COOL = 5 * 60 * 1000;
const STAR_STATE = { n: null, at: 0, failAt: 0, lastError: '' };

async function fetchStars() {
  try {
    const r = await fetch('https://api.github.com/repos/qqbot-hub/qqbot-plugins', {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'qqbot-plugins' },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) { STAR_STATE.lastError = 'GitHub 返回 ' + r.status; return null; }
    const j = await r.json();
    const n = Number(j && j.stargazers_count);
    if (!Number.isFinite(n)) { STAR_STATE.lastError = 'GitHub 返回里没有 star 数'; return null; }
    return n;
  } catch (e) {
    STAR_STATE.lastError = String((e && e.name) || (e && e.message) || e);
    return null;
  }
}

async function starsCached(force) {
  const now = Date.now();
  if (!force && STAR_STATE.n !== null && now - STAR_STATE.at < STAR_TTL) {
    return { ok: true, stars: STAR_STATE.n, cached: true, error: '' };
  }
  /* 冷却内不再重试：刚失败过就别让下一个访客再卡一次超时 */
  if (!force && STAR_STATE.failAt && now - STAR_STATE.failAt < STAR_COOL) {
    return { ok: true, stars: null, cached: false, error: STAR_STATE.lastError };
  }
  const n = await fetchStars();
  if (n === null) {
    STAR_STATE.failAt = now;
    return { ok: true, stars: null, cached: false, error: STAR_STATE.lastError };
  }
  STAR_STATE.n = n;
  STAR_STATE.at = now;
  STAR_STATE.failAt = 0;
  return { ok: true, stars: n, cached: false, error: '' };
}

function verifyResult(force) {
  const fresh = VERIFY_STATE.data && Date.now() - VERIFY_STATE.at < VERIFY_TTL;
  if ((!fresh || force) && !VERIFY_STATE.running) {
    /* 冷却期内不自动重跑；想知道真实水平就显式 start=1 强制来一次 */
    if (!force && Date.now() < VERIFY_COOL_UNTIL) {
      return {
        ok: true, ready: !!VERIFY_STATE.data, running: false, credible: false,
        cooling: true, fetchedAt: VERIFY_STATE.at ? new Date(VERIFY_STATE.at).toISOString() : '',
        error: VERIFY_STATE.error || '', ...(VERIFY_STATE.data || {}),
      };
    }
    runVerify();
  }
  return {
    ok: true,
    ready: !!VERIFY_STATE.data,
    running: VERIFY_STATE.running,
    credible: verifyCredible(VERIFY_STATE.data),
    cooling: !force && Date.now() < VERIFY_COOL_UNTIL,
    fetchedAt: VERIFY_STATE.at ? new Date(VERIFY_STATE.at).toISOString() : '',
    stale: !!VERIFY_STATE.data && !fresh,
    error: VERIFY_STATE.error || '',
    ...(VERIFY_STATE.data || {}),
  };
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
  stateFresh();
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

async function startInstallJob(target, params, hooks) {
  const mod = await installer();
  const jobId = 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const h = hooks || {};
  mod.runInstall(target, {
    params: params || {},
    jobId,
    onEvent: (type, payload) => broadcastInstall({ jobId, type, payload: slimEvent(type, payload) }),
  }).then((job) => { if (h.onDone) h.onDone(job); })
    .catch((e) => {
      broadcastInstall({ jobId, type: 'fail', payload: { id: jobId, status: 'failed', error: e.message } });
      if (h.onDone) h.onDone(null);
    });
  return jobId;
}

/* 正在跑的生态插件更新：防止一个插件被点两次，同时产生两个 pip 进程抢同一个 venv */
const ECO_UPDATING = new Set();

/* 组件的实时状态：端口开没开，页面用来显示「已运行 / 未安装」 */
async function componentsWithState() {
  const list = await Promise.all(components().map(async (c) => {
    /* 端口是动态的组件（DSH）：用它自己探测出来、记在配置里的端口来判断，
       不然会一直拿写死的默认端口去试，永远显示「未运行」 */
    if (c.dynamicPort) {
      const base = String((cfg.dsh || {}).baseUrl || '');
      const port = Number((base.match(/:(\d+)/) || [])[1] || 0);
      if (!port) return Object.assign({}, c, { ports: [], portsOpen: {}, running: null, detectedPort: 0 });
      const open = await tcpProbe('127.0.0.1', port, 700);
      return Object.assign({}, c, { ports: [port], portsOpen: { [port]: open }, running: open, detectedPort: port });
    }
    const ports = c.ports || [];
    const portsOpen = {};
    await Promise.all(ports.map(async (n) => { portsOpen[n] = await tcpProbe('127.0.0.1', n, 700); }));
    const running = ports.length ? Object.values(portsOpen).some(Boolean) : null;
    return Object.assign({}, c, { portsOpen, running });
  }));
  /* 协议端组件同理，也不能只认端口：端口被别的程序占着时这里会亮「● 运行中」（绿），
   * 而监控区、主链路卡片按心跳判「离线 / 未启动」——同一页三种说法。统一走心跳；
   * 探测拿不到结果就保留端口判定，降级而不是报错。 */
  try {
    const hb = await probeOnebot();
    if (hb && typeof hb.online === 'boolean') {
      for (const c of list) {
        if (c.role !== 'protocol' || c.alternativeTo) continue;
        c.running = hb.online;
      }
    }
  } catch { /* 探测失败：保留端口判定的结果 */ }
  return list;
}

/* ---------- 静态文件 ---------- */
const STATIC = { '/': 'public/index.html', '/index.html': 'public/index.html', '/login': 'public/login.html' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

/* ---------- 服务器 ---------- */
const server = http.createServer(async (req, res) => {
 try {   /* 整段包一层：某个接口写错不该把整个市场打挂（真发生过——一个未定义变量让进程退出，
            机器人控制台跟着 502，用户只看到"市场打不开了"）。下面整块不重缩进，只为不制造 1500 行 diff。 */
  let p;
  try { p = new URL(req.url, 'http://x').pathname; } catch { p = '/'; }
  const method = req.method;

  /* Agent bridge: loopback-only capabilities, deliberately separate from cookie authentication. */
  if (p.startsWith('/api/deploy/')) {
    const { mod, service } = await deployAgentPromise;
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (p === '/api/deploy/tool') {
      if (!loopback || !['127.0.0.1', '::1', 'localhost'].includes(HOST) || method !== 'POST') return sendJson(res, 403, { error: '部署工具仅限本机任务' });
      try {
        const body = JSON.parse(await readBody(req));
        const capability = String(req.headers.authorization || '').replace(/^Bearer /, '');
        return sendJson(res, 200, await service.tool(capability, body.name, body.args));
      } catch (e) { return sendJson(res, 403, { error: e.message }); }
    }
    if (!mod.localDeployRequest(req, HOST, PORT) || !authed(req)) return sendJson(res, 403, { error: '请在本机市场打开部署页面；公网演示站不能操作你的电脑' });
    try {
      if (method === 'POST' && p === '/api/deploy/token') return sendJson(res, 200, { token: service.ticket() });
      const body = method === 'POST' ? JSON.parse(await readBody(req)) : {};
      if (method === 'POST' && p === '/api/deploy/allowlist') {
        const discovery = await esm('scripts/lib/discover.mjs');
        return sendJson(res, 200, discovery.setBridgeAllowlist(cfg, body));
      }
      if (method === 'POST' && p === '/api/deploy/agent') {
        if (body.allowShell !== false || body.goal !== 'primary') return sendJson(res, 400, { error: '只允许 primary 部署且 allowShell 必须为 false' });
        return sendJson(res, 200, service.start(body.token, body.mode));
      }
      if (method === 'POST' && p === '/api/deploy/status') return sendJson(res, 200, service.get(body.id) || { error: '任务不存在' });
      if (method === 'POST' && p === '/api/deploy/continue') return sendJson(res, 200, service.continue(body.id));
      if (method === 'POST' && p === '/api/deploy/cancel') return sendJson(res, 200, service.cancel(body.id));
      return sendJson(res, 404, { error: '部署接口不存在' });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }

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

  /* 消息上报入口：协议端（NapCat/LLOneBot）不认登录 Cookie，必须放在统一鉴权之前。
   * 它自己的防护是「只接受本机来源」+「配了 AccessToken 就校验 token」。 */
  if (p === '/api/onebot/event') {
    if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' });
    return handleOnebotEvent(req, res);
  }

  /* API */
  if (p.startsWith('/api/')) {
    if (!authed(req)) return sendJson(res, 401, { ok: false, error: '未登录' });
    // A public binding with no configured password is read-only, except for plugin submissions.
    if (method !== 'GET' && !PASSWORD && !['127.0.0.1', '::1', 'localhost'].includes(HOST)
      && p !== '/api/registry/submit') {
      return sendJson(res, 403, { ok: false, error: '公网演示站为只读；本机部署请在回环地址打开，管理操作需配置访问口令' });
    }
    if (method === 'GET' && p === '/api/list') {
      await refreshConnections();
      const plugins = currentPlugins();
      /* 标出哪些插件有可配置项（schema 由插件自己声明），前端据此显示「配置」按钮 */
      const flags = {};
      const healthLib = await esm('scripts/lib/plugin-health.mjs');
      const health = await primaryHealth(plugins, healthLib);
      await Promise.all(plugins.map(async (pl) => { flags[pl.id] = !!(await pluginSchema(pl.id)); }));
      /* 权限来自真实代码扫描；兼容方法来自 methods.json，两边都不手写 */
      const pmap = permissionsMap();
      const lib = await methodsLib();
      const methods = lib.loadMethods();
      /* 主链路（SnowLuma + qq-bridge + DSH）本机是否就绪：前端用它决定徽章写
       * 「主链路直连」还是「主链路 · 待补依赖」，不做无条件绿灯 */
      const rt = await lib.probeRuntime();
      const primaryRow = methods.find((m) => m.id === lib.PRIMARY_METHOD) || null;
      const primaryEval = primaryRow ? lib.evaluate(primaryRow, rt) : { ready: false, missing: [] };
      return sendJson(res, 200, {
        ok: true,
        primary: {
          methodId: lib.PRIMARY_METHOD,
          name: primaryRow ? primaryRow.name : '',
          ready: !!primaryEval.ready,
          missing: primaryEval.missing || [],
        },
        plugins: plugins.map((pl) => {
          const pm = pmap[pl.id] || {};
          const compat = lib.pluginCompatMethods({ needsBridge: pm.needsBridge !== false }, methods);
          return Object.assign({}, pl, {
            hasSettings: !!flags[pl.id],
            health: health[pl.id] || null,
            framework: pm.framework || 'mcp',
            language: pm.language || 'JavaScript (ESM)',
            author: pl.author || '本项目（零依赖重写）',
            upstream: (pl.source && pl.source.label) || '',
            permissions: pm.permissions || [],
            confirmRequired: !!pm.confirmRequired,
            needsBridge: pm.needsBridge !== false,
            compat: {
              methods: compat.methods,
              needsBridge: compat.needsBridge,
              primary: compat.primary,
              primaryReady: !!primaryEval.ready,
              primaryMissing: primaryEval.missing || [],
            },
          });
        }),
      });
    }
    /* ---------- 生态插件目录：别人家商店里的真东西 ---------- */
    if (method === 'GET' && p === '/api/ecosystem') {
      const d = ecosystemDoc();
      const qs = new URL(req.url, 'http://x').searchParams;
      const fwQ = qs.get('framework') || '';
      const r = ecoQuery({
        q: qs.get('q') || '',
        framework: fwQ,
        category: qs.get('category') || '',
        offset: qs.get('offset') || 0,
        limit: qs.get('limit') || 60,
      });
      /* 分类计数按当前框架过滤后的全集算，页面上的筛选条才有意义 */
      const base = fwQ ? d.items.filter((x) => x.framework === fwQ) : d.items;
      const cats = {};
      for (const it of base) cats[it.category] = (cats[it.category] || 0) + 1;
      const fwCount = {};
      for (const it of d.items) fwCount[it.framework] = (fwCount[it.framework] || 0) + 1;
      return sendJson(res, 200, {
        ok: true,
        fetchedAt: d.fetchedAt,
        sources: d.sources,
        errors: d.errors,
        syncing: !!ecoSyncing,
        total: d.items.length,
        frameworks: fwCount,
        categories: cats,
        filtered: r.total,
        offset: r.offset,
        limit: r.limit,
        items: r.items,
      });
    }
    if (method === 'POST' && p === '/api/ecosystem/sync') {
      /* 同步要 10 秒上下，不等它 —— 前端显示「同步中」，完成后重新拉列表 */
      if (!ecoSyncing) ecoSync().catch(() => {});
      return sendJson(res, 200, { ok: true, started: true, syncing: true });
    }

    /* ---------- 插件上架：提交 → 审核 → 落地 ---------- */
    if (method === 'GET' && p === '/api/registry') {
      const mod = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'registry.mjs')).href);
      const qs = new URL(req.url, 'http://x').searchParams;
      const r = mod.list({ status: qs.get('status') || '', pluginId: qs.get('pluginId') || '' });
      return sendJson(res, 200, Object.assign({ ok: true, stats: mod.stats() }, r));
    }
    if (method === 'GET' && p === '/api/registry/item') {
      const mod = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'registry.mjs')).href);
      const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
      const item = mod.get(id);
      if (!item) return sendJson(res, 404, { ok: false, error: '没有这条提交' });
      return sendJson(res, 200, { ok: true, item });
    }
    if (method === 'GET' && p === '/api/registry/versions') {
      const mod = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'registry.mjs')).href);
      const pid = new URL(req.url, 'http://x').searchParams.get('pluginId') || '';
      return sendJson(res, 200, Object.assign({ ok: true }, mod.versions(pid)));
    }
    if (method === 'POST' && p === '/api/registry/submit') {
      const mod = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'registry.mjs')).href);
      const raw = await readBody(req);
      const obj = (() => { try { return JSON.parse(raw || '{}'); } catch { return {}; } })();
      const r = mod.submit(obj);
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (method === 'POST' && p === '/api/registry/review') {
      const mod = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'registry.mjs')).href);
      const raw = await readBody(req);
      const obj = (() => { try { return JSON.parse(raw || '{}'); } catch { return {}; } })();
      const r = await mod.review(String(obj.id || ''), String(obj.action || ''), obj.note);
      if (r.ok && r.deployed) {
        /* 新插件落地了：让消息路由和 schema 缓存都重新加载，否则要重启才用得上 */
        schemaCache.clear();
        refreshHandlers().catch(() => {});
      }
      return sendJson(res, r.ok ? 200 : 400, r);
    }


    if (method === 'GET' && p === '/api/plugin/updates') {
      const mod = await import(pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'updates.mjs')).href);
      const force = new URL(req.url, 'http://x').searchParams.get('force') === '1';
      return sendJson(res, 200, await mod.checkUpdates({ force }));
    }


    if (method === 'GET' && p === '/api/messages') {
      await refreshHandlers();
      const rt = await messageRuntime();
      const c = onebotCfg();
      /* Satori 为什么不能收：写清楚原因，别让用户以为是我们忘了做 */
      const satoriNote = c.protocol === 'satori'
        ? 'Satori 规范只提供 WS /v1/events 收事件，且鉴权要用 Authorization 头；Node 内置 WebSocket 不支持自定义头。当前协议是 Satori，所以「收消息」不可用 —— 要用消息驱动请走 OneBot 路线的上报地址。'
        : '';
      return sendJson(res, 200, {
        ok: true,
        protocol: c.protocol,
        supported: c.protocol !== 'satori',
        endpoint: `http://127.0.0.1:${PORT}/api/onebot/event${c.accessToken ? '?token=你的AccessToken' : ''}`,
        needToken: !!c.accessToken,
        handlers: handlerCache.map((x) => ({
          plugin: x.pluginId,
          id: x.handler.id || '',
          match: String(x.handler.match instanceof RegExp ? x.handler.match : (typeof x.handler.match === 'string' ? x.handler.match : (x.handler.match && (x.handler.match.prefix || x.handler.match.exact || '自定义函数')) || '')),
          permission: x.handler.permission || 'everyone',
          scope: x.handler.scope || ['group', 'private'],
        })),
        stats: rt.stats,
        note: satoriNote,
      });
    }
    /* ---------- 运行监控：端口 + 进程 + 协议心跳 + 最近任务 ---------- */
    if (method === 'GET' && p === '/api/monitor') {
      return sendJson(res, 200, await monitor());
    }
    /* ---------- 协议选择：OneBot v11 / Satori ----------
     * 列表带上每个协议的能力表，前端可以据此把不支持的动作置灰（而不是点了才报错） */
    if (method === 'GET' && p === '/api/protocol') {
      const { PROTOCOLS } = await protocolModule();
      const cur = onebotCfg().protocol;
      const hb = await probeOnebot();
      return sendJson(res, 200, {
        ok: true,
        current: cur,
        protocols: Object.values(PROTOCOLS).map((x) => ({
          id: x.id, label: x.label, note: x.note, capabilities: x.capabilities,
        })),
        health: hb,
        settings: globalSettings(),
      });
    }
    if (method === 'POST' && p === '/api/protocol') {
      const rawProto = await readBody(req);
      const body = (() => { try { return JSON.parse(rawProto || '{}'); } catch { return {}; } })();
      await saveGlobal(body);
      /* 存完立刻实测一次：让用户马上知道这个配置到底通不通，而不是自己去猜 */
      const hb = await probeOnebot(true);
      return sendJson(res, 200, { ok: true, settings: globalSettings(), health: hb });
    }
    if (method === 'GET' && p === '/api/health') {
      const d = await doctor();
      const o = d.onebot || {};
      return sendJson(res, 200, {
        ok: true, bridge: d.bridge.ok,
        /* 走 Satori 时 snowluma 探测没有意义，原样回传 null 让页面区分"不可用"和"不适用" */
        snowluma: d.snowluma.ok === null ? null : d.snowluma.ok,
        dsh: d.dsh.ok,
        protocol: d.protocol,
        onebot: {
          ok: !!o.online, protocol: o.protocol || d.protocol.id,
          impl: o.impl || 'unknown', app: o.app || '', version: o.version || '',
          selfId: o.selfId ?? null, nickname: o.nickname || '',
          latencyMs: o.latencyMs ?? null, checkedAt: o.checkedAt || '', error: o.error || '',
          errorKind: o.errorKind || '',
        },
        installed: d.installed, tools: d.mcp.tools, uptime: d.uptime, node: d.node, port: d.port,
      });
    }
    /* 轻量状态：只做心跳，不逐个 import 插件 —— 页面定时刷新用这个 */
    if (method === 'GET' && p === '/api/status') {
      await refreshConnections();
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
      /* 方法已存过密钥就在服务端合并进来：前端从头到尾拿不到 token 明文 */
      let params = body.params && typeof body.params === 'object' ? body.params : {};
      if (body.method) {
        const stored = await secretsForMethod(String(body.method));
        params = Object.assign({}, stored, params);
      }
      const jobId = await startInstallJob(target, params);
      return sendJson(res, 200, { ok: true, jobId, target, method: body.method || '' });
    }
    /* 回滚：撤销某次部署造出来的目录/进程/compose 项目 */
    if (method === 'POST' && p === '/api/install/rollback') {
      const raw = await readBody(req);
      const obj = (() => { try { return JSON.parse(raw || '{}'); } catch { return {}; } })();
      const mod = await installer();
      return sendJson(res, 200, await mod.rollbackJob(String(obj.jobId || '')));
    }

    /* ---------- 部署方法清单 / 兼容性矩阵 ---------- */
    if (method === 'GET' && p === '/api/methods') {
      const c = await (await methodsLib()).buildCompat();
      for (const m of c.methods) {
        const st = secretStatus(m.id, m.keyConfig);
        m.keyConfig = m.keyConfig.map((k) => Object.assign({}, k, { hasValue: !!(st[k.key] && st[k.key].has) }));
      }
      return sendJson(res, 200, c);
    }
    if (method === 'GET' && p === '/api/methods/one') {
      const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
      const c = await (await methodsLib()).buildCompat();
      const m = c.methods.find((x) => x.id === id);
      if (!m) return sendJson(res, 404, { ok: false, error: '没有这条部署方法' });
      const st = secretStatus(m.id, m.keyConfig);
      m.keyConfig = m.keyConfig.map((k) => Object.assign({}, k, { hasValue: !!(st[k.key] && st[k.key].has) }));
      return sendJson(res, 200, { ok: true, method: m, runtime: c.runtime });
    }
    if (method === 'GET' && p === '/api/compat') {
      const lib = await methodsLib();
      const c = await lib.buildCompat();
      const pmap = permissionsMap();
      const perPlugin = {};
      for (const pl of currentPlugins()) {
        const needsBridge = (pmap[pl.id] || {}).needsBridge !== false;
        perPlugin[pl.id] = lib.pluginCompatMethods({ needsBridge }, c.methods);
      }
      return sendJson(res, 200, {
        ok: true, generatedAt: c.generatedAt, runtime: c.runtime,
        pluginApis: c.pluginApis, matrix: c.matrix,
        primaryMethodId: c.primaryMethodId,
        methods: c.methods.map((m) => ({
          id: m.id, name: m.name, account: m.account, protocols: m.protocols,
          pluginApi: m.pluginApi, level: m.deploy.level, levelLabel: m.deploy.levelLabel,
          ready: m.ready, missing: m.missing, verified: m.deploy.verified,
          primary: !!m.primary,
        })),
        plugins: perPlugin,
      });
    }
    /* 密钥：写入/清除；只回"有没有配"，不回值 */
    if (method === 'POST' && p === '/api/secrets') {
      const raw = await readBody(req);
      const obj = (() => { try { return JSON.parse(raw || '{}'); } catch { return {}; } })();
      const mid = String(obj.method || '').trim();
      const key = String(obj.key || '').trim();
      if (!key) return sendJson(res, 400, { ok: false, error: '缺少 key' });
      const lib = await methodsLib();
      if (mid) {
        const m = lib.getMethod(mid);
        if (!m) return sendJson(res, 404, { ok: false, error: '没有这条部署方法' });
        if (key === '__any__') return sendJson(res, 400, { ok: false, error: 'key 不合法' });
      }
      const r = await setSecret(mid || 'global', key, obj.value);
      return sendJson(res, 200, Object.assign({ ok: true }, r));
    }

    /* 全网插件源：读快照 + 过滤/分页；POST 触发一次重新抓取（后台跑，带冷却） */
    if (method === 'GET' && p === '/api/hub') {
      return sendJson(res, 200, hubQuery(new URL(req.url, 'http://x').searchParams));
    }
    if (method === 'POST' && p === '/api/hub/sync') {
      return sendJson(res, 200, await startHubSync());
    }
    /* 实测结果：后台跑一遍 verify-plugins，结果缓存复用；通过数会随 QQ 在线状态浮动，
     * 页面不能把「64 项通过」写死，否则 QQ 没开时它说的就是假话 */
    if (method === 'GET' && p === '/api/verify') {
      return sendJson(res, 200, verifyResult(new URL(req.url, 'http://x').searchParams.get('start') === '1'));
    }
    /* 仓库 star 数：服务端代取 + 缓存，前端不直连 GitHub（CORS 会被拦） */
    if (method === 'GET' && p === '/api/stars') {
      const sp = new URL(req.url, 'http://x').searchParams;
      return sendJson(res, 200, await starsCached(sp.get('force') === '1'));
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
      /* 生态插件的「更新」不是改本地状态：得真的重跑 pip / npm / git。
       * 走安装任务是为了复用同一套步骤日志与回滚记录，不是新造一套。 */
      if (obj.action === 'update') {
        const target = String(obj.target || '').trim();
        const allowed = ['nonebot-plugin', 'koishi-plugin', 'astrbot-plugin'];
        if (!allowed.includes(target)) {
          return sendJson(res, 400, { ok: false, error: `这个对象不支持更新：${target || '(空)'}` });
        }
        const params = Object.assign({}, obj.params || {}, { action: 'update' });
        const key = target + ':' + (params.package || params.repo || '');
        if (ECO_UPDATING.has(key)) {
          return sendJson(res, 409, { ok: false, error: '这个插件正在更新中，等它跑完' });
        }
        ECO_UPDATING.add(key);
        const jobId = await startInstallJob(target, params, {
          onDone: () => { ECO_UPDATING.delete(key); },
        });
        return sendJson(res, 200, { ok: true, jobId, updating: true, msg: '已开始更新，进度会实时推过来' });
      }
      const result = performOp(obj.action, obj.id, obj);
      /* 装/卸/启停之后必须让消息路由看到新的插件状态，否则「装了插件还是不回消息」 */
      if (obj.action !== 'restart') refreshHandlers().catch(() => {});
      return sendJson(res, 200, result);
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
      return sendJson(res, 200, { ok: true, global: await saveGlobal(obj) });
    }

    /* 设置：插件配置 */
    if (method === 'GET' && p === '/api/plugin-config') {
      const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
      const schema = await pluginSchema(id);
      if (!schema) return sendJson(res, 404, { ok: false, error: '这个插件没有可配置项' });
      return sendJson(res, 200, { ok: true, id, schema, values: await pluginValuesForUi(id) });
    }
    if (method === 'POST' && p === '/api/plugin-config') {
      const raw = await readBody(req);
      const obj = (() => { try { return JSON.parse(raw || '{}'); } catch { return {}; } })();
      const schema = await pluginSchema(obj.id);
      if (!schema) return sendJson(res, 404, { ok: false, error: '这个插件没有可配置项' });
      cfg.plugins = Object.assign({}, cfg.plugins);
      const prev = pluginValues(obj.id);
      const vals = cleanValues(schema, obj.values);
      /* 密钥字段：填了就加密存；留空表示沿用原来的（界面上本来也不回值，
       * 否则用户只想改个模型名就得把 Key 再抄一遍） */
      const lib = await secretsLib();
      for (const f of schema.fields) {
        if (!SECRET_FIELD(f)) continue;
        const typed = String(vals[f.key] || '').trim();
        vals[f.key] = typed ? lib.encrypt(typed) : String(prev[f.key] || '');
      }
      cfg.plugins[obj.id] = vals;
      saveCfg();
      return sendJson(res, 200, { ok: true, id: obj.id, values: await pluginValuesForUi(obj.id), msg: '配置已保存，立即生效' });
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
 } catch (e) {
  console.error('[http] ' + req.method + ' ' + req.url + ' → ' + ((e && e.stack) || e));
  try {
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
    else res.end();
  } catch { /* 回包也失败就只能记日志了 */ }
 }
});

/* 先把密钥初始化完再开始监听：避免第一个 /api/health 因为 token 还没解出来而显示未配置 */
initSecrets().catch((e) => console.log('[secrets] 初始化失败（不影响启动）：' + e.message)).finally(() => {
  server.listen(PORT, HOST, () => {
    if (['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
      const discoveryTimer = setInterval(() => { void refreshConnections(); }, 10000);
      discoveryTimer.unref();
    }
    console.log('qqbot-plugins 插件市场已启动');
    console.log('地址: http://' + HOST + ':' + PORT + (PASSWORD ? '' : '（未设口令，本机开放访问）'));
    console.log('消息上报: POST http://' + HOST + ':' + PORT + '/api/onebot/event');
    refreshHandlers().then(() => {
      console.log('消息路由就绪，已挂载 ' + handlerCache.length + ' 个插件处理器');
    }).catch(() => {});
  });
});
