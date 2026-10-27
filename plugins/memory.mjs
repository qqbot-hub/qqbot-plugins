/* memory —— 机器人长期记忆：人物画像 / 长期事实 / 熟悉度与好感
 *
 * 对标 AstrBot 社区的记忆类插件（memory_beyond / iris_memory / mnemosyne），
 * 但这里不依赖向量库和 Embedding 模型：用「关键词分片 + 时间衰减」做检索，
 * 纯 JSON 落盘，零第三方依赖，装好就能用。
 *
 * 数据形状（data/store/memory/db.json）：
 *   {
 *     people: { "<uid>": { name, familiarity, affection, first, last, facts: [{ text, at, w }] } },
 *     groups: { "<gid>": { notes: [{ text, at, w }] } }
 *   }
 */
'use strict';
import { storage, sessionOf, num, str } from './_lib.mjs';

const MAX_FACTS = 120;          // 每人最多记多少条
const HALF_LIFE_DAYS = 60;      // 记忆权重半衰期

const load = () => storage('memory').get('db', { people: {}, groups: {} });
const save = (db) => storage('memory').set('db', db);

function ensurePerson(db, uid) {
  const k = String(uid);
  const p = db.people || (db.people = {});
  if (!p[k]) {
    p[k] = { name: '', familiarity: 0, affection: 50, first: Date.now(), last: Date.now(), facts: [] };
  }
  return p[k];
}

function ensureGroup(db, gid) {
  const k = String(gid);
  const g = db.groups || (db.groups = {});
  if (!g[k]) g[k] = { notes: [] };
  return g[k];
}

/* 中文按 2 字切片、英文按单词切片，做轻量关键词匹配（不引入分词库） */
function grams(text) {
  const out = new Set();
  const t = String(text || '').toLowerCase();
  const parts = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const w of parts) {
    if (/^[a-z0-9]+$/.test(w)) {
      out.add(w);
      continue;
    }
    out.add(w);
    for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2));
  }
  return out;
}

/* 关键词命中数 × 权重 × 时间衰减 */
function score(item, qGrams, now) {
  if (!qGrams.size) return 1;
  const g = grams(item.text);
  let hit = 0;
  for (const q of qGrams) if (g.has(q)) hit++;
  if (!hit) return 0;
  const days = (now - (item.at || now)) / 86400000;
  const decay = Math.pow(0.5, days / HALF_LIFE_DAYS);
  return hit * (item.w || 1) * (0.35 + 0.65 * decay);
}

const ago = (ts) => {
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d <= 0) return '今天';
  if (d === 1) return '昨天';
  if (d < 30) return d + ' 天前';
  return Math.floor(d / 30) + ' 个月前';
};

