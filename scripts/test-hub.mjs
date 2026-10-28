#!/usr/bin/env node
/* ============================================================
 * test-hub.mjs —— 全网插件源 + 调音台接入 自测
 *
 *   node scripts/test-hub.mjs
 *
 * 自己起一个临时市场进程（PORT=3222），测完关掉；不依赖 3210 是否在跑。
 * 只测市场自己的接口和代理，不打 GitHub（避免把限流额度烧在测试里）。
 * ============================================================ */
'use strict';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3222;
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0, fail = 0;
const ok = (name, extra = '') => { pass++; console.log('✅', name, extra); };
const bad = (name, why) => { fail++; console.log('❌', name, '→', why); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jget(p) {
  const r = await fetch(BASE + p);
  return { status: r.status, data: await r.json().catch(() => null) };
}

async function waitForServer(child, seconds = 15) {
  for (let i = 0; i < seconds * 4; i++) {
    if (child.exitCode !== null) return false;
    try {
      const r = await fetch(BASE + '/api/lab/status', { signal: AbortSignal.timeout(800) });
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'data', 'hub.json'))) {
    console.log('❌ data/hub.json 不存在：先跑一次 node scripts/hub-sync.mjs');
    process.exit(1);
  }

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });

  try {
    const up = await waitForServer(child);
    if (!up) { console.log('❌ 临时市场没起来：', stderr.slice(0, 300)); process.exit(1); }
    ok('临时市场启动', '→ 端口 ' + PORT);

    /* ① 快照整体形状 */
    {
      const { data } = await jget('/api/hub');
      const srcOk = data.counts.okSources > 0 && data.entries.length > 0;
      const ids = new Set(data.entries.map((e) => e.id));
      const dup = data.entries.length !== ids.size;
      srcOk && !dup && data.fetchedAt
        ? ok('快照形状', `→ ${data.total} 个仓库 · ${data.counts.okSources}/${data.counts.sources} 个源 · 无重复 id`)
        : bad('快照形状', JSON.stringify(data.counts) + (dup ? ' · 有重复 id' : ''));
    }

    /* ② facets 总数 = 总数 */
    {
      const { data } = await jget('/api/hub');
      const sum = Object.values(data.facets).reduce((a, b) => a + b, 0);
      sum === data.total
        ? ok('平台 facets 对得上', `→ ${data.total}`)
        : bad('平台 facets 对不上', `sum=${sum} total=${data.total}`);
    }

    /* ③ 搜索过滤 */
    {
      const { data: all } = await jget('/api/hub?perPage=1');
      const { data } = await jget('/api/hub?q=' + encodeURIComponent('plugin') + '&perPage=1');
      data.matched > 0 && data.matched <= all.total
        ? ok('关键词过滤', `→ plugin 命中 ${data.matched}/${all.total}`)
        : bad('关键词过滤', `matched=${data.matched}`);
    }

    /* ④ 平台筛选：返回的每一条都是该平台 */
    {
      const platforms = ['Yunzai', 'NoneBot', 'Koishi', 'AstrBot'];
      let allRight = true, used = '';
      for (const p of platforms) {
        const { data } = await jget('/api/hub?platform=' + encodeURIComponent(p) + '&perPage=60');
        if (!data.entries.every((e) => e.platform === p)) { allRight = false; used = p; break; }
      }
      allRight ? ok('平台筛选', `→ ${platforms.join('/')} 各查一遍，无串台`)
               : bad('平台筛选', used + ' 混进了别的平台');
    }

    /* ⑤ 排序：按星数降序 */
    {
      const { data } = await jget('/api/hub?sort=stars&perPage=60');
      let desc = true;
      for (let i = 1; i < data.entries.length; i++) {
        if (data.entries[i - 1].stars < data.entries[i].stars) { desc = false; break; }
      }
      desc ? ok('按星数排序', `→ 首名 ${data.entries[0].repo} ★${data.entries[0].stars}`)
           : bad('按星数排序', '不是降序');
    }

    /* ⑥ 分页：第 1 页和第 2 页不重叠 */
    {
      const a = await jget('/api/hub?perPage=6&page=1');
      const b = await jget('/api/hub?perPage=6&page=2');
      const ids1 = new Set(a.data.entries.map((e) => e.id));
      const overlap = b.data.entries.some((e) => ids1.has(e.id));
      !overlap && b.data.entries.length > 0 && b.data.entries.length <= 6
        ? ok('分页', `→ 第 2 页 ${b.data.entries.length} 条，与第 1 页无重叠`)
        : bad('分页', '有重叠或为空');
    }

    /* ⑦ 不存在的搜索词 → 空列表但接口正常 */
    {
      const { data } = await jget('/api/hub?q=' + encodeURIComponent('zzz-不存在-zzz') + '&perPage=1');
      data.ok && data.matched === 0 && data.entries.length === 0
        ? ok('空结果', '→ matched=0，不报错')
        : bad('空结果', JSON.stringify({ matched: data.matched, len: data.entries.length }));
    }

    /* ⑧ 同步接口：能启动、有冷却（不真等它抓完，避免烧 GitHub 限流） */
    {
      const first = await (await fetch(BASE + '/api/hub/sync', { method: 'POST' })).json();
      const second = await (await fetch(BASE + '/api/hub/sync', { method: 'POST' })).json();
      const cooled = first.ok === true && (second.ok === false || second.started === false);
      cooled
        ? ok('同步启动 + 冷却', '→ 第一次放行，第二次被 60 秒冷却挡住')
        : bad('同步启动 + 冷却', JSON.stringify({ first, second }));
      /* 等后台抓取结束或进程被杀，最多 2 秒，不拖慢测试 */
      await sleep(2000);
    }

    /* ⑨ 调音台状态接口 */
    {
      const { data } = await jget('/api/lab/status');
      typeof data.online === 'boolean' && data.url && data.proxy === '/lab/'
        ? ok('调音台状态接口', `→ ${data.url} · ${data.online ? '在线' : '离线'}`)
        : bad('调音台状态接口', JSON.stringify(data));
    }

    /* ⑩ 调音台代理：在线时代理能拿到它的页面，市场自己的接口不受影响 */
    {
      const st = await jget('/api/lab/status');
      if (st.data.online) {
        const r = await fetch(BASE + '/lab/');
        const html = await r.text();
        const apiOk = await jget('/api/list');
        /调音台/.test(html) && apiOk.data.ok
          ? ok('调音台 /lab/ 代理', `→ 页面 ${html.length} 字节 · 市场 /api/list 正常`)
          : bad('调音台 /lab/ 代理', '页面不对或市场接口被影响');
      } else {
        console.log('⏭️  调音台没在跑，跳过 /lab/ 代理用例（启动 node D:\\tts\\voicelab\\server.mjs 后重测）');
      }
    }
  } finally {
    child.kill();
    await sleep(300);
  }

  console.log('\n──────────────────────────────');
  console.log(`通过 ${pass} · 失败 ${fail}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error('测试脚本出错:', e); process.exit(1); });
