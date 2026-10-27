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
 * 依赖：无第三方依赖，Node 18+（用到全局 fetch）
 *
 * 配置来源（每次调用实时读取，改完不用重启 DSH）：
 *   config.json → snowluma.httpUrl / accessToken（OneBot 连接渠道）
 *   config.json → plugins.<id>（插件自己的配置，如群管理白名单）
 * ============================================================ */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
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
function snowlumaCfg() {
  const sl = loadConfig().snowluma || {};
  return {
    httpUrl: String(sl.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    accessToken: String(sl.accessToken || ''),
  };
}
function pluginCfg(id) {
  const all = loadConfig().plugins || {};
  const v = all[id];
  return v && typeof v === 'object' ? v : {};
}

/* ---------- OneBot 客户端（每次调用都读最新渠道配置） ---------- */
async function onebot(action, params = {}) {
  const sl = snowlumaCfg();
  const res = await fetch(sl.httpUrl + '/' + action, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sl.accessToken ? { Authorization: 'Bearer ' + sl.accessToken } : {}),
    },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(action + ' 响应不是 JSON: ' + text.slice(0, 120)); }
  if (data && data.status === 'failed') throw new Error(action + ' 失败: ' + (data.wording || data.message || data.retcode));
  return data && data.data !== undefined ? data.data : data;
}

/* 每次工具调用构造独立 ctx：插件私有配置放在 ctx.cfg */
const ctxFor = (pluginId) => ({ onebot, config: loadConfig(), cfg: pluginCfg(pluginId) });

/* ---------- 插件加载：data/plugins.json + data/state.json ---------- */
async function loadPlugins() {
  let catalog = [];
  let state = {};
  try { catalog = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'plugins.json'), 'utf8')); } catch {}
  try { state = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8')); } catch {}

  const tools = [];
  const fireDues = [];
  for (const meta of catalog) {
    const s = state[meta.id];
    if (!s || !s.installed) continue;
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
          });
        }
      }
      const due = def.fireDue || mod.fireDue;
      if (typeof due === 'function') fireDues.push({ id: meta.id, fn: due });
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
      try { f.fn(ctxFor(f.id)); } catch (e) { logErr('fireDue[' + f.id + ']: ' + e.message); }
    }
  };
  const timer = setInterval(tick, 15000);
  timer.unref?.();
  return tick;
}

/* ---------- JSON-RPC over stdio ---------- */
function write(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function main() {
  const hub = await loadPlugins();
  const fireTick = startFireDue(hub.fireDues);
  logErr(`qqbot-plugins MCP 已启动：${hub.tools.length} 个工具可用`);

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      handle(line).catch((e) => logErr('处理请求出错: ' + e.message));
    }
  });
  process.stdin.on('end', () => process.exit(0));

  async function handle(line) {
    let req;
    try { req = JSON.parse(line); } catch { return; }
    const { id, method, params } = req;
    const reply = (result) => id !== undefined && write({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => id !== undefined && write({ jsonrpc: '2.0', id, error: { code, message } });

    switch (method) {
      case 'initialize':
        return reply({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'qqbot-plugins', version: '1.1.0' },
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return; // 通知无需回复
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: hub.tools.map(({ _run, _plugin, ...t }) => t) });
      case 'tools/call': {
        fireTick();
        const name = params && params.name;
        const tool = hub.tools.find((t) => t.name === name);
        if (!tool) return fail(-32602, `未知工具: ${name}`);
        try {
          const text = String(await tool._run((params && params.arguments) || {}, ctxFor(tool._plugin)));
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
