/* sticker —— 表情包：把群友发表情偷进自己的库，之后一句话就发出去
 *
 * 两件事放一个插件里，是因为它们共用同一个表情库：
 * 沙箱按 pluginId 隔离数据，拆成「发表情」和「偷表情」两个插件，
 * 就会出现「偷到的表情另一个插件看不见」——那种拆分只是看起来功能多，实际用不了。
 *
 * 库存在本插件自己的数据目录（data/store/sticker/library.json），
 * 图片按 base64 存，不写外部文件：沙箱里插件没有写盘权限，这是唯一合规的存法。
 * 代价是占内存与体积，所以设了硬上限（单张 512KB、全库 8MB / 60 张），超了直接说清楚。
 *
 * 偷图的来源：图片链接、base64、OneBot 的 file 值，或者直接给 message_id
 * （用 get_msg 翻出这条消息里的图片段——群友发完表情，一句话就存下来）。
 */
'use strict';
import { num, str, storage } from './_lib.mjs';
import { bridgeOf } from './_lib.mjs';
import { parseImageInput, sniffMime, sizeLabel } from './_images.mjs';
import crypto from 'node:crypto';

const MAX_ONE = 512 * 1024;          // 单张 512KB：盖住绝大多数表情，挡住整段视频截图
const MAX_LIB = 8 * 1024 * 1024;     // 全库 8MB
const MAX_COUNT = 60;
const lib = () => {
  const s = storage('sticker');
  const v = s.get('library', null);
  return { s, doc: v && Array.isArray(v.items) ? v : { items: [] } };
};
const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB'
  : n >= 1024 ? Math.round(n / 1024) + 'KB'
  : Math.max(1, Math.round(n)) + 'B');   /* 小图别说成 0KB */
const shortDate = (iso) => String(iso || '').slice(0, 10);

/* 下载一张图。这里自己写 fetch 而不是塞进 _images，
 * 是因为权限清单是按插件源码扫的——借用公共模块会让「这个插件会联网」漏报。 */
async function download(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': 'Mozilla/5.0 qqbot-plugins', Accept: 'image/*,*/*' },
    });
    if (!res.ok) return { error: `下载失败 HTTP ${res.status}` };
    const len = num(res.headers.get('content-length'));
    if (len > MAX_ONE) return { error: `这张图 ${fmtBytes(len)}，超过单张 ${fmtBytes(MAX_ONE)} 上限，存不下` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ONE) return { error: `这张图 ${fmtBytes(buf.length)}，超过单张上限` };
    if (!sniffMime(buf)) return { error: '拿回来的不是图片（可能是错误页或链接已过期）' };
    return { buf };
  } catch (e) {
    return { error: e.name === 'TimeoutError' ? '下载超时（20 秒）' : (e.message || '下载失败') };
  }
}

/* 从一条消息里把图片挖出来：优先 image 段的 url，其次 file */
async function imageFromMessage(ctx, messageId) {
  const bridge = bridgeOf(ctx);
  let msg;
  try {
    msg = await bridge.raw('get_msg', { message_id: Number(messageId) || messageId });
  } catch (e) {
    return { error: `取不到这条消息（message_id=${messageId}）：${e.message}` };
  }
  const segs = (msg && (msg.message || msg.segments)) || [];
  const from = str(msg && msg.sender && (msg.sender.card || msg.sender.nickname));

  /* 有的实现把 message 给成 CQ 码字符串（[CQ:image,file=...]），不是消息段数组。
   * 不认这种写法的话，明明有图也会回「这条消息里没有图片」。 */
  if (typeof segs === 'string') {
    const m = segs.match(/\[CQ:image,([^\]]+)\]/i);
    if (m) {
      const params = {};
      /* CQ 参数用逗号分隔，但值里也可能有逗号（base64 data URL 就有）。
       * 只在「逗号后面紧跟着 key=」时才切，免得把值切断。 */
      for (const kv of m[1].split(/,(?=[A-Za-z_]+=)/)) {
        const i = kv.indexOf('=');
        if (i > 0) params[kv.slice(0, i)] = kv.slice(i + 1).replace(/&#44;/g, ',');
      }
      const hit = str(params.url) || str(params.file);
      if (hit) return { ref: hit, from };
    }
    return { error: '这条消息里没有图片。表情包要引用一条带图的消息。' };
  }

  const arr = Array.isArray(segs) ? segs : [segs];
  for (const seg of arr) {
    const type = seg && (seg.type || seg.message_type);
    if (type !== 'image') continue;
    const d = seg.data || {};
    const hit = str(d.url) || str(d.file) || str(d.file_id);
    if (hit) return { ref: hit, from };
  }
  return { error: '这条消息里没有图片。表情包要引用一条带图的消息。' };
}

