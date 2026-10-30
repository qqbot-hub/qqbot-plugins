/* video —— 认视频：说清一段视频里到底拍了什么
 *
 * 两档后端，能力差很多，返回结果里必须说穿：
 *   dashscope  阿里云 qwen-vl 的 video_url：整段视频交给模型逐帧看（推荐）
 *   openai     只拿得到封面/首帧的老实降级：能说画面和标题，看不到中间发生了什么
 *
 * 为什么不自己抽帧：抽帧要 ffmpeg，而插件跑在沙箱里、默认没有起子进程的权限；
 * 为一个抽帧给所有插件开口子不值得。云端视频接口是零依赖就能拿到逐帧能力的路。
 *
 * 链接怎么处理：分享页（B 站/抖音/微博）先抓 og:title / og:description / og:image，
 * 这些是页面自己声明的元信息，不是猜的；直链 mp4 直接交给视频接口。
 */
'use strict';
import { num, str, bridgeOf } from './_lib.mjs';

async function mediaUrl(a,ctx){
  if(a.url)return str(a.url);
  if(!a.message_id)return '';
  const msg=await bridgeOf(ctx).raw('get_msg',{message_id:a.message_id});
  return (Array.isArray(msg?.message)?msg.message:[]).filter(x=>x.type==='video').map(x=>x.data?.url || x.data?.file || '').find(u=>u.startsWith('https://') || u.startsWith('http://')) || '';
}
const MAX_HTML = 400 * 1024;
const MEDIA_RE = /\.(mp4|m4v|mov|webm|flv|mkv|m3u8|ts)(\?|#|$)/i;

const decodeEntities = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));

/* <meta property="og:title" content="…"> —— 属性顺序两种写法都有，都要认 */
function pickMeta(html, prop) {
  const esc = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${esc}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return decodeEntities(m[1]).trim();
  }
  return '';
}

function pageMeta(html) {
  const title = pickMeta(html, 'og:title') || pickMeta(html, 'twitter:title')
    || decodeEntities((html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i) || [])[1] || '').trim();
  const desc = pickMeta(html, 'og:description') || pickMeta(html, 'description')
    || pickMeta(html, 'twitter:description');
  const cover = pickMeta(html, 'og:image') || pickMeta(html, 'twitter:image');
  const duration = pickMeta(html, 'og:video:duration') || pickMeta(html, 'video:duration');
  /* 页面里声明的播放地址：只有真的是媒体文件才算数。
   * B 站这类站点的 og:video 指向 player.html（一个网页），把网页丢给视频接口只会 400，
   * 所以这里必须验扩展名，不能见到 og:video 就当直链用。 */
  const declared = pickMeta(html, 'og:video:secure_url') || pickMeta(html, 'og:video:url')
    || pickMeta(html, 'og:video') || pickMeta(html, 'twitter:player:stream')
    || pickMeta(html, 'contentUrl');
  const tagUrl = (html.match(/<(?:video|source)[^>]+src=["']([^"']+)["']/i) || [])[1] || '';
  const videoUrl = [declared, decodeEntities(tagUrl)].find((u) => u && /^https?:\/\//i.test(u) && MEDIA_RE.test(u)) || '';
  return { title, desc, cover, duration, videoUrl };
}

async function grabPage(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    if (!res.ok) return { error: `页面返回 HTTP ${res.status}` };
    const type = str(res.headers.get('content-type')).toLowerCase();
    if (type && !/text\/html|application\/xhtml|text\/plain/.test(type)) {
      return { error: `这不是网页（Content-Type: ${type}），当作媒体直链处理`, isMedia: true };
    }
    const raw = Buffer.from(await res.arrayBuffer());
    if (raw.length > MAX_HTML) return { error: '页面太大，只取前 400KB' };
    return { html: raw.toString('utf8'), finalUrl: res.url || url };
  } catch (e) {
    return { error: e.name === 'TimeoutError' ? '打开页面超时（20 秒）' : (e.message || '打不开这个链接') };
  }
}

