#!/usr/bin/env node
/* ============================================================
 * verify-plugins.mjs —— 把市场里每个插件的每个工具真跑一遍
 *
 *   node scripts/verify-plugins.mjs          跑全部插件
 *   node scripts/verify-plugins.mjs --json   输出 JSON（给网页/CI 用）
 *
 * 判定：
 *   ✅ 通过      工具正常返回了内容
 *   🔌 需在线    依赖 QQ 在线（SnowLuma 没开就会这样），属于环境问题不是插件问题
 *   ❌ 失败      插件自身报错
 *
 * 说明：所有依赖 OneBot 的工具都通过 HTTP 调 SnowLuma(3000)，
 *      本机没跑 SnowLuma 时统一显示「需在线」，不会被误判为坏插件。
 * 数据隔离：通过 QQBOT_STORE 指向临时目录，不会写入你的真实数据。
 * ============================================================ */
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { wrapOnebot } from '../plugins/_bridge.mjs';
import { dataPath } from './lib/paths.mjs';
import { runSandboxed, sanitizeConfig } from './lib/sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JSON_OUT = process.argv.includes('--json');
const USE_SANDBOX = String(process.env.QQBOT_VERIFY_MODE || 'sandbox') !== 'inline';

/* 每个工具的示例参数（贴近真实群聊场景） */
const G = 888;
const U = 1001;
const SAMPLES = {
  qq_calc: { expression: '(3.5*8+12)*0.8' },
  qq_dice: { count: 2, sides: 6 },
  qq_choose: { options: ['吃火锅', '吃面', '点外卖'] },
  qq_fortune: { user_id: U },
  qq_weather: { location: '北京' },
  qq_coin: { count: 3 },
  qq_color: {},
  qq_clock: {},
  qq_morse: { text: 'SOS' },
  qq_base: { value: 'ff', from: 16, to: 2 },
  qq_passgen: { length: 12 },
  qq_unit: { value: 5, from: '尺', to: 'm' },
  qq_translate: { text: '你好世界' },
  qq_abbr: { abbr: 'yyds' },
  qq_hitokoto: {},
  qq_bilihot: { count: 3 },
  qq_bingimg: {},
  qq_rate: { amount: 100, from: 'USD', to: 'CNY' },
  qq_jukebox: { song: '晴天 周杰伦' },
  qq_draw: {},
  qq_sensoji: {},
  qq_tarot: {},
  qq_zodiac: { zodiac: '天蝎' },
  qq_meihua: { question: '这周工作顺不顺' },
  qq_joke: {},
  qq_quote: {},
  qq_riddle: {},
  qq_poem: {},
  qq_gacha: { group_id: G, user_id: U },
  qq_roulette: { group_id: G, user_id: U },
  qq_signin: { group_id: G, user_id: U },
  qq_signin_rank: { group_id: G },
  qq_memo_add: { text: '周五交周报', group_id: G, user_id: U },
  qq_memo_list: { group_id: G },
  qq_memo_done: { index: 1, group_id: G },
  qq_ledger_add: { amount: 32.5, note: '午饭', group_id: G, user_id: U },
  qq_ledger_list: { group_id: G },
  qq_birthday_add: { name: '老王生日', date: '3-14', group_id: G },
  qq_birthday_list: { group_id: G },
  qq_remind: { minutes: 5, text: '喝水', group_id: G },
  qq_remind_list: { group_id: G },
  qq_pomodoro_start: { minutes: 25, group_id: G },
  qq_pomodoro_check: { group_id: G },
  qq_bj_start: { group_id: G },
  qq_bj_hit: { group_id: G },
  qq_bj_stand: { group_id: G },
  qq_bomb_start: { group_id: G },
  qq_bomb_try: { number: 50, group_id: G },
  qq_guess_start: { group_id: G },
  qq_guess_try: { number: 50, group_id: G },
  qq_idiom_start: { group_id: G },
  qq_idiom_next: { idiom: '马到成功', group_id: G },
  qq_wordle_start: { group_id: G },
  qq_wordle_try: { word: 'apple', group_id: G },
  qq_group_ban: { group_id: G, user_id: U, operator_id: U, minutes: 10 },
  qq_group_kick: { group_id: G, user_id: U, operator_id: U, confirm: true },
  qq_group_recall: { message_id: 123456 },
  qq_group_card: { group_id: G, user_id: U, card: '测试' },
  qq_group_title: { group_id: G, user_id: U, title: '测试' },
  qq_group_whole_ban: { group_id: G, enable: true, confirm: true, operator_id: U },
  qq_group_set_admin: { group_id: G, user_id: U, enable: true, confirm: true, operator_id: U },
  qq_group_notice: { group_id: G, content: '测试公告', operator_id: U },
  qq_group_info: { group_id: G },
  qq_group_members: { group_id: G, limit: 5 },
  qq_group_member: { group_id: G, user_id: U },
  qq_qzone_post: { content: '测试说说' },
  qq_qzone_list: {},
  qq_qzone_feeds: {},
  qq_qzone_delete: { tid: 'test' },

  qq_memory_save: { text: '小美不吃香菜', group_id: G, user_id: U },
  qq_memory_recall: { query: '香菜', group_id: G },
  qq_memory_card: { subject_id: U },
  qq_memory_forget: { subject_id: U, index: 1 },
  qq_tts: { text: '你好呀，这是一条测试语音', group_id: G },
  qq_imagine: { prompt: '赛博朋克风格的小猫，霓虹灯', group_id: G },
};