async function bytesOf(ctx, a) {
  /* message_id 优先：群友刚发的表情，模型只需要把 message_id 传进来 */
  let ref = str(a.image);
  let from = '';
  if (!ref && a.message_id != null) {
    const got = await imageFromMessage(ctx, a.message_id);
    if (got.error) return got;
    ref = got.ref;
    from = got.from;
  }
  if (!ref) return { error: '没给图片：传图片链接 / base64，或者带图消息的 message_id' };

  const parsed = parseImageInput(ref);
  if (parsed.kind === 'url') {
    const got = await download(parsed.value);
    if (got.error) return got;
    return { buf: got.buf, from: from || parsed.value.slice(0, 48) };
  }
  if (parsed.kind === 'dataurl') {
    const buf = Buffer.from(parsed.value.split(',')[1] || '', 'base64');
    if (!sniffMime(buf)) return { error: '这段 data URL 解出来不是图片' };
    if (buf.length > MAX_ONE) return { error: `这张图 ${fmtBytes(buf.length)}，超过单张上限` };
    return { buf, from: from || '粘贴的 base64' };
  }
  if (parsed.kind === 'base64') {
    const buf = Buffer.from(parsed.value, 'base64');
    if (buf.length > MAX_ONE) return { error: `这张图 ${fmtBytes(buf.length)}，超过单张上限` };
    return { buf, from: from || 'base64' };
  }
  /* file 值：先让协议端换回 base64 或直链 */
  try {
    const r = await bridgeOf(ctx).raw('get_image', { file: parsed.value });
    const b64 = str(r && (r.base64 || r.b64)).replace(/^base64:\/\//, '');
    if (b64) {
      const buf = Buffer.from(b64, 'base64');
      if (sniffMime(buf)) {
        if (buf.length > MAX_ONE) return { error: `这张图 ${fmtBytes(buf.length)}，超过单张上限` };
        return { buf, from: from || '协议端 get_image' };
      }
    }
    if (/^https?:\/\//i.test(str(r && r.url))) return bytesOf(ctx, { image: str(r.url) });
    return { error: `协议端认得 ${parsed.value}，但没给出能用的图片数据。把图片链接传进来更稳。` };
  } catch (e) {
    return { error: `这像是 OneBot 的 file 值，但取图失败：${e.message}` };
  }
}

export default {
  meta: {
    id: 'sticker',
    name: 'sticker',
    description: '表情包：把群友发的表情偷进自己的库，之后按关键词一句话发出去',
    category: '群互动',
  },

  tools: [
    {
      name: 'qq_sticker_save',
      description: '偷表情包：把一张图/表情存进本地表情库，之后能随时发。群友发了搞笑表情说「存了」「收下」时用。',
      inputSchema: {
        type: 'object',
        properties: {
          image: { type: 'string', description: '图片链接、base64，或 OneBot 的 file 值' },
          message_id: { type: 'string', description: '也可以只给一条带图消息的 message_id，插件自己会去翻这张图' },
          name: { type: 'string', description: '给这个表情起个名字，如「猫猫震惊」；留空用标签代替' },
          tags: { type: 'string', description: '标签，逗号分隔，如「猫,震惊,离谱」。之后发的时候按这些词匹配' },
        },
      },
      run: async (a, ctx) => {
        const got = await bytesOf(ctx, a);
        if (got.error) return '没存下：' + got.error;
        const buf = got.buf;
        if (!buf || !buf.length) return '没存下：图是空的';

        const mime = sniffMime(buf);
        if (!mime) return '没存下：这不像图片（只认 PNG / JPEG / GIF / WebP / BMP）';
        const id = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);

        const { s, doc } = lib();
        if (doc.items.some((x) => x.id === id)) {
          return `这个表情已经在库里了（id: ${id}），不用再存一次。`;
        }
        if (doc.items.length >= MAX_COUNT) {
          return `库满了：已经 ${doc.items.length} 张（上限 ${MAX_COUNT}）。先用 qq_sticker_list 看看，删几张不用的（qq_sticker_remove）。`;
        }
        const total = doc.items.reduce((n, x) => n + (x.bytes || 0), 0);
        if (total + buf.length > MAX_LIB) {
          return `库满了：已占 ${fmtBytes(total)}（上限 ${fmtBytes(MAX_LIB)}）。删几张再存。`;
        }

        const tags = str(a.tags).split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean).slice(0, 8);
        const name = str(a.name).slice(0, 24) || tags[0] || '未命名';
        const item = {
          id,
          name,
          tags,
          mime,
          size: sizeLabel(buf),
          bytes: buf.length,
          b64: buf.toString('base64'),
          addedAt: new Date().toISOString(),
          from: String(got.from || '').slice(0, 60),
        };
        doc.items.push(item);
        s.set('library', doc);
        return `📥 存好了：${name}（id: ${id}，${item.size || mime}，${fmtBytes(buf.length)}${tags.length ? '，标签：' + tags.join('/') : ''}）\n现在库里有 ${doc.items.length} 张。`;
      },
    },
    {
      name: 'qq_sticker_send',
      description: '发表情包：从本地表情库挑一张发到群里。群友说「来个表情」「发表情」或想用表情回一句时用。',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '按名字或标签找，如「猫」「震惊」；留空就随机发一张' },
          id: { type: 'string', description: '精确指定表情 id（先 qq_sticker_list 查）' },
          group_id: { type: 'number', description: '群号（群聊时传）' },
          user_id: { type: 'number', description: '私聊对象 QQ 号' },
        },
      },
      run: async (a, ctx) => {
        const { doc } = lib();
        if (!doc.items.length) {
          return '表情库还是空的。先用 qq_sticker_save 存几张（群友发表情时给 message_id 就能存）。';
        }
        const wantId = str(a.id);
        const kw = str(a.keyword).toLowerCase();
        let hit;
        if (wantId) {
          hit = doc.items.find((x) => x.id === wantId);
          if (!hit) return `库里没有 id 为 ${wantId} 的表情。用 qq_sticker_list 看看现有的。`;
        } else if (kw) {
          const matched = doc.items.filter((x) =>
            x.name.toLowerCase().includes(kw) ||
            (x.tags || []).some((t) => t.toLowerCase().includes(kw)));
          if (!matched.length) {
            const names = doc.items.slice(0, 8).map((x) => x.name).join('、');
            return `没有跟「${kw}」对上的表情。库里现有：${names}${doc.items.length > 8 ? ' 等' : ''}。`;
          }
          hit = matched[Math.floor(Math.random() * matched.length)];
        } else {
          hit = doc.items[Math.floor(Math.random() * doc.items.length)];
        }

        const gid = num(a.group_id), uid = num(a.user_id);
        if (!gid && !uid) return `挑到了「${hit.name}」，但不知道发给谁：带 group_id 或 user_id。`;
        try {
          const bridge = bridgeOf(ctx);
          await bridge.sendImage(gid ? { groupId: gid } : { userId: uid }, hit.b64);
        } catch (e) {
          return `选中了「${hit.name}」，但发送失败：${e.message}（检查协议端是否在线）`;
        }
        return `🎭 发了「${hit.name}」${hit.size ? '（' + hit.size + '）' : ''}${hit.tags && hit.tags.length ? '，标签：' + hit.tags.join('/') : ''}`;
      },
    },
    {
      name: 'qq_sticker_list',
      description: '看表情库里有哪些表情（名字、标签、id）。发之前不知道有什么，或要删的时候先看这个。',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '只看匹配名字/标签的' },
        },
      },
      run: async (a) => {
        const { doc } = lib();
        if (!doc.items.length) return '表情库是空的。群友发表情时用 qq_sticker_save 存几张就有了。';
        const kw = str(a.keyword).toLowerCase();
        const list = kw
          ? doc.items.filter((x) => x.name.toLowerCase().includes(kw) || (x.tags || []).some((t) => t.toLowerCase().includes(kw)))
          : doc.items;
        if (!list.length) return `没有跟「${a.keyword}」对上的表情。`;
        const total = doc.items.reduce((n, x) => n + (x.bytes || 0), 0);
        const rows = list.slice(0, 30).map((x, i) =>
          `${i + 1}. ${x.name}${x.tags && x.tags.length ? '（' + x.tags.join('/') + '）' : ''} · ${x.id}${x.size ? ' · ' + x.size : ''}`).join('\n');
        return `🎭 表情库 ${doc.items.length} 张，共 ${fmtBytes(total)}：\n${rows}${list.length > 30 ? `\n……还有 ${list.length - 30} 张没列` : ''}`;
      },
    },
    {
      name: 'qq_sticker_remove',
      description: '从表情库里删掉一张（按 id 或名字）。库满了、或者存错了要清掉时用。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '要删的表情 id' },
          name: { type: 'string', description: '按名字删（重名时删第一个匹配的）' },
        },
      },
      run: async (a) => {
        const { s, doc } = lib();
        const wantId = str(a.id);
        const wantName = str(a.name);
        if (!wantId && !wantName) return '要说删哪个：给 id 或名字。';
        const idx = wantId
          ? doc.items.findIndex((x) => x.id === wantId)
          : doc.items.findIndex((x) => x.name === wantName);
        if (idx < 0) return `库里没有${wantId ? ' id 为 ' + wantId : '叫「' + wantName + '」'}的表情。`;
        const [gone] = doc.items.splice(idx, 1);
        s.set('library', doc);
        return `🗑️ 删掉了「${gone.name}」（${gone.id}），库里还剩 ${doc.items.length} 张。`;
      },
    },
  ],
};
