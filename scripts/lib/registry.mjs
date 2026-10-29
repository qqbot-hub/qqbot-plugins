/* ============================================================
 * registry.mjs —— 插件上架登记：提交 → 审核 → 落地 → 版本
 *
 * 先说清楚这个东西的边界，别把它当成 npm 那套：
 *   这里是**单机/小团队**的登记流程，没有多用户、没有身份认证、
 *   没有防恶意提交。它的作用是：
 *     1) 把「谁在什么版本改了什么」记下来，而不是靠记忆；
 *     2) 审核这一步拦的是**明显不合格**的东西（缺字段、版本号乱写、
 *        声明了 exec 却没说明），不是在审人；
 *     3) 通过后把代码真正落到 plugins/<id>.mjs 并进市场，形成闭环。
 *   多租户、签名、防投毒是另一套工程，当前没有，也不假装有。
 *
 * 审核通过时做的事（有代码才会做）：
 *   1) 语法检查（真跑 node --check，不是正则猜）
 *   2) 写 plugins/<id>.mjs
 *   3) 在 data/catalog/plugins.json 里登记
 *   4) 重建权限表（scripts/build-permissions.mjs）
 * 所以「审核通过」= 这个插件真的能装能用了，不是一个状态字段。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT, DATA } from './paths.mjs';
import { parseVer } from './version.mjs';

/* 路径可用环境变量覆盖 —— 测试要在临时目录里跑完整「提交→审核→落盘」，
 * 不能把测试插件写进真实的 plugins/。生产不设这些变量，行为完全一样。 */
function envPath(key, def) {
  const v = process.env[key];
  return v ? path.resolve(v) : def;
}
const FILE = envPath('QQBOT_REGISTRY_FILE', path.join(DATA, 'state', 'registry.json'));
const PLUGINS_JSON = envPath('QQBOT_PLUGINS_JSON', path.join(DATA, 'catalog', 'plugins.json'));
const PLUGIN_DIR = envPath('QQBOT_PLUGIN_DIR', path.join(ROOT, 'plugins'));
const SKIP_PERM = process.env.QQBOT_SKIP_PERM === '1';
const MAX_CODE = 200 * 1024;          /* 单文件 200KB，超过说明这不该是一份插件 */

function load() {
  try {
    const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(doc.submissions)) return doc;
  } catch { /* 首次运行 */ }
  return { submissions: [] };
}

function save(doc) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n');
}

function nowIso() {
  return new Date().toISOString();
}

/** 插件 id：只允许小写字母开头，避免和现有插件/文件系统打架 */
export const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** 校验提交内容；返回 { ok, errors[], manifest } */
export function validate(input) {
  const errs = [];
  const m = {
    pluginId: String(input.pluginId || '').trim(),
    name: String(input.name || '').trim().slice(0, 40),
    version: String(input.version || '').trim(),
    author: String(input.author || '').trim().slice(0, 40),
    description: String(input.description || '').trim().slice(0, 300),
    category: String(input.category || '工具').trim().slice(0, 12),
    homepage: String(input.homepage || '').trim().slice(0, 300),
    changelog: String(input.changelog || '').trim().slice(0, 1000),
    permissions: Array.isArray(input.permissions) ? input.permissions.filter((x) => typeof x === 'string').slice(0, 12) : [],
    code: typeof input.code === 'string' ? input.code : '',
    overwrite: !!input.overwrite,
  };
  if (!ID_RE.test(m.pluginId)) errs.push('插件 id 只能用小写字母开头，含小写字母/数字/短横线，2~32 位');
  if (!m.name) errs.push('缺少名称');
  if (!m.author) errs.push('缺少作者');
  if (!m.description) errs.push('缺少简介（审核时靠它判断这插件干什么）');
  if (!m.version) errs.push('缺少版本号');
  else if (!parseVer(m.version) || !/^\d+\.\d+\.\d+/.test(m.version.replace(/^v/i, ''))) {
    errs.push('版本号要写成 1.0.0 这种三段式（semver）');
  }
  if (m.homepage && !/^https?:\/\//.test(m.homepage)) errs.push('仓库地址要以 http(s):// 开头');
  if (m.code && m.code.length > MAX_CODE) errs.push(`代码太大（${Math.round(m.code.length / 1024)}KB > 200KB）`);
  /* 声明了敏感能力却一个字没提，审核时必须补说明 */
  const risky = m.permissions.filter((p) => ['exec', 'file:write', 'message:send'].includes(p));
  if (risky.length && m.description.length < 20) {
    errs.push('声明了 ' + risky.join('/') + ' 这类敏感能力，简介要写清楚用途（至少 20 字）');
  }
  return { ok: !errs.length, errors: errs, manifest: m };
}

/** 语法检查：真写临时文件跑 node --check（ESM 不能靠 new Function） */
function syntaxCheck(code) {
  const tmp = path.join(os.tmpdir(), 'qqbot-submit-' + process.pid + '-' + Date.now() + '.mjs');
  try {
    fs.writeFileSync(tmp, code);
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe', timeout: 20000 });
    return { ok: true };
  } catch (e) {
    const msg = String((e.stderr && e.stderr.toString()) || e.message || '');
    return { ok: false, error: msg.split(/\r?\n/).filter(Boolean).slice(-3).join(' / ').slice(0, 300) };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件删不掉不影响结论 */ }
  }
}

