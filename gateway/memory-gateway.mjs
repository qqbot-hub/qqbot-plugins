#!/usr/bin/env node
/* ============================================================
 * memory-gateway.mjs —— 记忆网关（零依赖，Node 18+）
 *
 * 它夹在「桥接/DSH」和「memory-core」之间，解决三件 memory-core 自己解决不了的事：
 *
 *   ① 查询噪声：把「你还记得…吗 / 最近 / 怎么样」这类虚词剔掉再检索
 *      （实测：问"团子最近怎么样"会先命中《三体》，因为"最近"命中了它的文本）
 *   ② 按人隔离：memory-core 的 memories 表没有 user_id，全库共享
 *      → 写入时把归属做成前缀标签〔u:10001〕/〔g:888〕，检索后按标签过滤再剥掉
 *   ③ 相关度门槛：memory-core 默认 k=5 无下限，会把无关记忆也塞进 prompt
 *      → 这里加 score 门槛 + 字节预算
 *
 * 用法：
 *   1) 先把 memory-core 起在 8780（见 docs/API.md）
 *   2) node memory-gateway.mjs --config gateway.config.json
 *   3) 把桥接/DSH 的 base_url 改成 http://127.0.0.1:8781/v1
 *
 * 关键：请求必须带 user（如 "qq:10001"），群里再带 x-channel: group 与 x-group: 群号。
 * 不带 user 会 400 —— 这是为了不让所有人的记忆混在一起。
 * ============================================================ */
'use strict';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ---------------- 配置 ---------------- */
const DEFAULTS = {
  port: 8781,
  host: '127.0.0.1',
  core: { url: 'http://127.0.0.1:8780', token: 'local-token' },
  upstream: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' },
  recall: { k: 6, minScore: 0.35, maxBytes: 1400, maxItems: 5 },
  remember: { enabled: true, minChars: 6, importance: 0.4 },
  timeoutMs: { core: 4000, upstream: 180000 },
  debug: false,
};

function loadConfig() {
  const argIdx = process.argv.indexOf('--config');
  const file = argIdx > 0 ? process.argv[argIdx + 1] : path.join(HERE, 'gateway.config.json');
  let cfg = JSON.parse(JSON.stringify(DEFAULTS));
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg = deepMerge(cfg, raw);
    log('配置已加载：' + file);
  } else {
    log('未找到 ' + file + '，使用默认值（可用环境变量覆盖）');
  }
  /* 环境变量优先，方便容器/脚本 */
  const env = process.env;
  if (env.MG_PORT) cfg.port = Number(env.MG_PORT);
  if (env.MG_CORE_URL) cfg.core.url = env.MG_CORE_URL;
  if (env.MG_CORE_TOKEN) cfg.core.token = env.MG_CORE_TOKEN;
  if (env.MG_UPSTREAM_BASE) cfg.upstream.baseUrl = env.MG_UPSTREAM_BASE;
  if (env.MG_UPSTREAM_KEY) cfg.upstream.apiKey = env.MG_UPSTREAM_KEY;
  if (env.MG_UPSTREAM_MODEL) cfg.upstream.model = env.MG_UPSTREAM_MODEL;
  cfg.core.url = cfg.core.url.replace(/\/+$/, '');
  cfg.upstream.baseUrl = cfg.upstream.baseUrl.replace(/\/+$/, '');
  return cfg;
}

function deepMerge(a, b) {
  for (const [k, v] of Object.entries(b || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) a[k] = deepMerge(a[k] || {}, v);
    else a[k] = v;
  }
  return a;
}

const log = (...a) => console.log('[gateway]', ...a);

/* ---------------- 工具 ---------------- */

/** 归属标签：写进记忆文本前缀，检索后剥掉。这是不改 memory-core 就能按人隔离的办法 */
const TAG_RE = /^〔([^〕]{1,60})〕/;
function tagOf(text) {
  const m = TAG_RE.exec(String(text || ''));
  return m ? m[1] : '';
}
function stripTag(text) {
  return String(text || '').replace(TAG_RE, '').trim();
}
/** 标签格式 u|qq:10001 或 g|888 —— 用 | 分隔，避免 owner 内部冒号干扰 */
function splitTag(tag) {
  const i = String(tag).indexOf('|');
  return i < 0 ? [String(tag), ''] : [tag.slice(0, i), tag.slice(i + 1)];
}

