/* imagine —— AI 画画：文生图并直接发到 QQ
 *
 * 两种后端，都在「⚙ 配置」里切换：
 *   pollinations  免费、无需 Key（默认），出图约 1 秒
 *   openai        OpenAI 兼容的 /images/generations（OpenAI / 硅基流动 / 自建 SD-WebUI 的兼容层）
 *
 * 对标社区里的 AI 绘图插件（Yunzai ap-plugin、Kirara AI 绘图、RH_ComfyUI），
 * 这里统一成一次 HTTP 调用，不需要额外部署绘图服务也能先跑通。
 */
'use strict';
import { num, str } from './_lib.mjs';
import { bridgeOf } from './_lib.mjs';

const cfgOf = (ctx) => (ctx && ctx.cfg) || {};

function sizeOf(a, c) {
  const w = Math.min(Math.max(Math.trunc(num(a.width) || num(c.width) || 768), 256), 1536);
  const h = Math.min(Math.max(Math.trunc(num(a.height) || num(c.height) || 768), 256), 1536);
  return { w, h };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 同一句话在 10 分钟内重复要图，直接复用，既快又不浪费免费额度 */
const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const cacheKey = (p, w, h) => `${w}x${h}|${p}`;
function cacheGet(k) {
  const v = CACHE.get(k);
  if (!v) return null;
  if (Date.now() - v.at > CACHE_TTL) { CACHE.delete(k); return null; }
  return v;
}
function cacheSet(k, val) {
  if (CACHE.size > 60) CACHE.delete(CACHE.keys().next().value);
  CACHE.set(k, Object.assign({ at: Date.now() }, val));
}

async function fromPollinations(prompt, { w, h }, c) {
  const key = cacheKey(prompt, w, h);
  const hit = cacheGet(key);
  if (hit) return hit;

  /* 免费服务按 IP 限流 / 匿名额度有限（402/429），退避重试几次 */
  let lastErr = null;
  const waits = [2500, 6000, 12000];
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    const seed = Math.trunc(num(c.seed) || Math.floor(Math.random() * 1e9));
    const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt.slice(0, 800)) +
      `?width=${w}&height=${h}&nologo=true&seed=${seed}` + (c.model ? '&model=' + encodeURIComponent(c.model) : '');
    const headers = str(c.apiKey) ? { Authorization: 'Bearer ' + str(c.apiKey) } : {};
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
      if (res.ok) {
        const out = { buf: Buffer.from(await res.arrayBuffer()), url };
        cacheSet(key, out);
        return out;
      }
      if (res.status === 402) {
        lastErr = new Error('免费出图额度用完了（402）。两个办法：① 去 pollinations.ai 领一个免费 token，填进本插件的「API Key」；② 把出图后端换成「OpenAI 兼容接口」并填 Key。也可以几十秒后再试');
        break;
      }
      if (res.status === 429 || res.status === 503) {
        lastErr = new Error(`出图服务繁忙（${res.status}），请稍等十几秒再要`);
        if (attempt < waits.length) { await sleep(waits[attempt]); continue; }
        break;
      }
      throw new Error('出图服务返回 ' + res.status);
    } catch (e) {
      lastErr = e;
      if (attempt < waits.length) { await sleep(waits[attempt]); continue; }
    }
  }
  throw lastErr || new Error('出图服务暂时不可用');
}

