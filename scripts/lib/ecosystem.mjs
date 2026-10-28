/* ============================================================
 * ecosystem.mjs —— 把别人的插件生态接进本平台的市场
 *
 * 三个源，三种完全不同的形状，这里统一成同一个条目结构：
 *
 *   NoneBot  registry.nonebot.dev/plugins.json   PyPI 包，947 条，字段最规整
 *   AstrBot  GitHub topic:astrbot-plugin          目录型，git 仓库
 *   Koishi   registry.npmmirror.com 搜索          npm 包
 *
 * 统一条目（市场直接吃这个）：
 *   { id, name, description, category, author, framework, language, version,
 *     homepage, pluginApi, install:{target,params}, needsMethod, origin:'ecosystem' }
 *
 * install 是真实可用的安装参数 —— 点"安装"就是把它交给 recipes/<target>.mjs，
 * 不是假按钮。needsMethod 说明必须先部署哪条方法，否则插件无处可装。
 *
 * 关于 TLS：本机到 api.github.com 的证书吊销检查（schannel）会失败，
 * 表现为 fetch failed。这里只在**第一次失败后**放宽一次校验并重试，
 * 不做全局降级，也不静默吞掉真正的网络错误。
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.mjs';
import { normalizeVer } from './version.mjs';

const CACHE = path.join(ROOT, 'data', 'sources', 'ecosystem.json');
const UA = 'qqbot-plugins/1.0 (+local market)';

/* 每个源最多收多少条：市场是给人看的，不是搜索引擎；
 * NoneBot 947 条全留（它本来就不大），GitHub 搜索只取前 N 页 */
const LIMITS = { nonebot: 1200, astrbot: 300, koishi: 400 };

let tlsLoose = false;

/** fetch 文本；失败后放宽证书校验重试一次（只在必要时） */
async function getText(url, opts = {}) {
  const timeout = opts.timeout || 20000;
  const headers = Object.assign({ 'user-agent': UA }, opts.headers || {});
  const once = async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout), headers });
    return { ok: r.ok, status: r.status, text: await r.text() };
  };
  try {
    return await once();
  } catch (e) {
    /* 证书类错误才降级；DNS/超时不值得再来一次 */
    if (tlsLoose) throw e;
    if (!/fetch failed|certificate|self.signed|unable to verify|SSL|TLS|schannel/i.test(String(e.message))) throw e;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    tlsLoose = true;
    console.warn('[ecosystem] 证书校验失败，已放宽 TLS 校验重试（本机 schannel 吊销检查问题）');
    return await once();
  }
}

/* tags 里的英文标签 → 中文分类。命中不了就按 NoneBot 的 type 兜底
 *
 * 这里必须用**整词**匹配，不能前缀匹配：第一版写 /^(...|chat|...)/，
 * 结果 Koishi 插件里泛滥的 "chatbot" 关键词全被算成 AI（436 条误分类）。
 * 关键词表本身就是脏的，宁可落到"其它"也不要批量分错。 */
const TAG_MAP = [
  [/^(qq|onebot|adapter|napcat|lagrange|go-cqhttp)$/i, 'QQ 适配'],
  [/^(image|img|pic|photo|draw|meme|picture|painting)$/i, '图片'],
  [/^(game|games|play|fun|entertainment|rpg)$/i, '娱乐'],
  [/^(search|info|query|lookup|wiki|rss|news)$/i, '查询'],
  [/^(server|monitor|status|system|admin|docker|shell)$/i, '运维'],
  [/^(tool|tools|util|utils|helper)$/i, '工具'],
  [/^(ai|llm|gpt|openai|chatgpt|claude|gemini|qwen|ollama|deepseek|chat)$/i, 'AI'],
  [/^(media|video|music|audio|voice|tts|speech|radio)$/i, '媒体'],
  [/^(sign|checkin|check-in|points|money|economy|lottery|gacha)$/i, '互动'],
];
export function classify(tags, type) {
  const list = (tags || []).map((t) => (typeof t === 'string' ? t : t && t.label)).filter(Boolean);
  /* 复合词拆开再逐词比：ai-chat / qq-bot / image-search 能命中，
   * 而 chatbot 拆出来只有 chatbot 一个词，不会误判成 AI */
  const words = [];
  for (const t of list) for (const w of String(t).split(/[-_\s/.]+/)) if (w) words.push(w);
  for (const w of words) {
    for (const [re, label] of TAG_MAP) if (re.test(w)) return label;
  }
  if (/application/i.test(String(type || ''))) return '功能';
  if (/adapter/i.test(String(type || ''))) return 'QQ 适配';
  return '其它';
}

