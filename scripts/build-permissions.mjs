/* ============================================================
 * build-permissions.mjs —— 扫真实代码，生成插件的权限清单
 *
 * 为什么要扫而不是手写：
 *   手写权限表 100% 会跟代码漂移，最后变成"卡片写着只读，实际在删文件"。
 *   这里对 plugins/*.mjs 做静态扫描（只看用了哪些 API，不做语义分析），
 *   生成 data/catalog/permissions.json，安装前照着它给用户看、要二次确认。
 *
 * 扫出来的东西（宁可多报，不可漏报）：
 *   message:send  发消息 / 群管理动作   → 会以机器人身份在群里说话
 *   file:read     读本地文件            → 能看到你磁盘上的东西
 *   file:write    写本地文件/存数据     → 能改你磁盘上的东西
 *   exec          执行系统命令          → 权限最大的一类，必须二次确认
 *   network       访问网络              → 数据会出本机
 *
 * 用法：
 *   node scripts/build-permissions.mjs          生成/更新
 *   node scripts/build-permissions.mjs --check  只检查是否过期（测试用）
 * ============================================================ */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT } from './lib/paths.mjs';

const PLUGIN_DIR = path.join(ROOT, 'plugins');
const OUT = path.join(ROOT, 'data', 'catalog', 'permissions.json');

const RULES = [
  {
    key: 'exec',
    label: '执行系统命令',
    level: 'danger',
    why: '可以在你电脑上运行任意命令',
    /* 注意不要写成裸的 \bexec( ：正则的 re.exec() 会误报，这属于"把只读插件标成能执行命令"的假警报 */
    re: /child_process|execFileSync|\bspawnSync\b|\bspawn\(|\bexecFile\(|\bexecSync\(/,
  },
  {
    key: 'file:write',
    label: '写入本地文件',
    level: 'warn',
    why: '会往磁盘写数据（缓存、配置、下载的文件）',
    re: /writeFileSync|writeFile\(|appendFile|mkdirSync|writeJson\(|\bstorage\(/,
  },
  {
    key: 'file:read',
    label: '读取本地文件',
    level: 'info',
    why: '会读磁盘上的文件',
    re: /localMusic|readFileSync|readFile\(|readJson\(|createReadStream/,
  },
  {
    key: 'message:send',
    label: '以机器人身份发消息 / 管理群',
    level: 'warn',
    why: '会在群里说话、发图、禁言或踢人（受机器人自身群权限限制）',
    re: /bridgeOf|\.bridge\.|send_group_msg|send_private_msg|send_msg|sendGroup|sendPrivate|set_group_ban|setGroupBan|sendText|sendImage|api\.reply|api\.sendText/,
  },
  {
    key: 'network',
    label: '访问网络',
    level: 'info',
    why: '数据会发到本机之外的接口',
    re: /\bfetch\(|httpJson\(|httpGet\(|https?:\/\//,
  },
];

function pluginFiles() {
  try {
    return fs.readdirSync(PLUGIN_DIR).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort();
  } catch { return []; }
}

export function scan() {
  const files = pluginFiles();
  const out = {};
  const hashes = {};
  for (const f of files) {
    const id = f.replace(/\.mjs$/, '');
    const src = fs.readFileSync(path.join(PLUGIN_DIR, f), 'utf8');
    hashes[id] = crypto.createHash('sha1').update(src).digest('hex').slice(0, 12);
    const perms = RULES.filter((r) => r.re.test(src)).map((r) => ({
      key: r.key, label: r.label, level: r.level, why: r.why,
    }));
    out[id] = {
      permissions: perms,
      /* 二次确认只对这三类做：能执行命令、能写文件、能以机器人身份说话 */
      confirmRequired: perms.some((p) => ['exec', 'file:write', 'message:send'].includes(p.key)),
      /* 需要协议端：主动调 OneBot 动作，或者注册了消息处理器（要能收消息就必须有协议端） */
      needsBridge: /bridgeOf|\.bridge\.|send_group_msg|set_group_ban|setGroupBan|sendGroup|sendPrivate/.test(src)
        || /\bhandlers\s*:/.test(src),
      hasSettings: /settings\s*:/.test(src),
      /* 框架按真实形态标：只有工具是 mcp，只有 handler 是 message，两者都有就都写 */
      framework: (() => {
        const hasTools = /\btools\s*:\s*\[/.test(src);
        const hasMsg = /\bhandlers\s*:\s*\[/.test(src);
        if (hasTools && hasMsg) return 'mcp+message';
        if (hasMsg) return 'message';
        return 'mcp';
      })(),
      language: 'JavaScript (ESM)',
      loc: src.split(/\r?\n/).length,
    };
  }
  return { out, hashes };
}

export function build() {
  const { out, hashes } = scan();
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    method: '静态扫描 plugins/*.mjs 的 API 使用情况（见 scripts/build-permissions.mjs）',
    sourceHashes: hashes,
    plugins: out,
  };
}

const __isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (__isCli) {
  const checkOnly = process.argv.includes('--check');
  const next = build();
  if (checkOnly) {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { /* 没有就是过期 */ }
    const same = prev && JSON.stringify(prev.sourceHashes) === JSON.stringify(next.sourceHashes);
    if (!same) {
      console.error('权限清单已过期：请运行 node scripts/build-permissions.mjs');
      process.exit(1);
    }
    console.log(`权限清单是最新的（${Object.keys(next.plugins).length} 个插件）`);
    process.exit(0);
  }
  fs.writeFileSync(OUT, JSON.stringify(next, null, 2) + '\n');
  const n = Object.keys(next.plugins).length;
  const risky = Object.values(next.plugins).filter((p) => p.confirmRequired).length;
  console.log(`已写入 ${path.relative(ROOT, OUT)}：${n} 个插件，其中 ${risky} 个需要安装前二次确认`);
}
