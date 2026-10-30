/* DSH（DeepSeek Harness）：插件宿主
 * 它本身是桌面程序，但进程能被脚本拉起来：先探测端口，没开就去常见安装位置找
 * 「DeepSeek Harness.exe」并后台启动，然后轮询等它响应。
 * 仍然需要人工的只剩「首次登录账号」——这一步任何脚本都替代不了。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const profileFile = (profile) => path.join(process.env.USERPROFILE || os.homedir(), '.dsh', 'profiles', profile, 'cordis.patch.yml');

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
function findDshExe(configured) {
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
async function discoverDsh(ctx) {
  const cfgDsh = ctx.cfg().dsh || {};
  const tried = new Set();
  const found = { running: false, webPort: 0, apiPort: 0, ports: [], exe: cfgDsh.exe || '' };
  const consider = async (port) => {
    if (!port || tried.has(port)) return;
    tried.add(port);
    const r = await probePort(port);
    if (!r) return;
    found.running = true;
    found.ports.push(r);
    if (r.kind === 'web' && !found.webPort) found.webPort = port;
    if (r.kind === 'api' && !found.apiPort) found.apiPort = port;
  };
  /* 1) 配置里记过的端口（可能仍有效） */
  const cfgPort = Number((String(cfgDsh.baseUrl || '').match(/:(\d+)/) || [])[1] || 0);
  if (cfgPort) await consider(cfgPort);
  /* 2) 3080 这个老默认值 */
  if (!found.running) await consider(3080);
  /* 3) 按进程找真实端口（DSH 端口是动态的，写死的常量靠不住） */
  if (!found.running) {
    const ports = await listeningPortsOfDsh(ctx);
    for (const p of ports) { if (found.webPort && found.apiPort) break; await consider(p); }
  }
  return found;
}

export default {
  id: 'dsh',
  title: 'DSH（DeepSeek Harness）',
  kind: 'host',
  steps: [
    {
      key: 'profile',
      title: '检查 DSH 配置目录',
      hint: 'DSH 是桌面程序：装好并启动一次（登录你的账号），它才会生成 ~/.dsh/profiles',
      async run(ctx) {
        const dir = path.join(HOME, '.dsh', 'profiles');
        if (!fs.existsSync(dir)) return { status: 'manual', detail: '还没有 DSH profile，需要先手动启动并登录一次', hint: '打开 DeepSeek Harness 并完成首次登录，确认生成 ~/.dsh/profiles 后，再重新运行部署' };
        const profiles = fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory());
        if (!profiles.length) return { status: 'manual', detail: 'DSH profiles 目录为空，需要先手动启动并登录一次', hint: '打开 DeepSeek Harness 并完成首次登录，确认生成 profile 后，再重新运行部署' };
        const want = (ctx.cfg().dsh && ctx.cfg().dsh.profile) || 'desktop';
        const profile = profiles.includes(want) ? want : profiles[0];
        ctx.state.profile = profile;
        const hasYml = fs.existsSync(profileFile(profile));
        return { status: 'ok', detail: `profile: ${profile}（共 ${profiles.length} 个）${hasYml ? '，配置文件就绪' : '，还没有 cordis.patch.yml（首次注册时自动建）'}` };
      },
    },
    {
      key: 'running',
      title: '探测 DSH 是否在运行',
      hint: 'DSH 的端口是动态的（不一定是 3080）：脚本会按进程找到它真正在听哪个端口',
      async run(ctx) {
        const d = await discoverDsh(ctx);
        ctx.state.dsh = d;
        if (!d.running) {
          return { status: 'ok', detail: '没发现运行中的 DSH 进程，下一步尝试自动启动' };
        }
        const base = d.webPort ? `http://127.0.0.1:${d.webPort}` : (d.apiPort ? `http://127.0.0.1:${d.apiPort}` : '');
        if (base) {
          ctx.saveCfg({ dsh: Object.assign({ baseUrl: 'http://127.0.0.1:3080' }, ctx.cfg().dsh || {}, { baseUrl: base, apiUrl: d.apiPort ? `http://127.0.0.1:${d.apiPort}` : '', detectedAt: new Date().toISOString() }) });
        }
        const bits = [];
        if (d.webPort) bits.push(`网页端 ${d.webPort}`);
        if (d.apiPort) bits.push(`API ${d.apiPort}`);
        return { status: 'ok', detail: `DSH 正在运行（${bits.join(' · ') || '端口 ' + d.ports.map((x) => x.port).join(',')}）` };
      },
    },
    {
      key: 'start',
      title: '启动 DSH 进程',
      hint: '自动启动没成功的话：手动打开「DeepSeek Harness」桌面程序，登录后回到这里再点一次安装',
      async run(ctx) {
        let d = ctx.state.dsh || (await discoverDsh(ctx));
        if (d.running) return { status: 'skip', detail: `已经在运行（${d.webPort ? '网页端 ' + d.webPort : '进程在'}），不用重启` };

        const configured = (ctx.cfg().dsh || {}).exe || '';
        const exe = findDshExe(configured);
        if (!exe) {
          return {
            status: 'manual',
            detail: '没在这台机器上找到「DeepSeek Harness.exe」',
            hint: '如果你装了 DSH，把它的 exe 完整路径填到「连接设置 → DSH 可执行文件」，或者在配置里写 dsh.exe，脚本下次就能自动拉起它',
          };
        }
        ctx.saveCfg({ dsh: Object.assign({ baseUrl: 'http://127.0.0.1:3080' }, ctx.cfg().dsh || {}, { exe }) });
        const r = ctx.spawnDetached(exe, [], { cwd: path.dirname(exe) });
        if (!r.ok) return { status: 'manual', detail: `启动失败：${r.error}`, hint: `手动双击 ${exe}` };

        /* Electron 冷启动要几秒，而且端口是动态的：每 2 秒重新发现一次 */
        for (let i = 0; i < 15; i++) {
          await new Promise((res) => setTimeout(res, 2000));
          d = await discoverDsh(ctx);
          if (d.running) {
            ctx.state.dsh = d;
            const base = d.webPort ? `http://127.0.0.1:${d.webPort}` : `http://127.0.0.1:${d.apiPort || 3080}`;
            ctx.saveCfg({ dsh: Object.assign({ baseUrl: 'http://127.0.0.1:3080' }, ctx.cfg().dsh || {}, { baseUrl: base, apiUrl: d.apiPort ? `http://127.0.0.1:${d.apiPort}` : '', exe }) });
            return { status: 'ok', detail: `已启动（${path.basename(exe)}）· 端口 ${d.webPort || d.apiPort}，用时约 ${(i + 1) * 2} 秒` };
          }
        }
        return {
          status: 'manual',
          detail: '进程起来了但 30 秒内没在已知端口上响应',
          hint: '可能是首次启动要登录账号。看 DSH 窗口登录一次，再回来点「部署」重试（脚本会自动接上它已开的端口）',
        };
      },
    },
    {
      key: 'record',
      title: '记录 DSH 地址与 profile',
      async run(ctx) {
        const dsh = ctx.cfg().dsh || {};
        ctx.saveCfg({ dsh: Object.assign({ baseUrl: 'http://127.0.0.1:3080' }, dsh, { profile: ctx.state.profile }) });
        return { status: 'ok', detail: `已记录 profile=${ctx.state.profile}` };
      },
    },
  ],
};
