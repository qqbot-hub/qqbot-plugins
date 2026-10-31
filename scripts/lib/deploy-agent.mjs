import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, readCfg } from './paths.mjs';
import { redact, decrypt } from './secrets.mjs';
import { registered as isRegistered } from './dsh-registration.mjs';
import { observedTools } from './plugin-health.mjs';
import { runInstall, exec } from '../installer.mjs';

export const DEPLOY_COMPONENTS = ['node', 'dsh', 'snowluma', 'qqbridge', 'market'];
export const DEPLOY_TOOLS = [
  { name: 'deploy_status', description: '读取部署手册、当前链路体检和本次部署进度。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'deploy_step', description: '执行一个白名单 recipe。每步最多尝试两次；需要人工时立即停止。', inputSchema: { type: 'object', properties: { component: { type: 'string', enum: DEPLOY_COMPONENTS } }, required: ['component'], additionalProperties: false } },
  { name: 'deploy_verify', description: '检查协议心跳、DSH、桥接和 MCP 注册；只有返回 ready 才可报告链路就绪。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

export function findDshCli(cfg = readCfg()) {
  const roots = [cfg.dsh?.exe && path.dirname(cfg.dsh.exe), path.join(os.homedir(), 'AppData/Local/Programs/DeepSeek Harness')].filter(Boolean);
  const candidates = [cfg.dsh?.cliPath, ...roots.map(root => path.join(root, 'resources/runtime/cli/bin/dsh.cmd'))];
  return candidates.find(file => file && fs.existsSync(file)) || '';
}

// Also checks Origin and Host: a foreign page, including DNS rebinding, cannot mint a capability.
export function localDeployRequest(req, listenHost, port) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(listenHost)) return false;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
  try {
    const host = new URL('http://' + req.headers.host);
    const origin = new URL(req.headers.origin);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)
      && host.port === String(port) && origin.origin === host.origin;
  } catch { return false; }
}