/** 查询清洗：去掉疑问/语气/时间虚词，只留实词（解决"最近/怎么样"抢命中的问题） */
const STOP_PATTERNS = [
  /[?？!！。，,、；;：:"'“”‘’]+/g,
  /(你还?记得|还记得|记得|上次|之前|那时|当时|那个|这件事|那件事|事情)/g,
  /(怎么样|如何|什么|啥|哪位|哪个|哪里|哪儿|多少)/g,
  /(最近|现在|今天|昨天|前天|刚才|刚刚)/g,
  /(吗|呢|吧|啊|呀|哦|嗯|唉|哈|呗|嘛|了|的|地|得)/g,
];
function cleanQuery(text) {
  let s = String(text || '');
  for (const re of STOP_PATTERNS) s = s.replace(re, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  /* 太短就退回原文，避免清洗过度导致检索为空 */
  return s.length >= 2 ? s : String(text || '').trim();
}

/** 判断是不是一句问话：问话不是事实，不该当记忆存 */
function looksLikeQuestion(text) {
  const s = String(text || '').trim();
  if (/[?？]\s*$/.test(s)) return true;
  return /(吗|呢|怎么样|如何|是什么|是什么样|为什么|为啥|哪个|哪位|谁|多少|几点|咋办)\s*[。？?]?$/.test(s);
}

/** 从 openai messages 里取最后一条用户消息的纯文本 */
function lastUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') return contentToText(m.content);
  }
  return '';
}
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
      .map((p) => p.text || '').join(' ').trim();
  }
  return '';
}

async function coreCall(cfg, endpoint, payload) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), cfg.timeoutMs.core);
  try {
    const res = await fetch(cfg.core.url + endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.core.token ? { Authorization: 'Bearer ' + cfg.core.token } : {}),
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { status: 'error', message: text.slice(0, 200) }; }
    if (!res.ok || data.status === 'error') throw new Error(data.message || ('HTTP ' + res.status));
    return data.data !== undefined ? data.data : data;
  } finally { clearTimeout(t); }
}

/* ---------------- 记忆读写 ---------------- */

/** 频道 → 允许的记忆可见性。群聊不能召回 private（私聊才说的话） */
function visibilityFor(channel) {
  return channel === 'group' ? ['public', 'group'] : ['public', 'private', 'group'];
}

/**
 * 检索并组装注入块。
 * 返回 { block, hits } —— block 可以直接拼进 system prompt。
 */
async function buildMemoryBlock(cfg, { query, owner, group, channel }) {
  const cleaned = cleanQuery(query);
  if (!cleaned) return { block: '', hits: [] };

  let data;
  try {
    data = await coreCall(cfg, '/recall', {
      query: cleaned,
      k: Math.max(cfg.recall.k, 8),
      visibility: visibilityFor(channel),
    });
  } catch (e) {
    log('检索失败（降级为无记忆）：' + e.message);
    return { block: '', hits: [] };
  }

  const hits = (data.hits || [])
    /* ① 归属过滤：只留「属于这个人」「属于这个群」「没标签的全局」 */
    .filter((h) => {
      const tag = tagOf(h.text);
      if (!tag) return true;
      const [kind, val] = splitTag(tag);
      if (kind === 'u') return String(val) === String(owner);
      if (kind === 'g') return group && String(val) === String(group);
      return true;
    })
    /* ② 相关度门槛：低于 minScore 的直接丢，避免塞无关记忆 */
    .filter((h) => Number(h.score || 0) >= cfg.recall.minScore);

  /* ③ 条数与字节预算 */
  const picked = [];
  let bytes = 0;
  for (const h of hits) {
    if (picked.length >= cfg.recall.maxItems) break;
    const line = `- ${stripTag(h.text)}`;
    const size = Buffer.byteLength(line, 'utf8');
    if (bytes + size > cfg.recall.maxBytes) break;
    bytes += size;
    picked.push(Object.assign({}, h, { text: stripTag(h.text) }));
  }

  if (!picked.length) return { block: '', hits: [] };
  const block = picked.map((h) => `- ${h.text}`).join('\n');
  return { block, hits: picked };
}

/** 写入一条记忆（带归属标签）。失败不影响主流程 */
async function rememberTurn(cfg, { text, owner, group, channel, kind = 'episode', importance }) {
  if (!cfg.remember.enabled) return;
  const body = String(text || '').trim();
  if (body.length < cfg.remember.minChars) return;      // 太短（"嗯""哈哈"）不记
  if (/^[\s\p{Emoji}\p{P}]+$/u.test(body)) return;      // 纯表情/标点不记
  if (looksLikeQuestion(body)) return;                   // 问句不记（"上海那边怎么样"不是事实）

  const tag = group && channel === 'group' ? `g|${group}` : `u|${owner}`;
  try {
    await coreCall(cfg, '/remember', {
      text: `〔${tag}〕${body.slice(0, 800)}`,
      kind,
      importance: importance != null ? importance : cfg.remember.importance,
      visibility: channel === 'group' ? 'public' : 'private',
    });
    if (cfg.debug) log('已记住：' + body.slice(0, 40));
  } catch (e) {
    log('写入记忆失败（不影响回复）：' + e.message);
  }
}

