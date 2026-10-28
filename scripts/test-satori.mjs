#!/usr/bin/env node
/* ============================================================
 * test-satori.mjs —— Satori 适配器 + 统一协议层自测
 *
 *   node scripts/test-satori.mjs
 *
 * 两类用例，分开标注，绝不混为一谈：
 *
 *  【A】协议契约用例（本地 stub 服务端）
 *      验证我们发出去的请求长什么样、怎么解析响应。
 *      Satori 的字段名与错误文本都取自本机真实安装的
 *      @satorijs/plugin-server 2.9.1 与 @satorijs/protocol 1.7.0 源码，
 *      不是凭印象编的。但 stub 毕竟不是真平台，所以只证明"协议实现正确"。
 *
 *  【B】真实服务端用例（127.0.0.1:5141 的 Koishi Satori Server）
 *      证明适配器能连上真实服务端、并把真实错误码正确分类。
 *      服务端没起时跳过（打印 SKIP），不伪装成通过。
 *
 * 已知边界：本机没有可用的平台实例（QQ 适配器与 Koishi 4.18 存在
 *   @satorijs/core 版本冲突，官方也已弃用该适配器），所以"发消息成功"
 *   这一路径没有端到端实测，只有契约级验证。这一点在文档里同样标注。
 * ============================================================ */
'use strict';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSatori, SATORI_CAPABILITIES } from '../plugins/_satori.mjs';
import { createProtocol, protocolKind, PROTOCOLS } from '../plugins/_protocol.mjs';
import { createBridge } from '../plugins/_bridge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let pass = 0, fail = 0, skip = 0;
const ok = (name, extra = '') => { pass++; console.log('✅', name, extra); };
const bad = (name, why) => { fail++; console.log('❌', name, '→', why); };
const skipped = (name, why) => { skip++; console.log('⏭ ', name, '（跳过：' + why + '）'); };
const stopSrv = (srv) => { try { srv.closeAllConnections?.(); } catch { /* 低版本 Node */ } srv.close(); };

/* ---------- stub：严格按真实服务端的行为回应 ---------- */
function mockSatori(opts = {}) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const name = req.url.split('/v1/')[1] || '';
        const json = (() => { try { return JSON.parse(body || '{}'); } catch { return {}; } })();
        seen.push({ name, body: json, url: req.url, method: req.method, headers: req.headers });

        if (opts.hang) return;                                  // 不响应 → 测超时
        if (opts.invalidToken) { res.writeHead(403); return res.end('invalid token'); }
        if (opts.notLogin) { res.writeHead(403); return res.end('login not found'); }
        if (opts.badUrl) { res.writeHead(404); return res.end('Not Found'); }
        if (opts.status405) { res.writeHead(405); return res.end('Please use POST method to send requests.'); }

        const reply = (obj) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (name === 'login.get') {
          return reply({ login: { sn: 1, adapter: 'onebot', platform: 'onebot', status: 1, features: [], user: { id: opts.selfId || '3996086451', name: opts.name || '白渡' } } });
        }
        if (name === 'message.create') return reply({ id: 'msg-1', channel: { id: json.channel_id, type: 0 } });
        if (name === 'message.delete') return reply({});
        if (name === 'guild.list') return reply({ data: [{ id: '10001', name: '测试群' }] });
        if (name === 'guild.get') return reply({ guild: { id: json.guild_id, name: '测试群' } });
        if (name === 'guild.member.list') return reply({ data: [{ user: { id: '20001', name: '小明' }, nick: '群名片' }] });
        if (name === 'guild.member.mute') return reply({});
        if (name === 'guild.member.kick') return reply({});
        const m = /^([a-z]+)\.([a-z]+)$/.exec(name);
        if (!m) { res.writeHead(404); return res.end('method not found'); }
        res.writeHead(404); return res.end('method not found');
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, base: 'http://127.0.0.1:' + srv.address().port + '/satori' }));
  });
}

