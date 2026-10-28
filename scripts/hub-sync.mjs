#!/usr/bin/env node
/* ============================================================
 * hub-sync.mjs —— 把「全网插件源」抓成一份统一目录
 *
 *   node scripts/hub-sync.mjs              # 抓全部源，写入 data/hub.json
 *   node scripts/hub-sync.mjs --source=nonebot
 *   node scripts/hub-sync.mjs --json       # 机器可读摘要
 *
 * 数据来自 GitHub Search API（公开、只读）。不克隆、不下载、不改任何上游仓库。
 * 各平台插件格式不同（Yunzai 是 JS 目录、NoneBot 是 Python 包、Koishi 是 npm 包），
 * 所以这里抓到的是**目录**：名字、描述、作者、星数、语言、更新时间、原文链接，
 * 供本市场统一检索；真正能装进本市场的，只有本项目自己写的 .mjs 插件。
 * ============================================================ */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpJson, rateHint } from './lib/net.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES_FILE = path.join(ROOT, 'data', 'sources.json');
const OUT_FILE = path.join(ROOT, 'data', 'hub.json');

const ARG = process.argv.slice(2);
const JSON_OUT = ARG.includes('--json');
const ONLY = (ARG.find((a) => a.startsWith('--source=')) || '').split('=')[1] || '';
const LIMIT = Number((ARG.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const config = readJson(path.join(ROOT, 'config.json'), {});
const hubCfg = config.hub || {};
const TOKEN = String(process.env.GITHUB_TOKEN || hubCfg.githubToken || '');
/* 未登录时搜索接口只有 10 次/分钟，必须拉开间隔；有 token 可以快一点 */
const DELAY_MS = Number(hubCfg.syncDelayMs) > 0 ? Number(hubCfg.syncDelayMs) : (TOKEN ? 1500 : 6500);

const PLUGINISH = /plugin|插件|扩展|拓展|extension|addon|module|adapter|适配|bot/i;

function log(...a) { if (!JSON_OUT) console.log(...a); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一条 GitHub 仓库 → 本市场的统一条目 */
function toEntry(item, src) {
  const topics = Array.isArray(item.topics) ? item.topics : [];
  return {
    id: String(item.full_name || '').toLowerCase(),
    repo: item.full_name,
    name: item.name,
    desc: String(item.description || '').replace(/\s+/g, ' ').trim().slice(0, 220),
    url: item.html_url,
    homepage: item.homepage || '',
    platform: src.platform,
    sourceId: src.id,
    sourceName: src.name,
    stars: item.stargazers_count || 0,
    forks: item.forks_count || 0,
    lang: item.language || '',
    updatedAt: item.pushed_at || item.updated_at || '',
    archived: !!item.archived,
    fork: !!item.fork,
    license: item.license && item.license.spdx_id && item.license.spdx_id !== 'NOASSERTION' ? item.license.spdx_id : '',
    topics: topics.slice(0, 8),
  };
}

function keep(entry, src) {
  if (src.filter !== 'pluginish') return true;
  const blob = [entry.name, entry.desc, entry.topics.join(' ')].join(' ').toLowerCase();
  return PLUGINISH.test(blob);
}

/** 抓一个源 */
async function fetchSource(src) {
  const started = Date.now();
  const perPage = Math.min(Number(src.perPage || hubCfg.perPage || 40), 100);
  const url = 'https://api.github.com/search/repositories'
    + '?q=' + encodeURIComponent(src.query)
    + '&sort=' + (src.sort || 'stars') + '&order=desc&per_page=' + perPage;
  const headers = TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {};
  try {
    const r = await httpJson(url, { headers, timeoutMs: 20000 });
    if (!r.ok) {
      const hint = rateHint(r.status, r.data) || `HTTP ${r.status}`;
      return { id: src.id, name: src.name, ok: false, count: 0, error: hint, tookMs: Date.now() - started };
    }
    const items = (r.data && r.data.items) || [];
    const entries = items.map((it) => toEntry(it, src)).filter((e) => keep(e, src));
    return {
      id: src.id, name: src.name, ok: true, count: entries.length,
      total: (r.data && r.data.total_count) || items.length,
      via: r.via, tookMs: Date.now() - started, entries,
    };
  } catch (e) {
    return { id: src.id, name: src.name, ok: false, count: 0, error: String(e.message || e), tookMs: Date.now() - started };
  }
}

export async function syncAll(opts = {}) {
  const def = readJson(SOURCES_FILE, { sources: [] });
  let sources = def.sources || [];
  if (opts.only || ONLY) sources = sources.filter((s) => s.id === (opts.only || ONLY));
  if (LIMIT) sources = sources.slice(0, LIMIT);

  const results = [];
  const byRepo = new Map();
  for (const src of sources) {
    const r = await fetchSource(src);
    results.push({ id: r.id, name: r.name, ok: r.ok, count: r.count, total: r.total || null, error: r.error || '', via: r.via || '', tookMs: r.tookMs });
    for (const e of r.entries || []) {
      const old = byRepo.get(e.id);
      /* 同一个仓库可能同时命中多个源：保留星数更高的那条，来源合并成一个数组 */
      if (old) {
        if (!old.sources.includes(e.sourceId)) old.sources.push(e.sourceId);
        if (e.stars > old.stars) Object.assign(old, e, { sources: old.sources });
      } else {
        byRepo.set(e.id, Object.assign({}, e, { sources: [e.sourceId] }));
      }
    }
    log(`${r.ok ? '✅' : '❌'} ${src.name.padEnd(20)} ${r.ok ? r.count + ' 条' : r.error}（${r.tookMs}ms${r.via ? ' · ' + r.via : ''}）`);
    if (src !== sources[sources.length - 1]) await sleep(DELAY_MS);
  }

  const entries = [...byRepo.values()].sort((a, b) => b.stars - a.stars);
  const snapshot = {
    version: 1,
    fetchedAt: new Date().toISOString(),
    via: TOKEN ? 'github-search(token)' : 'github-search(anonymous)',
    counts: { sources: results.length, okSources: results.filter((r) => r.ok).length, entries: entries.length },
    sources: results,
    entries,
  };
  return snapshot;
}

/* ---------- CLI ---------- */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  log('抓取全网插件源（GitHub Search API，只读）…');
  if (!TOKEN) log('（未配置 hub.githubToken，限速 10 次/分钟，源之间会等 6.5 秒）');
  const snap = await syncAll();
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(snap, null, 1) + '\n');
  if (JSON_OUT) {
    console.log(JSON.stringify({ fetchedAt: snap.fetchedAt, counts: snap.counts, sources: snap.sources }, null, 2));
  } else {
    log('');
    log(`共 ${snap.counts.entries} 个仓库，来自 ${snap.counts.okSources}/${snap.counts.sources} 个源`);
    log('写入 ' + path.relative(ROOT, OUT_FILE));
    const bad = snap.sources.filter((s) => !s.ok);
    if (bad.length) {
      log('有源没抓成功：');
      for (const s of bad) log('  ' + s.name + '：' + s.error);
    }
  }
  process.exitCode = snap.counts.okSources ? 0 : 1;
}
