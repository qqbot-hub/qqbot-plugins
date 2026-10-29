/* ============================================================
 * sandbox.mjs —— 插件运行时沙箱（父进程侧）
 *
 * 做两件事：
 *   1. 把插件代码放进独立子进程，用 Node 的权限模型（--permission）压住能力：
 *      默认读得到插件代码，但写不了任何文件、起不了子进程、开不了 worker。
 *      插件在 meta.permissions 里声明了 exec，才放开 --allow-child-process。
 *   2. 插件需要的宿主能力（发消息、调 OneBot、写自己的数据）全部回到父进程执行，
 *      父进程按 pluginId 校验后再动，插件进程本身没有任何写盘能力。
 *
 * 隔离边界说清楚：
 *   - 文件写入 / 子进程 / worker 是内核层面的 permission model 拒绝，插件绕不过去
 *   - 网络不在这套模型里（Node 的 permission 目前不管 net），属代码层拦截，不是硬边界
 *   - 每次调用起一个短命进程（约 60~120ms），换来的是崩溃/死循环不外溢
 * ============================================================ */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT = 20000;
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export const SANDBOX_RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sandbox-runner.mjs');

/** 这个插件声明了哪些能力（meta.permissions，注册表提交的插件会用） */
export function permissionsOf(metaOrDef = {}) {
  const p = metaOrDef.permissions || (metaOrDef.meta && metaOrDef.meta.permissions) || [];
  return Array.isArray(p) ? p.map(String) : [];
}

/** 权限的权威来源：build-permissions.mjs 扫真实代码生成的 data/catalog/permissions.json。
 *  手写声明会跟代码漂移，这份是扫出来的，所以以它为准。 */
export function permsFromCatalog(hubRoot, pluginId) {
  try {
    const f = path.join(hubRoot, 'data', 'catalog', 'permissions.json');
    const p = JSON.parse(fs.readFileSync(f, 'utf8'));
    const rec = (p.plugins || {})[pluginId];
    if (!rec) return [];
    return (rec.permissions || []).map((x) => (typeof x === 'string' ? x : x && x.key)).filter(Boolean);
  } catch {
    return [];   // 读不到就按「什么都没声明」处理，权限只会更少不会更多
  }
}

/** catalog 扫描结果 + 插件自声明，取并集 */
export function permsFor(hubRoot, pluginId, metaOrDef) {
  return [...new Set([...permsFromCatalog(hubRoot, pluginId), ...permissionsOf(metaOrDef || {})])];
}

/** 按声明拼启动参数。没声明就什么都不给。 */
export function permissionArgs(hubRoot, perms = []) {
  const args = ['--permission'];
  /* 只读：插件自己的代码目录 + 共享库。故意不含 data/ 和 config.json，
   * 插件拿不到配置里的密钥密文，也读不到别的插件存的数据。 */
  args.push('--allow-fs-read=' + path.join(hubRoot, 'plugins'));
  args.push('--allow-fs-read=' + path.join(hubRoot, 'scripts', 'lib'));
  /* 执行器自己也得能读，否则子进程起不来（测试会用临时 hubRoot，所以这里单独放行） */
  args.push('--allow-fs-read=' + path.dirname(SANDBOX_RUNNER));
  if (perms.includes('exec')) args.push('--allow-child-process');
  return args;
}

/** 插件数据目录。认 QQBOT_STORE，和 _lib.mjs 的 STORE_DIR 保持一致 ——
 *  自动化测试靠它把数据重定向到临时目录，否则回归会写脏真实数据。 */
function storeDir(hubRoot, pluginId) {
  const base = process.env.QQBOT_STORE
    ? path.resolve(process.env.QQBOT_STORE)
    : path.join(hubRoot, 'data', 'store');
  return path.join(base, pluginId);
}

/** 读该插件的数据（很小，直接随任务传进子进程） */
export function readStore(hubRoot, pluginId) {
  if (!PLUGIN_ID_RE.test(pluginId)) return {};
  const dir = storeDir(hubRoot, pluginId);
  const bag = {};
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return { [pluginId]: bag }; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      bag[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch { /* 坏文件跳过，不让一条坏数据毁掉整个插件 */ }
  }
  return { [pluginId]: bag };
}

/** 把子进程回传的数据落盘。只写/data/store/<该插件>/，别的路径一律拒绝。 */
export function writeStore(hubRoot, pluginId, store) {
  if (!PLUGIN_ID_RE.test(pluginId)) throw new Error('非法的插件 id: ' + pluginId);
  const bag = (store && store[pluginId]) || {};
  const dir = storeDir(hubRoot, pluginId);
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set();
  for (const [name, value] of Object.entries(bag)) {
    const safe = String(name).replace(/[\\/:*?"<>|]/g, '_');
    const f = path.join(dir, safe + '.json');
    /* 双保险：拼出来的路径必须还在这个插件的目录里 */
    if (path.dirname(path.resolve(f)) !== path.resolve(dir)) continue;
    if (value === undefined || value === null) continue;
    fs.writeFileSync(f, JSON.stringify(value, null, 2));
    keep.add(safe + '.json');
  }
  /* 内存里被 set(null) 清掉的键，对应文件也删掉 */
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json') && !keep.has(f)) fs.unlinkSync(path.join(dir, f));
    }
  } catch { /* 删不掉就算了，不影响本次结果 */ }
  return Object.keys(bag).length;
}

/** 父进程的 NODE_OPTIONS 可能带着 --require=xxx 把外部脚本注进每个 node 进程，
 *  沙箱里读不到那个文件就会直接 ERR_ACCESS_DENIED 起不来（本机就撞到了这个：
 *  --require=.../node-language-shim.cjs）。只剔除这类注入项，其他选项保留。 */
