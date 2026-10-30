/* voice —— 语音合成（TTS）并作为语音消息发到 QQ
 *
 * 两种后端，在「⚙ 配置」里切换：
 *   openai  OpenAI 兼容的云端接口（需 Key）
 *           · OpenAI           baseUrl=https://api.openai.com/v1   model=tts-1      voice=alloy
 *           · 硅基流动         baseUrl=https://api.siliconflow.cn/v1 model=FunAudioLLM/CosyVoice2-0.5B
 *   breeze  本地 Breeze-TTS-2.cpp（免 Key，数据不出本机）
 *           · 先跑起来：breeze-server breeze-tts-2-q8_0.gguf --host 127.0.0.1 --port 8080
 *           · 地址填 http://127.0.0.1:8080/v1，支持音色设计/克隆（instruction / voice）
 *   voxd    SurfCore 的语音引擎（免 Key，直接复用它的本地/云端 TTS）
 *           · 本地 8765 / 云端 8767，接口是 POST {baseUrl}/v1/speak/file → 返回 wav 字节
 *           · 装了 SurfCore 就不用再配 Key，两边共用同一套音色
 *
 * openai / breeze 走 POST {baseUrl}/audio/speech；voxd 走 POST {baseUrl}/v1/speak/file。
 *
 * 说明：QQ 语音对编码有要求（silk/amr），多数 OneBot 实现会自动转码 mp3；
 * 若你的协议端报错，请在协议端开启转码。
 */
'use strict';
import { num, str } from './_lib.mjs';
import { bridgeOf } from './_lib.mjs';

const cfgOf = (ctx) => (ctx && ctx.cfg) || {};

function baseOf(ctx) {
  const c = cfgOf(ctx);
  const provider = str(c.provider);
  const fallback = provider === 'breeze' ? 'http://127.0.0.1:8080/v1'
    : provider === 'voxd' ? 'http://127.0.0.1:8765'
    : 'https://api.siliconflow.cn/v1';
  return str(c.baseUrl || fallback).replace(/\/+$/, '');
}

const isLocal = (url) => /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|host\.docker\.internal)(:|\/|$)/i.test(url);

/* 把音频字节作为语音条发出去（三个后端共用） */
async function sendRecord(ctx, buf, a, text, sourceLabel) {
  const b64 = buf.toString('base64');
  const gid = num(a.group_id), uid = num(a.user_id);
  try {
    const bridge = bridgeOf(ctx);
    if (gid) await bridge.sendRecord({ groupId: gid }, b64);
    else if (uid) await bridge.sendRecord({ userId: uid }, b64);
    else return '语音已生成，但不知道发给谁：请带上 group_id 或 user_id。';
  } catch (e) {
    return `语音已生成（${Math.round(buf.length / 1024)}KB），但发送失败：${e.message}。检查 OneBot 是否在线、协议端是否支持语音格式。`;
  }
  return `🔊 语音已发出（${Math.round(buf.length / 1024)}KB，${text.length} 字，${sourceLabel}）`;
}

