/* ============================================================
 * QQ-Plugin-Hub 插件共享库（供各插件 import，本身不是插件）
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

export const HUB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STORE_DIR = path.join(HUB_ROOT, 'data', 'store');

/* ---------- 存储 ---------- */
export function storage(pluginId) {
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
      fs.writeFileSync(file(name), JSON.stringify(value, null, 2));
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
      headers: Object.assign({ 'User-Agent': 'QQ-Plugin-Hub/1.0' }, opts.headers || {}),
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

/* ---------- 简易超时包装 ---------- */
export async function withTimeout(promise, ms, label = '操作') {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label + '超时')), ms); });
  try { return await Promise.race([promise, timer]); } finally { clearTimeout(t); }
}
