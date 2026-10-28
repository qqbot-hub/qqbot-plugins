/* ============================================================
 * methods.mjs —— 部署方法清单 + 本机能力探测 + 兼容性矩阵
 *
 * 这一层解决的问题：不要对所有部署方法都摆一个「一键部署」按钮然后点了报错。
 * 每条方法先问三个问题，答案决定前端给什么：
 *   1. 它需要什么（Node / Python / Docker / 桌面 QQ / 外置 Redis、Mongo）—— 本机有没有
 *   2. 它的自动化程度到哪（oneclick / compose / assisted / guide）—— 有脚本就真跑脚本，
 *      只有步骤就只给步骤，不假装
 *   3. 它能不能承载本市场的统一插件 —— 取决于宿主是不是 DSH、插件要不要 OneBot 动作
 *
 * 兼容性矩阵的口径（重要，别改成"全兼容"）：
 *   · 本市场 46 个插件是零依赖 .mjs，跑在市场的 MCP 进程里，只对 **DSH 宿主** 有效；
 *   · 其中凡是调用协议端动作（发消息/禁言/公告…）的，还要求该方法讲 OneBot v11；
 *   · AstrBot / Koishi / NoneBot / Yunzai / MaiBot / NcatBot 的原生插件，只在各自框架内可用，
 *     矩阵里如实标 native，跨框架一律 no —— 跨框架要靠 Phase 2 的适配层，现在没有就是没有。
 * ============================================================ */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT } from './paths.mjs';

const METHODS_FILE = path.join(ROOT, 'data', 'catalog', 'methods.json');

export const LEVEL_LABEL = {
  oneclick: '可一键部署',
  compose: 'Compose 部署',
  assisted: '半自动',
  guide: '仅步骤指引',
};

export const PLUGIN_APIS = {
  'mcp-dsh': { label: '本市场统一插件（MCP / DSH）', cross: true },
  astrbot: { label: 'AstrBot 原生插件' },
  koishi: { label: 'Koishi 原生插件' },
  nonebot: { label: 'NoneBot2 原生插件' },
  yunzai: { label: 'Yunzai 原生插件' },
  maibot: { label: 'MaiBot 原生插件' },
  ncatbot: { label: 'NcatBot 原生插件' },
};

export function loadMethods() {
  try {
    const doc = JSON.parse(fs.readFileSync(METHODS_FILE, 'utf8'));
    return Array.isArray(doc.methods) ? doc.methods : [];
  } catch {
    return [];
  }
}

export function getMethod(id) {
  return loadMethods().find((m) => m.id === id) || null;
}

/* ---------- 本机能力探测（带缓存，别每次请求都起进程） ---------- */
const run = (cmd, args) => new Promise((resolve) => {
  try {
    execFile(cmd, args, { timeout: 4000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, text: String(stdout || '') + String(stderr || '') });
    });
  } catch (e) { resolve({ ok: false, text: String(e.message || '') }); }
});
const ver = (s) => (String(s).match(/(\d+\.\d+(\.\d+)?)/) || [])[1] || '';

let runtimeCache = { at: 0, value: null };
export async function probeRuntime(force = false) {
  if (!force && runtimeCache.value && Date.now() - runtimeCache.at < 60000) return runtimeCache.value;

  const [py, py3, docker, compose] = await Promise.all([
    run('python', ['--version']),
    run('py', ['-3', '--version']),
    run('docker', ['--version']),
    run('docker', ['compose', 'version']),
  ]);
  const nodeVer = process.versions.node;
  const python = py.ok ? py.text : (py3.ok ? py3.text : '');
  const value = {
    node: { ok: true, version: nodeVer, major: Number(nodeVer.split('.')[0]) },
    python: { ok: !!python, version: ver(python), raw: python.trim() },
    docker: {
      ok: docker.ok,
      version: ver(docker.text),
      compose: compose.ok,
      raw: (docker.text || '').trim().slice(0, 120),
    },
    os: process.platform,
  };
  runtimeCache = { at: Date.now(), value };
  return value;
}

/* ---------- 方法可用性：缺什么就明说 ---------- */
export function methodRequirements(m) {
  const rt = m.runtime || {};
  const need = [];
  if (rt.node) need.push({ key: 'node', label: `Node.js ${rt.node}` });
  if (rt.python) need.push({ key: 'python', label: `Python ${rt.python}` });
  if (rt.docker) need.push({ key: 'docker', label: 'Docker + Compose v2' });
  if (rt.redis) need.push({ key: 'redis', label: 'Redis' });
  if (rt.mongo) need.push({ key: 'mongo', label: 'MongoDB' });
  if (m.needsDesktopQQ) need.push({ key: 'qqnt', label: '桌面 QQ（QQNT）' });
  return need;
}