export default {
  meta: {
    id: 'memory',
    name: 'memory',
    description: '长期记忆：记住关于某人的事、群里的约定，能按关键词回忆，并维护熟悉度/好感度',
    category: '群互动',
  },

  settings: {
    title: '记忆插件',
    intro: '记忆存在本机的 data/store/memory/ 里，不上传任何地方。可以随时清空某个人的档案。',
    fields: [
      { key: 'maxFacts', label: '每人最多记多少条', type: 'number', default: 120, help: '超出后会挤掉权重最低的旧记忆' },
      { key: 'allowGroups', label: '允许记群笔记的群号', type: 'list', placeholder: '每行一个群号，留空=所有群', help: '留空表示不做限制' },
    ],
  },

  tools: [
    {
      name: 'qq_memory_save',
      description: '记住一条长期事实（如某人的喜好、生日、约定、群规）。群友说"记住…""别忘了…"时用。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要记住的内容，写成一句完整的事实' },
          subject_id: { type: 'number', description: '这条事实关于谁（QQ 号）；不填则记到当前说话人头上' },
          subject_name: { type: 'string', description: '这个人的昵称，可留空' },
          weight: { type: 'number', description: '重要程度 1-3，默认 1；越重要越不容易被挤掉' },
          group_id: { type: 'number', description: '群号（群聊时传，会同时记进群笔记）' },
          user_id: { type: 'number', description: '当前说话人 QQ 号' },
        },
        required: ['text'],
      },
      run: (a) => {
        const text = str(a.text).slice(0, 200);
        if (!text) return '要记什么呀？把内容说清楚一点。';
        const sess = sessionOf(a);
        const uid = num(a.subject_id) || sess.userId;
        if (!uid) return '缺 user_id：这条记忆要记到谁头上？';
        const db = load();
        const p = ensurePerson(db, uid);
        if (a.subject_name) p.name = str(a.subject_name).slice(0, 24);
        const w = Math.min(Math.max(num(a.weight) || 1, 1), 3);
        p.facts.push({ text, at: Date.now(), w });
        p.familiarity = (p.familiarity || 0) + 1;
        p.last = Date.now();
        if (p.facts.length > MAX_FACTS) {
          p.facts.sort((x, y) => score(y, new Set(), Date.now()) - score(x, new Set(), Date.now()));
          p.facts.length = MAX_FACTS;
        }
        if (sess.type === 'group' && sess.groupId) {
          const g = ensureGroup(db, sess.groupId);
          g.notes.push({ text, at: Date.now(), w, by: sess.userId || 0 });
          if (g.notes.length > 300) g.notes.splice(0, g.notes.length - 300);
        }
        save(db);
        return `🧠 记住了：${text}（${p.name || 'QQ' + uid} · 第 ${p.facts.length} 条）`;
      },
    },
    {
      name: 'qq_memory_recall',
      description: '回忆记忆。群友问"你还记得…吗""上次说的…"时用；不给关键词则返回最近记住的内容。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，比如 生日 / 不吃辣 / 上次那家店' },
          subject_id: { type: 'number', description: '只看某个人的记忆（QQ 号），可留空' },
          group_id: { type: 'number', description: '只看这个群的笔记，可留空' },
          limit: { type: 'number', description: '最多返回几条，默认 5' },
        },
      },
      run: (a) => {
        const q = grams(str(a.query));
        const lim = Math.min(Math.max(Math.trunc(num(a.limit) || 5), 1), 12);
        const db = load();
        const now = Date.now();
        const bucket = [];

        const uids = a.subject_id ? [String(num(a.subject_id))] : Object.keys(db.people || {});
        for (const uid of uids) {
          const p = db.people[uid];
          if (!p) continue;
          for (const f of p.facts) {
            const s = score(f, q, now);
            if (s > 0) bucket.push({ s, text: f.text, at: f.at, who: p.name || 'QQ' + uid });
          }
        }
        if (a.group_id) {
          const g = (db.groups || {})[String(num(a.group_id))];
          if (g) for (const n of g.notes) {
            const s = score(n, q, now);
            if (s > 0) bucket.push({ s, text: n.text, at: n.at, who: '群笔记' });
          }
        }

        if (!bucket.length) {
          return q.size
            ? `没找到和「${str(a.query)}」相关的记忆。（可以让我先记一条：qq_memory_save）`
            : '还没有任何记忆。让我记点什么吧。';
        }
        bucket.sort((x, y) => y.s - x.s || y.at - x.at);
        return '🧠 我想起来了：\n' + bucket.slice(0, lim)
          .map((r, i) => `${i + 1}. ${r.text}　—— ${r.who}，${ago(r.at)}`)
          .join('\n');
      },
    },
    {
      name: 'qq_memory_card',
      description: '看某人的印象卡：熟悉度、好感度、记了多少条、最近说过什么。',
      inputSchema: {
        type: 'object',
        properties: { subject_id: { type: 'number', description: '看谁的（QQ 号）' } },
        required: ['subject_id'],
      },
      run: (a) => {
        const uid = String(num(a.subject_id));
        const p = (load().people || {})[uid];
        if (!p) return `对 QQ${uid} 还没有任何印象——还没聊过，或者没让我记过。`;
        const fam = p.familiarity || 0;
        const tier = fam >= 60 ? '老朋友' : fam >= 25 ? '熟人' : fam >= 8 ? '认识' : '陌生';
        const recent = p.facts.slice(-3).map((f) => `· ${f.text}（${ago(f.at)}）`).join('\n');
        return `🪪 ${p.name || 'QQ' + uid} 的印象卡\n熟悉度：${fam}（${tier}）　好感度：${p.affection ?? 50}/100\n记得 ${p.facts.length} 条：\n${recent || '（暂无）'}`;
      },
    },
    {
      name: 'qq_memory_forget',
      description: '忘掉记忆：给 index 删某人某一条，只给 subject_id 则清空这个人的全部记忆。',
      inputSchema: {
        type: 'object',
        properties: {
          subject_id: { type: 'number', description: '要动的 QQ 号' },
          index: { type: 'number', description: '第几条（从 1 开始）；不填=全部清空' },
        },
        required: ['subject_id'],
      },
      run: (a) => {
        const uid = String(num(a.subject_id));
        const db = load();
        const p = (db.people || {})[uid];
        if (!p) return `本来就没有 QQ${uid} 的记忆。`;
        if (a.index == null) {
          delete db.people[uid];
          save(db);
          return `🧹 已清空 QQ${uid} 的全部记忆。`;
        }
        const i = Math.trunc(num(a.index)) - 1;
        if (i < 0 || i >= p.facts.length) return `没有第 ${a.index} 条（现在共 ${p.facts.length} 条）。`;
        const [gone] = p.facts.splice(i, 1);
        save(db);
        return `🧹 忘掉了：${gone.text}`;
      },
    },
  ],
};
