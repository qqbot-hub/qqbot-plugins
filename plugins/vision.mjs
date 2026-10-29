/* vision —— QQ 识图：看清一张图里有什么、把图里的字读出来
 *
 * 群里最常见的三种问法：
 *   「这图是什么」「图里写的啥」「帮我看看这张截图」
 * 都由同一个多模态接口回答，区别只在提示词。
 *
 * 后端用 OpenAI 兼容的 /chat/completions（image_url 段）：
 *   · 硅基流动  baseUrl=https://api.siliconflow.cn/v1  model=Qwen/Qwen2.5-VL-72B-Instruct
 *   · 阿里云    baseUrl=https://dashscope.aliyuncs.com/compatible-mode/v1  model=qwen-vl-max-latest
 *   · 本机 Ollama baseUrl=http://127.0.0.1:11434/v1   model=qwen2.5vl:7b（免 Key）
 *
 * 图片怎么进来：QQ 消息里的图片链接、base64、或 OneBot 的 file 值都认。
 * 链接会先试着自己下回来再转 base64——QQ 的图片链接带 rkey，部分接口抓不到，
 * 我们本机能拿到就自己拿，别把失败甩给模型。
 */
'use strict';
import { num, str } from './_lib.mjs';
import { parseImageInput, sniffMime, sizeLabel, toDataUrl } from './_images.mjs';

const cfgOf = (ctx) => (ctx && ctx.cfg) || {};
const MAX_BYTES = 8 * 1024 * 1024;

function baseOf(c) {
  const p = str(c.provider);
  const fallback = p === 'ollama' ? 'http://127.0.0.1:11434/v1'
    : p === 'dashscope' ? 'https://dashscope.aliyuncs.com/compatible-mode/v1'
    : 'https://api.siliconflow.cn/v1';
  return str(c.baseUrl || fallback).replace(/\/+$/, '');
}

function defaultModel(c) {
  const p = str(c.provider);
  if (p === 'ollama') return 'qwen2.5vl:7b';
  if (p === 'dashscope') return 'qwen-vl-max-latest';
  return 'Qwen/Qwen2.5-VL-72B-Instruct';
}

/* 下载图片：超时 20 秒、上限 8MB。失败返回 null，交给调用方决定用原链接兜底 */
async function fetchImage(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': 'Mozilla/5.0 qqbot-plugins', Accept: 'image/*,*/*' },
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const len = num(res.headers.get('content-length'));
    if (len > MAX_BYTES) return { error: `图片 ${Math.round(len / 1048576)}MB，超过 8MB 上限` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return { error: '图片超过 8MB 上限' };
    if (!sniffMime(buf)) return { error: '拿回来的不是图片（可能是错误页或需要登录）' };
    return { buf };
  } catch (e) {
    return { error: e.name === 'TimeoutError' ? '下载超时' : (e.message || '下载失败') };
  }
}