export function cleanNodeOptions(v = '') {
  return String(v)
    .replace(/--(?:require|import|loader)(?:=|\s+)("[^"]*"|\S+)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 子进程环境：继承运行所需，但把可能带密钥的变量抹掉。
 *  密钥文件在 data/ 里已经读不到了（不在 allow 列表），env 这条路也得堵上，
 *  否则插件可以先读密文再自己解密。 */
export function childEnv() {
  const env = { ...process.env, QQBOT_SANDBOX: '1', NODE_OPTIONS: cleanNodeOptions(process.env.NODE_OPTIONS) };
  for (const k of Object.keys(env)) {
    if (/SECRET|PASSPHRASE|TOKEN|PASSWORD|APIKEY|API_KEY|CREDENTIAL/i.test(k)) delete env[k];
  }
  return env;
}

/** 交给子进程的配置副本：去掉 secrets 段（插件本来也用不到 token） */
export function sanitizeConfig(config) {
  if (!config || typeof config !== 'object') return {};
  const c = { ...config };
  delete c.secrets;
  return c;
}

/**
 * 在沙箱里跑一次插件调用。
 * @param {object} o
 * @param {string} o.hubRoot      项目根
 * @param {string} o.pluginId     插件 id（决定它能写哪份数据）
 * @param {string} o.pluginFile   插件 .mjs 绝对路径
 * @param {'tool'|'handler'|'fireDue'} o.kind
 * @param {object} o.host         宿主能力：onebot/probe/heartbeat/reply/sendText/log
 * @returns {Promise<{text:string, ms:number, stderr:string}>}
 */
export async function runSandboxed(o) {
  const {
    hubRoot, pluginId, pluginFile, kind = 'tool',
    toolName, handlerId, args = {}, msg,
    cfg = {}, config = {}, permissions = [],
    timeoutMs = DEFAULT_TIMEOUT, host = {},
  } = o;

  if (!PLUGIN_ID_RE.test(pluginId)) throw new Error('非法的插件 id: ' + pluginId);
  if (!fs.existsSync(pluginFile)) throw new Error('插件文件不存在: ' + pluginFile);

  const task = {
    hubRoot,
    pluginId,
    pluginFile,
    kind,
    toolName: toolName || '',
    handlerId: handlerId || '',
    args,
    msg,
    cfg,
    config,
    store: readStore(hubRoot, pluginId),
  };

  const started = Date.now();
  const child = spawn(process.execPath, [
    ...permissionArgs(hubRoot, permissions),
    SANDBOX_RUNNER,
  ], {
    cwd: hubRoot,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: childEnv(),
    windowsHide: true,
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });
  child.stdout.on('data', () => { /* 插件乱打印也不污染父进程 stdout（MCP 协议走 stdout） */ });
  child.on('error', (e) => { stderr += 'spawn 失败: ' + e.message; });

  let settled = false;
  let timer = null;

  const result = await new Promise((resolve, reject) => {
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(v);
    };

    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
      finish(reject, new Error(`插件执行超时（${timeoutMs}ms 未返回），已强杀子进程`));
    }, timeoutMs);

    /* 父进程代办的宿主能力 */
    const callHost = async (fn, a) => {
      if (fn === 'onebot') return host.onebot ? host.onebot(a[0], a[1] || {}) : Promise.reject(new Error('宿主未提供 onebot'));
      if (fn === 'probe') return host.probe ? host.probe() : { ok: false, error: '宿主未提供探测能力' };
      if (fn === 'heartbeat') return host.heartbeat ? host.heartbeat() : { online: false, error: '宿主未提供探测能力' };
      if (fn === 'reply') return host.reply ? host.reply(a[0]) : null;
      if (fn === 'sendText') return host.sendText ? host.sendText(a[0], a[1]) : null;
      if (fn === 'log') { if (host.log) host.log(a[0]); return null; }
      throw new Error('未知的宿主能力: ' + fn);
    };

    child.on('message', async (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.type === 'rpc') {
        try {
          const value = await callHost(m.fn, Array.isArray(m.args) ? m.args : []);
          child.send({ type: 'rpc-result', id: m.id, ok: true, value: value === undefined ? null : value });
        } catch (e) {
          child.send({ type: 'rpc-result', id: m.id, ok: false, error: (e && e.message) || String(e) });
        }
        return;
      }
      if (m.type === 'done') {
        if (m.ok) {
          let saved = 0;
          try { saved = writeStore(hubRoot, pluginId, m.store); }
          catch (e) { stderr += '\n[沙箱] 数据落盘失败: ' + e.message; }
          finish(resolve, { text: String(m.text == null ? '' : m.text), ms: Date.now() - started, stderr, saved });
        } else {
          const err = new Error(m.error || '插件执行失败');
          if (m.code) err.code = m.code;
          err.pluginStack = m.stack || '';
          finish(reject, err);
        }
      }
    });

    child.on('exit', (code, signal) => {
      /* 正常路径是 done 之后进程自己退；走到这里说明还没 done 就没了 */
      const tail = stderr.trim().split('\n').filter(Boolean).slice(-6).join(' | ');
      finish(reject, new Error(
        `插件进程意外退出（code=${code}${signal ? ', signal=' + signal : ''}）` + (tail ? '：' + tail : ''),
      ));
    });

    child.send({ type: 'init', task });
  });

  try { if (!child.killed) child.kill(); } catch { /* 已经退了 */ }
  return result;
}
