/* ============================================================
 * updates.mjs —— 已装的生态插件，有没有新版本
 *
 * 三种生态的最新版来源各不相同，这里各走各的官方渠道：
 *   NoneBot → PyPI（包名 == pip 名）
 *   Koishi  → npm registry 的 /<pkg>/latest
 *   AstrBot → GitHub releases（插件本体在仓库里，版本号写在 metadata.yaml）
 *
 * 原则：查不到就是"未知"，绝不把"网络失败"说成"已是最新"。
 * 页面据此显示的三种状态是：有新版 / 已是最新 / 查不到（附原因）。
 * ============================================================ */
import fs from 'node:fs';
import { dataPath } from './paths.mjs';
import { isNewer, normalizeVer } from './version.mjs';

const CACHE_MS = 30 * 60e3;
let cache = { at: 0, data: null };
let tlsLoose = false;

function readState(key) {
  try {
    const p = dataPath(key);
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch {
    return {};
  }
}

async function getJson(url, timeout = 12000) {
  const once = async () => {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { 'user-agent': 'qqbot-plugins/1.0', accept: 'application/json' },
    });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, status: r.status, json: await r.json() };
  };
  try {
    return await once();
  } catch (e) {
    if (tlsLoose) return { ok: false, status: 0, error: String(e.message).slice(0, 80) };
    if (!/fetch failed|certificate|self.signed|unable to verify|SSL|TLS|schannel/i.test(String(e.message))) {
      return { ok: false, status: 0, error: String(e.message).slice(0, 80) };
    }
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    tlsLoose = true;
    try { return await once(); } catch (e2) { return { ok: false, status: 0, error: String(e2.message).slice(0, 80) }; }
  }
}

async function latestNonebot(pkg) {
  /* 和 recipe 里一致：镜像优先，官方最后（国内直连 pypi.org 常超时） */
  const urls = [
    `https://pypi.tuna.tsinghua.edu.cn/pypi/${encodeURIComponent(pkg)}/json`,
    `https://mirrors.aliyun.com/pypi/web/json/${encodeURIComponent(pkg)}`,
    `https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`,
  ];
  let last = '';
  for (const u of urls) {
    const r = await getJson(u);
    if (r.ok && r.json && r.json.info && r.json.info.version) return { latest: r.json.info.version };
    if (r.status === 404) { last = 'PyPI 上没有这个包'; continue; }
    last = r.error ? r.error : `HTTP ${r.status}`;
  }
  return { latest: '', error: last || '查询失败' };
}

async function latestKoishi(pkg) {
  const r = await getJson(`https://registry.npmmirror.com/${encodeURIComponent(pkg).replace('%2F', '/')}/latest`);
  if (r.ok && r.json && r.json.version) return { latest: r.json.version };
  if (r.status === 404) return { latest: '', error: 'npm 上没有这个包' };
  return { latest: '', error: r.error || `HTTP ${r.status}` };
}

async function latestAstrbot(repo) {
  const m = /github\.com[/:]([^/]+)\/([^/#?]+)/i.exec(String(repo || ''));
  if (!m) return { latest: '', error: '不是 GitHub 仓库，无法查最新版' };
  const owner = m[1];
  const name = m[2].replace(/\.git$/, '');
  const rel = await getJson(`https://api.github.com/repos/${owner}/${name}/releases/latest`);
  if (rel.ok && rel.json && (rel.json.tag_name || rel.json.name)) {
    return { latest: normalizeVer(rel.json.tag_name || rel.json.name) };
  }
  /* 很多作者不发 release，只打 tag */
  const tags = await getJson(`https://api.github.com/repos/${owner}/${name}/tags?per_page=5`);
  if (tags.ok && Array.isArray(tags.json) && tags.json.length) {
    const v = tags.json.map((t) => normalizeVer(t.name)).filter((s) => /^\d+\.\d+/.test(s));
    if (v.length) return { latest: v.sort((a, b) => (isNewer(a, b) ? 1 : -1))[0] };
  }
  if (rel.status === 403 || tags.status === 403) return { latest: '', error: 'GitHub API 限流（未登录每小时 60 次）' };
  return { latest: '', error: rel.error || '仓库没有 release 也没有版本 tag' };
}

/** 按生态分组收集待查项 */
function collect() {
  const out = [];
  const nb = readState('nonebotPlugins');
  for (const [pkg, rec] of Object.entries(nb)) {
    out.push({
      ecosystem: 'nonebot', key: pkg,
      name: rec.package || pkg,
      current: normalizeVer(rec.version || ''),
      broken: rec.status === 'broken',
      reason: rec.reason || '',
      query: rec.package || pkg,
      install: { target: 'nonebot-plugin', params: { package: rec.package || pkg } },
    });
  }
  const ks = readState('koishiPlugins');
  for (const [pkg, rec] of Object.entries(ks)) {
    out.push({
      ecosystem: 'koishi', key: pkg,
      name: rec.package || pkg,
      current: normalizeVer(rec.version || ''),
      broken: false,
      query: rec.package || pkg,
      install: { target: 'koishi-plugin', params: { package: rec.package || pkg } },
    });
  }
  const ab = readState('astrbotPlugins');
  for (const [name, rec] of Object.entries(ab)) {
    out.push({
      ecosystem: 'astrbot', key: name,
      name: rec.displayName || rec.name || name,
      current: normalizeVer(rec.version || ''),
      broken: false,
      query: rec.repo || '',
      repo: rec.repo || '',
      install: { target: 'astrbot-plugin', params: { repo: rec.repo || '' } },
    });
  }
  return out;
}

const FETCHERS = { nonebot: latestNonebot, koishi: latestKoishi, astrbot: latestAstrbot };

/** 检查全部已装生态插件；force=true 跳过 30 分钟缓存 */
export async function checkUpdates({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) {
    return Object.assign({}, cache.data, { cached: true });
  }
  const list = collect();
  const results = [];
  /* 限并发 5：GitHub 未登录 60 次/小时，一次性打满会被限流 */
  const queue = list.slice();
  const workers = Array.from({ length: Math.min(5, queue.length || 1) }, async () => {
    while (queue.length) {
      const it = queue.shift();
      const fn = FETCHERS[it.ecosystem];
      let res = { latest: '', error: '未知生态' };
      try { res = await fn(it.query); } catch (e) { res = { latest: '', error: String(e.message).slice(0, 80) }; }
      const latest = normalizeVer(res.latest || '');
      const hasUpdate = latest && it.current ? isNewer(latest, it.current) : false;
      results.push(Object.assign({}, it, {
        latest,
        hasUpdate,
        /* 三种状态必须分得清：有新版 / 已最新 / 查不到 */
        state: !latest ? 'unknown' : (hasUpdate ? 'update' : 'latest'),
        error: res.error || '',
      }));
    }
  });
  await Promise.all(workers);
  /* 稳定的展示顺序：有更新的排前面，然后按生态+名字 */
  const order = { update: 0, unknown: 1, latest: 2 };
  results.sort((a, b) => (order[a.state] - order[b.state]) || a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name));

  const data = {
    ok: true,
    checkedAt: new Date().toISOString(),
    total: results.length,
    counts: {
      update: results.filter((r) => r.state === 'update').length,
      latest: results.filter((r) => r.state === 'latest').length,
      unknown: results.filter((r) => r.state === 'unknown').length,
    },
    items: results,
    cached: false,
  };
  cache = { at: Date.now(), data };
  return data;
}

/** 给页面用的单行摘要；没有已装生态插件时返回空串 */
export function updateSummaryText(counts) {
  if (!counts || !counts.update) return '';
  return `${counts.update} 个插件有新版本`;
}