export function createDeployAgent({ doctor, port, runRecipe = runInstall, resolveCli = findDshCli, snapshotFile }) {
  const jobs = new Map(), tickets = new Map();
  let active = null, persistenceError = null;
  const clean = value => redact(String(value), [
    ...Object.entries(process.env).filter(([key]) => /TOKEN|SECRET|PASSWORD|API_KEY|CAPABILITY/i.test(key)).map(([, value]) => value),
    ...Object.values(readCfg().secrets || {}).map(decrypt),
    ...[...jobs.values()].map(job => job.capability),
  ]).replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '***');
  const event = (job, state, message) => {
    if (job.cancelled && state !== 'cancelled') return;
    job.state = state;
    job.events.push({ seq: ++job.seq, state, message: clean(message).slice(0, 2000), at: new Date().toISOString() });
    if (job.events.length > 200) job.events.shift();
    persist();
  };
  const snapshot = job => structuredClone({ id: job.id, mode: job.mode, effectiveMode: job.effectiveMode || job.mode, state: job.state, running: job.running, events: job.events, steps: job.steps, result: job.result || null });
  function persist() {
    if (!snapshotFile) return;
    try {
      fs.mkdirSync(path.dirname(snapshotFile), { recursive:true });
      fs.writeFileSync(snapshotFile+'.tmp', clean(JSON.stringify([...jobs.values()].slice(-10).map(snapshot))), { mode:0o600 });
      fs.renameSync(snapshotFile+'.tmp', snapshotFile); persistenceError = null;
    } catch { persistenceError = '部署记录保存失败，请检查数据目录权限'; }
  }
  if (snapshotFile && fs.existsSync(snapshotFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(snapshotFile,'utf8'));
      if (!Array.isArray(saved)) throw new Error('Invalid history');
      for (const item of saved.slice(-10)) {
        if (!item || !/^[a-f0-9-]{36}$/i.test(item.id) || !Array.isArray(item.events)) continue;
        const job = { id:item.id, mode:item.mode==='ai'?'ai':'recipe', effectiveMode:item.effectiveMode, state:item.state, running:false, events:item.events.slice(-200).map(e=>({seq:Number(e.seq)||0,state:String(e.state),message:clean(e.message).slice(0,2000),at:e.at})), steps:item.steps||{}, result:item.result||null, attempts:{}, capability:'', seq:0 };
        job.seq = Math.max(0,...job.events.map(e=>e.seq));
        jobs.set(job.id,job);
        if (!['done','failed','cancelled'].includes(job.state)) {
          job.state='failed'; job.events.push({seq:++job.seq,state:'failed',message:'市场服务已重启，上次记录已保留；请重新点击一键部署检查当前状态。',at:new Date().toISOString()});
        }
      }
    } catch { persistenceError='部署历史读取失败，请检查数据文件'; }
  }
  async function verify(job) {
    const report = await doctor();
    const cfg = readCfg();
    const profile = cfg.dsh?.profile || 'desktop';
    const registered = isRegistered(profile);
    const missing = [];
    if (!report.onebot?.online) missing.push('OneBot 尚未通过心跳/登录验证');
    if (!report.dsh?.ok) missing.push('DSH 未连接');
    if (!report.bridge?.ok) missing.push('qq-bridge 未连接');
    if (!registered) missing.push('市场 MCP 未注册到目标 DSH profile');
    if (!report.mcp?.tools) missing.push('没有已启用的插件工具，请在市场安装插件');
    const loaded = observedTools(ROOT).size > 0;
    if (!loaded) missing.push('尚未观察到 DSH 客户端列出当前版本的市场工具');
    if (DEPLOY_COMPONENTS.some(c => job.steps[c]?.status !== 'done')) missing.push('部署步骤尚未全部通过');
    const ready = !missing.length;
    const result = { ready, missing, registered, loaded, restartRequired: registered && !loaded, note: ready ? '链路体检与 DSH 工具加载已通过；消息回复仍需在白名单会话中验证。' : '首次注册需要 DSH 加载配置；后续安装插件支持热更新。请在 DSH 刷新工具列表，仍无工具时重载 MCP 连接。' };
    job.result = result;
    return result;
  }
  async function step(job, component) {
    if (!DEPLOY_COMPONENTS.includes(component)) throw new Error('组件不在部署白名单');
    if (job.cancelled) throw new Error('任务已取消');
    if (job.state === 'manual') throw new Error('等待用户操作，请点击继续');
    if (job.busy) throw new Error('已有部署步骤执行中');
    const index = DEPLOY_COMPONENTS.indexOf(component);
    if (index > 0 && job.steps.node?.status !== 'done') throw new Error('请先完成 Node 运行时检查');
    if (job.steps[component]?.status === 'done') return job.steps[component];
    if ((job.attempts[component] || 0) >= 2) throw new Error('该组件已尝试两次，需要用户检查日志');
    job.busy = true;
    job.attempts[component] = (job.attempts[component] || 0) + 1;
    event(job, 'automatic', '执行 ' + component);
    try {
      const installed = await runRecipe(component, { onEvent(type, payload) {
        if (type === 'step' && payload.status !== 'running') event(job, 'automatic', `${component}/${payload.key}: ${payload.status} ${payload.detail || ''}`);
      } });
      if (job.cancelled) return { status: 'cancelled' };
      const stop = installed.steps.find(s => ['manual', 'fail'].includes(s.status));
      const result = { status: job.cancelled ? 'cancelled' : installed.status, jobId: installed.id, hint: clean(stop?.hint || ''), detail: clean(stop?.detail || ''), command: `node scripts/installer.mjs run ${component}` };
      job.steps[component] = result;
      if (installed.status === 'manual') {
        job.attempts[component] = Math.max(0, job.attempts[component] - 1);
        job.manualComponent = component;
        event(job, 'manual', result.detail + '\n' + result.hint);
        // Stop the isolated agent at the manual boundary; continuation creates a fresh capability.
        job.capability = '';
        job.child?.kill();
      }
      return result;
    } finally { job.busy = false; }
  }
  async function tool(job, name, args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('部署工具参数必须为对象');
    if (Object.keys(args).some(key => name !== 'deploy_step' || key !== 'component')) throw new Error('部署工具参数不在白名单');
    if (name === 'deploy_status') return { manual: job.state === 'manual', steps: job.steps, attempts: job.attempts, report: await doctor(), handbook: fs.readFileSync(path.join(ROOT, 'docs/AGENT-DEPLOY.md'), 'utf8') };
    if (name === 'deploy_step') return step(job, args.component);
    if (name === 'deploy_verify') return verify(job);
    throw new Error('不允许的部署工具');
  }
  async function deterministic(job) {
    let manual = false;
    for (const component of DEPLOY_COMPONENTS) {
      if (job.cancelled) return;
      job.state = 'automatic';
      try {
        const result = await step(job, component);
        if (result.status === 'manual') { manual = true; if (component === 'node') break; continue; }
        if (result.status !== 'done') { event(job, 'failed', result.detail + '\n' + result.hint); return; }
      } catch (e) { event(job, 'failed', clean(e.message)); return; }
    }
    if (manual) { event(job, 'manual', '准备工作已完成；请按各组件提示完成操作，再点击继续。已完成组件不会重装。'); return; }
    const result = await verify(job);
    job.capability = '';
    event(job, result.ready ? 'done' : 'manual', result.ready ? result.note : result.missing.join('\n') + '\n' + result.note);
  }
  async function agent(job) {
    const cli = resolveCli();
    const cfgKey = decrypt(readCfg().secrets?.['global.deepseekApiKey'] || '');
    const apiKey = process.env.DEEPSEEK_API_KEY || cfgKey;
    if (!cli || !apiKey) {
      job.effectiveMode = 'recipe';
      event(job, 'automatic', 'AI 模式需要 DSH CLI 和独立 headless 的 DEEPSEEK_API_KEY；回落到确定性部署。GUI 登录不会自动复制到部署 profile。');
      return deterministic(job);
    }
    const dir = path.join(ROOT, 'runtimes/deploy-agent', job.id);
    job.runtimeDir = dir;
    fs.mkdirSync(dir, { recursive: true });
    const env = { ...process.env, DSH_HOME: dir, DEEPSEEK_API_KEY: apiKey, QQBOT_DEPLOY_URL: `http://127.0.0.1:${port}`, QQBOT_DEPLOY_CAPABILITY: job.capability };
    for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD/i.test(key) && key !== 'QQBOT_DEPLOY_CAPABILITY') delete env[key];
    // Resolve CLI's underlying Electron entry without shell interpolation of task/user input.
    const install = path.resolve(path.dirname(cli), '../../../..');
    const exe = path.join(install, 'DeepSeek Harness.exe');
    const entry = path.join(install, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js');
    env.ELECTRON_RUN_AS_NODE = '1';
    const dump = await exec(exe, ['--expose-internals', entry, 'headless', '--dump-default-config'], { env, timeoutMs: 15000 });
    if (job.cancelled) return;
    if (dump.code !== 0 || !dump.stdout.includes('id: headless-runner')) throw new Error('无法确认 DSH headless 配置；使用普通部署');
    const ids = [...dump.stdout.matchAll(/^- id: ([^\r\n]+)/gm)].map(m => m[1]);
    const disabled = ids.filter(id => id.startsWith('tool-') || ['plugin-manager', 'config-editor', 'skill-filesystem', 'agent-instructions', 'workflow-ptc'].includes(id));
    const patch = path.join(dir, 'deploy.patch.yml');
    const quote = s => "'" + s.replace(/'/g, "''") + "'";
    fs.writeFileSync(patch, disabled.map(id => `- id: ${id}\n  disabled: true\n`).join('') + `- insert:\n    - id: qqbot-deploy-only\n      name: ${quote(path.join(ROOT, 'scripts/dsh-deploy-plugin.mjs').replace(/\\/g, '/'))}\n`);
    event(job, 'ai', 'DSH 正在通过白名单部署工具编排；本次运行会消耗模型额度。');
    const child = spawn(exe, ['--expose-internals', entry, 'headless', '--patch', patch, '--json', '-'], { cwd: ROOT, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    job.child = child;
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.length > 65536) output = output.slice(-65536);
      let i;
      while ((i = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, i); output = output.slice(i + 1);
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'error') event(job, 'ai', ev.message || 'DSH 返回错误');
          if (['text', 'final'].includes(ev.type) && typeof ev.text === 'string') event(job, job.state === 'manual' ? 'manual' : 'ai', ev.text);
          // Only forward public assistant messages, never reasoning, tool arguments or stderr.
          if (ev.type === 'assistant/message') {
            const text = (ev.data?.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
            if (text) event(job, job.state === 'manual' ? 'manual' : 'ai', text);
          }
        } catch {}
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdin.end(fs.readFileSync(path.join(ROOT, 'docs/AGENT-DEPLOY.md'), 'utf8'));
    try { await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
    finally { clearTimeout(timer); job.child = null; }
    if (job.cancelled || job.state === 'manual') return;
    const result = await verify(job);
    if (result.ready) { job.capability = ''; return event(job, 'done', result.note); }
    event(job, 'automatic', 'AI 未完成体检，回落到确定性 recipe；仍受每步两次上限约束。');
    await deterministic(job);
  }
  async function run(job) {
    try { await (job.mode === 'ai' ? agent(job) : deterministic(job)); }
    catch (e) {
      if (!job.cancelled && job.mode === 'ai' && job.state !== 'manual' && !job.busy) {
        event(job, 'automatic', 'AI 任务无法继续：' + clean(e.message) + '。转为普通部署。');
        try { await deterministic(job); } catch (fallbackError) { event(job, 'failed', clean(fallbackError.message)); }
      } else if (!job.cancelled) event(job, 'failed', clean(e.message));
    }
    finally {
      job.capability = '';
      job.running = false;
      persist();
      if (job.runtimeDir) {
        const expected = path.join(ROOT, 'runtimes/deploy-agent', job.id);
        if (job.runtimeDir === expected) {
          try { fs.rmSync(expected, { recursive: true, force: true }); } catch { /* Windows may briefly hold a session file. No capability remains valid. */ }
        }
      }
    }
  }
  return {
    ticket() {
      const now = Date.now();
      for (const [t, expiry] of tickets) if (expiry < now) tickets.delete(t);
      if (tickets.size >= 20) throw new Error('部署请求过多');
      const token = crypto.randomBytes(32).toString('hex'); tickets.set(token, now + 60000); return token;
    },
    start(token, mode) {
      const expiry = tickets.get(token); tickets.delete(token);
      if (!expiry || expiry < Date.now()) throw new Error('一次性部署 token 已失效');
      if (active && (active.running || !['done', 'failed', 'cancelled'].includes(active.state))) throw new Error('已有部署任务，请继续或取消现有任务');
      if (!['ai', 'recipe'].includes(mode)) throw new Error('未知部署模式');
      if (jobs.size >= 10) jobs.delete(jobs.keys().next().value);
      const job = { id: crypto.randomUUID(), mode, capability: crypto.randomBytes(32).toString('hex'), state: 'automatic', steps: {}, attempts: {}, events: [], seq: 0, running: true };
      jobs.set(job.id, job); active = job; event(job, 'automatic', '部署任务已创建'); void run(job); return snapshot(job);
    },
    get(id) { const job = jobs.get(id); return job && {...snapshot(job),persistenceError}; },
    latest() { const job=[...jobs.values()].at(-1); return job ? {...snapshot(job),persistenceError} : null; },
    continue(id) {
      const job = jobs.get(id);
      if (!job || job.running || job.state !== 'manual') throw new Error('任务仍在执行或不处于等待状态');
      for (const c of DEPLOY_COMPONENTS) if (job.steps[c]?.status === 'manual') delete job.steps[c];
      job.manualComponent = '';
      // A user checkpoint grants a fresh attempt budget for that manual component only.
      job.capability = crypto.randomBytes(32).toString('hex');
      job.state = 'automatic';
      job.running = true; event(job, 'automatic', '用户已确认操作完成，重新检查'); void run(job); return snapshot(job);
    },
    cancel(id) {
      const job = jobs.get(id); if (!job) throw new Error('任务不存在');
      job.cancelled = true; job.capability = ''; job.child?.kill(); event(job, 'cancelled', '任务已取消。正在执行的 recipe 将安全完成当前步骤，已启动的组件保留。'); return snapshot(job);
    },
    async tool(capability, name, args) {
      const job = [...jobs.values()].find(j => j.capability && j.capability === capability);
      if (!job || !job.running || job.cancelled) throw new Error('部署能力凭据无效或任务已结束');
      return tool(job, name, args);
    },
  };
}
