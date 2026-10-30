import assert from 'node:assert/strict';
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
const wait = async state => { for (let i = 0; i < 100; i++) { if (service.get(job.id).state === state) { await new Promise(r => setTimeout(r, 10)); return; } await new Promise(r => setTimeout(r, 10)); } throw new Error('等待超时 ' + state); };
await wait('manual');
assert.deepEqual(calls, ['node', 'snowluma']);
service.continue(job.id);
await wait('manual');
assert.deepEqual(calls, ['node', 'snowluma', 'snowluma', 'qqbridge', 'dsh', 'market']);
assert.equal(service.get(job.id).result.ready, false);
assert.ok(service.get(job.id).result.missing.length);
service.cancel(job.id);
assert.equal(service.get(job.id).state, 'cancelled');
assert.deepEqual(DEPLOY_COMPONENTS, ['node', 'snowluma', 'qqbridge', 'dsh', 'market']);

let attempts = 0;
const limited = createDeployAgent({ doctor: async () => ({}), port: 3210, resolveCli: () => '', runRecipe: async () => {
  attempts++;
  return { id: 'mock', status: 'manual', steps: [{ status: 'manual', detail: '人工步骤', hint: '完成后继续' }] };
} });
const limitedJob = limited.start(limited.ticket(), 'recipe');
const waitLimited = async (condition) => { for (let i = 0; i < 100; i++) { if (condition()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('等待任务状态超时'); };
await waitLimited(() => limited.get(limitedJob.id).state === 'manual');
limited.continue(limitedJob.id);
await waitLimited(() => limited.get(limitedJob.id).state === 'manual');
limited.continue(limitedJob.id);
await waitLimited(() => !limited.get(limitedJob.id).running);
assert.equal(attempts, 2);
assert.equal(limited.get(limitedJob.id).state, 'failed');
console.log('部署边界、工具守卫、令牌重放、人工恢复、两次重试上限、步骤顺序及最终体检检查通过。未启动外部服务或修改用户配置。');