function baseOf(c) {
  const p = str(c.provider);
  const fallback = p === 'dashscope' ? 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    : 'https://api.siliconflow.cn/v1';
  return str(c.baseUrl || fallback).replace(/\/+$/, '');
}

function modelOf(c) {
  const p = str(c.provider);
  if (str(c.model)) return str(c.model);
  return p === 'dashscope' ? 'qwen-vl-max-latest' : 'Qwen/Qwen2.5-VL-72B-Instruct';
}

/* 统一的一次多模态调用。content 段由调用方拼，这里只管传输与错误翻译。
 * 默认 140 秒 —— 比自己声明的 150 秒执行窗口略短，这样"接口太慢"能变成一句人话返回，
 * 而不是被沙箱从外面掐死。 */
async function chat(c, content, { maxTokens = 900, timeoutMs = 140000 } = {}) {
  const base = baseOf(c);
  const key = str(c.apiKey);
  const model = modelOf(c);
  if (!key) {
    return { error: '这条插件还没配置：需要 API Key。去「⚙ 配置」里填上——认视频要用支持视频的多模态接口（推荐阿里云 DashScope 的 qwen-vl），普通文字模型看不了视频。' };
  }
  let res;
  try {
    res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.2, messages: [{ role: 'user', content }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const hint = /ECONNREFUSED|fetch failed/i.test(e.message || '')
      ? `连不上 ${base}：检查接口地址`
      : (e.name === 'TimeoutError' || e.name === 'AbortError'
        ? `接口 ${Math.round(timeoutMs / 1000)} 秒没返回——视频越长越慢，先试更短的片段`
        : e.message);
    return { error: '认视频失败：' + hint };
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) return { error: `接口拒绝（${res.status}）：API Key 不对或没有该模型的权限` };
  if (res.status === 404) return { error: `接口 404：${base}/chat/completions 不存在，或模型 ${model} 不可用` };
  if (res.status === 429) return { error: '接口限流了（429），等十几秒再试' };
  if (res.status === 400) {
    return { error: `接口说请求不对（400）：${text.slice(0, 200)}\n常见原因：这个模型不支持视频输入，或视频链接它抓不到。把后端换成 DashScope，或改用封面图理解。` };
  }
  if (!res.ok) return { error: `接口返回 ${res.status}：` + text.slice(0, 160) };
  let data;
  try { data = JSON.parse(text); } catch { return { error: '接口返回的不是 JSON：' + text.slice(0, 120) }; }
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  let out = '';
  if (typeof msg === 'string') out = msg;
  else if (msg && Array.isArray(msg.content)) out = msg.content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
  else if (msg && typeof msg.content === 'string') out = msg.content;
  out = String(out || '').trim();
  if (!out) return { error: '模型返回空内容，换个问法或换段视频再试' };
  return { text: out, model };
}

const ASK = '你是群聊里的看片助手。用中文说清这段视频讲了什么：先一句总述，再列 2-4 个关键画面/动作，最后如果有字幕或屏幕上的文字，抄下来。只写你真正看到的，没看到就说没看到，不要编造。';

export default {
  meta: {
    id: 'video',
    name: 'video',
    description: '认视频：把一段视频交给多模态模型看清内容（支持阿里云 qwen-vl 的视频接口）',
    category: '工具',
    /* 视频理解天然比文字慢，沙箱默认 25 秒会把它掐死；这里显式申请更长的执行时间 */
    timeoutMs: 150000,
  },

  settings: {
    title: '认视频',
    intro: '要真看到画面，得用支持视频的接口（推荐阿里云 DashScope 的 qwen-vl）。普通识图模型只能看封面，返回结果里会写明是哪种。Key 可以先不填把插件装上，但用之前必须在「⚙ 配置」里填好，否则每次调用都会提示没配置。',
    fields: [
      {
        key: 'provider', label: '后端', type: 'select', default: 'dashscope',
        options: [
          { value: 'dashscope', label: '阿里云 DashScope qwen-vl（支持视频，推荐）' },
          { value: 'openai', label: '其他 OpenAI 兼容接口（通常只能看封面）' },
        ],
      },
      { key: 'baseUrl', label: '接口地址', type: 'text', placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1', help: 'DashScope 兼容模式地址固定；用别的服务就填它的 /v1 地址' },
      /* 故意不标 required：标了的话「一键接入」会卡在必填检查这一步装不上，
       * 而用户往往想先装上再去申请 Key。没 Key 时调用会明确提示去配置。 */
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...', help: 'DashScope 的 Key 在阿里云百炼控制台拿。认视频没有免 Key 的路子，用之前必须填' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'qwen-vl-max-latest', help: 'DashScope 用 qwen-vl-max-latest 或 qwen-vl-plus；换成别的模型可能不支持视频' },
      { key: 'fps', label: '抽帧密度（帧/秒）', type: 'number', default: 2, help: '1-4。越大看得越细也越慢越贵；默认 2 够看清大部分群视频' },
    ],
  },

  tools: [
    {
      name: 'qq_video_see',
      description: '看一段视频并说清里面拍了什么。群友发视频问「这啥」「视频里演了啥」时用。传视频链接或分享页链接。',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: {type:'number',description:'包含视频的 QQ 消息ID，与url二选一'},
        url: { type: 'string', description: '视频直链（mp4 等）或分享页链接（B 站/抖音/微博/QQ 视频）' },
          question: { type: 'string', description: '具体想问的，如「视频最后出现了什么字」；留空就做通用描述' },
          fps: { type: 'number', description: '抽帧密度 1-4，默认用配置值' },
        },
        required: [],
      },
      run: async (a, ctx) => {
        const c = (ctx && ctx.cfg) || {};
        const url = await mediaUrl(a,ctx);
        if (!/^https?:\/\//i.test(url)) {
          return '认视频要一个 http/https 链接：视频直链或分享页都行。图片请用 qq_see，本机文件沙箱读不到。';
        }
        const provider = str(c.provider) || 'dashscope';
        const question = str(a.question);
        const isMedia = MEDIA_RE.test(url);

        /* 分享页先拿元信息：标题/简介/封面，这些即使模型只看封面也能用上。
         * 页面若自己声明了真正的媒体直链（不是 player.html 那种网页），就优先用它。 */
        let meta = { title: '', desc: '', cover: '', duration: '', videoUrl: '' };
        let pageNote = '';
        if (!isMedia) {
          const page = await grabPage(url);
          if (page.html) {
            meta = pageMeta(page.html);
            pageNote = meta.videoUrl ? '分享页（找到页面里的直链）' : '分享页';
          } else if (page.isMedia) {
            /* 链接没带 .mp4 后缀，但服务端说这就是媒体流：照样交给视频接口 */
            pageNote = '直链';
          } else {
            pageNote = page.error || '';
          }
        }

        const lines = [];
        if (meta.title) lines.push('标题：' + meta.title.slice(0, 120));
        if (meta.desc) lines.push('简介：' + meta.desc.slice(0, 300));
        if (meta.duration) lines.push('时长：' + meta.duration + ' 秒');
        const context = lines.length ? lines.join('\n') + '\n\n' : '';

        if (provider === 'dashscope') {
          const target = isMedia ? url : (meta.videoUrl || url);
          const fps = Math.min(Math.max(Math.trunc(num(a.fps) || num(c.fps) || 2), 1), 4);
          const content = [{
            type: 'text',
            text: ASK + '\n\n' + context + (question ? '我特别想知道：' + question : ''),
          }, {
            type: 'video_url',
            video_url: { url: target, fps },
          }];
          const r = await chat(c, content, { maxTokens: 900 });
          if (r.error) {
            /* 分享页报错时把真正的原因说清楚：不是「模型坏了」，
             * 而是这类页面不对外给播放地址（B 站/抖音都把播放地址锁在登录态里）。 */
            if (!isMedia && !meta.videoUrl && /400|抓不到|请求不对/.test(r.error)) {
              return r.error + `\n\n这条是分享页${meta.title ? '「' + meta.title.slice(0, 40) + '」' : ''}，页面没给出可下载的播放地址，接口只能看到网页本身。\n办法：① 弄到 mp4 直链再传（qq_video_probe 能帮你看页面里有没有直链）；② 或者只用标题和封面 —— 换「其他 OpenAI 兼容接口」后端就会走封面这条路。`;
            }
            return r.error;
          }
          const head = `🎬 ${r.text}`;
          const tail = [`逐帧看（${fps} 帧/秒）`, r.model, pageNote].filter(Boolean).join(' · ');
          return `${head}\n（${tail}）`;
        }

        /* 非 DashScope 后端：只能看封面。不假装看过整段视频。 */
        if (!meta.cover) {
          return `这个后端看不了视频内容${pageNote ? '（' + pageNote + '）' : ''}，也没抓到封面图。\n两个办法：① 去「⚙ 配置」把后端换成「阿里云 DashScope qwen-vl」，那里能真的逐帧看；② 如果视频有封面图，把封面链接用 qq_see 看。`;
        }
        const content = [{
          type: 'text',
          text: ASK + '\n\n' + context + '\n\n注意：你只拿到这段视频的封面图，看不到中间过程。就封面能确定的说，别把整段视频的内容编出来。' + (question ? '我特别想知道：' + question : ''),
        }, { type: 'image_url', image_url: { url: meta.cover } }];
        const r = await chat(c, content, { maxTokens: 700, timeoutMs: 90000 });
        if (r.error) return r.error;
        return `🎬 ${r.text}\n（只看封面，不是逐帧 · ${r.model}）\n想真看画面：把后端换成阿里云 DashScope qwen-vl。`;
      },
    },
    {
      name: 'qq_video_probe',
      description: '只查一段视频的元信息：标题、简介、时长、封面直链，不花模型额度。想知道链接是什么、有没有封面时用。',
      inputSchema: {
        type: 'object',
        properties: {
          message_id: {type:'number',description:'包含视频的 QQ 消息ID，与url二选一'},
        url: { type: 'string', description: '视频直链或分享页链接' },
        },
        required: [],
      },
      run: async (a, ctx) => {
        const url = await mediaUrl(a,ctx);
        if (!/^https?:\/\//i.test(url)) return '要一个 http/https 链接。';
        if (MEDIA_RE.test(url)) {
          return `🎬 这是一个视频直链，没有网页元信息可读：\n${url}\n\n想知道里面拍了什么，用 qq_video_see。`;
        }
        const page = await grabPage(url);
        if (page.isMedia) {
          return `🎬 这看起来是视频直链（服务端返回的是媒体流），没有网页元信息可读：\n${url}\n\n想知道里面拍了什么，用 qq_video_see。`;
        }
        if (page.error && !page.html) return '打不开这个链接：' + page.error;
        const m = pageMeta(page.html || '');
        if (!m.title && !m.desc && !m.cover) {
          return '这个页面没写 og 元信息（可能需要登录，或者是纯前端渲染的）。可以直接把直链丢给 qq_video_see 试试。';
        }
        const rows = [
          m.title ? `标题：${m.title}` : '',
          m.desc ? `简介：${m.desc.slice(0, 400)}` : '',
          m.duration ? `时长：${m.duration} 秒` : '',
          m.cover ? `封面：${m.cover}` : '',
          /* 页面自己声明了真正的媒体文件才算「能逐帧」；只给 player.html 的不写，免得误导 */
          m.videoUrl ? `直链：${m.videoUrl}` : '直链：页面没给（这类站点把播放地址锁在登录态里，逐帧看不了）',
          page.finalUrl && page.finalUrl !== url ? `跳转到：${page.finalUrl}` : '',
        ].filter(Boolean);
        return '🎬 ' + rows.join('\n');
      },
    },
  ],
};
