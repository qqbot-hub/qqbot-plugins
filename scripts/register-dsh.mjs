#!/usr/bin/env node
/* ============================================================
 * register-dsh.mjs —— 把 qqbot-plugins 的 MCP 服务器注册进 DSH
 *
 * 用法：
 *   node scripts/register-dsh.mjs <profile>          注册（幂等，可重复跑）
 *   node scripts/register-dsh.mjs <profile> --remove 移除
 *
 * 原理：DSH 的 MCP 客户端配置在 ~/.dsh/profiles/<profile>/cordis.patch.yml，
 * 是一个 YAML 数组，由若干补丁操作组成（与 qq-bridge 官方 setup-dsh.mjs
 * 写 mcp__snowluma__ 系列的方式完全一致）。本脚本用注释块管理自己的条目：
 *
 *   # === qqbot-plugins MCP BEGIN ===
 *   - insert:
 *       - id: mcp-qqbot
 *         name: '@deepseek-ai/dsh-mcp-client'
 *         config:
 *           serverName: qqbot
 *           transport: stdio
 *           command: '<node>'
 *           args:
 *             - '<qqbot-plugins>/mcp-server.mjs'
 *           toolCallTimeoutMs: 725000
 *   # === qqbot-plugins MCP END ===
 *
 * 只动 BEGIN/END 之间的行，绝不改文件其他内容。写入前自动备份。
 * 写完必须完整退出并重启 DSH 才生效。
 * ============================================================ */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const BEGIN = '# === qqbot-plugins MCP BEGIN ===';
const END = '# === qqbot-plugins MCP END ===';

const yamlSingleQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function managedBlock() {
  const node = process.execPath;
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp-server.mjs');
  return [BEGIN,
    '- insert:',
    '    - id: mcp-qqbot',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: qqbot',
    '        transport: stdio',
    '        command: ' + yamlSingleQuote(node),
    '        args:',
    '          - ' + yamlSingleQuote(script),
    '        toolCallTimeoutMs: 725000',
    END, ''].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const remove = args.includes('--remove');
  const profile = args.find((a) => !a.startsWith('--')) || 'desktop';
  const home = process.env.USERPROFILE || os.homedir();
  if (!home) { console.error('拿不到用户目录（USERPROFILE/HOME）'); process.exit(1); }
  const dir = path.join(home, '.dsh', 'profiles', profile);
  const file = path.join(dir, 'cordis.patch.yml');

  if (!fs.existsSync(dir)) {
    console.error(`profile 目录不存在：${dir}`);
    console.error('打开 ~/.dsh/profiles/ 看一眼有哪些子目录，用那个名字重跑。');
    process.exit(1);
  }

  let lines = [];
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    lines = raw.split('\n');
    /* 先备份 */
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, file + '.' + stamp + '.bak');
    console.log('已备份原文件 → ' + file + '.' + stamp + '.bak');
    /* 删掉旧的托管块（含注释行本身） */
    const out = [];
    let inBlock = false;
    for (const l of lines) {
      if (l.trim() === BEGIN) { inBlock = true; continue; }
      if (l.trim() === END) { inBlock = false; continue; }
      if (!inBlock) out.push(l);
    }
    lines = out;
  } else {
    console.log('cordis.patch.yml 不存在，将新建：' + file);
  }

  if (!remove) {
    /* 去掉文件末尾空行后拼接我们的块 */
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    const content = (lines.length ? lines.join('\n') + '\n\n' : '') + managedBlock();
    fs.writeFileSync(file, content);
    console.log('✅ 已把 qqbot-plugins 注册进 DSH（serverName: qqbot）');
  } else {
    fs.writeFileSync(file, lines.join('\n'));
    console.log('✅ 已从 DSH 移除 qqbot-plugins 注册');
  }

  console.log('配置文件：' + file);
  console.log('⚠️  preset 和 MCP 只在 DSH 启动时加载——现在请【完整退出 DSH 并重新打开】，');
  console.log('   然后在 DSH 里搜索 mcp__qqbot__ 验证工具已挂上。');
}

main();