/** 把「需要什么」和「本机有没有」对上，得到 missing 列表 */
export function evaluate(m, rt) {
  const missing = [];
  const r = m.runtime || {};
  if (r.node) {
    const min = Number(String(r.node).replace(/[^\d.]/g, '').split('.')[0] || 0);
    if (!rt.node.ok || rt.node.major < min) missing.push(`Node.js ${r.node}`);
  }
  if (r.python && !rt.python.ok) missing.push(`Python ${r.python}`);
  if (r.docker && !(rt.docker.ok && rt.docker.compose)) missing.push('Docker + Compose v2');
  if (r.redis) missing.push('Redis（本机未检测，按你的实际安装为准）');
  if (r.mongo) missing.push('MongoDB（本机未检测，按你的实际安装为准）');
  /* 桌面 QQ 只做提示，不当作 missing：脚本无法可靠判断 QQ 是否装了 */
  const level = (m.deploy && m.deploy.level) || 'guide';
  const verified = !!(m.deploy && m.deploy.verified);
  return {
    level,
    levelLabel: LEVEL_LABEL[level] || level,
    ready: missing.length === 0,
    missing,
    verified,
    verifiedNote: (m.deploy && m.deploy.verifiedNote) || '',
    requiresDesktopQQ: !!m.needsDesktopQQ,
  };
}

/* ---------- 兼容性矩阵 ---------- */
/**
 * 判断某个插件能不能装在某个方法上。三条硬条件，缺一不可：
 *   1. 该方法能承载本市场插件（pluginApi === 'mcp-dsh'，即宿主是 DSH）
 *   2. 插件要协议端动作时，该方法必须有 OneBot v11
 *   3. 该方法当前可用（依赖齐全）—— 不可用不算兼容，只算"依赖未满足"
 */
export function pluginCompatMethods(plugin, methods) {
  const needsBridge = plugin.needsBridge !== false;   // 没标注的默认按"要用协议端"算，宁严不宽
  const ok = [];
  const reasons = {};
  for (const m of methods) {
    if (m.pluginApi !== 'mcp-dsh') { reasons[m.id] = '宿主不是 DSH，本市场插件跑不了'; continue; }
    const protocols = m.protocols || [];
    if (needsBridge && !protocols.includes('onebot11')) {
      reasons[m.id] = '该插件要调用协议端动作，但这条链路不讲 OneBot v11';
      continue;
    }
    ok.push(m.id);
  }
  return { methods: ok, reasons, needsBridge };
}

export async function buildCompat({ methods } = {}) {
  const list = methods || loadMethods();
  const rt = await probeRuntime();
  const rows = list.map((m) => {
    const ev = evaluate(m, rt);
    return {
      id: m.id,
      name: m.name,
      tagline: m.tagline,
      account: m.account,
      accountNote: m.accountNote,
      os: m.os,
      protocols: m.protocols || [],
      pluginApi: m.pluginApi,
      host: m.host,
      ports: m.ports || [],
      stack: m.stack || [],
      needsDesktopQQ: !!m.needsDesktopQQ,
      qqnt: m.qqnt || null,
      requirements: methodRequirements(m),
      deploy: {
        level: ev.level,
        levelLabel: ev.levelLabel,
        kind: (m.deploy && m.deploy.kind) || 'guide',
        chain: (m.deploy && m.deploy.chain) || [],
        compose: (m.deploy && m.deploy.compose) || '',
        recipe: (m.deploy && m.deploy.recipe) || '',
        manualSteps: (m.deploy && m.deploy.manualSteps) || [],
        verified: ev.verified,
        verifiedNote: ev.verifiedNote,
      },
      keyConfig: (m.keyConfig || []).map((k) => ({
        key: k.key, label: k.label, secret: !!k.secret, required: !!k.required, help: k.help || '',
        /* 只回传"有没有配"，永远不回传值 */
        hasValue: false,
      })),
      risks: m.risks || [],
      links: m.links || [],
      ready: ev.ready,
      missing: ev.missing,
      requiresDesktopQQ: ev.requiresDesktopQQ,
    };
  });

  /* 插件生态 × 方法：native 表示该框架的原生插件能直接装进去 */
  const matrix = {};
  for (const api of Object.keys(PLUGIN_APIS)) {
    matrix[api] = {};
    for (const m of list) {
      matrix[api][m.id] = m.pluginApi === api ? 'native' : 'no';
    }
  }
  /* 本市场统一插件：按"要不要 OneBot 动作"分两行，避免把纯本地工具也说成不能跨协议 */
  matrix['mcp-dsh:bridge'] = {};
  matrix['mcp-dsh:local'] = {};
  for (const m of list) {
    const isDsh = m.pluginApi === 'mcp-dsh';
    matrix['mcp-dsh:bridge'][m.id] = isDsh && (m.protocols || []).includes('onebot11') ? 'native' : 'no';
    matrix['mcp-dsh:local'][m.id] = isDsh ? 'native' : 'no';
  }

  return {
    ok: true,
    runtime: rt,
    generatedAt: new Date().toISOString(),
    levelLabels: LEVEL_LABEL,
    pluginApis: PLUGIN_APIS,
    matrix,
    methods: rows,
  };
}