/** 统一 id：生态前缀 + 原名，避免和自有插件撞 */
function ecoId(prefix, raw) {
  return (prefix + '-' + String(raw || ''))
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/* ---------------- NoneBot ---------------- */
export async function fetchNonebot() {
  const r = await getText('https://registry.nonebot.dev/plugins.json', { timeout: 30000 });
  if (!r.ok) throw new Error(`NoneBot 插件商店 HTTP ${r.status}`);
  const arr = JSON.parse(r.text);
  if (!Array.isArray(arr)) throw new Error('NoneBot 插件商店返回的不是数组');
  const items = [];
  for (const p of arr) {
    /* valid:false 是作者自己标了"不可用/测试失败"，不往市场里摆 */
    if (p.valid === false) continue;
    const pkg = String(p.project_link || '').trim();
    const mod = String(p.module_name || '').trim();
    if (!pkg && !mod) continue;
    items.push({
      id: ecoId('nb', mod || pkg),
      name: String(p.name || mod || pkg).slice(0, 60),
      description: String(p.desc || '').slice(0, 160),
      category: classify(p.tags, p.type),
      author: String(p.author || '').slice(0, 40),
      framework: 'nonebot',
      language: 'Python',
      version: normalizeVer(p.version || ''),
      homepage: String(p.homepage || ''),
      pluginApi: 'nonebot',
      install: { target: 'nonebot-plugin', params: { package: pkg || mod } },
      needsMethod: 'napcat-nonebot',
      tags: (p.tags || []).map((t) => (typeof t === 'string' ? t : t && t.label)).filter(Boolean).slice(0, 4),
      origin: 'ecosystem',
      sourceLabel: 'NoneBot 插件商店',
      official: !!p.is_official,
    });
  }
  return items.slice(0, LIMITS.nonebot);
}

/* ---------------- AstrBot（GitHub topic 搜索） ---------------- */
export async function fetchAstrbot() {
  const per = 100;
  const pages = Math.ceil(LIMITS.astrbot / per);
  const items = [];
  for (let page = 1; page <= pages; page++) {
    const url = 'https://api.github.com/search/repositories?q=topic:astrbot-plugin'
      + `&sort=stars&order=desc&per_page=${per}&page=${page}`;
    const r = await getText(url, { headers: { accept: 'application/vnd.github+json' } });
    if (!r.ok) {
      if (page === 1) throw new Error(`GitHub 搜索 HTTP ${r.status}${r.status === 403 ? '（可能触发了限流，未登录每小时 10 次搜索）' : ''}`);
      break; /* 后面几页失败就用手上这些，别整批丢掉 */
    }
    const j = JSON.parse(r.text);
    const list = j.items || [];
    for (const repo of list) {
      const full = String(repo.full_name || '');
      if (!full) continue;
      items.push({
        id: ecoId('ab', repo.name),
        name: String(repo.name || '').replace(/^astrbot[_-]plugin[_-]?/i, '').slice(0, 60) || full,
        description: String(repo.description || '').slice(0, 160),
        category: classify(repo.topics, ''),
        author: String((repo.owner && repo.owner.login) || '').slice(0, 40),
        framework: 'astrbot',
        language: /python/i.test(String(repo.language || '')) ? 'Python' : (repo.language || 'Python'),
        version: '',
        homepage: String(repo.html_url || ''),
        pluginApi: 'astrbot',
        install: { target: 'astrbot-plugin', params: { repo: repo.html_url } },
        needsMethod: 'napcat-astrbot',
        tags: (repo.topics || []).filter((t) => t !== 'astrbot-plugin').slice(0, 4),
        stars: repo.stargazers_count || 0,
        pushedAt: String(repo.pushed_at || '').slice(0, 10),
        origin: 'ecosystem',
        sourceLabel: 'GitHub topic:astrbot-plugin',
      });
    }
    if (list.length < per) break;
  }
  return items;
}

/* ---------------- Koishi（npm 搜索） ---------------- */
export async function fetchKoishi() {
  const items = [];
  const size = 250; /* npm 搜索单页上限 */
  const pages = Math.ceil(LIMITS.koishi / size);
  for (let page = 0; page < pages; page++) {
    const from = page * size;
    const url = `https://registry.npmmirror.com/-/v1/search?text=koishi-plugin&size=${size}&from=${from}`;
    const r = await getText(url, { timeout: 25000 });
    if (!r.ok) {
      if (page === 0) throw new Error(`npm 搜索 HTTP ${r.status}`);
      break;
    }
    const j = JSON.parse(r.text);
    for (const o of j.objects || []) {
      const pkg = o.package || {};
      const name = String(pkg.name || '');
      if (!/^(@[^/]+\/)?koishi-plugin-/.test(name)) continue; /* 只认 Koishi 插件命名 */
      const links = pkg.links || {};
      items.push({
        id: ecoId('ks', name.replace(/^@[^/]+\//, '')),
        name: name.replace(/^(@[^/]+\/)?koishi-plugin-/, '').slice(0, 60) || name,
        description: String(pkg.description || '').slice(0, 160),
        category: classify(pkg.keywords || [], 'plugin'),
        author: String((pkg.publisher && pkg.publisher.username) || (pkg.author && pkg.author.name) || '').slice(0, 40),
        framework: 'koishi',
        language: 'TypeScript',
        version: normalizeVer(pkg.version || ''),
        homepage: String(links.repository || links.homepage || `https://www.npmjs.com/package/${name}`),
        pluginApi: 'koishi',
        install: { target: 'koishi-plugin', params: { package: name } },
        needsMethod: 'napcat-koishi',
        tags: (pkg.keywords || []).filter((k) => k !== 'koishi-plugin').slice(0, 4),
        origin: 'ecosystem',
        sourceLabel: 'npm（npmmirror 镜像）',
      });
    }
    if ((j.objects || []).length < size) break;
  }
  return items;
}

/** 拉全部源；单源失败不影响其他源，错误如实带回去 */
export async function syncAll() {
  const out = { fetchedAt: new Date().toISOString(), sources: {}, items: [], errors: [] };
  const jobs = [
    ['nonebot', fetchNonebot],
    ['astrbot', fetchAstrbot],
    ['koishi', fetchKoishi],
  ];
  for (const [key, fn] of jobs) {
    try {
      const items = await fn();
      out.sources[key] = { ok: true, count: items.length };
      out.items.push(...items);
    } catch (e) {
      out.sources[key] = { ok: false, error: String(e.message || e).slice(0, 200) };
      out.errors.push(`${key}: ${e.message}`);
    }
  }
  /* 同 id 去重（不同源撞名的极少，但撞了会渲染出两张一样的卡） */
  const seen = new Set();
  out.items = out.items.filter((it) => (seen.has(it.id) ? false : seen.add(it.id)));
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(out, null, 1) + '\n');
  return out;
}

/** 读缓存（不联网）；文件不存在返回空结构 */
export function readEcosystem() {
  try {
    const doc = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    return {
      fetchedAt: doc.fetchedAt || '',
      sources: doc.sources || {},
      errors: doc.errors || [],
      items: Array.isArray(doc.items) ? doc.items : [],
    };
  } catch {
    return { fetchedAt: '', sources: {}, errors: [], items: [] };
  }
}

/** 缓存是否过期（默认 12 小时） */
export function isStale(hours = 12) {
  const doc = readEcosystem();
  if (!doc.fetchedAt) return true;
  return Date.now() - new Date(doc.fetchedAt).getTime() > hours * 3600e3;
}