/* 找一个肯定没人监听的端口，用来测"连不上" */
async function closedPort() {
  return new Promise((resolve) => {
    const s = http.createServer(() => {});
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function main() {
  console.log('=== A. 协议契约用例（本地 stub，按真实服务端行为构造）===\n');

  /* 1~6：请求形态 */
  {
    const h = await mockSatori();
    const s = createSatori({ baseUrl: h.base, token: 'tok-abc', platform: 'onebot', selfId: '3996086451' });
    const r = await s.sendText({ groupId: 10001 }, '你好');
    const call = h.seen[0] || {};
    (call.method === 'POST' && call.url === '/satori/v1/message.create')
      ? ok('发文本走 POST /v1/message.create', '→ ' + call.method + ' ' + call.url)
      : bad('发文本路由', JSON.stringify({ m: call.method, u: call.url }));
    const auth = String(call.headers?.authorization || '');
    (auth === 'Bearer tok-abc') ? ok('鉴权头 Bearer 正确') : bad('鉴权头', auth);
    (call.headers?.['satori-platform'] === 'onebot' && call.headers?.['satori-user-id'] === '3996086451')
      ? ok('实例头 satori-platform / satori-user-id 齐全')
      : bad('实例头缺失', JSON.stringify({ p: call.headers?.['satori-platform'], u: call.headers?.['satori-user-id'] }));
    const arr = call.body?.content;
    (Array.isArray(arr) && arr[0]?.type === 'text' && arr[0]?.attrs?.content === '你好')
      ? ok('消息体是 Satori 元素数组', '→ ' + JSON.stringify(arr))
      : bad('消息体格式', JSON.stringify(arr));
    (call.body?.channel_id === '10001') ? ok('群号映射到 channel_id', '→ ' + call.body.channel_id) : bad('channel_id', JSON.stringify(call.body));
    (r.messageId === 'msg-1') ? ok('返回解析出 messageId', '→ ' + r.messageId) : bad('messageId 解析', JSON.stringify(r));
    stopSrv(h.srv);
  }

  /* 7：图片自动补 data URI */
  {
    const h = await mockSatori();
    const s = createSatori({ baseUrl: h.base, token: 't', selfId: '1' });
    await s.sendImage({ groupId: 1 }, 'AAAABBBB');
    const el = h.seen[0]?.body?.content?.[0];
    (el?.type === 'img' && String(el.attrs?.src).startsWith('data:image/png;base64,'))
      ? ok('裸 base64 自动补成 data URI')
      : bad('图片元素', JSON.stringify(el));
    await s.sendImage({ groupId: 1 }, 'https://x/y.png');
    const el2 = h.seen[1]?.body?.content?.[0];
    (el2?.attrs?.src === 'https://x/y.png') ? ok('URL 图片原样传') : bad('图片 URL', JSON.stringify(el2));
    stopSrv(h.srv);
  }

  /* 8~11：错误分类 */
  {
    const cases = [
      ['invalidToken', 'auth', 'wrong token 归类为鉴权错误'],
      ['notLogin', 'notlogin', '未登录实例归类为 notlogin'],
      ['badUrl', 'unsupported', '路径错归类为 unsupported'],
      ['status405', 'business', 'GET 方法错归类为 business'],
    ];
    for (const [flag, want, label] of cases) {
      const h = await mockSatori({ [flag]: true });
      const s = createSatori({ baseUrl: h.base, token: 't', selfId: '1' });
      try {
        await s.api('login.get', {});
        bad(label, '居然成功了');
      } catch (e) {
        (e.kind === want) ? ok(label, '→ kind=' + e.kind) : bad(label, 'kind=' + e.kind + ' msg=' + e.message);
      }
      stopSrv(h.srv);
    }
  }

  /* 12：连不上 → offline */
  {
    const p = await closedPort();
    const s = createSatori({ baseUrl: 'http://127.0.0.1:' + p + '/satori', token: 't', timeoutMs: 1500 });
    try {
      await s.api('login.get', {});
      bad('连不上归类为 offline', '居然成功了');
    } catch (e) {
      (e.kind === 'offline' && /连不上 Satori 服务端/.test(e.message))
        ? ok('连不上归类为 offline', '→ ' + e.message.slice(0, 40) + '…')
        : bad('offline 分类', 'kind=' + e.kind + ' ' + e.message);
    }
  }

  /* 13：超时 → timeout */
  {
    const h = await mockSatori({ hang: true });
    const s = createSatori({ baseUrl: h.base, token: 't', timeoutMs: 600 });
    try {
      await s.api('login.get', {});
      bad('超时归类为 timeout', '居然成功了');
    } catch (e) {
      (e.kind === 'timeout') ? ok('超时归类为 timeout', '→ ' + e.message.slice(0, 32) + '…') : bad('timeout 分类', e.kind + ' ' + e.message);
    }
    stopSrv(h.srv);
  }

  /* 14~16：群管理参数字段（单位换算是关键，Satori 用毫秒） */
  {
    const h = await mockSatori();
    const s = createSatori({ baseUrl: h.base, token: 't', selfId: '1' });
    await s.banMember('10001', '20001', 10);
    const mute = h.seen[0];
    (mute.name === 'guild.member.mute' && mute.body.duration === 600000)
      ? ok('禁言 10 分钟 → duration 600000 毫秒', '→ ' + mute.body.duration)
      : bad('禁言单位换算', JSON.stringify(mute.body));
    (mute.body.guild_id === '10001' && mute.body.user_id === '20001')
      ? ok('禁言字段 guild_id / user_id 正确')
      : bad('禁言字段名', JSON.stringify(mute.body));

    await s.kickMember('10001', '20001', true);
    const kick = h.seen[1];
    (kick.name === 'guild.member.kick' && kick.body.permanent === true)
      ? ok('踢人走 guild.member.kick + permanent')
      : bad('踢人字段', JSON.stringify(kick.body));

    await s.recall('msg-9');
    (h.seen[2].name === 'message.delete' && h.seen[2].body.message_id === 'msg-9')
      ? ok('撤回走 message.delete')
      : bad('撤回调用', JSON.stringify(h.seen[2]));
    stopSrv(h.srv);
  }

  /* 17~18：数据归一化 */
  {
    const h = await mockSatori();
    const s = createSatori({ baseUrl: h.base, token: 't', selfId: '1' });
    const groups = await s.listGroups();
    (groups.length === 1 && groups[0].groupId === '10001' && groups[0].name === '测试群')
      ? ok('群列表归一化为 groupId / name')
      : bad('群列表归一化', JSON.stringify(groups));
    const mem = await s.getMembers('10001');
    (mem[0]?.userId === '20001' && mem[0]?.nickname === '小明' && mem[0]?.card === '群名片')
      ? ok('成员列表归一化为 userId / nickname / card')
      : bad('成员归一化', JSON.stringify(mem));
    stopSrv(h.srv);
  }

  /* 19：探测 */
  {
    const h = await mockSatori({ selfId: '3996086451', name: '白渡' });
    const s = createSatori({ baseUrl: h.base, token: 't', platform: 'onebot' });
    const p = await s.probe();
    (p.ok && p.selfId === '3996086451' && p.nickname === '白渡' && p.impl === 'satori')
      ? ok('probe 解析出账号与昵称', '→ ' + p.selfId + ' / ' + p.nickname)
      : bad('probe 解析', JSON.stringify(p));
    const hb = await s.heartbeat({ force: true });
    (hb.online === true && hb.protocol === 'satori' && hb.hasToken === true)
      ? ok('heartbeat 结构含 protocol 与 hasToken')
      : bad('heartbeat 结构', JSON.stringify(hb));
    stopSrv(h.srv);
  }

  /* 20：明确不支持的动作必须报出来，不能假装成功 */
  {
    const h = await mockSatori();
    const s = createSatori({ baseUrl: h.base, token: 't' });
    const names = ['setNotice', 'getNotice', 'setCard', 'setTitle', 'wholeBan', 'setAdmin'];
    let allGood = true;
    for (const n of names) {
      try { await s[n](); allGood = false; bad('不支持动作应抛错：' + n, '没抛'); }
      catch (e) { if (e.kind !== 'unsupported') { allGood = false; bad('不支持动作类型：' + n, e.kind); } }
    }
    if (allGood) ok('6 个 Satori 不支持的动作均抛 unsupported', '→ ' + names.join(','));
    stopSrv(h.srv);
  }

  console.log('\n=== B. 统一协议层用例 ===\n');

  /* 21~23：协议选择与能力表 */
  {
    (protocolKind({}) === 'onebot') ? ok('默认协议是 onebot（老配置行为不变）') : bad('默认协议', protocolKind({}));
    (protocolKind({ protocol: 'satori' }) === 'satori') ? ok('显式指定 satori 生效') : bad('satori 选择', protocolKind({}));
    (protocolKind({ satori: { enabled: true } }) === 'satori') ? ok('satori.enabled 也能切过去') : bad('enabled 切换', '');

    const ob = createProtocol({ protocol: 'onebot', httpUrl: 'http://127.0.0.1:3000' });
    (ob.protocol === 'onebot' && ob.capabilities.notice === true)
      ? ok('OneBot 后端能力表：群公告可用')
      : bad('onebot 能力表', JSON.stringify(ob.capabilities));
    (ob.capabilities.wholeBan === true && ob.capabilities.setCard === true)
      ? ok('OneBot 后端能力表：全员禁言/群名片可用')
      : bad('onebot 能力缺失', '');
  }

  /* 24：两个后端暴露同一套语义方法（这是"统一抽象层"的核心承诺） */
  {
    const ob = createBridge({ httpUrl: 'http://127.0.0.1:3000' });
    const sa = createSatori({ baseUrl: 'http://127.0.0.1:9/satori' });
    const need = ['sendText', 'sendImage', 'getLoginInfo', 'getGroupInfo', 'getMembers', 'getMember',
      'banMember', 'kickMember', 'recall', 'setCard', 'setTitle', 'wholeBan', 'setAdmin', 'setNotice', 'getNotice'];
    const missOb = need.filter((k) => typeof ob[k] !== 'function');
    const missSa = need.filter((k) => typeof sa[k] !== 'function');
    (!missOb.length) ? ok('OneBot 后端实现全部 15 个语义方法') : bad('OneBot 缺方法', missOb.join(','));
    (!missSa.length) ? ok('Satori 后端实现全部 15 个语义方法', '（不支持的动作抛 unsupported 而不是缺失）') : bad('Satori 缺方法', missSa.join(','));
    const sameCaps = Object.keys(PROTOCOLS.onebot.capabilities).every((k) => k in PROTOCOLS.satori.capabilities);
    sameCaps ? ok('两个协议能力表键名一致，前端可统一渲染') : bad('能力表键不一致', '');
    (SATORI_CAPABILITIES.notice === false) ? ok('Satori 能力表如实标注 notice=false') : bad('能力表造假', '');
  }

  console.log('\n=== C. 真实服务端用例（本机 Koishi Satori Server）===\n');
  {
    /* 端口可用 SATORI_BASE 覆盖；默认 5142 是 runtimes/satori-srv 起的干净服务端 */
    const base = (process.env.SATORI_BASE || 'http://127.0.0.1:5142/satori').replace(/\/+$/, '');
    const tokFile = path.join(ROOT, 'runtimes', 'satori-srv', '.satori-token');
    const altTokFile = path.join(ROOT, 'runtimes', 'satori-lab', '.satori-token');
    let alive = false;
    try {
      const r = await fetch(base + '/v1/login.get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'satori-platform': 'onebot', 'satori-user-id': '0' },
        body: '{}',
        signal: AbortSignal.timeout(2500),
      });
      alive = r.status < 500;
    } catch { alive = false; }

    if (!alive) {
      skipped('真实服务端连通性', '服务端没在跑，先启动 runtimes/satori-srv');
      skipped('真实错误码分类', '同上');
    } else {
      ok('连上真实 Satori 服务端', '→ ' + base);
      const tokPath = fs.existsSync(tokFile) ? tokFile : (fs.existsSync(altTokFile) ? altTokFile : '');
      const tok = tokPath ? fs.readFileSync(tokPath, 'utf8').trim() : '';
      const s = createSatori({ baseUrl: base, token: tok, platform: 'onebot', selfId: '3996086451', timeoutMs: 4000 });
      try {
        const p = await s.probe();
        /* 本机没有可用平台实例，真实服务端会回 "login not found" —— 分类必须是 notlogin，不能是 offline */
        (p.ok === false && p.kind === 'notlogin')
          ? ok('真实服务端：无实例时分类为 notlogin（不是 offline）', '→ ' + p.error.slice(0, 46))
          : (p.ok === false
            ? bad('真实错误码分类', 'kind=' + p.kind + ' | ' + (p.error || '').slice(0, 50))
            : ok('真实服务端返回了在线实例', '→ ' + p.selfId + ' / ' + p.nickname));
      } catch (e) {
        bad('真实服务端探测', e.message);
      }
      /* 错 token 必须归到 auth */
      const badTok = createSatori({ baseUrl: base, token: 'definitely-wrong', platform: 'onebot', selfId: '3996086451', timeoutMs: 4000 });
      try {
        await badTok.api('login.get', {});
        skipped('真实服务端错误令牌分类', '服务端未开启 token 校验');
      } catch (e) {
        (e.kind === 'auth') ? ok('真实服务端：错令牌归类为 auth', '→ ' + e.message.slice(0, 38) + '…') : bad('错令牌分类', e.kind + ' | ' + e.message);
      }
      /* 不存在的方法必须是 unsupported，而不是被当成业务错误吞掉 */
      try {
        await s.api('foo.bar', {});
        bad('真实服务端：不存在的方法', '居然成功了');
      } catch (e) {
        (e.kind === 'unsupported') ? ok('真实服务端：不存在的方法归类为 unsupported') : bad('不存在方法分类', e.kind);
      }
    }
  }

  console.log('\n──────────────────────────────');
  console.log(`通过 ${pass} · 失败 ${fail}${skip ? ' · 跳过 ' + skip : ''}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.error('测试脚本出错:', e); process.exit(1); });
