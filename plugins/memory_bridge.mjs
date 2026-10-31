/* memory_bridge —— 把 memory-core（记忆大脑）接进本市场的工具层
 *
 * 它本身不存记忆，只做三件事：
 *   1. 调 memory-core 的 /recall 检索，按「归属标签」过滤后返回
 *   2. 调 /remember 写入，自动打上归属标签
 *   3. 提供统计，供市场页面显示
 *
 * 与 gateway 的约定一致：
 *   · 归属标签写在文本前缀：〔u|qq:10001〕 或 〔g|888〕，检索后剥掉
 *   · 群聊只允许 public/group 可见性，私聊三种都允许
 *
 * 依赖：本机跑着 memory-core（默认 http://127.0.0.1:8780）
 * 无第三方依赖。
 */
'use strict';
import { num, str } from './_lib.mjs';

const TAG_RE = /^〔([^〕]{1,60})〕/;
const splitTag = (t) => { const i = t.indexOf('|'); return i < 0 ? [t, ''] : [t.slice(0, i), t.slice(i + 1)]; };
const stripTag = (t) => String(t || '').replace(TAG_RE, '').trim();

const cfgOf = (ctx) => (ctx && ctx.cfg) || {};
const coreUrl = (ctx) => str(cfgOf(ctx).coreUrl || 'http://127.0.0.1:8780').replace(/\/+$/, '');
const tokenOf = (ctx) => str(cfgOf(ctx).coreToken || '');

async function coreCall(ctx, endpoint, payload, method = 'POST') {
  const headers = { 'Content-Type': 'application/json' };
  if (tokenOf(ctx)) headers.Authorization = 'Bearer ' + tokenOf(ctx);
  let res;
  try {
    res = await fetch(coreUrl(ctx) + endpoint, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(6000),
    });
  } catch (e) {
    throw new Error(`连不上记忆引擎（${coreUrl(ctx)}）：确认「⚙ 配置」里的接口地址填对了，且 memory-core 已启动`);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('记忆引擎返回非 JSON：' + text.slice(0, 120)); }
  if (!res.ok || data.status === 'error') throw new Error(data.message || ('HTTP ' + res.status));
  return data.data !== undefined ? data.data : data;
}

/** 归属：群聊记到群上，私聊记到人上 */
function ownerTag(uid, gid, channel) {
  return (channel === 'group' && gid) ? `g|${gid}` : `u|qq:${uid || 'unknown'}`;
}