/* ---------------- HTTP ---------------- */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
const sendErr = (res, code, message) => sendJson(res, code, { error: { message, type: 'memory_gateway_error' } });

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function main() {
  const cfg = loadConfig();

  if (!cfg.upstream.apiKey) {
    log('⚠️  未配置上游 API Key（upstream.apiKey / MG_UPSTREAM_KEY），转发会失败');
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');

    /* 健康检查：同时探一下 memory-core */
    if (req.method === 'GET' && url.pathname === '/health') {
      let core = 'down';
      try {
        const r = await fetch(cfg.core.url + '/health', {
          headers: cfg.core.token ? { Authorization: 'Bearer ' + cfg.core.token } : {},
          signal: AbortSignal.timeout(2000),
        });
        core = r.ok ? 'ok' : 'http-' + r.status;
      } catch { /* 保持 down */ }
      return sendJson(res, 200, {
        status: core === 'ok' ? 'ok' : 'degraded',
        core,
        upstream: cfg.upstream.baseUrl,
        recall: cfg.recall,
        remember: cfg.remember.enabled,
      });
    }

    /* 透传上游模型列表，方便客户端探测 */
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return sendJson(res, 200, {
        object: 'list',
        data: [{ id: 'memory-gateway', object: 'model', owned_by: 'local' }],
      });
    }

    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      return sendErr(res, 404, '只支持 POST /v1/chat/completions 与 GET /health');
    }

    let body;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw || '{}');
    } catch (e) {
      return sendErr(res, 400, '请求体不是合法 JSON：' + e.message);
    }

    /* 身份：必须带 user，否则所有人记忆会混在一起 */
    const owner = String(body.user || body.user_id || '').trim();
    if (!owner) return sendErr(res, 400, '必须带 user 字段（如 "qq:10001"），避免不同人的记忆混在一起');

    const channel = String(req.headers['x-channel'] || body.channel || 'private').toLowerCase() === 'group' ? 'group' : 'private';
    const group = String(req.headers['x-group'] || body.group || '').trim();

    const messages = Array.isArray(body.messages) ? body.messages.slice() : [];
    const userText = lastUserText(messages);

    /* 1) 组装记忆块（失败降级，不影响正常聊天） */
    let block = '';
    let hits = [];
    if (userText) {
      const got = await buildMemoryBlock(cfg, { query: userText, owner, group, channel });
      block = got.block; hits = got.hits;
      if (cfg.debug) log(`召回 ${hits.length} 条：${hits.map((h) => h.score).join(',')}`);
    }

    /* 2) 注入：放在 system 之前（若已有 system，则追加到其末尾） */
    if (block) {
      const memorySystem = {
        role: 'system',
        content: '以下是你记得的旧事，用来接话，不要逐条复述：\n' + block,
      };
      const sysIdx = messages.findIndex((m) => m && m.role === 'system');
      if (sysIdx >= 0) {
        const sys = messages[sysIdx];
        const old = contentToText(sys.content);
        messages[sysIdx] = Object.assign({}, sys, {
          content: (old ? old + '\n\n' : '') + memorySystem.content,
        });
      } else {
        messages.unshift(memorySystem);
      }
    }

    /* 3) 转发上游 */
    const payload = Object.assign({}, body, {
      model: body.model || cfg.upstream.model,
      messages,
    });
    delete payload.user;          // 上游多数不认这个字段
    delete payload.channel;
    delete payload.group;

    let upstreamRes;
    try {
      upstreamRes = await fetch(cfg.upstream.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.upstream.apiKey ? { Authorization: 'Bearer ' + cfg.upstream.apiKey } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(cfg.timeoutMs.upstream),
      });
    } catch (e) {
      return sendErr(res, 502, '连不上上游模型：' + e.message);
    }

    /* 流式：直接透传，不做后处理 */
    if (body.stream) {
      res.writeHead(upstreamRes.status, {
        'Content-Type': upstreamRes.headers.get('content-type') || 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const reader = upstreamRes.body;
      for await (const chunk of reader) res.write(chunk);
      res.end();
      if (userText) rememberTurn(cfg, { text: userText, owner, group, channel });
      return;
    }

    const text = await upstreamRes.text();
    res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(text);

    /* 4) 记住这一轮（异步，不阻塞回复） */
    if (upstreamRes.ok && userText) {
      rememberTurn(cfg, { text: userText, owner, group, channel });
    }
  });

  server.listen(cfg.port, cfg.host, () => {
    log(`记忆网关已启动 http://${cfg.host}:${cfg.port}/v1`);
    log(`  记忆引擎：${cfg.core.url}`);
    log(`  上游模型：${cfg.upstream.baseUrl}`);
    log(`  召回：k=${cfg.recall.k} 门槛=${cfg.recall.minScore} 预算=${cfg.recall.maxBytes}B`);
  });
}

main();