/* 需要 QQ 在线的工具：报这些错算环境问题 */
const BOT_ERRORS = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|当前 OneBot 实现/i;
/* 依赖公网的工具：超时/连不上算网络问题 */
const NET_ERRORS = /连不上|超时|timeout|ENOTFOUND|EAI_AGAIN|fetch failed|繁忙|限流|暂时不可用/i;
/* 没填 Key/地址：属于配置问题 */
const CFG_ERRORS = /还没配置|需要 API Key|接口地址|API Key/i;

function classify(err) {
  const msg = String((err && err.message) || err || '');
  if (BOT_ERRORS.test(msg)) return 'bot';
  if (CFG_ERRORS.test(msg)) return 'cfg';
  if (NET_ERRORS.test(msg)) return 'net';
  return 'fail';
}

async function main() {
  /* 数据隔离：临时目录，跑完删掉 */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-verify-'));
  process.env.QQBOT_STORE = tmp;

  const catalog = JSON.parse(fs.readFileSync(dataPath('plugins'), 'utf8'));
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {}

  /* 用假 OneBot 连接地址，避免误打真实 QQ */
  const onebot = async (action) => { throw new Error('fetch failed: 测试环境未启用 OneBot（' + action + '）'); };
  const ctx = (pluginId) => ({ onebot, bridge: wrapOnebot(onebot), config, cfg: (config.plugins || {})[pluginId] || {} });

  const rows = [];
  for (const meta of catalog) {
    if (meta.external) continue;   // 外部桌面程序没有 MCP 工具，跳过
    const file = path.join(ROOT, 'plugins', meta.id + '.mjs');
    if (!fs.existsSync(file)) { rows.push({ plugin: meta.id, tool: '-', status: 'fail', msg: '插件文件不存在' }); continue; }
    let mod;
    try { mod = await import(pathToFileURL(file).href); }
    catch (e) { rows.push({ plugin: meta.id, tool: '-', status: 'fail', msg: '加载失败: ' + e.message }); continue; }
    const def = mod.default || {};
    if (!Array.isArray(def.tools)) { rows.push({ plugin: meta.id, tool: '-', status: 'fail', msg: '无 tools 数组' }); continue; }

    for (const t of def.tools) {
      /* 无参工具（inputSchema.properties 为空）本来就不用示例参数，直接空对象调；
       * 以前这里一律查 SAMPLES，导致 qq_ping 这种零参工具被误判成「缺少示例参数」。 */
      const props = (t.inputSchema && t.inputSchema.properties) || {};
      const noArg = Object.keys(props).length === 0;
      const args = SAMPLES[t.name] ?? (noArg ? {} : null);
      if (args == null) { rows.push({ plugin: meta.id, tool: t.name, status: 'fail', msg: '缺少示例参数' }); continue; }
      const started = Date.now();
      try {
        /* 默认就在沙箱里跑：线上插件是跑在沙箱子进程里的，
         * 只在进程内 import 调用等于验了个线上不存在的环境。
         * 设 QQBOT_VERIFY_MODE=inline 可以退回老方式（排查沙箱本身的问题时用）。 */
        let text;
        if (USE_SANDBOX) {
          const r = await runSandboxed({
            hubRoot: ROOT,
            pluginId: meta.id,
            pluginFile: file,
            kind: 'tool',
            toolName: t.name,
            args,
            cfg: (config.plugins || {})[meta.id] || {},
            config: sanitizeConfig(config),
            permissions: (def.meta && def.meta.permissions) || [],
            host: {
              onebot: async (action) => { throw new Error('fetch failed: 测试环境未启用 OneBot（' + action + '）'); },
              probe: async () => ({ ok: false, error: '测试环境不探测' }),
              heartbeat: async () => ({ online: false, error: '测试环境不探测' }),
              log: () => {},
            },
            timeoutMs: 40000,
          });
          text = r.text;
        } else {
          const out = await t.run(JSON.parse(JSON.stringify(args)), ctx(meta.id));
          text = String(out == null ? '' : out);
        }
        if (!text.trim()) { rows.push({ plugin: meta.id, tool: t.name, status: 'fail', msg: '返回空内容' }); continue; }
        /* 插件自己提示「还没配置」：算配置问题，不算失败 */
        if (/还没配置|需要 API Key|去「⚙ 配置」/.test(text)) { rows.push({ plugin: meta.id, tool: t.name, status: 'cfg', msg: text.replace(/s+/g, ' ').slice(0, 80) }); continue; }
        /* 返回了内容但明确是「服务限流/没画出来」：算外部服务问题 */
        if (/没画出来|繁忙|限流|暂时不可用/.test(text)) { rows.push({ plugin: meta.id, tool: t.name, status: 'net', msg: text.replace(/s+/g, ' ').slice(0, 80) }); continue; }
        rows.push({ plugin: meta.id, tool: t.name, status: 'pass', ms: Date.now() - started, sample: text.replace(/\s+/g, ' ').slice(0, 70) });
      } catch (e) {
        const kind = classify(e);
        rows.push({ plugin: meta.id, tool: t.name, status: kind, msg: String(e.message || e).slice(0, 90) });
      }
    }
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  const pass = rows.filter((r) => r.status === 'pass');
  const bot = rows.filter((r) => r.status === 'bot');
  const net = rows.filter((r) => r.status === 'net');
  const cfgRows = rows.filter((r) => r.status === 'cfg');
  const fail = rows.filter((r) => r.status === 'fail');

  if (JSON_OUT) {
    console.log(JSON.stringify({
      total: rows.length,
      pass: pass.length,
      needBot: bot.length,
      needNet: net.length,
      needCfg: cfgRows.length,
      fail: fail.length,
      plugins: catalog.filter((m) => !m.external).length,
      rows,
    }, null, 2));
    process.exit(fail.length ? 1 : 0);
  }

  const icon = { pass: '✅', bot: '🔌', net: '🌐', cfg: '🔑', fail: '❌' };
  for (const r of rows) {
    const tag = icon[r.status] || '?';
    const detail = r.sample || r.msg || '';
    console.log(`${tag} ${(r.plugin + '/' + r.tool).padEnd(34)} ${detail}`);
  }
  console.log('');
  console.log('──────────────────────────────────────────');
  const mcpCount = catalog.filter((m) => !m.external).length;
  console.log(`插件 ${mcpCount} 个 · 工具 ${rows.length} 个${catalog.length > mcpCount ? `（另有 ${catalog.length - mcpCount} 个外部桌面程序，不参与实测）` : ''}`);
  console.log(`✅ 实测通过 ${pass.length}   🔌 需 QQ 在线 ${bot.length}   🔑 需配置 ${cfgRows.length}   🌐 需公网 ${net.length}   ❌ 失败 ${fail.length}`);
  if (fail.length) {
    console.log('\n失败明细：');
    for (const r of fail) console.log(`  ${r.plugin}/${r.tool}: ${r.msg}`);
  }
  console.log('──────────────────────────────────────────');
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error('测试脚本自身出错:', e); process.exit(1); });