async function fromOpenAI(prompt, { w, h }, c) {
  const base = str(c.baseUrl || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
  if (!str(c.apiKey)) throw new Error('这条后端需要 API Key：去「⚙ 配置」里填 imagine 插件的 Key，或把后端换成 pollinations（免费）');
  const res = await fetch(base + '/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + str(c.apiKey) },
    body: JSON.stringify({
      model: str(c.model) || 'Kwai-Kolors/Kolors',
      prompt: prompt.slice(0, 800),
      image_size: `${w}x${h}`,
      batch_size: 1,
      n: 1,
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) {
    const msg = (await res.text()).slice(0, 160);
    throw new Error(`出图接口返回 ${res.status}：${msg}`);
  }
  const data = await res.json();
  const item = (data.data && data.data[0]) || {};
  if (item.b64_json) return { buf: Buffer.from(item.b64_json, 'base64'), url: '' };
  if (item.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(60000) });
    if (!img.ok) throw new Error('图片下载失败 ' + img.status);
    return { buf: Buffer.from(await img.arrayBuffer()), url: item.url };
  }
  throw new Error('接口没有返回图片数据');
}

export default {
  meta: {
    id: 'imagine',
    name: 'imagine',
    description: 'AI 画画：说一句描述就生成图片并直接发到群里',
    category: '娱乐',
  },

  settings: {
    title: 'AI 画画',
    intro: '默认用免费的 Pollinations（不用填 Key）；想用更好的模型可以换成 OpenAI 兼容接口。',
    fields: [
      {
        key: 'provider', label: '出图后端', type: 'select', default: 'pollinations',
        options: [{ value: 'pollinations', label: 'Pollinations（免费 · 无需 Key）' }, { value: 'openai', label: 'OpenAI 兼容接口（需 Key）' }],
      },
      { key: 'baseUrl', label: '接口地址（仅 openai 后端）', type: 'text', placeholder: 'https://api.siliconflow.cn/v1', help: 'OpenAI 填 https://api.openai.com/v1；自建 SD 兼容层填它的 /v1 地址' },
      { key: 'apiKey', label: 'API Key / Pollinations Token', type: 'password', placeholder: 'sk-... 或 pollinations 的免费 token', help: 'openai 后端必填；pollinations 后端可选——填了就带上，能解除匿名额度限制' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'flux', help: 'Pollinations 可用 flux / turbo；OpenAI 兼容填 Kwai-Kolors/Kolors 或 dall-e-3 等' },
      { key: 'width', label: '默认宽', type: 'number', default: 768, help: '256-1536' },
      { key: 'height', label: '默认高', type: 'number', default: 768, help: '256-1536' },
    ],
  },

  tools: [{
    name: 'qq_imagine',
    description: '按文字描述生成一张图片并发到 QQ。群友说"画个…""来张图""生成图片"时用。描述里可写风格与细节。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述，中文即可，可带风格，如「赛博朋克风格的猫，霓虹灯」' },
        width: { type: 'number', description: '宽度，默认用配置值' },
        height: { type: 'number', description: '高度，默认用配置值' },
        group_id: { type: 'number', description: '群号（群聊时传）' },
        user_id: { type: 'number', description: '私聊对象 QQ 号' },
      },
      required: ['prompt'],
    },
    run: async (a, ctx) => {
      const c = cfgOf(ctx);
      const prompt = str(a.prompt).slice(0, 800);
      if (!prompt) return '想画什么？给我一句描述。';
      const size = sizeOf(a, c);
      const provider = str(c.provider) || 'pollinations';

      let out;
      try {
        out = provider === 'openai' ? await fromOpenAI(prompt, size, c) : await fromPollinations(prompt, size, c);
      } catch (e) {
        return '没画出来：' + (e.message || e);
      }
      if (!out.buf || out.buf.length < 2000) return '出图返回的内容不像图片，稍后再试。';

      const b64 = out.buf.toString('base64');
      const gid = num(a.group_id), uid = num(a.user_id);
      try {
        const bridge = bridgeOf(ctx);
        if (gid) await bridge.sendImage({ groupId: gid }, b64);
        else if (uid) await bridge.sendImage({ userId: uid }, b64);
        else return out.url ? `画好了：${out.url}` : '画好了，但不知道发给谁：请带上 group_id 或 user_id。';
      } catch (e) {
        if (out.url) return `画好了但发不出去（${e.message}），图片直链：${out.url}`;
        return `画好了但发送失败：${e.message}`;
      }
      return `🎨 画好了（${size.w}×${size.h}，${Math.round(out.buf.length / 1024)}KB）`;
    },
  }],
};