/* 把参数里的图片变成多模态接口能吃的东西 */
async function resolveImage(ctx, raw) {
  const parsed = parseImageInput(raw);
  if (!parsed) return { error: '没给图片：传图片链接、base64，或 OneBot 的 file 值' };

  if (parsed.kind === 'url') {
    const got = await fetchImage(parsed.value);
    if (got.buf) {
      return {
        url: toDataUrl(got.buf.toString('base64'), sniffMime(got.buf)),
        size: sizeLabel(got.buf),
        bytes: got.buf.length,
        via: '下载后转 base64',
      };
    }
    /* 下载不通就把链接原样交出去，接口那边可能自己抓得到 */
    return { url: parsed.value, size: '', bytes: 0, via: '直传链接（本机下载失败：' + got.error + '）' };
  }

  if (parsed.kind === 'dataurl') {
    const b64 = parsed.value.split(',')[1] || '';
    const buf = Buffer.from(b64, 'base64');
    /* 传进来的 base64 也要卡体积：8MB 的图转成 base64 是 11MB 的字符串，
     * 直接塞进 JSON 发给接口会超时/被拒，不如在这里就说清楚。 */
    if (buf.length > MAX_BYTES) return { error: `图片 ${Math.round(buf.length / 1048576)}MB，超过 8MB 上限，先压一下再传` };
    if (!sniffMime(buf)) return { error: '这段 data URL 解出来不是图片（只认 PNG / JPEG / GIF / WebP / BMP）' };
    return { url: parsed.value, size: sizeLabel(buf), bytes: buf.length, via: 'data URL' };
  }

  if (parsed.kind === 'base64') {
    const buf = Buffer.from(parsed.value, 'base64');
    if (!sniffMime(buf)) return { error: '这串 base64 解出来不是图片' };
    if (buf.length > MAX_BYTES) return { error: `图片 ${Math.round(buf.length / 1048576)}MB，超过 8MB 上限，先压一下再传` };
    return { url: toDataUrl(buf.toString('base64'), parsed.mime), size: sizeLabel(buf), bytes: buf.length, via: 'base64' };
  }

  /* OneBot 的 file 值：有些实现能靠 get_image 换回 base64 或本地路径。
   * 这里直接调 ctx.onebot 的 get_image，不经过 bridge 那层封装 —— 识图不发消息、不碰群管理，
   * 只是借协议端把 file 换成数据；走 bridge 会被权限扫描标成「能以机器人身份发消息」，
   * 用户看到会以为识图会在群里说话。 */
  const onebot = ctx && ctx.onebot;
  if (typeof onebot !== 'function') {
    return { error: `这看起来是 OneBot 的 file 值（${parsed.value}），但当前没有协议端连接可用。把图片链接或 base64 传进来就行。` };
  }
  try {
    const r = await onebot('get_image', { file: parsed.value });
    const b64 = str(r && (r.base64 || r.b64));
    const fileUrl = str(r && (r.url || r.file));
    if (b64) {
      const buf = Buffer.from(b64.replace(/^base64:\/\//, ''), 'base64');
      if (sniffMime(buf)) {
        return { url: toDataUrl(buf.toString('base64'), sniffMime(buf)), size: sizeLabel(buf), bytes: buf.length, via: 'OneBot get_image' };
      }
    }
    if (/^https?:\/\//i.test(fileUrl)) return resolveImage(ctx, fileUrl);
    return { error: `协议端认得这个 file（${parsed.value}），但没给出可用的图片地址或 base64。把图片链接直接传进来最快。` };
  } catch (e) {
    return { error: `这看起来是 OneBot 的 file 值，但取图失败：${e.message}。把图片链接或 base64 传进来更稳。` };
  }
}

/* 统一走 OpenAI 兼容的视觉接口 */
async function askVision(c, img, prompt, maxTokens) {
  const base = baseOf(c);
  const key = str(c.apiKey);
  const provider = str(c.provider) || 'openai';
  if (provider !== 'ollama' && !key) {
    return { error: '这条插件还没配置：需要 API Key。去「⚙ 配置」里填上（硅基流动 / 阿里云 / OpenAI 都行），或者把后端换成「本机 Ollama」——那个不用 Key。' };
  }
  const model = str(c.model) || defaultModel(c);
  /* detail 是 OpenAI 的字段；DashScope 兼容模式与部分自建服务对它比较严格，
   * 只在选了 OpenAI 系后端时才带上，免得因为这些站点不认的字段吃 400。 */
  const imgPart = { type: 'image_url', image_url: { url: img.url } };
  if (provider === 'openai' && str(c.detail)) imgPart.image_url.detail = str(c.detail);
  const body = {
    model,
    max_tokens: maxTokens,
    temperature: 0.2,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        imgPart,
      ],
    }],
  };
  let res;
  try {
    res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, key ? { Authorization: 'Bearer ' + key } : {}),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    const hint = /ECONNREFUSED|fetch failed/i.test(e.message || '')
      ? `连不上 ${base}：检查接口地址，或本机 Ollama / vLLM 有没有起来`
      : (e.name === 'TimeoutError' ? '接口 90 秒没返回，图可能太大或服务在排队' : e.message);
    return { error: '识图失败：' + hint };
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) return { error: `识图接口拒绝（${res.status}）：API Key 不对或没权限，去「⚙ 配置」检查` };
  if (res.status === 404) return { error: `接口 404：${base}/chat/completions 不存在，或模型名 ${model} 不可用` };
  if (res.status === 429) return { error: '识图接口限流了（429），等十几秒再试' };
  if (!res.ok) return { error: `识图接口返回 ${res.status}：` + text.slice(0, 160) };

  let data;
  try { data = JSON.parse(text); } catch { return { error: '识图接口返回的不是 JSON：' + text.slice(0, 120) }; }
  const pick = data.choices && data.choices[0];
  const msg = pick && pick.message;
  let out = '';
  if (typeof msg === 'string') out = msg;
  else if (msg && Array.isArray(msg.content)) out = msg.content.map((p) => (typeof p === 'string' ? p : p.text || '')).join('');
  else if (msg && typeof msg.content === 'string') out = msg.content;
  out = String(out || '').trim();
  if (!out) return { error: '模型返回了空内容，换个问法或换张图再试' };
  return { text: out, model };
}

