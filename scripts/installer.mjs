/* ============================================================
 * installer.mjs —— 一键安装引擎
 *
 * 一句话：把「点安装」变成真的装。每个可装的东西（协议端 / 桥 / 调音台 / 插件）
 * 在 recipes/ 下有一份 recipe，引擎按步骤跑：detect → download → extract →
 * configure → start → verify，每步都能：通过 / 跳过 / 需要人工 / 失败。
 *
 * 三条铁律：
 *   1. 幂等：已经装好的东西再点一次不会重装（步骤自己 emit skip）
 *   2. 可停：任一步 fail 立刻停，不会带着半成品继续往下装
 *   3. 可解释：每一步都有中文 detail，失败给 hint（人话，带具体命令/链接）
 *
 * 用法（CLI）：
 *   node scripts/installer.mjs list
 *   node scripts/installer.mjs run snowluma
 *   node scripts/installer.mjs run plugin --id=clock
 * 用法（库）：
 *   import { runInstall } from './scripts/installer.mjs';
 *   const job = runInstall('snowluma', { onEvent: (e) => ... });
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { ROOT, RUNTIMES, dataPath, readCfg, writeCfg, readJson, writeJson } from './lib/paths.mjs';

const RECIPE_DIR = path.join(ROOT, 'recipes');
const JOB_KEEP = 20;              // jobs.json 里保留最近多少次任务
const LOG_LINES_KEEP = 400;       // 单次任务日志最多留多少行

/* ---------- recipe 加载 ---------- */
const recipeCache = new Map();

export function recipeIds() {
  try {
    return fs.readdirSync(RECIPE_DIR).filter((f) => f.endsWith('.mjs')).map((f) => f.replace(/\.mjs$/, ''));
  } catch { return []; }
}

export async function loadRecipe(id) {
  const safe = String(id || '').replace(/[^a-z0-9_-]/gi, '');
  if (!safe) throw new Error('recipe id 不合法');
  if (recipeCache.has(safe)) return recipeCache.get(safe);
  const file = path.join(RECIPE_DIR, safe + '.mjs');
  if (!fs.existsSync(file)) throw new Error(`没有这份安装脚本：recipes/${safe}.mjs`);
  const mod = await import('file://' + file.replace(/\\/g, '/') + '?t=' + Date.now());
  const r = mod.default;
  if (!r || !Array.isArray(r.steps)) throw new Error(`recipes/${safe}.mjs 结构不对：需要导出 { id, title, steps[] }`);
  recipeCache.set(safe, r);
  return r;
}

/* ---------- 小工具：端口 / HTTP / 进程 ---------- */
export function portOpen(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

export async function httpGet(url, timeoutMs = 4000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'qqbot-plugins-installer' } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 不是 JSON 就算了 */ }
  return { status: r.status, ok: r.ok, text, json };
}

/** 跑一个命令，边跑边把输出喂给日志；永不抛错，让 recipe 自己判断 */
export function exec(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || ROOT,
      shell: false,
      windowsHide: true,
      env: Object.assign({}, process.env, opts.env || {}),
    });
    let out = '', err = '';
    const onData = (chunk) => {
      const s = chunk.toString();
      if (opts.onLog) String(s).split(/\r?\n/).filter(Boolean).forEach((l) => opts.onLog(l));
    };
    child.stdout?.on('data', (c) => { out += c; onData(c); });
    child.stderr?.on('data', (c) => { err += c; onData(c); });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, opts.timeoutMs || 300000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? -1 : code, stdout: out, stderr: err }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: String(e.message) }); });
  });
}

/* ---------- ctx：recipe 能用的全部能力 ---------- */
function makeCtx(job, params, emit) {
  const shared = {};
  const log = (msg, level = 'info') => {
    const line = { t: Date.now(), level, msg: String(msg) };
    job.logs.push(line);
    if (job.logs.length > LOG_LINES_KEEP) job.logs.splice(0, job.logs.length - LOG_LINES_KEEP);
    emit('log', line);
  };
  return {
    params: params || {},
    state: shared,
    paths: {
      root: ROOT,
      runtimes: RUNTIMES,
      runtimeDir: (id) => path.join(RUNTIMES, id),
    },
    log,
    portOpen,
    httpGet,
    exec: (cmd, args, opts) => exec(cmd, args, Object.assign({}, opts, {
      /* quiet: 只取结果不刷屏（netstat/tasklist 这类输出几千行，刷进日志没法看） */
      onLog: opts && opts.quiet ? null : (l) => log(l, 'cmd'),
    })),
    /** 起一个常驻进程（协议端/桥/调音台），不等它结束，脱离父进程独立活 */
    spawnDetached: (cmd, args = [], opts = {}) => {
      try {
        const child = spawn(cmd, args, {
          cwd: opts.cwd || ROOT,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env: Object.assign({}, process.env, opts.env || {}),
        });
        child.unref();
        log(`已在后台启动：${path.basename(cmd)} ${args.join(' ')}`, 'info');
        return { ok: true, pid: child.pid };
      } catch (e) {
        log(`启动失败：${e.message}`, 'err');
        return { ok: false, error: e.message };
      }
    },
    isPortOpen: portOpen,
    exists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
    readJson,
    writeJson,
    cfg: () => readCfg({}),
    saveCfg: (patch) => {
      const c = readCfg({});
      const next = Object.assign(c, patch || {});
      writeCfg(next);
      return next;
    },
    /** 平台识别，recipe 里用来分 Windows/其他 */
    isWin: process.platform === 'win32',
  };
}

/* ---------- 任务登记 ---------- */
const jobs = new Map();
let seq = 0;

function loadJobHistory() {
  return readJson('jobs', []) || [];
}

