import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const HOME = process.env.USERPROFILE || os.homedir();
/* 常见安装位置：先看用户配置里记过的，再按目录名猜（Harness / DSH / DeepSeek） */
function candidateDirs() {
  const bases = [
    path.join(HOME, 'AppData', 'Local', 'Programs'),
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    path.join(HOME, 'AppData', 'Local'),
  ];
  for (const d of ['C:', 'D:', 'E:']) {
    try {
      if (fs.existsSync(d + '\\')) bases.push(d + '\\');
    } catch { /* 没这个盘 */ }
  }
  return bases;
}

/* 在候选目录里找 DSH 可执行文件（深度最多 2 层，只看名字像的目录，避免全盘扫描） */
export function findDshExe(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  const hits = [];
  for (const base of candidateDirs()) {
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch { continue; }
    for (const ent of entries.slice(0, 400)) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(base, ent.name);
      const lower = ent.name.toLowerCase();
      const looksLike = /harness|dsh|deepseek/.test(lower);
      if (!looksLike) continue;
      /* 一、目录本身就有 exe */
      try {
        for (const f of fs.readdirSync(dir)) {
          if (/\.exe$/i.test(f) && /harness/i.test(f) && !/uninstall/i.test(f)) hits.push(path.join(dir, f));
        }
      } catch { /* 没权限 */ }
      /* 二、往下一层（Electron 程序常见 <安装目录>/app/ 结构） */
      let subs = [];
      try { subs = fs.readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory()); } catch { /* 略 */ }
      for (const sub of subs.slice(0, 30)) {
        const d2 = path.join(dir, sub.name);
        try {
          for (const f of fs.readdirSync(d2)) {
            if (/\.exe$/i.test(f) && /harness/i.test(f) && !/uninstall/i.test(f)) hits.push(path.join(d2, f));
          }
        } catch { /* 略 */ }
      }
    }
  }
  /* 也认 PATH 里的 dsh 命令 */
  for (const p of String(process.env.PATH || '').split(path.delimiter)) {
    const guess = path.join(p, 'DeepSeek Harness.exe');
    try { if (fs.existsSync(guess)) hits.push(guess); } catch { /* 略 */ }
  }
  return hits[0] || '';
}

/* 给一个端口发个 GET，按响应指纹判断它是什么端口：
 * web = DSH 的网页端（401 且提示 "dsh web"）
 * api = OpenAI 兼容网关（401 且提示 api key）
 * http = 有 HTTP 但不认识（也算活着） */
async function probePort(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    const body = (await r.text().catch(() => '')).slice(0, 400).toLowerCase();
    if (/dsh web|web authentication/.test(body)) return { port, kind: 'web', status: r.status };
    if (/api key|openai|authentication_error/.test(body)) return { port, kind: 'api', status: r.status };
    return { port, kind: 'http', status: r.status };
  } catch (e) {
    const code = (e && e.cause && e.cause.code) || e.code;
    if (code === 'ECONNREFUSED') return null;          // 明确没人听
    /* 超时/被重置：端口开着但不说 HTTP，算它活着但认不出 */
    if (/TIMEOUT|ABORT|ECONNRESET|UND_ERR/.test(String(code || e.name || ''))) return { port, kind: 'raw', status: 0 };
    return null;
  }
}

/* 找出 DSH 进程正在监听的所有端口（Windows 用 netstat + tasklist） */
async function listeningPortsOfDsh(ctx) {
  if (!ctx.isWin) return [];
  const ports = new Set();
  try {
    const tl = await ctx.exec('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'], { timeoutMs: 8000, quiet: true });
    const pids = new Set();
    for (const line of String(tl.stdout || '').split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (m && /harness/i.test(m[1])) pids.add(m[2]);
    }
    if (!pids.size) return [];
    const ns = await ctx.exec('netstat', ['-ano'], { timeoutMs: 12000, quiet: true });
    for (const line of String(ns.stdout || '').split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
      if (m && pids.has(m[2])) ports.add(Number(m[1]));
    }
  } catch { /* 命令不可用就当没发现 */ }
  return [...ports].filter((n) => n > 0 && n < 65536);
}

/* 综合判断 DSH 现状：配置端口 → 进程端口 → 指纹识别 */
export async function discoverDsh(ctx) {
  const cfgDsh = ctx.cfg().dsh || {};
  const tried = new Set();
  const found = { running: false, webPort: 0, apiPort: 0, ports: [], exe: cfgDsh.exe || '' };
  const consider = async (port) => {
    if (!port || tried.has(port)) return;
    tried.add(port);
    const r = await probePort(port);
    if (!r || !['web', 'api'].includes(r.kind)) return;
    found.running = true;
    found.ports.push(r);
    if (r.kind === 'web' && !found.webPort) found.webPort = port;
    if (r.kind === 'api' && !found.apiPort) found.apiPort = port;
  };
  /* 1) 配置里记过的端口（可能仍有效） */
  const cfgPort = Number((String(cfgDsh.baseUrl || '').match(/:(\d+)/) || [])[1] || 0);
  if (cfgPort) await consider(cfgPort);
  /* 2) 3080 这个老默认值 */
  if (!found.webPort) await consider(3080);
  /* 3) 按进程找真实端口（DSH 端口是动态的，写死的常量靠不住） */
  if (!found.webPort) {
    const ports = await listeningPortsOfDsh(ctx);
    for (const p of ports) { if (found.webPort && found.apiPort) break; await consider(p); }
  }
  return found;
}
