import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeployAgent, localDeployRequest, DEPLOY_COMPONENTS } from './lib/deploy-agent.mjs';
import { apply } from './dsh-deploy-plugin.mjs';

const req = (origin = 'http://127.0.0.1:3210', host = '127.0.0.1:3210') => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { origin, host } });
assert.equal(localDeployRequest(req(), '127.0.0.1', 3210), true);
assert.equal(localDeployRequest(req('https://evil.example'), '127.0.0.1', 3210), false);
assert.equal(localDeployRequest(req('http://evil.example:3210', 'evil.example:3210'), '127.0.0.1', 3210), false);
assert.equal(localDeployRequest(req(), '0.0.0.0', 3210), false);
assert.equal(localDeployRequest(req(undefined, 'localhost:9999'), '127.0.0.1', 3210), false);

let guard;
const names = [];
apply({ tools: { guard(fn) { guard = fn; }, register(tool) { names.push(tool.name); } } });
assert.deepEqual(names, ['deploy_status', 'deploy_step', 'deploy_verify']);
assert.equal(guard({ name: 'deploy_step' }), undefined);
for (const name of ['pwsh', 'bash', 'run_code', 'subagent', 'write_file']) assert.equal(typeof guard({ name }), 'string');
assert.throws(() => apply({ tools: {} }), /守卫/);

let release;
const pending = new Promise(resolve => { release = resolve; });
const calls = [];
let paused = false;
const service = createDeployAgent({ doctor: async () => ({}), port: 3210, resolveCli: () => '', runRecipe: async target => {
  calls.push(target);
  if (target === 'node' && calls.length === 1) await pending;
  if (target === 'snowluma' && !paused) { paused = true; return { id: 'mock', status: 'manual', steps: [{ status: 'manual', detail: '请扫码', hint: '扫码后继续' }] }; }
  return { id: 'mock', status: 'done', steps: [] };
} });
const ticket = service.ticket();
const job = service.start(ticket, 'recipe');
assert.throws(() => service.start(ticket, 'recipe'), /失效/);
assert.throws(() => service.start(service.ticket(), 'recipe'), /已有/);
await assert.rejects(service.tool('wrong', 'deploy_step', { component: 'shell' }), /无效/);
release();
const wait = async state => { for (let i = 0; i < 200; i++) { const s = service.get(job.id); if (s.state === state && !s.running) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('等待超时 ' + state); };
await wait('manual');
assert.deepEqual(calls, ['node', 'dsh', 'snowluma', 'qqbridge', 'market']);
service.continue(job.id);
await wait('manual');
assert.deepEqual(calls, ['node', 'dsh', 'snowluma', 'qqbridge', 'market', 'snowluma']);
assert.equal(service.get(job.id).result.ready, false);
assert.ok(service.get(job.id).result.missing.length);
service.cancel(job.id);
assert.equal(service.get(job.id).state, 'cancelled');
assert.deepEqual(DEPLOY_COMPONENTS, ['node', 'dsh', 'snowluma', 'qqbridge', 'market']);

let attempts = 0;
const limited = createDeployAgent({ doctor: async () => ({}), port: 3210, resolveCli: () => '', runRecipe: async () => {
  attempts++;
  return { id: 'mock', status: 'manual', steps: [{ status: 'manual', detail: '人工步骤', hint: '完成后继续' }] };
} });
const limitedJob = limited.start(limited.ticket(), 'recipe');
const waitLimited = async (condition) => { for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('等待任务状态超时'); };
await waitLimited(() => !limited.get(limitedJob.id).running);
limited.continue(limitedJob.id);
await waitLimited(() => !limited.get(limitedJob.id).running);
limited.continue(limitedJob.id);
await waitLimited(() => !limited.get(limitedJob.id).running);
assert.equal(attempts, 3);
assert.equal(limited.get(limitedJob.id).state, 'manual');
limited.cancel(limitedJob.id);
let failures = 0;
const failed = createDeployAgent({ doctor: async () => ({}), port: 3210, runRecipe: async () => { failures++; return { id: 'mock', status: 'failed', steps: [{ status: 'fail', detail: 'broken' }] }; } });
const fj = failed.start(failed.ticket(), 'recipe');
await new Promise(r => setTimeout(r, 25));
assert.equal(failed.get(fj.id).state, 'failed');
assert.equal(failures, 1);
const historyDir=fs.mkdtempSync(path.join(os.tmpdir(),'qqbot-history-'));
try {
  const snapshotFile=path.join(historyDir,'agent.json');
  const persistent=createDeployAgent({doctor:async()=>({}),port:3210,snapshotFile,runRecipe:async()=>({id:'fixture',status:'manual',steps:[{status:'manual',detail:'等待扫码',hint:'完成后继续'}]})});
  const pj=persistent.start(persistent.ticket(),'recipe');
  await waitLimited(()=>!persistent.get(pj.id).running);
  assert.equal(JSON.parse(fs.readFileSync(snapshotFile,'utf8'))[0].running,false);
  assert.ok(!fs.readFileSync(snapshotFile,'utf8').includes('capability'));
  let reran=false;
  const restored=createDeployAgent({doctor:async()=>({}),port:3210,snapshotFile,runRecipe:async()=>{reran=true;throw Error('must not auto run');}});
  assert.equal(restored.latest().id,pj.id);
  assert.equal(restored.latest().state,'failed');
  assert.ok(restored.latest().events.some(e=>e.message.includes('等待扫码')));
  assert.equal(restored.latest().running,false);
  assert.equal(reran,false);
  persistent.cancel(pj.id);
  assert.equal(createDeployAgent({doctor:async()=>({}),port:3210,snapshotFile}).latest().state,'cancelled');
} finally {fs.rmSync(historyDir,{recursive:true,force:true});}
console.log('部署边界、工具守卫、令牌重放、人工恢复、独立准备步骤及最终体检检查通过。未启动外部服务或修改用户配置。');
