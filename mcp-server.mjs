#!/usr/bin/env node
/* ============================================================
 * qqbot-plugins MCP 服务器（stdio）
 *
 * 这是与 DSH（DeepSeek Harness）搭桥的核心：
 * scripts/register-dsh.mjs 会把本进程注册进 cordis.patch.yml，
 * DSH 启动后所有已安装插件的工具都会以 mcp__qqbot__<tool> 出现，
 * AI 就能在 QQ 里直接调用。
 *
 * 协议：JSON-RPC 2.0 over stdio（MCP 2024-11-05 基本子集）
 * 依赖：yaml 配置解析库；Node >=20
 *
 * 配置来源（每次调用实时读取，改完不用重启 DSH）：
 *   config.json → snowluma.httpUrl / accessToken（OneBot 连接渠道）
 *   config.json → plugins.<id>（插件自己的配置，如群管理白名单）
 * ============================================================ */
'use strict';

import { stateSignature } from './scripts/lib/plugin-health.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBridge, createOneBot } from './plugins/_bridge.mjs';
import { createProtocol, createProbe } from './plugins/_protocol.mjs';
import { decrypt } from './scripts/lib/secrets.mjs';
import { dataPath } from './scripts/lib/paths.mjs';
import { runSandboxed, sanitizeConfig, permsFor } from './scripts/lib/sandbox.mjs';
import { DEPLOY_TOOLS } from './scripts/lib/deploy-agent.mjs';

const HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const PKG_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(HUB_ROOT, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();
const DATA_DIR = path.join(HUB_ROOT, 'data');
const CONFIG_FILE = path.join(HUB_ROOT, 'config.json');

function logErr(...a) { process.stderr.write('[qqbot] ' + a.join(' ') + '\n'); }

/* ---------- 配置（带 mtime 缓存，改文件即刻生效） ---------- */
let cfgCache = { mtime: 0, data: null };
function loadConfig() {
  try {
    const st = fs.statSync(CONFIG_FILE);
    if (cfgCache.data && cfgCache.mtime === st.mtimeMs) return cfgCache.data;
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cfgCache = { mtime: st.mtimeMs, data };
    return data;
  } catch {
    return cfgCache.data || {};
  }
}
/* 协议端配置：优先读 onebot 段，兼容旧的 snowluma 段
 *
 * 注意 token：网页端把它加密存进 config.json 的 secrets 里，
 * 这里必须解密才拿得到，否则会拿空 token 去连协议端（401）。
 * 解密失败就退回旧字段，保证升级上来的部署不会直接不可用。 */
function secretOf(c, slot) {
  const enc = (c.secrets || {})[slot];
  if (!enc) return '';
  try { return decrypt(enc) || ''; } catch { return ''; }
}
function onebotCfg() {
  const c = loadConfig();
  const ob = c.onebot || {};
  const sl = c.snowluma || {};
  const sa = c.satori || {};
  const tok = secretOf(c, 'snowluma-dsh.onebotToken');
  return {
    protocol: String(c.protocol || 'onebot').toLowerCase() === 'satori' ? 'satori' : 'onebot',
    impl: String(ob.impl || 'auto'),
    httpUrl: String(ob.httpUrl || sl.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    accessToken: String(tok || ob.accessToken || sl.accessToken || ''),
    authMode: String(ob.authMode || 'header'),
    pathPrefix: String(ob.pathPrefix || ''),
    satori: {
      baseUrl: String(sa.baseUrl || 'http://127.0.0.1:5142/satori').replace(/\/+$/, ''),
      token: String(secretOf(c, 'satori.token') || sa.token || ''),
      platform: String(sa.platform || 'onebot'),
      selfId: String(sa.selfId || ''),
    },
  };
}
function pluginCfg(id) {
  const all = loadConfig().plugins || {};
  const v = all[id];
  if (!v || typeof v !== 'object') return {};
  /* 插件级密钥（voice/imagine 的 apiKey）现在是密文存的，交给插件前解开。
   * 认 enc:v1: 前缀而不是靠字段名——老配置里的明文会原样返回，不会读坏。 */
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = (typeof val === 'string' && val.startsWith('enc:v1:'))
      ? (() => { try { return decrypt(val) || ''; } catch { return ''; } })()
      : val;
  }
  return out;
}

/* ---------- 协议端客户端（每次调用都读最新配置，改地址/Token 不用重启） ---------- */
async function onebot(action, params = {}) {
  return createOneBot(onebotCfg()).onebot(action, params);
}
/* 插件统一走这一层：OneBot v11 还是 Satori 由配置决定，插件代码不变 */
function bridge() {
  return createProtocol(onebotCfg());
}

/* 每次工具调用构造独立 ctx：插件私有配置放在 ctx.cfg */
const ctxFor = (pluginId) => ({ onebot, bridge: bridge(), config: loadConfig(), cfg: pluginCfg(pluginId) });

/* 沙箱里插件能用的宿主能力：都在这边执行，插件进程自己没有发消息/调 API 的本事 */
const sandboxHost = {
  onebot,
  probe: () => createProbe(onebotCfg()).probe(),
  heartbeat: () => createProbe(onebotCfg()).heartbeat(),
  log: (m) => logErr('[plugin] ' + m),
};

/* 沙箱开关：万一某个插件在沙箱里跑不动，可以 QQBOT_SANDBOX=0 临时退回进程内执行。
 * 默认开。 */
const USE_SANDBOX = String(process.env.QQBOT_SANDBOX || '1') !== '0';

/* ---------- 插件加载：data/catalog/plugins.json + data/state/plugins.json ---------- */
async function loadPlugins() {
  let catalog = [];
  let state = {};
  try { catalog = JSON.parse(fs.readFileSync(dataPath('plugins'), 'utf8')); } catch {}
  try { state = JSON.parse(fs.readFileSync(dataPath('state'), 'utf8')); } catch {}

  const tools = [];
  const fireDues = [];
  for (const meta of catalog) {
    const s = state[meta.id];
    /* 停用(status.enabled=false)必须真的不暴露工具，否则页面上点了停用，
     * AI 那边还能调——与市场显示的状态对不上。 */
    if (!s || !s.installed || !s.enabled) continue;
    const file = path.join(HUB_ROOT, 'plugins', meta.id + '.mjs');
    if (!fs.existsSync(file)) continue;
    try {
      const mod = await import(pathToFileURL(file).href);
      const def = mod.default || {};
      if (Array.isArray(def.tools)) {
        for (const t of def.tools) {
          tools.push({
            name: t.name,
            description: `[${meta.name}] ${t.description}`,
            inputSchema: t.inputSchema || { type: 'object', properties: {} },
            _run: t.run,
            _plugin: meta.id,
            _file: file,
            /* 插件声明了哪些能力，决定沙箱给不给 --allow-child-process 之类的开关 */
            _perm: permsFor(HUB_ROOT, meta.id, def),
            /* 个别工具天然慢（认视频要等模型逐帧看完），插件可用 meta.timeoutMs 申请更长时间。
             * 上限压在 180 秒：再长就不像"一次工具调用"了，客户端多半先超时。 */
            _timeout: Math.min(Math.max(Number(def.meta && def.meta.timeoutMs) || 0, 0), 180000),
          });
        }
      }
      const due = def.fireDue || mod.fireDue;
      if (typeof due === 'function') fireDues.push({ id: meta.id, fn: due, file, perm: permsFor(HUB_ROOT, meta.id, def) });
    } catch (e) {
      logErr('加载插件 ' + meta.id + ' 失败: ' + e.message);
    }
  }
  return { tools, fireDues };
}

/* ---------- 到点提醒的兜底触发（每 15 秒 + 每次工具调用前） ---------- */
function startFireDue(fireDues) {
  if (!fireDues.length) return () => {};
  const tick = () => {
    for (const f of fireDues) {
      /* 到点提醒也在沙箱里跑：它同样会发消息，不该比工具调用多一份信任 */
      if (USE_SANDBOX) {
        runSandboxed({
          hubRoot: HUB_ROOT,
          pluginId: f.id,
          pluginFile: f.file,
          kind: 'fireDue',
          cfg: pluginCfg(f.id),
          config: sanitizeConfig(loadConfig()),
          permissions: f.perm || [],
          host: sandboxHost,
          timeoutMs: 20000,
        }).catch((e) => logErr('fireDue[' + f.id + ']: ' + e.message));
        continue;
      }
      try { f.fn(ctxFor(f.id)); } catch (e) { logErr('fireDue[' + f.id + ']: ' + e.message); }
    }
  };
  const timer = setInterval(tick, 15000);
  timer.unref?.();
  tick.stop = () => clearInterval(timer);
  return tick;
}

/* ---------- JSON-RPC over stdio ---------- */
function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function main() {
  let signature = stateSignature();
  let hub = await loadPlugins();
  let refreshing = null, initialized = false, clientName = '', deliveredSignature = '', deliveredNames = [];
  let fireTick = startFireDue(hub.fireDues);
  async function refresh(force=false) {
    if (!force && signature === stateSignature()) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const nextSignature = stateSignature();
      const next = await loadPlugins();
      hub = next; signature = nextSignature;
      fireTick.stop?.(); fireTick = startFireDue(hub.fireDues);
      // New due handlers are picked up by the shared periodic callback below.
      if (initialized) write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  const observerDir = path.join(path.dirname(dataPath('state')), 'mcp-observers');
  const observer = () => {
    if (!initialized || !/deepseek|dsh|harness/i.test(clientName)) return;
    try {
      fs.mkdirSync(observerDir, { recursive: true });
      fs.writeFileSync(path.join(observerDir, process.pid + '.json'), JSON.stringify({ root: HUB_ROOT, pid: process.pid, client: clientName, signature: deliveredSignature, tools: deliveredNames, at: Date.now() }));
    } catch {}
  };
  let lastReload=0;
  const reloadTimer = setInterval(() => {
    let force=false;try{const request=JSON.parse(fs.readFileSync(path.join(observerDir,'reload-request.json'),'utf8'));if(request.root===HUB_ROOT && request.at>lastReload){lastReload=request.at;force=true;deliveredSignature='';}}catch{}
    refresh(force).then(observer).catch(e => logErr('reload: ' + e.message));
  }, 1500);
  reloadTimer.unref();
  logErr(`qqbot-plugins MCP 已启动：${hub.tools.length} 个工具可用`);

  let buf = '';
  /* 沙箱调用是异步的（每次起子进程约 100ms），客户端关掉 stdin 时如果直接 exit，
   * 正在跑的那次调用结果就丢了 —— 表现为 AI「说调了工具但没反应」。
   * 所以退出前给在途请求最多 3 秒把结果写完。 */
  let inflight = 0;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      inflight += 1;
      handle(line)
        .catch((e) => logErr('处理请求出错: ' + e.message))
        .finally(() => { inflight -= 1; });
    }
  });
  process.stdin.on('end', async () => {
    const t0 = Date.now();
    while (inflight > 0 && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    process.exit(0);
  });

  async function handle(line) {
    let req;
    try { req = JSON.parse(line); } catch { return; }
    const { id, method, params } = req;
    const reply = (result) => id !== undefined && write({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => id !== undefined && write({ jsonrpc: '2.0', id, error: { code, message } });

    switch (method) {
      case 'initialize':
        clientName = String(params?.clientInfo?.name || '');
        return reply({
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: true } },
          /* 版本号从 package.json 读，别写死——写死过一次，改了包版本这里还报旧号 */
          serverInfo: { name: 'qqbot-plugins', version: PKG_VERSION },
        });
      case 'notifications/initialized':
        initialized = true; return;
      case 'notifications/cancelled':
        return; // 通知无需回复
      case 'ping':
        return reply({});
      case 'tools/list':
        await refresh(); deliveredSignature = signature; deliveredNames = hub.tools.map(t => t.name); observer();
        /* 下划线开头的都是内部字段（执行函数、插件 id、文件路径、权限），
         * 不能漏给客户端 —— 否则会把服务器本地路径暴露出去 */
        return reply({
          tools: [...(process.env.QQBOT_DEPLOY_CAPABILITY ? DEPLOY_TOOLS : []), ...hub.tools.map((t) => Object.fromEntries(
            Object.entries(t).filter(([k]) => !k.startsWith('_')),
          ))],
        });
      case 'tools/call': {
        await refresh();
        fireTick();
        const name = params && params.name;
        if (DEPLOY_TOOLS.some(t => t.name === name) && process.env.QQBOT_DEPLOY_CAPABILITY) {
          try {
            const url = new URL(process.env.QQBOT_DEPLOY_URL);
            if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('部署地址必须为本机');
            const response = await fetch(url.origin + '/api/deploy/tool', {
              method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.QQBOT_DEPLOY_CAPABILITY },
              body: JSON.stringify({ name, args: params.arguments || {} }), signal: AbortSignal.timeout(660000),
            });
            const result = await response.json();
            return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], isError: !response.ok });
          } catch (e) { return reply({ content: [{ type: 'text', text: e.message }], isError: true }); }
        }
        const tool = hub.tools.find((t) => t.name === name);
        if (!tool) return fail(-32602, `未知工具: ${name}`);
        const args = (params && params.arguments) || {};
        try {
          if (USE_SANDBOX) {
            const r = await runSandboxed({
              hubRoot: HUB_ROOT,
              pluginId: tool._plugin,
              pluginFile: tool._file,
              kind: 'tool',
              toolName: tool.name,
              args,
              cfg: pluginCfg(tool._plugin),
              config: sanitizeConfig(loadConfig()),
              permissions: tool._perm || [],
              host: sandboxHost,
              timeoutMs: tool._timeout > 25000 ? tool._timeout : 25000,
            });
            return reply({ content: [{ type: 'text', text: r.text }], isError: false });
          }
          const text = String(await tool._run(args, ctxFor(tool._plugin)));
          return reply({ content: [{ type: 'text', text }], isError: false });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: '工具执行失败: ' + (e && e.message ? e.message : String(e)) }], isError: true });
        }
      }
      default:
        return fail(-32601, 'method not found: ' + method);
    }
  }
}

main().catch((e) => { logErr('启动失败: ' + e.stack); process.exit(1); });