/** 提交一条（同一 id 重复提交 = 新版本，进版本历史） */
export function submit(input) {
  const v = validate(input);
  if (!v.ok) return { ok: false, errors: v.errors };
  const m = v.manifest;

  /* 有代码就先验语法：让"审核通过"这一步不必替作者修代码 */
  let syntax = { ok: true };
  if (m.code) {
    syntax = syntaxCheck(m.code);
    if (!syntax.ok) return { ok: false, errors: ['代码语法检查没过：' + syntax.error] };
  }

  const doc = load();
  const exists = doc.submissions.some((s) => s.pluginId === m.pluginId && s.version === m.version);
  if (exists) return { ok: false, errors: [`${m.pluginId}@${m.version} 已经提交过了；改版本号再提交`] };

  const approvedBefore = doc.submissions.filter((s) => s.pluginId === m.pluginId && s.status === 'approved');
  const sub = {
    id: 'sub-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    pluginId: m.pluginId,
    name: m.name,
    version: m.version.replace(/^v/i, ''),
    author: m.author,
    description: m.description,
    category: m.category,
    homepage: m.homepage,
    changelog: m.changelog,
    permissions: m.permissions,
    hasCode: !!m.code,
    code: m.code,
    overwrite: m.overwrite,
    status: 'pending',
    submittedAt: nowIso(),
    reviewedAt: '',
    reviewNote: '',
    /* 第一次提交就是 1.0.0 起步；后续按顺序标出这是第几个版本 */
    isUpdateOf: approvedBefore.length ? approvedBefore[approvedBefore.length - 1].version : '',
  };
  doc.submissions.push(sub);
  save(doc);
  return {
    ok: true,
    id: sub.id,
    status: sub.status,
    detail: `已提交 ${m.pluginId}@${sub.version}${sub.isUpdateOf ? `（更新自 v${sub.isUpdateOf}）` : ''}，等审核`,
  };
}

export function list(filter) {
  const doc = load();
  let items = doc.submissions;
  const st = String((filter && filter.status) || '').trim();
  if (st) items = items.filter((s) => s.status === st);
  const pid = String((filter && filter.pluginId) || '').trim();
  if (pid) items = items.filter((s) => s.pluginId === pid);
  /* 最新的在前 */
  items = items.slice().sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
  return {
    total: doc.submissions.length,
    counts: {
      pending: doc.submissions.filter((s) => s.status === 'pending').length,
      approved: doc.submissions.filter((s) => s.status === 'approved').length,
      rejected: doc.submissions.filter((s) => s.status === 'rejected').length,
    },
    items: items.map((s) => {
      /* 列表里不返回代码正文：几百 KB 的代码塞进列表会拖死页面 */
      const { code, ...rest } = s;
      return Object.assign(rest, { codeSize: code ? code.length : 0 });
    }),
  };
}

/** 某插件的版本历史（含当前线上版本） */
export function versions(pluginId) {
  const doc = load();
  const list = doc.submissions
    .filter((s) => s.pluginId === pluginId)
    .sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)))
    .map((s) => ({
      version: s.version,
      status: s.status,
      changelog: s.changelog,
      submittedAt: s.submittedAt,
      reviewedAt: s.reviewedAt,
      note: s.reviewNote,
    }));
  const live = list.filter((x) => x.status === 'approved').slice(-1)[0] || null;
  return { pluginId, live: live ? live.version : '', items: list };
}

/** 把通过审核的代码落到 plugins/ 并登记进市场 */
/** 落盘后真读一次模块，把工具名/说明写进市场目录。
 *  以前这里写死 tools: []，结果新插件在市场卡片上显示"0 个工具"，
 *  而 MCP 那边明明能调 —— 页面与实际能力对不上，属于瞎标，所以改成真读。
 *  读不出来（模块加载报错）就是空数组，不编。 */
async function readToolsFromFile(file) {
  try {
    const mod = await import(pathToFileURL(file).href + '?pub=' + Date.now());
    const def = mod.default || {};
    const list = Array.isArray(def.tools) ? def.tools : (Array.isArray(mod.tools) ? mod.tools : []);
    return list.map((t) => ({ name: String(t.name || ''), description: String(t.description || '') })).filter((t) => t.name);
  } catch {
    return [];
  }
}

