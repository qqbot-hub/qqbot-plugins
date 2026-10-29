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
import { redact } from './lib/secrets.mjs';

/* 参数名里带这些词的，一律按密钥处理：不进 jobs.json、不进日志 */
const SECRET_KEY_RE = /(key|token|secret|passwd|password|appsecret)/i;
const scrubParams = (params = {}) => {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = SECRET_KEY_RE.test(k) && String(v || '') ? '***' : v;
  }
  return out;
};
const secretValues = (params = {}) => Object.entries(params)
  .filter(([k, v]) => SECRET_KEY_RE.test(k) && String(v || '').length >= 6)
  .map(([, v]) => String(v));

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

/* 与 exec / portOpen 同一套约定：永不抛错，让调用方自己判断。
 * 之前这里直接 await fetch 且不包 try——目标端口还没起来（ECONNREFUSED）、
 * 网络抖动、DNS 抽风时 fetch 会 reject，异常一路冒到 installer，
 * 把整个任务打成 fail、后续步骤全部 blocked。典型受害场景：
 * 「卸载 → 改配置 → 重启 Koishi → 探测控制台」，刚重启那一刻必然连不上，
 * 本该是「还没起来，继续等」，却被当成致命错误，卸载半途而废。 */
export async function httpGet(url, timeoutMs = 4000) {
  let r;
  try {
    r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'qqbot-plugins-installer' } });
  } catch (e) {
    return { status: 0, ok: false, text: '', json: null, error: String(e && e.message ? e.message : e) };
  }
  let text = '';
  try { text = await r.text(); } catch (e) { /* 读body失败不算致命 */ }
  let json = null;
  try { json = JSON.parse(text); } catch { /* 不是 JSON 就算了 */ }
  return { status: r.status, ok: r.ok, text, json };
}

/** 跑一个命令，边跑边把输出喂给日志；永不抛错，让 recipe 自己判断 */
export function exec(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    /* Windows 的 .cmd/.bat 必须经 cmd.exe 中转：直接 spawn 会 EINVAL（Node 的安全限制） */
    let file = cmd, argv = args;
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(cmd))) {
      file = process.env.ComSpec || 'cmd.exe';
      argv = ['/d', '/s', '/c', cmd, ...args];
    }
    const child = spawn(file, argv, {
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
function makeCtx(job, params, emit, secrets = []) {
  const shared = {};
  const log = (msg, level = 'info') => {
    const line = { t: Date.now(), level, msg: redact(String(msg), secrets) };
    job.logs.push(line);
    if (job.logs.length > LOG_LINES_KEEP) job.logs.splice(0, job.logs.length - LOG_LINES_KEEP);
    emit('log', line);
  };
  return {
    params: params || {},
    state: shared,
    /** 登记"这次部署造出来的东西"，失败时可回滚（进程 / 目录 / compose 项目） */
    record: (artifact) => {
      if (!artifact || !artifact.kind) return;
      job.artifacts.push(Object.assign({ at: Date.now() }, artifact));
    },
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
          stdio: opts.stdio || 'ignore',
          windowsHide: true,
          env: Object.assign({}, process.env, opts.env || {}),
        });
        child.unref();
        log(`已在后台启动：${path.basename(cmd)} ${args.join(' ')}`, 'info');
        if (child.pid) job.artifacts.push({ at: Date.now(), kind: 'pid', value: child.pid, why: path.basename(cmd) });
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
  artifacts: (j.artifacts || []).map((a) => ({ kind: a.kind, value: a.value, why: a.why || '' })),
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
    const job = { id: newId(), target, title: target, status: 'failed', startedAt: Date.now(), endedAt: Date.now(), steps: [], logs: [{ t: Date.now(), level: 'err', msg: e.message }], params: scrubParams(opts.params), artifacts: [] };
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
    /* 密钥类参数进任务记录前先打码：jobs.json 是明文文件 */
    params: scrubParams(opts.params),
    artifacts: [],
    steps: recipe.steps.map((s) => ({ key: s.key, title: s.title, status: 'pending', detail: '', hint: '', ms: 0 })),
    logs: [],
  };
  jobs.set(job.id, job);
  const ctx = makeCtx(job, opts.params, emit, secretValues(opts.params));
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

/* ---------- 回滚 ----------
 * 只撤"这次任务自己造出来的东西"，靠 recipe 里 ctx.record() 与 spawnDetached 自动登记的
 * artifacts 来定位。三条安全边界：
 *   1. 目录/文件只在 runtimes/ 里面才删（防止 recipe 写错路径把用户目录清了）
 *   2. 进程按 pid 杀，杀之前先看进程还在不在
 *   3. compose 用 `down`（保留卷），不用 down -v —— 数据卷里可能是登录态，删了要重扫码
 */
const inRuntimes = (p) => {
  try {
    const abs = path.resolve(String(p || ''));
    const base = path.resolve(RUNTIMES);
    return abs === base || abs.startsWith(base + path.sep);
  } catch { return false; }
};

async function killPid(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, why: 'pid 不合法' };
  if (process.platform === 'win32') {
    const r = await exec('taskkill', ['/PID', String(n), '/T', '/F'], { timeoutMs: 15000 });
    return { ok: r.code === 0, why: String(r.stdout || r.stderr).trim().slice(0, 120) };
  }
  try { process.kill(n, 'SIGTERM'); return { ok: true, why: 'SIGTERM' }; }
  catch (e) { return { ok: false, why: e.message }; }
}

export async function rollbackJob(jobId) {
  const job = jobs.get(jobId) || loadJobHistory().find((j) => j.id === jobId);
  if (!job) return { ok: false, error: '没有这个任务记录' };
  const arts = [...(job.artifacts || [])];
  if (!arts.length) return { ok: false, error: '这次部署没有登记可回滚的东西（可能一步都没执行成功）' };

  const order = { pid: 0, compose: 1, file: 2, dir: 3 };
  arts.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));

  const done = [], failed = [], skipped = [];
  for (const a of arts) {
    if (a.kind === 'pid') {
      const r = await killPid(a.value);
      (r.ok ? done : skipped).push(`结束进程 ${a.value}${a.why ? `（${a.why}）` : ''}${r.ok ? '' : '：' + r.why}`);
    } else if (a.kind === 'compose') {
      const r = await exec('docker', ['compose', '-f', a.value, 'down'], { timeoutMs: 180000 });
      (r.code === 0 ? done : failed).push(`docker compose down ${path.basename(path.dirname(a.value))}`);
    } else if (a.kind === 'dir' || a.kind === 'file') {
      if (!inRuntimes(a.value)) { skipped.push(`跳过 ${a.value}（不在 runtimes/ 内，不删）`); continue; }
      try { fs.rmSync(a.value, { recursive: true, force: true }); done.push(`删除 ${a.value}`); }
      catch (e) { failed.push(`删除 ${a.value} 失败：${e.message}`); }
    } else {
      skipped.push(`不认识的回滚类型 ${a.kind}`);
    }
  }
  try {
    const list = loadJobHistory().map((j) => (j.id === jobId ? Object.assign({}, j, { rolledBackAt: new Date().toISOString() }) : j));
    writeJson('jobs', list);
  } catch { /* 记录写不进去不影响回滚本身 */ }
  return { ok: failed.length === 0, done, failed, skipped };
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
  if (cmd === 'rollback') {
    if (!target) { console.error('用法：node scripts/installer.mjs rollback <jobId>'); process.exit(1); }
    const r = await rollbackJob(target);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
  console.error('未知命令：' + cmd);
  process.exit(1);
}