function saveJob(job) {
  try {
    const list = loadJobHistory().filter((j) => j.id !== job.id);
    list.unshift(stripJob(job));
    writeJson('jobs', list.slice(0, JOB_KEEP));
  } catch { /* 历史存不下不影响安装 */ }
}

const stripJob = (j) => ({
  id: j.id, target: j.target, title: j.title, status: j.status,
  startedAt: j.startedAt, endedAt: j.endedAt, params: j.params,
  steps: j.steps.map((s) => ({ key: s.key, title: s.title, status: s.status, detail: s.detail, hint: s.hint, ms: s.ms })),
  logs: (j.logs || []).slice(-80),
});

export function getJob(id) {
  return jobs.get(id) || loadJobHistory().find((j) => j.id === id) || null;
}

export function recentJobs() {
  const live = [...jobs.values()].map(stripJob);
  const hist = loadJobHistory().filter((h) => !jobs.has(h.id));
  return live.concat(hist).slice(0, JOB_KEEP);
}

/* ---------- 跑一份 recipe ---------- */
/**
 * @param {string} target   recipe 文件名（不含扩展名），如 snowluma / plugin
 * @param {object} opts     { params, onEvent }
 * @returns {Promise<object>} job
 */
export async function runInstall(target, opts = {}) {
  const emit = (type, payload) => { try { opts.onEvent && opts.onEvent(type, payload); } catch {} };
  const newId = () => opts.jobId || ('job-' + Date.now() + '-' + (++seq));
  let recipe;
  try {
    recipe = await loadRecipe(target);
  } catch (e) {
    const job = { id: newId(), target, title: target, status: 'failed', startedAt: Date.now(), endedAt: Date.now(), steps: [], logs: [{ t: Date.now(), level: 'err', msg: e.message }], params: opts.params || {} };
    jobs.set(job.id, job);
    emit('fail', job);
    return job;
  }

  const job = {
    id: newId(),
    target: recipe.id || target,
    title: recipe.title || target,
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    params: opts.params || {},
    steps: recipe.steps.map((s) => ({ key: s.key, title: s.title, status: 'pending', detail: '', hint: '', ms: 0 })),
    logs: [],
  };
  jobs.set(job.id, job);
  const ctx = makeCtx(job, opts.params, emit);
  emit('start', { id: job.id, title: job.title, steps: job.steps.map((s) => ({ key: s.key, title: s.title })) });
  ctx.log(`开始安装：${job.title}`);

  for (let i = 0; i < recipe.steps.length; i++) {
    const step = recipe.steps[i];
    const st = job.steps[i];
    st.status = 'running';
    emit('step', { index: i, key: st.key, status: 'running' });
    const t0 = Date.now();
    let res;
    try {
      res = (await step.run(ctx)) || {};
    } catch (e) {
      res = { status: 'fail', detail: e.message, hint: step.hint };
    }
    st.ms = Date.now() - t0;
    st.status = res.status === 'skip' ? 'skip' : res.status === 'manual' ? 'manual' : res.status === 'fail' ? 'fail' : 'done';
    st.detail = res.detail || '';
    st.hint = res.hint || step.hint || '';
    if (st.detail) ctx.log(`[${step.title}] ${st.detail}`, st.status === 'fail' ? 'err' : 'info');
    emit('step', { index: i, key: st.key, status: st.status, detail: st.detail, hint: st.hint, ms: st.ms });

    if (st.status === 'fail' || st.status === 'manual') {
      job.status = st.status === 'fail' ? 'failed' : 'manual';
      job.endedAt = Date.now();
      for (let k = i + 1; k < job.steps.length; k++) job.steps[k].status = 'blocked';
      if (st.hint) ctx.log('下一步：' + st.hint, 'warn');
      ctx.log(job.status === 'failed' ? '安装中断：这一步没过去，后面的步骤没有执行。' : '需要你手动做一件事，做完再点一次安装即可继续。', 'warn');
      saveJob(job);
      emit(job.status === 'failed' ? 'fail' : 'manual', job);
      return job;
    }
  }

  job.status = 'done';
  job.endedAt = Date.now();
  ctx.log('全部步骤完成 ✓');
  saveJob(job);
  emit('done', job);
  return job;
}

/* ---------- CLI ---------- */
const __isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (__isCli) {
  const [cmd, target, ...rest] = process.argv.slice(2);
  const params = {};
  for (const a of rest) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) params[m[1]] = m[2];
  }
  if (!cmd || cmd === 'list') {
    const ids = recipeIds();
    console.log('可用的安装脚本：');
    for (const id of ids) {
      const r = await loadRecipe(id).catch(() => null);
      console.log(`  ${id.padEnd(12)} ${r ? r.title : ''}`);
    }
    process.exit(0);
  }
  if (cmd === 'run') {
    if (!target) { console.error('用法：node scripts/installer.mjs run <id> [--k=v]'); process.exit(1); }
    const job = await runInstall(target, {
      params,
      onEvent: (type, p) => {
        if (type === 'log') console.log((p.level === 'err' ? '  ✗ ' : p.level === 'cmd' ? '    ' : '  · ') + p.msg);
        if (type === 'step') console.log(`[${p.status}] ${p.key}${p.detail ? ' — ' + p.detail : ''}`);
        if (type === 'done') console.log('\n完成 ✓');
        if (type === 'fail') console.log('\n失败 ✗ ' + (p.steps.find((s) => s.status === 'fail') || {}).hint);
        if (type === 'manual') console.log('\n需要人工：' + (p.steps.find((s) => s.status === 'manual') || {}).hint);
      },
    });
    process.exit(job.status === 'done' ? 0 : 1);
  }
  console.error('未知命令：' + cmd);
  process.exit(1);
}
