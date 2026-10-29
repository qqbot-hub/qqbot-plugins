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
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dataPath, RUNTIMES } from './paths.mjs';
import { isNewer, normalizeVer } from './version.mjs';

const pExecFile = promisify(execFile);

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
      recordVersion: normalizeVer(rec.version || ''),
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
      recordVersion: normalizeVer(rec.version || ''),
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
      recordVersion: normalizeVer(rec.version || ''),
      broken: false,
      query: rec.repo || '',
      repo: rec.repo || '',
      install: { target: 'astrbot-plugin', params: { repo: rec.repo || '' } },
    });
  }
  return out;
}

const FETCHERS = { nonebot: latestNonebot, koishi: latestKoishi, astrbot: latestAstrbot };

/**
 * 读「本机实际装着的版本」。
 *
 * 为什么不信登记表：data/state/*.json 里记的是安装那一刻的版本，之后用户可能手动
 * pip install -U、npm update，也可能被降级、被卸掉。拿这个旧记账去和远端比，就会把
 * 「其实早就不是最新」说成「已是最新」—— 那是虚标。
 * 三条路都是直接问安装现场：venv 里的 pip、node_modules 的 package.json、AstrBot 的 metadata.yaml。
 * 读不到就返回空版本 + 原因，由调用方降级成「未知」，绝不猜。
 */
async function installedVersion(eco, it, root = RUNTIMES) {
  try {
    if (eco === 'nonebot') {
      const py = process.platform === 'win32'
        ? path.join(root, 'nonebot', '.venv', 'Scripts', 'python.exe')
        : path.join(root, 'nonebot', '.venv', 'bin', 'python');
      if (!fs.existsSync(py)) return { ver: '', error: '本机没有 NoneBot 的 venv' };
      const { stdout } = await pExecFile(py, ['-m', 'pip', 'show', it.key], { timeout: 20000, windowsHide: true });
      const m = /^Version:\s*(.+)$/m.exec(stdout || '');
      if (!m) return { ver: '', error: 'pip show 查不到这个包' };
      return { ver: m[1].trim() };
    }
    if (eco === 'koishi') {
      const p = path.join(root, 'koishi', 'node_modules', it.key, 'package.json');
      if (!fs.existsSync(p)) return { ver: '', error: 'node_modules 里没有这个包' };
      return { ver: JSON.parse(fs.readFileSync(p, 'utf8')).version || '' };
    }
    if (eco === 'astrbot') {
      const p = path.join(root, 'astrbot', 'data', 'plugins', it.key, 'metadata.yaml');
      if (!fs.existsSync(p)) return { ver: '', error: '插件目录里没有 metadata.yaml' };
      const m = /^version:\s*(.+)$/m.exec(fs.readFileSync(p, 'utf8'));
      if (!m) return { ver: '', error: 'metadata.yaml 里没写 version' };
      return { ver: m[1].replace(/#.*$/, '').trim() };
    }
  } catch (e) {
    return { ver: '', error: String(e.message).slice(0, 60) };
  }
  return { ver: '', error: '未知生态' };
}

export { installedVersion };

/**
 * 单独抽出来的三态判定，方便测试，也避免把「读不到」误判成「已是最新」。
 * 返回 { state, hasUpdate, error }。
 */
export function decideState({ latest, current, fromInstalled, instError, recordVersion, fetchError }) {
  const L = normalizeVer(latest || '');
  const C = normalizeVer(current || '');
  if (!L) return { state: 'unknown', hasUpdate: false, error: fetchError || '' };
  if (!fromInstalled) {
    return {
      state: 'unknown',
      hasUpdate: false,
      error: `${instError || '读不到本机安装版本'}（登记表记的是 ${recordVersion || '未知'}）`,
    };
  }
  if (!C) return { state: 'unknown', hasUpdate: false, error: '读不到本机安装版本' };
  const hasUpdate = isNewer(L, C);
  return { state: hasUpdate ? 'update' : 'latest', hasUpdate, error: fetchError || '' };
}

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
      /* 先问安装现场要真实版本，再问远端最新版：拿记账版本去比会虚标 */
      const inst = await installedVersion(it.ecosystem, it);
      const current = normalizeVer(inst.ver || it.recordVersion || '');
      const fromInstalled = !!inst.ver;
      const fn = FETCHERS[it.ecosystem];
      let res = { latest: '', error: '未知生态' };
      try { res = await fn(it.query); } catch (e) { res = { latest: '', error: String(e.message).slice(0, 80) }; }
      const latest = normalizeVer(res.latest || '');
      const d = decideState({
        latest,
        current,
        fromInstalled,
        instError: inst.error,
        recordVersion: it.recordVersion,
        fetchError: res.error,
      });

      results.push(Object.assign({}, it, {
        current,
        currentSource: fromInstalled ? 'installed' : 'record',
        latest,
        hasUpdate: d.hasUpdate,
        state: d.state,
        error: d.error,
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
