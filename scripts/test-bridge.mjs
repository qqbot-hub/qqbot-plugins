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
import { createBridge, classifyError } from '../plugins/_bridge.mjs';

let pass = 0, fail = 0;
const ok = (name, extra = '') => { pass++; console.log('✅', name, extra); };
const bad = (name, why) => { fail++; console.log('❌', name, '→', why); };
/* 关服务器：先断掉所有连接，避免「不响应」用例把进程挂住 */
const stop = (m) => { try { m.srv.closeAllConnections?.(); } catch { /* 低版本 Node */ } m.srv.close(); };

/* 起一个假协议端，行为由 opts 决定 */
function mockServer(opts = {}) {
  return new Promise((resolve) => {
    const seen = [];
    const send = (res, data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    };
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const action = req.url.split('?')[0].split('/').pop();
        const params = JSON.parse(body || '{}');
        seen.push({ action, params, url: req.url, headers: req.headers });

        if (opts.hang) return;                       // 永不响应：用来测超时
        if (opts.status === 401) { res.writeHead(401); return res.end('unauthorized'); }
        /* 端口被别的程序占着时最常见的样子：回一个 HTML 404 页面，而不是 OneBot 响应 */
        if (opts.html404) {
          res.writeHead(404, { 'Content-Type': 'text/html' });
          return res.end('<!doctype html><meta charset="utf-8"><h1>404</h1><p>Not Found</p>');
        }
        /* 登录信息 / 版本：探测用，固定返回标准形态，和报文格式用例解耦 */
        if (action === 'get_login_info') return send(res, { user_id: opts.selfId || 10001, nickname: opts.nickname || '测试号' });
        if (action === 'get_version_info') return send(res, { app_name: opts.appName || 'NapCatQQ', app_version: '1.0.0', protocol_version: 'v11' });
        if (opts.failed) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'failed', retcode: 100, wording: opts.failed }));
        }
        if (opts.noticeOnly && action === '_send_group_notice') {
          /* 模拟"只认 send_group_notice、不认 _send_group_notice"的实现 */
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'failed', retcode: 1404, wording: '未知动作 _send_group_notice' }));
        }
        if (opts.noNotice && /notice/i.test(action)) {
          /* 模拟"所有公告动作都没实现"的实现 */
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'failed', retcode: 1404, wording: 'unknown action ' + action }));
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
    stop(m);
  }

  /* ② 鉴权：header */
  {
    const m = await mockServer({});
    await createBridge({ httpUrl: m.url, accessToken: 'tok', authMode: 'header' }).sendText({ groupId: 1 }, 'x');
    const auth = m.seen[0].headers.authorization;
    auth === 'Bearer tok' ? ok('鉴权 header', '→ ' + auth) : bad('鉴权 header', String(auth));
    stop(m);
  }

  /* ③ 鉴权：query */
  {
    const m = await mockServer({});
    await createBridge({ httpUrl: m.url, accessToken: 'tok', authMode: 'query' }).sendText({ groupId: 1 }, 'x');
    const url = m.seen[0].url;
    /access_token=tok/.test(url) && !m.seen[0].headers.authorization
      ? ok('鉴权 query', '→ ' + url)
      : bad('鉴权 query', url + ' | auth=' + m.seen[0].headers.authorization);
    stop(m);
  }

  /* ④ 不鉴权 */
  {
    const m = await mockServer({});
    await createBridge({ httpUrl: m.url, accessToken: 'tok', authMode: 'none' }).sendText({ groupId: 1 }, 'x');
    (!m.seen[0].headers.authorization && !/access_token/.test(m.seen[0].url))
      ? ok('鉴权 none', '→ 未携带任何凭据')
      : bad('鉴权 none', '仍带了凭据');
    stop(m);
  }

  /* ⑤ 业务失败 → 错误信息可读 */
  {
    const m = await mockServer({ failed: '群号不存在' });
    try { await createBridge({ httpUrl: m.url }).banMember(1, 2, 10); bad('业务失败提示', '没有抛错'); }
    catch (e) { /群号不存在/.test(e.message) ? ok('业务失败提示', '→ ' + e.message) : bad('业务失败提示', e.message); }
    stop(m);
  }

  /* ⑥ 401 → 提示 Token 问题 */
  {
    const m = await mockServer({ status: 401 });
    try { await createBridge({ httpUrl: m.url }).sendText({ groupId: 1 }, 'x'); bad('401 提示', '没有抛错'); }
    catch (e) { /AccessToken/.test(e.message) ? ok('401 提示', '→ ' + e.message) : bad('401 提示', e.message); }
    stop(m);
  }

  /* ⑦ 连不上 → 提示检查协议端 */
  {
    try { await createBridge({ httpUrl: 'http://127.0.0.1:9' }).sendText({ groupId: 1 }, 'x'); bad('连接失败提示', '没有抛错'); }
    catch (e) { /协议端|连不上/.test(e.message) ? ok('连接失败提示', '→ ' + e.message.slice(0, 40)) : bad('连接失败提示', e.message); }
  }

  /* ⑦-2 端口被别的程序占着：返回 HTML 404 时，错误文案不能再糊一段 HTML 给用户。
   * 以前这里是 `返回 404：<!doctype html>…`，页面上一片标签，看不出真正原因。 */
  {
    const m = await mockServer({ html404: true });
    try { await createBridge({ httpUrl: m.url }).sendText({ groupId: 1 }, 'x'); bad('HTML 404 提示', '没有抛错'); }
    catch (e) {
      const hasTag = /<[a-z!\/]/i.test(e.message) || /doctype/i.test(e.message);
      (!hasTag && /不是 OneBot 响应/.test(e.message))
        ? ok('HTML 404 提示', '→ ' + e.message)
        : bad('HTML 404 提示', '错误文案里仍有 HTML：' + e.message);
    }
    stop(m);
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
    stop(m);
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
    stop(m);
  }

  /* ⑩ 动作名学会就记住：第二次不再撞错的名字 */
  {
    const m = await mockServer({ noticeOnly: true });
    const br = createBridge({ httpUrl: m.url });
    try {
      await br.setNotice(1, '第一次');
      const first = m.seen.length;
      await br.setNotice(1, '第二次');
      const second = m.seen.length - first;
      const lastName = m.seen[m.seen.length - 1].action;
      (first === 2 && second === 1 && lastName === 'send_group_notice')
        ? ok('动作名学会就记住', `→ 首次试 ${first} 次，之后只用 ${lastName}（${second} 次请求）`)
        : bad('动作名学会就记住', `first=${first} second=${second} last=${lastName}`);
    } catch (e) { bad('动作名学会就记住', e.message); }
    stop(m);
  }

  /* ⑪ 全部名字都不通 → 明确报「没有这个动作」，且归类为 unsupported */
  {
    const m = await mockServer({ noNotice: true });
    try {
      await createBridge({ httpUrl: m.url }).setNotice(1, '公告');
      bad('动作名全不通的报错', '没有抛错');
    } catch (e) {
      const kind = classifyError(e).kind;
      (/没有这个动作/.test(e.message) && kind === 'unsupported')
        ? ok('动作名全不通的报错', '→ 尝试 ' + m.seen.length + ' 个名字，归类 ' + kind)
        : bad('动作名全不通的报错', kind + ' | ' + e.message);
    }
    stop(m);
  }

  /* ⑫ 错误分类：离线 / 鉴权 / 不支持 / 超时 */
  {
    const kinds = {
      offline: classifyError(new Error('连不上协议端（http://127.0.0.1:9）')).kind,
      auth: classifyError(new Error('send_group_msg 失败：被拒绝（401）：AccessToken 不对')).kind,
      unsupported: classifyError(new Error('x 失败：unknown action')).kind,
      timeout: classifyError(new Error('x 失败：超时（200ms 没响应）')).kind,
      business: classifyError(new Error('set_group_ban 失败：群号不存在')).kind,
    };
    const want = { offline: 'offline', auth: 'auth', unsupported: 'unsupported', timeout: 'timeout', business: 'business' };
    const wrong = Object.keys(want).filter((k) => kinds[k] !== want[k]);
    wrong.length === 0
      ? ok('错误分类 5 类', '→ ' + Object.keys(kinds).map((k) => k + '=' + kinds[k]).join(' '))
      : bad('错误分类 5 类', '不对的：' + wrong.map((k) => k + '=' + kinds[k]).join(','));
  }

  /* ⑬ getLoginInfo：拿到 QQ 号和昵称，并记住 selfId */
  {
    const m = await mockServer({ selfId: 3996086451, nickname: '白渡' });
    const br = createBridge({ httpUrl: m.url });
    try {
      const info = await br.getLoginInfo();
      (info.selfId === 3996086451 && info.nickname === '白渡' && br.selfId === 3996086451)
        ? ok('登录信息 getLoginInfo', `→ ${info.nickname} / QQ ${info.selfId}`)
        : bad('登录信息 getLoginInfo', JSON.stringify(info) + ' selfId=' + br.selfId);
    } catch (e) { bad('登录信息 getLoginInfo', e.message); }
    stop(m);
  }

  /* ⑭ 心跳：在线 → 在线状态 + 实现名 + 延迟 + 时间戳 */
  {
    const m = await mockServer({ appName: 'NapCatQQ', selfId: 10086, nickname: '小号' });
    try {
      const hb = await createBridge({ httpUrl: m.url }).heartbeat({ force: true });
      (hb.online === true && hb.impl === 'napcat' && typeof hb.latencyMs === 'number' && !!Date.parse(hb.checkedAt))
        ? ok('心跳（在线）', `→ ${hb.impl} · ${hb.nickname} · ${hb.latencyMs}ms`)
        : bad('心跳（在线）', JSON.stringify(hb));
    } catch (e) { bad('心跳（在线）', e.message); }
    stop(m);
  }

  /* ⑮ 心跳：离线 → online=false + 可读错误，不抛异常 */
  {
    try {
      const hb = await createBridge({ httpUrl: 'http://127.0.0.1:9', timeoutMs: 800 }).heartbeat({ force: true });
      (hb.online === false && /协议端/.test(hb.error || ''))
        ? ok('心跳（离线）', '→ ' + String(hb.error).slice(0, 34))
        : bad('心跳（离线）', JSON.stringify(hb));
    } catch (e) { bad('心跳（离线）', '不该抛异常：' + e.message); }
  }

  /* ⑯ 路径前缀 + 超时分类 */
  {
    const m = await mockServer({});
    await createBridge({ httpUrl: m.url, pathPrefix: '/onebot/v11' }).sendText({ groupId: 1 }, 'x');
    /^\/onebot\/v11\/send_group_msg/.test(m.seen[0].url || '')
      ? ok('路径前缀 pathPrefix', '→ ' + m.seen[0].url)
      : bad('路径前缀 pathPrefix', m.seen[0].url);
    stop(m);

    const h = await mockServer({ hang: true });
    try {
      await createBridge({ httpUrl: h.url, timeoutMs: 400 }).sendText({ groupId: 1 }, 'x');
      bad('超时提示', '没有抛错');
    } catch (e) {
      const kind = classifyError(e).kind;
      (kind === 'timeout' && /超时/.test(e.message))
        ? ok('超时提示', '→ ' + e.message.slice(0, 34))
        : bad('超时提示', kind + ' | ' + e.message);
    }
    stop(h);
  }

  console.log('\n──────────────────────────────');
  console.log(`通过 ${pass} · 失败 ${fail}`);
  process.exitCode = fail ? 1 : 0;   // 让事件循环自然退出，避免 Windows 上 libuv 断言
}

main().catch((e) => { console.error('测试脚本出错:', e); process.exit(1); });
