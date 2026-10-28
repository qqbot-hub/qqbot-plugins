#!/usr/bin/env node
/* ============================================================
 * test-bridge.mjs —— 协议端适配层自测
 *
 *   node scripts/test-bridge.mjs
 *
 * 用本地假服务器模拟不同 OneBot v11 实现的差异：
 *   · 响应格式：{status:'ok',data} / {retcode:0,data} / 裸数据
 *   · 鉴权方式：Authorization 头 / ?access_token= / 不鉴权
 *   · 失败响应：{status:'failed',wording} / 401
 *   · 群公告动作名兜底：_send_group_notice → send_group_notice
 * ============================================================ */
'use strict';

import http from 'node:http';
import { createBridge } from '../plugins/_bridge.mjs';

let pass = 0, fail = 0;
const ok = (name, extra = '') => { pass++; console.log('✅', name, extra); };
const bad = (name, why) => { fail++; console.log('❌', name, '→', why); };

/* 起一个假协议端，行为由 opts 决定 */
function mockServer(opts = {}) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const action = req.url.split('?')[0].split('/').pop();
        const params = JSON.parse(body || '{}');
        seen.push({ action, params, url: req.url, headers: req.headers });

        if (opts.status === 401) { res.writeHead(401); return res.end('unauthorized'); }
        if (opts.failed) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'failed', retcode: 100, wording: opts.failed }));
        }
        if (opts.noticeOnly && action === '_send_group_notice') {
          /* 模拟"只认 send_group_notice、不认 _send_group_notice"的实现 */
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'failed', retcode: 1404, wording: '未知动作 _send_group_notice' }));
        }
        if (opts.noticeOnly && !/notice/.test(action)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'failed', retcode: 1404, wording: 'action not found' }));
        }
        let payload;
        if (opts.shape === 'retcode') payload = { retcode: 0, status: 'ok', data: { message_id: 2, action } };
        else if (opts.shape === 'bare') payload = { message_id: 3, action };
        else payload = { status: 'ok', retcode: 0, data: { message_id: 1, action } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: 'http://127.0.0.1:' + srv.address().port, seen }));
  });
}

async function main() {
  /* ① 三种响应格式 */
  for (const shape of ['status', 'retcode', 'bare']) {
    const m = await mockServer({ shape });
    try {
      const r = await createBridge({ httpUrl: m.url }).sendText({ groupId: 1 }, 'hi');
      const id = r && (r.message_id || (r.data && r.data.message_id));
      id ? ok('响应格式 ' + shape, '→ message_id=' + id) : bad('响应格式 ' + shape, JSON.stringify(r));
    } catch (e) { bad('响应格式 ' + shape, e.message); }
    m.srv.close();
  }

  /* ② 鉴权：header */
  {
    const m = await mockServer({});
    await createBridge({ httpUrl: m.url, accessToken: 'tok', authMode: 'header' }).sendText({ groupId: 1 }, 'x');
    const auth = m.seen[0].headers.authorization;
    auth === 'Bearer tok' ? ok('鉴权 header', '→ ' + auth) : bad('鉴权 header', String(auth));
    m.srv.close();
  }

  /* ③ 鉴权：query */
  {
    const m = await mockServer({});
    await createBridge({ httpUrl: m.url, accessToken: 'tok', authMode: 'query' }).sendText({ groupId: 1 }, 'x');
    const url = m.seen[0].url;
    /access_token=tok/.test(url) && !m.seen[0].headers.authorization
      ? ok('鉴权 query', '→ ' + url)
      : bad('鉴权 query', url + ' | auth=' + m.seen[0].headers.authorization);
    m.srv.close();
  }

  /* ④ 不鉴权 */
  {
    const m = await mockServer({});
    await createBridge({ httpUrl: m.url, accessToken: 'tok', authMode: 'none' }).sendText({ groupId: 1 }, 'x');
    (!m.seen[0].headers.authorization && !/access_token/.test(m.seen[0].url))
      ? ok('鉴权 none', '→ 未携带任何凭据')
      : bad('鉴权 none', '仍带了凭据');
    m.srv.close();
  }

  /* ⑤ 业务失败 → 错误信息可读 */
  {
    const m = await mockServer({ failed: '群号不存在' });
    try { await createBridge({ httpUrl: m.url }).banMember(1, 2, 10); bad('业务失败提示', '没有抛错'); }
    catch (e) { /群号不存在/.test(e.message) ? ok('业务失败提示', '→ ' + e.message) : bad('业务失败提示', e.message); }
    m.srv.close();
  }

  /* ⑥ 401 → 提示 Token 问题 */
  {
    const m = await mockServer({ status: 401 });
    try { await createBridge({ httpUrl: m.url }).sendText({ groupId: 1 }, 'x'); bad('401 提示', '没有抛错'); }
    catch (e) { /AccessToken/.test(e.message) ? ok('401 提示', '→ ' + e.message) : bad('401 提示', e.message); }
    m.srv.close();
  }

  /* ⑦ 连不上 → 提示检查协议端 */
  {
    try { await createBridge({ httpUrl: 'http://127.0.0.1:9' }).sendText({ groupId: 1 }, 'x'); bad('连接失败提示', '没有抛错'); }
    catch (e) { /协议端|连不上/.test(e.message) ? ok('连接失败提示', '→ ' + e.message.slice(0, 40)) : bad('连接失败提示', e.message); }
  }

  /* ⑧ 群公告动作名兜底 */
  {
    const m = await mockServer({ noticeOnly: true });
    try {
      await createBridge({ httpUrl: m.url }).setNotice(1, '公告内容');
      const tried = m.seen.map((s) => s.action).join(' → ');
      m.seen.length === 2 && /^_send_group_notice → send_group_notice$/.test(tried)
        ? ok('群公告动作名兜底', '→ 依次尝试: ' + tried)
        : bad('群公告动作名兜底', '尝试序列不符: ' + tried);
    } catch (e) { bad('群公告动作名兜底', e.message + ' | ' + m.seen.map((s) => s.action).join(',')); }
    m.srv.close();
  }

  /* ⑨ 高层方法参数是否正确 */
  {
    const m = await mockServer({});
    const br = createBridge({ httpUrl: m.url });
    await br.banMember(100, 200, 10);
    const p = m.seen[0].params;
    (m.seen[0].action === 'set_group_ban' && p.group_id === 100 && p.user_id === 200 && p.duration === 600)
      ? ok('禁言参数换算', '→ 10 分钟 = ' + p.duration + ' 秒')
      : bad('禁言参数换算', JSON.stringify(m.seen[0]));
    m.srv.close();
  }

  console.log('\n──────────────────────────────');
  console.log(`通过 ${pass} · 失败 ${fail}`);
  process.exitCode = fail ? 1 : 0;   // 让事件循环自然退出，避免 Windows 上 libuv 断言
}

main().catch((e) => { console.error('测试脚本出错:', e); process.exit(1); });
