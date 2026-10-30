/* ============================================================
 * sandbox-runner.mjs —— 沙箱子进程里的执行器（不直接运行，由 sandbox.mjs fork 出来）
 *
 * 跑法：node --permission --allow-fs-read=<plugins> ... sandbox-runner.mjs
 * 父进程 fork 后先 send({ type:'init', task })，这里加载插件、执行一次、把结果 send 回去，然后退出。
 *
 * 为什么要单独一个进程：
 *   现在的插件代码和市场进程同生共死，一个插件死循环或写错文件就能拖垮整个市场。
 *   挪进子进程 + Node 的 --permission，文件写入、起子进程这些能力就由内核层面的
 *   权限模型直接拒绝（ERR_ACCESS_DENIED），不再是「代码里说好了不许」。
 *
 * 子进程里没有任何写权限，插件要存数据怎么办：
 *   _lib.mjs 的 storage() 检测到 __QQBOT_SANDBOX__ 就切到内存实现，结束时把脏数据
 *   回传父进程，父进程校验 pluginId 之后才落盘。插件代码一行都不用改。
 * ============================================================ */
'use strict';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* ---------- 与父进程的 RPC ---------- */
let seq = 0;
const pending = new Map();

function rpc(fn, args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    try {
      process.send({ type: 'rpc', id, fn, args });
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

process.on('message', (m) => {
  if (!m || m.type !== 'rpc-result') return;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve(m.value);
  else p.reject(Object.assign(new Error(m.error || '宿主调用失败'),{retcode:m.retcode}));
});

/* ---------- 内存版 storage（写盘交给父进程） ---------- */
const safeName = (n) => String(n).replace(/[\\/:*?"<>|]/g, '_');

function makeSandboxStorage(task) {
  const bags = task.store || {};
  const dirty = new Set();

  return {
    dirtyKeys: () => [...dirty],
    snapshot() {
      const pluginId = task.pluginId;
      const out = {};
      if (bags[pluginId]) out[pluginId] = bags[pluginId];
      return out;
    },
    storage(pluginId) {
      /* 一个插件只能碰自己的数据。防止插件 A 借沙箱读插件 B 的备忘/积分。 */
      if (String(pluginId) !== String(task.pluginId)) {
        throw new Error(`沙箱拒绝：${task.pluginId} 的进程不能访问 ${pluginId} 的数据`);
      }
      const bag = bags[pluginId] || (bags[pluginId] = {});
      return {
        get(name, fallback) {
          const k = safeName(name);
          return Object.prototype.hasOwnProperty.call(bag, k) ? bag[k] : fallback;
        },
        set(name, value) {
          const k = safeName(name);
          if (value === undefined || value === null) delete bag[k];
          else bag[k] = value;
          dirty.add(k);
          return value;
        },
        update(name, fallback, fn) {
          const cur = this.get(name, fallback);
          return this.set(name, fn(cur) ?? cur);
        },
      };
    },
  };
}

/* ---------- 执行一次任务 ---------- */
let bridgeMod = null;
async function bridgeOf(task) {
  if (!bridgeMod) {
    const f = pathToFileURL(path.join(task.hubRoot, 'plugins', '_bridge.mjs')).href;
    bridgeMod = await import(f);
  }
  return bridgeMod;
}

async function runTask(task) {
  const sandbox = makeSandboxStorage(task);
  globalThis.__QQBOT_SANDBOX__ = sandbox;

  const mod = await import(pathToFileURL(path.resolve(task.pluginFile)).href + `?run=${Date.now()}`);
  const def = mod.default || {};

  if (task.kind === 'tool') {
    const tool = (def.tools || []).find((t) => t.name === task.toolName);
    if (!tool) throw new Error(`插件 ${task.pluginId} 里没有工具 ${task.toolName}`);

    const remoteOnebot = (action, params) => rpc('onebot', [action, params || {}]);
    const { wrapOnebot } = await bridgeOf(task);
    const bridge = wrapOnebot(remoteOnebot, {
      probe: () => rpc('probe', []),
      heartbeat: () => rpc('heartbeat', []),
    });
    const ctx = {
      localMusic: args=>rpc('localMusic',[args]),
      onebot: remoteOnebot,
      bridge,
      config: task.config || {},
      cfg: task.cfg || {},
    };
    const out = await tool.run(task.args || {}, ctx);
    return String(out == null ? '' : out);
  }

  if (task.kind === 'handler') {
    const h = (def.handlers || []).find((x) => (x.id || '') === (task.handlerId || ''));
    if (!h) throw new Error(`插件 ${task.pluginId} 里没有 handler ${task.handlerId}`);

    const api = {
      reply: (text) => rpc('reply', [String(text)]),
      sendText: (to, text) => rpc('sendText', [to, String(text)]),
      cfg: task.cfg || {},
      log: (m) => { rpc('log', [String(m)]).catch(() => {}); },
    };
    await h.run(task.msg || {}, api);
    return '';
  }

  if (task.kind === 'fireDue') {
    const due = def.fireDue || mod.fireDue;
    if (typeof due !== 'function') return '';
    const remoteOnebot = (action, params) => rpc('onebot', [action, params || {}]);
    const { wrapOnebot } = await bridgeOf(task);
    await due({ onebot: remoteOnebot, bridge: wrapOnebot(remoteOnebot), config: task.config || {}, cfg: task.cfg || {} });
    return '';
  }

  throw new Error('未知任务类型: ' + task.kind);
}

process.on('message', async (m) => {
  if (!m || m.type !== 'init') return;
  try {
    const text = await runTask(m.task);
    const sandbox = globalThis.__QQBOT_SANDBOX__;
    process.send({ type: 'done', ok: true, text, store: sandbox.snapshot(), dirty: sandbox.dirtyKeys() });
  } catch (e) {
    process.send({
      type: 'done',
      ok: false,
      error: (e && e.message) ? e.message : String(e),
      code: (e && e.code) || '',
      stack: (e && e.stack) ? String(e.stack).slice(0, 800) : '',
    });
  }
});