const SEE_PROMPT = '你是群聊里的识图助手。先一句话说清这张图是什么，再列出图里能确认的关键信息（人物/物体/场景/文字）。只写你真正看见的，看不清就说看不清，不要编。';

export default {
  meta: {
    id: 'vision',
    name: 'vision',
    description: 'QQ 识图：看清图片里有什么、读出截图里的文字（多模态模型，支持本机 Ollama）',
    category: '工具',
    /* 识图要等模型看完图，大图/排队时 25 秒不够（沙箱默认就是 25 秒），
     * 这里申请 95 秒：比插件内部的 90 秒接口超时略长，这样先返回的是
     * 「接口 90 秒没返回」这种能看懂的话，而不是「插件执行超时，已强杀子进程」。 */
    timeoutMs: 95000,
  },

  settings: {
    title: 'QQ 识图',
    intro: '云端多模态接口要填 Key；本机跑 Ollama 不用 Key、图片不出本机。群友发图问「这是什么」时用它。',
    fields: [
      {
        key: 'provider', label: '后端', type: 'select', default: 'openai',
        options: [
          { value: 'openai', label: 'OpenAI 兼容接口（硅基流动 / OpenAI / 自建）' },
          { value: 'dashscope', label: '阿里云 DashScope（qwen-vl）' },
          { value: 'ollama', label: '本机 Ollama（免 Key，图片不出本机）' },
        ],
      },
      { key: 'baseUrl', label: '接口地址', type: 'text', placeholder: 'https://api.siliconflow.cn/v1', help: '硅基流动 https://api.siliconflow.cn/v1；阿里云 https://dashscope.aliyuncs.com/compatible-mode/v1；本机 Ollama http://127.0.0.1:11434/v1' },
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...（本机 Ollama 留空）', help: '云端必填；Ollama 不需要' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'Qwen/Qwen2.5-VL-72B-Instruct', help: '硅基流动用 Qwen/Qwen2.5-VL-72B-Instruct；阿里云用 qwen-vl-max-latest；Ollama 用 qwen2.5vl:7b' },
      {
        key: 'detail', label: '看图精细度', type: 'select', default: 'auto',
        options: ['auto', 'high', 'low'],
        help: 'high 更能看清小字但更贵更慢；low 便宜快，适合只问「这是什么」',
      },
    ],
  },

  tools: [
    {
      name: 'qq_see',
      description: '看一张图并说出图里有什么。群友发图问「这是什么」「帮我看看」时用。图片可以是链接、base64，或 OneBot 的 file 值。',
      inputSchema: {
        type: 'object',
        properties: {
          image: { type: 'string', description: '图片链接（http/https）、base64、data URL，或 OneBot 消息里的 file 值' },
          question: { type: 'string', description: '想问的具体问题，如「图里几只猫」「这个报错是什么意思」；留空就做通用描述' },
        },
        required: ['image'],
      },
      run: async (a, ctx) => {
        const c = cfgOf(ctx);
        const img = await resolveImage(ctx, a.image);
        if (img.error) return '看图失败：' + img.error;
        const q = str(a.question);
        const prompt = q ? `${SEE_PROMPT}\n\n这张图我想知道：${q}` : SEE_PROMPT;
        const r = await askVision(c, img, prompt, 700);
        if (r.error) return r.error;
        const meta = [img.size && `${img.size}`, img.bytes ? `${Math.round(img.bytes / 1024)}KB` : '', r.model].filter(Boolean).join(' · ');
        return `👁️ ${r.text}${meta ? `\n（${meta}）` : ''}`;
      },
    },
    {
      name: 'qq_ocr',
      description: '把图片里的文字原样读出来（截图、题目、二维码下的字）。只要文字时用这个，比 qq_see 更专注。',
      inputSchema: {
        type: 'object',
        properties: {
          image: { type: 'string', description: '图片链接、base64、data URL，或 OneBot 的 file 值' },
          lang: { type: 'string', description: '文字语言提示，如 中文 / 英文 / 日文；留空自动' },
        },
        required: ['image'],
      },
      run: async (a, ctx) => {
        const c = cfgOf(ctx);
        const img = await resolveImage(ctx, a.image);
        if (img.error) return '读字失败：' + img.error;
        const lang = str(a.lang);
        const prompt = `把这张图里的文字逐行抄出来，保持原有顺序和换行，不要翻译、不要总结、不要补充图里没有的字。${lang ? `文字主要是${lang}。` : ''}图里没有文字就直说「图里没有文字」。`;
        const r = await askVision(c, img, prompt, 1200);
        if (r.error) return r.error;
        return `📝 图里的文字：\n${r.text}`;
      },
    },
  ],
};
