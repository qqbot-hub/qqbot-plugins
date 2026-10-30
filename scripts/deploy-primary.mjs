#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInstall } from './installer.mjs';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const METHODS_FILE = path.join(ROOT, 'data', 'catalog', 'methods.json');

function primaryMethod() {
  const data = JSON.parse(fs.readFileSync(METHODS_FILE, 'utf8'));
  const method = data.methods.find((item) => item.primary);
  if (!method) throw new Error('部署清单中没有标记主链路的方法');
  const chain = method.deploy?.chain || (method.deploy?.recipe ? [method.deploy.recipe] : []);
  if (!chain.length) throw new Error('主链路没有可执行的部署步骤');
  return { method, chain };
}

function showEvent(type, payload) {
  if (type === 'log') {
    const marker = payload.level === 'err' ? '!' : payload.level === 'cmd' ? '$' : '-';
    console.log(`  ${marker} ${payload.msg}`);
  } else if (type === 'step') {
    const detail = payload.detail ? `: ${payload.detail}` : '';
    console.log(`  [${payload.status}] ${payload.key}${detail}`);
    if (payload.hint && ['manual', 'fail'].includes(payload.status)) console.log(`    下一步：${payload.hint}`);
  }
}

export async function deployPrimary({ dryRun = false } = {}) {
  const { method, chain } = primaryMethod();
  console.log(`主链路：${method.name}`);
  console.log(`执行步骤：${chain.join(' -> ')}`);

  if (dryRun) return { status: 'dry-run', chain };

  let needsManual = false;
  let marketRegistered = false;
  for (const target of chain) {
    console.log(`\n== ${target} ==`);
    const params = target === 'compose' ? { method: method.id } : {};
    const job = await runInstall(target, {
      params,
      onEvent: showEvent,
    });

    if (job.status === 'manual') {
      needsManual = true;
      if (target === 'node') break;
      continue;
    }
    if (job.status !== 'done') {
      const failed = job.steps.find((step) => step.status === 'fail');
      console.error(`\n部署在 ${target} 停止${failed?.detail ? `：${failed.detail}` : ''}`);
      return { status: 'failed', target, job };
    }
    if (target === 'market') marketRegistered = true;
  }

  if (marketRegistered) {
    console.log('\nMCP 已注册到 DSH。首次接入请加载配置，已有连接请刷新工具列表，以实际 tools/list 结果为准。');
  } else {
    console.log('\nMCP 尚未注册：请先启动并登录 DSH 生成 profile，再重新运行部署。');
  }
  if (needsManual) {
    console.log('部署过程中有需要人工完成的步骤；请按上面的提示完成后，再运行 npm run deploy:primary 复查。');
    return { status: 'manual', chain };
  }
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/doctor.mjs'], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
    child.once('error', () => resolve(1)); child.once('close', resolve);
  });
  return { status: code === 0 ? 'done' : 'manual', chain };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const dryRun = process.argv.includes('--dry-run');
  try {
    const result = await deployPrimary({ dryRun });
    if (result.status === 'failed') process.exitCode = 1;
    if (result.status === 'manual') process.exitCode = 2;
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}