export default {
  meta: {
    id: 'memory_bridge',
    name: 'memory_bridge',
    description: '记忆大脑：把 memory-core 接进来，支持长期记忆检索/写入/统计（按人隔离、按群隔离）',
    category: '群互动',
  },

  settings: {
    title: '记忆大脑（memory-core）',
    intro: '需要先在本机跑 memory-core（AstrBot 生态那套记忆引擎）。没启动时工具会明确提示。',
    fields: [
      { key: 'coreUrl', label: '记忆引擎地址', type: 'text', placeholder: 'http://127.0.0.1:8780', help: 'memory-core 的 HTTP 地址，默认 8780' },
      { key: 'coreToken', label: '访问令牌', type: 'password', placeholder: 'local-token', help: '启动 memory-core 时设的 MEMORY_TOKEN' },
      { key: 'k', label: '每次召回条数', type: 'number', default: 5 },
      { key: 'minScore', label: '相关度门槛', type: 'number', default: 0.35, help: '低于这个分数的记忆不返回，避免噪声' },
      { key: 'autoTag', label: '自动打归属标签', type: 'boolean', default: true, help: '写入时自动加〔u|qq:xxx〕，检索时按它过滤，实现按人隔离' },
    ],
  },

  tools: [
    {
      name: 'mem_recall',
      description: '回忆和当前话题相关的旧事。群友问"你还记得…吗""上次说的"时用。会自动过滤掉不属于这个人的记忆。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索关键词或整句话' },
          k: { type: 'number', description: '返回几条，默认 5' },
          group_id: { type: 'number', description: '群号（群聊时传，群聊不返回 private 记忆）' },
          user_id: { type: 'number', description: '当前说话人 QQ 号' },
        },
        required: ['query'],
      },
      run: async (a, ctx) => {
        const c = cfgOf(ctx);
        const gid = num(a.group_id);
        const uid = num(a.user_id);
        const channel = gid ? 'group' : 'private';
        const k = Math.min(Math.max(Math.trunc(num(a.k) || num(c.k) || 5), 1), 12);
        const minScore = Number.isFinite(Number(c.minScore)) ? Number(c.minScore) : 0.35;

        const data = await coreCall(ctx, '/recall', {
          query: str(a.query),
          k: Math.max(k * 2, 8),
          visibility: channel === 'group' ? ['public', 'group'] : ['public', 'private', 'group'],
        });

        const autoTag = c.autoTag !== false;
        const picked = (data.hits || [])
          .filter((h) => {
            if (!autoTag) return true;
            const tag = (TAG_RE.exec(h.text) || [])[1];
            if (!tag) return true;                       // 无标签 = 全局
            const [kind, val] = splitTag(tag);
            if (kind === 'u') return String(val) === `qq:${uid || 'unknown'}`;
            if (kind === 'g') return gid && String(val) === String(gid);
            return true;
          })
          .filter((h) => Number(h.score || 0) >= minScore)
          .slice(0, k);

        if (!picked.length) return `没找到和「${str(a.query)}」相关的记忆。`;
        return '🧠 我想起来了：\n' + picked
          .map((h, i) => `${i + 1}. ${stripTag(h.text)}　（${h.kind}，相关度 ${h.score}）`)
          .join('\n');
      },
    },
    {
      name: 'mem_remember',
      description: '记一条长期记忆。群友说"记住…""别忘了…"时用。会自动打上归属标签，避免别人看到。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要记住的内容，一句话说清' },
          kind: { type: 'string', description: 'episode 事件 / fact 事实 / preference 偏好 / relation 关系 / skill 做法' },
          importance: { type: 'number', description: '重要程度 0-1，默认 0.5；约定和偏好建议 0.7' },
          group_id: { type: 'number', description: '群号（群聊时传）' },
          user_id: { type: 'number', description: '当前说话人 QQ 号' },
        },
        required: ['text'],
      },
      run: async (a, ctx) => {
        const c = cfgOf(ctx);
        const text = str(a.text).slice(0, 800);
        if (!text) return '要记什么？把内容说清楚。';
        const gid = num(a.group_id);
        const uid = num(a.user_id);
        const channel = gid ? 'group' : 'private';
        const tag = ownerTag(uid, gid, channel);
        const body = c.autoTag === false ? text : `〔${tag}〕${text}`;
        const kind = ['episode', 'fact', 'preference', 'relation', 'skill'].includes(str(a.kind)) ? str(a.kind) : 'fact';
        const imp = Number.isFinite(num(a.importance)) ? Math.min(Math.max(num(a.importance), 0.05), 1) : 0.5;

        const r = await coreCall(ctx, '/remember', {
          text: body,
          kind,
          importance: imp,
          visibility: channel === 'group' ? 'public' : 'private',
        });
        return `🧠 记住了（#${r && r.id != null ? r.id : '?'}，${kind}，重要度 ${imp}）`;
      },
    },
    {
      name: 'mem_stats',
      description: '看记忆库的规模：总共多少条、各类型多少、平均重要度。',
      inputSchema: { type: 'object', properties: {} },
      run: async (a, ctx) => {
        const s = await coreCall(ctx, '/stats', null, 'GET');
        const kinds = s.kinds || {};
        return `📊 记忆库：${s.active || 0} 条（归档 ${s.archived || 0}）\n` +
          `类型：${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(' · ') || '空'}\n` +
          `实体 ${s.entities || 0} · 关系 ${s.relations || 0} · 向量 ${s.vectors || 0}\n` +
          `平均重要度：${s.avg_importance != null ? s.avg_importance : '-'}`;
      },
    },
  ],
};