export default {
  meta: {
    id: 'voice',
    name: 'voice',
    description: '语音合成：把一段文字变成语音消息发到 QQ（云端 API 或本地 Breeze-TTS）',
    category: '工具',
  },

  settings: {
    title: '语音（TTS）',
    intro: '云端接口要填 Key；本地 Breeze-TTS 跑在自己电脑上，不用 Key、不上传数据。',
    fields: [
      {
        key: 'provider', label: '后端', type: 'select', default: 'baidu',
        options: [
          { value: 'baidu', label: '百度翻译 TTS（免 Key；文本发送至百度，最长100字）' },
          { value: 'openai', label: 'OpenAI 兼容云端接口（需 Key）' },
          { value: 'breeze', label: '本地 Breeze-TTS-2.cpp（免 Key）' },
          { value: 'voxd', label: 'SurfCore 语音引擎 voxd（免 Key）' },
        ],
      },
      { key: 'baseUrl', label: '接口地址', type: 'text', placeholder: 'https://api.siliconflow.cn/v1 或 http://127.0.0.1:8080/v1', help: 'OpenAI 填 https://api.openai.com/v1；本地 Breeze 填 http://127.0.0.1:8080/v1（它默认 8080 端口）' },
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...（本地后端可留空）', help: '云端必填；本地 Breeze 不需要，留空即可' },
      { key: 'model', label: '模型（仅云端）', type: 'text', placeholder: 'FunAudioLLM/CosyVoice2-0.5B', help: 'OpenAI 用 tts-1；硅基流动用 FunAudioLLM/CosyVoice2-0.5B；本地 Breeze 不用填' },
      { key: 'voice', label: '音色 / voice_id', type: 'text', placeholder: 'FunAudioLLM/CosyVoice2-0.5B:anna 或 narrator', help: '云端填音色名；本地 Breeze 填保存过的 voice_id，留空用默认音色' },
      { key: 'character', label: '角色名（仅 SurfCore voxd）', type: 'text', placeholder: '如 大肥鱼', help: 'SurfCore 语音引擎按角色选择音色；留空用它的默认音色' },
      { key: 'instruction', label: '语气指令（仅本地 Breeze）', type: 'text', placeholder: '轻声、慢一点、带点笑意', help: 'Breeze 支持用一句话描述语气，会直接影响合成效果' },
      { key: 'speed', label: '语速', type: 'number', default: 1, help: '0.5 - 2.0，默认 1（本地 Breeze 可能忽略）' },
      { key: 'format', label: '音频格式', type: 'select', options: ['mp3', 'wav', 'opus'], default: 'mp3' },
    ],
  },

  tools: [{
    name: 'qq_tts',
    description: '把文字合成为语音并发到 QQ。群友说"用语音说""念一下""来个语音"时用。不要复述原文。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要念出来的文字，建议 100 字以内' },
        voice: { type: 'string', description: '临时换音色 / voice_id，可留空用配置里的' },
        tone: { type: 'string', description: '语气描述（仅本地 Breeze 生效），如"温柔一点""兴奋地说"' },
        group_id: { type: 'number', description: '群号（群聊时传）' },
        user_id: { type: 'number', description: '私聊对象 QQ 号' },
      },
      required: ['text'],
    },
    run: async (a, ctx) => {
      const c = cfgOf(ctx);
      const text = str(a.text).slice(0, 300);
      if (!text) return '要念什么？把文字给我。';

      const provider = str(c.provider) || 'baidu';
      const base = baseOf(ctx);
      const key = str(c.apiKey);
      const voiceId = str(a.voice) || str(c.voice);
      if (provider === 'openai' && !key) {
        return '还没配置语音接口：去市场「⚙ 配置」里填 voice 插件的接口地址和 API Key（或把后端切成「本地 Breeze-TTS」/「SurfCore voxd」，这两个不用 Key）。';
      }

      if (provider === 'baidu') {
        if(str(a.text).length > 100) return '百度免 Key 语音每次最多100字，请缩短后重试。';
        const speed=Math.max(1,Math.min(9,Math.round((Number(c.speed)||1)*5)));
        const url='https://fanyi.baidu.com/gettts?'+new URLSearchParams({lan:'zh',text,spd:String(speed),source:'web'});
        try {
          const r=await fetch(url,{signal:AbortSignal.timeout(20000)});
          if(!r.ok || !/audio|octet-stream/i.test(r.headers.get('content-type')||''))return '百度语音暂不可用，请稍后重试或切换后端。';
          const parts=[];let size=0;for await(const part of r.body){size+=part.length;if(size>4*1024*1024)throw new Error('音频超过4MB');parts.push(Buffer.from(part));}
          const audio=Buffer.concat(parts);if(audio.length<1000)return '百度返回的音频过短，请切换后端。';
          return await sendRecord(ctx,audio,a,text,'百度免 Key');
        }catch(e){return '百度语音请求失败：'+e.message+'；可以切换为本地或云端后端。';}
      }
      if (provider === 'voxd') {
        const body = { text, format: 'wav', sr: 24000, cache: true };
        if (voiceId) body.voice = voiceId;
        const ch = str(c.character);
        if (ch) body.character = ch;
        let buf2;
        try {
          const res = await fetch(base + '/v1/speak/file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120000),
          });
          if (!res.ok) return `SurfCore 语音引擎返回 ${res.status}：${(await res.text()).slice(0, 160)}`;
          buf2 = Buffer.from(await res.arrayBuffer());
        } catch (e) {
          return `连不上 SurfCore 语音引擎（${base}）：确认 SurfCore 的语音包已启动（本地默认 8765）`;
        }
        if (!buf2 || buf2.length < 1000) return 'SurfCore 语音引擎返回的内容不像音频，检查角色名/语音包是否安装。';
        return await sendRecord(ctx, buf2, a, text, 'SurfCore 本地引擎');
      }

      const format = str(c.format) || 'mp3';
      let body;
      if (provider === 'breeze') {
        /* Breeze 本地服务：无鉴权；额外支持 instruction 语气指令与 voice_id */
        body = {
          input: text,
          response_format: format,
          voice: voiceId || 'default',
          voice_id: voiceId || 'default',
        };
        const tone = str(a.tone) || str(c.instruction);
        if (tone) body.instruction = tone;
      } else {
        body = {
          model: str(c.model) || 'FunAudioLLM/CosyVoice2-0.5B',
          input: text,
          voice: voiceId || 'FunAudioLLM/CosyVoice2-0.5B:anna',
          response_format: format,
        };
        const sp = num(c.speed);
        if (Number.isFinite(sp) && sp > 0) body.speed = Math.min(Math.max(sp, 0.5), 2);
      }

      const headers = { 'Content-Type': 'application/json' };
      /* 只有云端才带 Authorization；本地地址即使填了 Key 也不必带 */
      if (key && (provider !== 'breeze' || !isLocal(base))) headers.Authorization = 'Bearer ' + key;

      let buf;
      try {
        const res = await fetch(base + '/audio/speech', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120000),
        });
        if (!res.ok) {
          const msg = (await res.text()).slice(0, 200);
          return `语音接口返回 ${res.status}：${msg}`;
        }
        buf = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        const hint = provider === 'breeze'
          ? '连不上本地 Breeze：确认 breeze-server 已启动（默认 8080，地址要带 /v1）'
          : '连不上语音接口';
        return `${hint}：${e.message || e}`;
      }
      if (!buf || buf.length < 1000) return '语音接口返回的内容不像音频，检查模型/音色名是否正确。';

      return await sendRecord(ctx, buf, a, text, provider === 'breeze' ? '本地 Breeze' : '云端');
    },
  }],
};
