/* ============================================================
 * scripts/lib/net.mjs —— 极简 HTTP 取 JSON（零三方依赖）
 *
 * 为什么不用裸 fetch：
 *   本机装了会做 TLS 拦截的代理/杀软时，Node 用 OpenSSL 校验证书会报
 *   `unable to verify the first certificate`，而 Windows 自带的 curl 走系统
 *   证书库通常能通。所以这里先 fetch，失败再退到 curl（不改变任何系统设置）。
 *
 * 返回：{ ok, status, data, text, via }（via = 'fetch' | 'curl'）
 * ============================================================ */
'use strict';

import { execFile } from 'node:child_process';

const UA = 'qqbot-plugins-hub/1.0 (+https://github.com/qqbot-hub/qqbot-plugins)';

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function curlJson(url, headers, timeoutMs, method, body) {
  return new Promise((resolve) => {
    const args = ['-sS', '--ssl-no-revoke', '-m', String(Math.ceil(timeoutMs / 1000)), '-w', '\n%{http_code}'];
    for (const [k, v] of Object.entries(headers)) args.push('-H', k + ': ' + v);
    if (method && method !== 'GET') args.push('-X', method);
    if (body) args.push('--data-binary', body);
    args.push(url);
    execFile('curl', args, { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      /* curl 不存在 / 超时被杀：都算失败，交给调用方报原错误 */
      if (err && !stdout) return resolve(null);
      const text = String(stdout || '');
      const idx = text.lastIndexOf('\n');
      const code = Number(text.slice(idx + 1).trim()) || 0;
      const payload = idx >= 0 ? text.slice(0, idx) : text;
      resolve({ ok: code >= 200 && code < 300, status: code, data: safeParse(payload), text: payload, via: 'curl' });
    });
  });
}

export async function httpJson(url, opts = {}) {
  const { headers = {}, timeoutMs = 20000, method = 'GET', body } = opts;
  const h = Object.assign({ 'User-Agent': UA, Accept: 'application/vnd.github+json' }, headers);

  let firstErr = null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method, headers: h, body, signal: ac.signal });
    const text = await r.text();
    return { ok: r.ok, status: r.status, data: safeParse(text), text, via: 'fetch' };
  } catch (e) {
    firstErr = e;
  } finally {
    clearTimeout(timer);
  }

  const viaCurl = await curlJson(url, h, timeoutMs, method, body);
  if (viaCurl) return viaCurl;
  throw new Error(`请求失败：${url}（${firstErr && firstErr.message}）`);
}

/* GitHub 限流时给一句人话 */
export function rateHint(status, data) {
  if (status === 403 || status === 429) {
    const msg = String((data && data.message) || '');
    if (/rate limit|secondary/i.test(msg)) {
      return 'GitHub 接口限流了（未登录每小时只有 10 次搜索）。等一分钟再点同步，或在 config.json 里填 hub.githubToken';
    }
    return 'GitHub 拒绝了这次请求：' + (msg || '403');
  }
  return '';
}
