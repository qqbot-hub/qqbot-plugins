/* ============================================================
 * secrets.mjs —— 密钥加密存储（AES-256-GCM）
 *
 * 为什么要有这个文件：
 *   config.json 是要提交/可读的，一旦把模型 API Key、OneBot Token、AppSecret
 *   明文写进去，等于把它们贴到别人脸上。这里做三件事：
 *     1. 密钥文件（data/state/.secrets.key，已 gitignore）存 32 字节随机密钥，
 *        权限 0600；没有密钥文件时自动生成。
 *     2. 值用 AES-256-GCM 加密，密文带版本前缀 `enc:v1:<iv>:<tag>:<ct>`，
 *        解密失败不抛给调用方，返回空串（宁可用不了，也不要半截乱码）。
 *     3. 提供 redact()：日志里出现密钥原文时替换成 ***，防止写进 jobs.json。
 *
 * 边界（如实说）：
 *   · 这是"本机加密"，防的是误提交、误粘贴、日志泄露，防不住能读你整个用户目录的人。
 *   · Windows 上 chmod 0600 不完全生效（NTFS ACL 由系统管），这点写在 docs 里。
 * ============================================================ */
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';

const KEY_DIR = path.join(ROOT, 'data', 'state');
const KEY_FILE = path.join(KEY_DIR, '.secrets.key');
const PREFIX = 'enc:v1:';

let cachedKey = null;

function keyFromPassphrase(pass) {
  /* 用户自己给了口令就派生，否则用随机密钥文件 */
  return crypto.scryptSync(pass, 'qqbot-plugins::secrets::v1', 32);
}

function loadKey() {
  if (cachedKey) return cachedKey;
  const pass = String(process.env.QQBOT_SECRET_PASSPHRASE || '').trim();
  if (pass) { cachedKey = keyFromPassphrase(pass); return cachedKey; }
  try {
    const raw = fs.readFileSync(KEY_FILE);
    if (raw.length === 32) { cachedKey = raw; return cachedKey; }
  } catch { /* 没文件，下面生成 */ }
  fs.mkdirSync(KEY_DIR, { recursive: true });
  const k = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, k, { mode: 0o600 });
  try { fs.chmodSync(KEY_FILE, 0o600); } catch { /* Windows 上可能不支持，忽略 */ }
  cachedKey = k;
  return cachedKey;
}

export const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

export function encrypt(plain) {
  const text = String(plain == null ? '' : plain);
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ct].map((b) => b.toString('base64')).join(':');
}

export function decrypt(payload) {
  const s = String(payload || '');
  if (!s) return '';
  if (!isEncrypted(s)) return s;          // 兼容历史明文，读得到就先用着
  const parts = s.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return '';
  try {
    const [iv, tag, ct] = parts.map((x) => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', loadKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    /* 换了机器/换了密钥文件：解不开就当没配，让用户重新填，不要崩 */
    return '';
  }
}

/** 展示用：只留头尾，永远不给明文 */
export function mask(v) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return s.slice(0, 3) + '••••' + s.slice(-2);
}

/** 日志脱敏：已知的密钥原文全替换掉 */
export function redact(text, secrets = []) {
  let out = String(text == null ? '' : text);
  for (const raw of secrets) {
    const s = String(raw || '');
    if (s.length < 6) continue;
    out = out.split(s).join('***');
  }
  return out;
}