async function publishToCatalog(sub) {
  if (!sub.hasCode || !sub.code) {
    return { ok: true, deployed: false, detail: '没有提交代码，只登记状态；市场里不会出现这个插件' };
  }
  const file = path.join(PLUGIN_DIR, sub.pluginId + '.mjs');
  if (fs.existsSync(file) && !sub.overwrite) {
    return {
      ok: false,
      error: `plugins/${sub.pluginId}.mjs 已存在。如果这次是覆盖更新，提交时勾选「允许覆盖」，或者换个 id`,
    };
  }
  const chk = syntaxCheck(sub.code);
  if (!chk.ok) return { ok: false, error: '语法检查没过：' + chk.error };
  fs.writeFileSync(file, sub.code);

  /* 进市场目录 */
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(PLUGINS_JSON, 'utf8')); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = arr.plugins || [];
  const entry = {
    id: sub.pluginId,
    name: sub.name,
    description: sub.description,
    category: sub.category,
    tools: await readToolsFromFile(file),
    source: { label: `${sub.author} 提交 · v${sub.version}`, url: sub.homepage || '' },
    origin: 'submitted',
    version: sub.version,
    author: sub.author,
  };
  const i = arr.findIndex((p) => p.id === sub.pluginId);
  if (i >= 0) arr[i] = Object.assign({}, arr[i], entry);
  else arr.push(entry);
  fs.writeFileSync(PLUGINS_JSON, JSON.stringify(arr, null, 2) + '\n');

  /* 重建权限表：不重建的话新插件在市场里没有权限 chip，等于绕过二次确认 */
  let permOk = true;
  let permMsg = '';
  if (!SKIP_PERM) {
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-permissions.mjs')], { stdio: 'pipe', timeout: 60000 });
    } catch (e) {
      permOk = false;
      permMsg = String((e.stderr && e.stderr.toString()) || e.message).slice(0, 200);
    }
  }
  return {
    ok: true,
    deployed: true,
    detail: `已写入 plugins/${sub.pluginId}.mjs 并登记进市场`
      + (permOk ? '，权限表已重建' : '；但权限表重建失败：' + permMsg),
  };
}

/** 审核：approve 会真的落地代码；reject 只记原因。
 *  异步是因为落地后要真读一次模块把工具列表填进市场目录。 */
export async function review(id, action, note) {
  const doc = load();
  const sub = doc.submissions.find((s) => s.id === id);
  if (!sub) return { ok: false, error: '没有这条提交' };
  if (sub.status !== 'pending') return { ok: false, error: `这条已经是「${sub.status}」，不能重复审核` };
  const act = String(action || '');
  if (!['approve', 'reject'].includes(act)) return { ok: false, error: 'action 只能是 approve 或 reject' };

  if (act === 'reject') {
    /* 拒绝必须写原因：作者拿到的只有这一句话，写"不通过"等于没说。
     * 以前空着也能提交，默认塞一句"（没有写原因）"，那是在帮审核偷懒。 */
    const why = String(note || '').trim();
    if (why.length < 4) return { ok: false, error: '拒绝要写清楚原因（至少 4 个字），作者要靠它改' };
    sub.status = 'rejected';
    sub.reviewedAt = nowIso();
    sub.reviewNote = why.slice(0, 500);
    save(doc);
    return { ok: true, status: 'rejected', detail: '已拒绝，原因已记录（作者能看到）' };
  }

  /* 通过：先落地，落地失败就不改状态 —— 否则会出现"显示已上架但市场里没有" */
  const pub = await publishToCatalog(sub);
  if (!pub.ok) return { ok: false, error: pub.error, hint: '修好再点通过，或者先改成拒绝并写明原因' };
  sub.status = 'approved';
  sub.reviewedAt = nowIso();
  sub.reviewNote = String(note || '').slice(0, 500);
  sub.deployed = !!pub.deployed;
  save(doc);
  return { ok: true, status: 'approved', deployed: !!pub.deployed, detail: pub.detail };
}

/** 给页面顶部用的概览 */
export function stats() {
  const doc = load();
  const pending = doc.submissions.filter((s) => s.status === 'pending').length;
  const approvedIds = new Set(doc.submissions.filter((s) => s.status === 'approved').map((s) => s.pluginId));
  return {
    total: doc.submissions.length,
    pending,
    approved: doc.submissions.filter((s) => s.status === 'approved').length,
    rejected: doc.submissions.filter((s) => s.status === 'rejected').length,
    plugins: approvedIds.size,
  };
}

/** 取单条（含代码），给详情弹窗用 */
export function get(id) {
  const doc = load();
  return doc.submissions.find((s) => s.id === id) || null;
}
