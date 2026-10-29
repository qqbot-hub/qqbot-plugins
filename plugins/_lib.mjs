/* ============================================================
 * qqbot-plugins 插件共享库（供各插件 import，本身不是插件）
 * 零第三方依赖。所有插件通过 ctx 获得运行时能力：
 *   ctx.onebot(action, params)  调 SnowLuma 的 OneBot HTTP API
 *   ctx.httpJson(url, opts)     带超时的 GET/POST JSON
 *   ctx.storage                 每个插件独立的数据目录（data/store/<id>/）
 * ============================================================ */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { wrapOnebot } from './_bridge.mjs';

export const HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* 允许用 QQBOT_STORE 重定向数据目录（自动化测试用临时目录，不污染真实数据） */
export const STORE_DIR = process.env.QQBOT_STORE
  ? path.resolve(process.env.QQBOT_STORE)
  : path.join(HUB_ROOT, 'data', 'store');

/* ---------- 存储 ---------- */
/* 沙箱里没有写权限，也不能让插件直接碰磁盘：
 * 子进程侧的 storage 由 sandbox-runner 换成「内存读写 + 结束时回传脏数据」，
 * 由父进程校验 pluginId 后再落盘。插件代码一行都不用改。 */
const SANDBOX = () => globalThis.__QQBOT_SANDBOX__ || null;

export function storage(pluginId) {
  const sb = SANDBOX();
  if (sb && typeof sb.storage === 'function') return sb.storage(pluginId);
  const dir = path.join(STORE_DIR, pluginId);
  fs.mkdirSync(dir, { recursive: true });
  /* Windows 文件名不能含 \ / : * ? " < > |，会话键里的冒号等统一替换 */
  const safe = (name) => String(name).replace(/[\\/:*?"<>|]/g, '_');
  const file = (name) => path.join(dir, safe(name) + '.json');
  return {
    get(name, fallback) {
      try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); }
      catch { return fallback; }
    },
    set(name, value) {
      const f = file(name);
      /* 传 undefined/null = 清空这份数据（删文件），
         不能直接 JSON.stringify（它对 undefined 返回 undefined，写文件会崩） */
      if (value === undefined || value === null) {
        try { fs.unlinkSync(f); } catch { /* 本来就不存在 */ }
        return value;
      }
      fs.writeFileSync(f, JSON.stringify(value, null, 2));
      return value;
    },
    update(name, fallback, fn) {
      const cur = this.get(name, fallback);
      return this.set(name, fn(cur) ?? cur);
    },
  };
}

/* ---------- HTTP ---------- */
export async function httpJson(url, opts = {}, timeoutMs = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: Object.assign({ 'User-Agent': 'qqbot-plugins/1.0' }, opts.headers || {}),
      method: opts.method || 'GET',
      body: opts.body != null ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  } finally { clearTimeout(t); }
}

/* ---------- 随机与确定性 ---------- */
export const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
/* 同一天、同样的 key 得到同样结果（星座运势/今日运势用） */
export function dayHash(...parts) {
  const today = new Date();
  const day = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}`;
  const h = crypto.createHash('sha256').update(day + '|' + parts.join('|')).digest();
  return h.readUInt32BE(0);
}
export const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* ---------- 工具参数 ---------- */
export const num = (v) => (typeof v === 'number' ? v : parseFloat(v));
export const str = (v) => (v == null ? '' : String(v).trim());
/* 会话标识：AI 在群聊里会带 group_id，私聊时只有 user_id */
export function sessionOf(args) {
  const gid = num(args.group_id);
  return gid && Number.isFinite(gid)
    ? { type: 'group', key: 'group:' + gid, groupId: gid, userId: num(args.user_id) || 0 }
    : { type: 'private', key: 'private:' + (num(args.user_id) || 'me'), groupId: 0, userId: num(args.user_id) || 0 };
}

/* ---------- 协议端适配：插件优先用 ctx.bridge，没有时用 ctx.onebot 兜底 ---------- */
export function bridgeOf(ctx) {
  if (ctx && ctx.bridge) return ctx.bridge;
  if (ctx && ctx.onebot) return wrapOnebot(ctx.onebot);
  throw new Error('缺少协议端连接：市场没有注入 ctx.bridge / ctx.onebot');
}

/* ---------- 简易超时包装 ---------- */
export async function withTimeout(promise, ms, label = '操作') {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label + '超时')), ms); });
  try { return await Promise.race([promise, timer]); } finally { clearTimeout(t); }
}
