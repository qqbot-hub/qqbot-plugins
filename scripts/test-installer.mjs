#!/usr/bin/env node
/* ============================================================
 * test-installer.mjs —— 安装引擎自测
 *
 *   node scripts/test-installer.mjs
 *
 * 只验证引擎本身的契约（步骤状态机、错误分支、任务记录），
 * 不下载任何东西、不动系统：真正会改系统的只有 node / plugin 两份 recipe，
 * 它们本身是只读检查加状态落盘。
 * ============================================================ */
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInstall, loadRecipe, getJob, recentJobs, recipeIds } from './installer.mjs';
import { dataPath } from './lib/paths.mjs';

let pass = 0, fail = 0;
const ok = (n, extra = '') => { pass++; console.log('✅', n, extra); };
const bad = (n, why) => { fail++; console.log('❌', n, '→', why); };

async function main() {
  /* 状态隔离：这套测试会真的跑安装流程（包括把一个插件装上、把失败记账）。
   * 不隔离的话，跑一次测试就会把 clock 装到用户机器上，还会在「运行监控」里
   * 留下一堆 red 的失败任务 —— 那些是测试喂的非法输入，不是真故障。 */
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-install-test-'));
  process.env.QQBOT_STATE_FILE = path.join(TMP, 'plugins.json');
  process.env.QQBOT_JOBS_FILE = path.join(TMP, 'jobs.json');

  /* 1. recipe 能被枚举与加载 */
  const ids = recipeIds();
  const want = ['node', 'snowluma', 'napcat', 'qqbridge', 'dsh', 'market', 'voicelab', 'plugin'];
  const missing = want.filter((w) => !ids.includes(w));
  missing.length ? bad('8 份安装脚本齐全', '缺 ' + missing.join(',')) : ok('8 份安装脚本齐全', '（' + ids.length + ' 个）');

  /* 2. 每份 recipe 结构合法：id/title/steps，且 step 有 key 与 run */
  let structOk = true, why = '';
  for (const id of ids) {
    const r = await loadRecipe(id).catch((e) => { structOk = false; why = id + ': ' + e.message; return null; });
    if (!r) continue;
    if (!r.title || !Array.isArray(r.steps) || !r.steps.length) { structOk = false; why = id + ' 缺 title/steps'; continue; }
    for (const s of r.steps) {
      if (!s.key || typeof s.run !== 'function') { structOk = false; why = `${id}.${s.key || '?'} 缺 key/run`; }
    }
  }
  structOk ? ok('结构合法（key + run 齐全）') : bad('结构合法（key + run 齐全）', why);

  /* 3. 只读检查回：跑 node recipe 应该全绿 */
  const j1 = await runInstall('node', {});
  j1.status === 'done' ? ok('跑通 node 检查', `（${j1.steps.length} 步）`) : bad('跑通 node 检查', j1.status);

  /* 4. 步骤状态机：全部 step 都有终态，且没有 pending 残留 */
  const stuck = j1.steps.filter((s) => s.status === 'pending' || s.status === 'running');
  stuck.length ? bad('步骤都有终态', stuck.map((s) => s.key).join(',')) : ok('步骤都有终态');

  /* 5. 失败分支：不存在的 recipe */
  const j2 = await runInstall('no_such_recipe', {});
  j2.status === 'failed' ? ok('不存在的脚本 → failed') : bad('不存在的脚本 → failed', j2.status);

  /* 6. 失败分支：plugin 没给 id */
  const j3 = await runInstall('plugin', { params: {} });
  (j3.status === 'failed' && /没给插件 id/.test(JSON.stringify(j3.steps))) ? ok('plugin 缺 id → 明确报错') : bad('plugin 缺 id → 明确报错', JSON.stringify(j3.steps[0]));

  /* 7. 失败分支：plugin 给了不存在的 id */
  const j4 = await runInstall('plugin', { params: { id: 'not_a_real_plugin_xyz' } });
  const detail4 = (j4.steps[0] || {}).detail || '';
  (j4.status === 'failed' && /清单里没有/.test(detail4)) ? ok('plugin 不存在的 id → 指明原因') : bad('plugin 不存在的 id → 指明原因', j4.status + ' / ' + detail4);

  /* 8. 失败即停：后续步骤被标成 blocked，不会继续装 */
  const blocked = j4.steps.slice(1).every((s) => s.status === 'blocked');
  blocked ? ok('失败即停（后续 blocked）', `（${j4.steps.length - 1} 步未执行）`) : bad('失败即停（后续 blocked）', JSON.stringify(j4.steps.map((s) => s.status)));

  /* 9. 真装一个插件：状态落盘 + 可查 */
  const j5 = await runInstall('plugin', { params: { id: 'clock' } });
  const state = (() => { try { return JSON.parse(fs.readFileSync(dataPath('state'), 'utf8')); } catch { return {}; } })();
  (j5.status === 'done' && state.clock && state.clock.installed)
    ? ok('安装 clock 插件并落盘', '（' + (state.clock.installedAt || '').slice(0, 19) + '）')
    : bad('安装 clock 插件并落盘', j5.status + ' / ' + JSON.stringify(state.clock || {}));

  /* 10. 任务可回查（getJob 命中内存或历史） */
  const found = getJob(j5.id);
  (found && found.id === j5.id) ? ok('任务可按 id 回查') : bad('任务可按 id 回查', '找不到 ' + j5.id);

  /* 11. 历史落盘：jobs.json 里能看到刚跑的任务 */
  const hist = recentJobs();
  const inHist = hist.some((h) => h.id === j5.id);
  inHist ? ok('任务历史已落盘', `（保留 ${hist.length} 条）`) : bad('任务历史已落盘', 'jobs.json 里没有');

  /* 12. hint 继承：步骤级 hint 会带进结果（失败步骤才该有） */
  const j6 = await runInstall('plugin', { params: { id: 'no_such_plugin' } });
  const hasHint = !!j6.steps[0].hint;
  hasHint ? ok('失败步骤带 hint（人话提示）') : bad('失败步骤带 hint（人话提示）', '空');

  /* 13. DSH 端口是动态的：给一个只回 "dsh web" 401 的端口，running 步骤要能认出它 */
  const http = await import('node:http');
  const fake = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web');
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const fakePort = fake.address().port;
  const saved = {};
  const dshCtx = {
    cfg: () => ({ dsh: { baseUrl: 'http://127.0.0.1:' + fakePort } }),
    saveCfg: (patch) => Object.assign(saved, patch || {}),
    portOpen: async () => false,
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    isWin: false,
    state: {},
  };
  const dshRecipe = await loadRecipe('dsh');
  const runningStep = dshRecipe.steps.find((s) => s.key === 'running');
  const dshRes = await runningStep.run(dshCtx);
  fake.close();
  (dshRes.status === 'ok' && /网页端/.test(dshRes.detail) && dshCtx.state.dsh && dshCtx.state.dsh.webPort === fakePort)
    ? ok('DSH 动态端口能被指纹识别', `（${fakePort} → ${dshRes.detail}）`)
    : bad('DSH 动态端口能被指纹识别', JSON.stringify(dshRes));

  /* 14. 写回的 baseUrl 指向真实端口，而不是写死的 3080 */
  (saved.dsh && saved.dsh.baseUrl === 'http://127.0.0.1:' + fakePort)
    ? ok('探测到的端口写回配置', saved.dsh.baseUrl)
    : bad('探测到的端口写回配置', JSON.stringify(saved.dsh || {}));

  /* 15. httpJson 的返回契约：真实数据在 .data 里（NapCat 曾因直接取 .assets 而永远失败） */
  const { httpJson } = await import('./lib/net.mjs');
  const apiSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tag_name: 'v1.2.3', assets: [{ name: 'NapCat.Shell.zip', size: 1024 }] }));
  });
  await new Promise((r) => apiSrv.listen(0, '127.0.0.1', r));
  const apiPort = apiSrv.address().port;
  const got = await httpJson(`http://127.0.0.1:${apiPort}/releases/latest`);
  apiSrv.close();
  (got.ok && got.data && Array.isArray(got.data.assets) && got.data.assets[0].name === 'NapCat.Shell.zip')
    ? ok('httpJson 返回包装对象（数据在 .data 里）')
    : bad('httpJson 返回包装对象（数据在 .data 里）', JSON.stringify(got).slice(0, 160));

  /* 探测一个没人监听的端口 / 不存在的域名，必须返回 { ok:false }，绝不抛异常。
   * 「刚重启的服务还没起来」和「网络抖一下」都会让 fetch reject，
   * 以前会一路冒到 installer，把整条流水线打成 fail、后续步骤全 blocked
   * （实测过：卸载 Koishi 插件时这一步炸了，登记清理没跑，记录残留）。 */
  const { httpGet } = await import('./installer.mjs');
  let deadRes = null, threw = '';
  const deadSock = http.createServer(() => {});
  await new Promise((r) => deadSock.listen(0, '127.0.0.1', r));
  const deadPort = deadSock.address().port;
  deadSock.close();
  try { deadRes = await httpGet(`http://127.0.0.1:${deadPort}/`, 1500); } catch (e) { threw = String(e.message || e); }
  (!threw && deadRes && deadRes.ok === false && deadRes.status === 0)
    ? ok('httpGet 连不上时不抛错，返回 ok:false')
    : bad('httpGet 连不上时不抛错，返回 ok:false', threw || JSON.stringify(deadRes));

  let dnsRes = null, dnsErr = '';
  try { dnsRes = await httpGet('http://no-such-host.invalid/x', 1500); } catch (e) { dnsErr = String(e.message || e); }
  (!dnsErr && dnsRes && dnsRes.ok === false)
    ? ok('httpGet 域名解析失败时也不抛错')
    : bad('httpGet 域名解析失败时也不抛错', dnsErr || JSON.stringify(dnsRes));

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响结论 */ }
  console.log('\n──────────────────────────────');
  console.log(`通过 ${pass} · 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('测试崩了：', e); process.exit(1); });
