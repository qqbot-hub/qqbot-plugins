/* voice —— 语音合成（TTS）并作为语音消息发到 QQ
 *
 * 走 OpenAI 兼容的 /audio/speech 接口，所以下面这些都能直接接：
 *   · OpenAI           baseUrl=https://api.openai.com/v1        model=tts-1        voice=alloy
 *   · 硅基流动 SiliconFlow baseUrl=https://api.siliconflow.cn/v1 model=FunAudioLLM/CosyVoice2-0.5B
 *   · 本地 GPT-SoVITS / CosyVoice / fish-speech 等自建兼容服务
 *
 * 对标 qq-bridge 的 Edge TTS 语音回复（PR #74）与 edge-tts 项目，
 * 但这里统一走标准 HTTP 接口，不依赖 Python 与本地模型。
 *
 * 说明：QQ 语音对编码有要求（silk/amr），多数 OneBot 实现会自动转码 mp3；
 * 若你的协议端报错，请在协议端开启转码，或改用 send_mode=file 让协议端自己处理。
 */
'use strict';
import { num, str } from './_lib.mjs';

const cfgOf = (ctx) => (ctx && ctx.cfg) || {};
const baseOf = (ctx) => str(cfgOf(ctx).baseUrl || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');

export default {
  meta: {
    id: 'voice',
    name: 'voice',
    description: '语音合成：把一段文字变成语音消息发到 QQ（OpenAI 兼容 TTS 接口）',
    category: '工具',
  },

  settings: {
    title: '语音（TTS）',
    intro: '需要一个 OpenAI 兼容的语音接口。没填 Key 时插件会提示你，不会静默失败。',
    fields: [
      { key: 'baseUrl', label: '接口地址', type: 'text', placeholder: 'https://api.siliconflow.cn/v1', help: 'OpenAI 填 https://api.openai.com/v1；自建 GPT-SoVITS 填它暴露的 /v1 地址' },
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...', help: '必填。本地自建服务没鉴权的话随便填一个非空值即可' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'FunAudioLLM/CosyVoice2-0.5B', help: 'OpenAI 用 tts-1；硅基流动用 FunAudioLLM/CosyVoice2-0.5B' },
      { key: 'voice', label: '音色', type: 'text', placeholder: 'FunAudioLLM/CosyVoice2-0.5B:anna', help: 'OpenAI 用 alloy / nova / shimmer；硅基流动用 "模型:音色名" 格式' },
      { key: 'speed', label: '语速', type: 'number', default: 1, help: '0.5 - 2.0，默认 1' },
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
        voice: { type: 'string', description: '临时换音色，可留空用配置里的' },
        group_id: { type: 'number', description: '群号（群聊时传）' },
        user_id: { type: 'number', description: '私聊对象 QQ 号' },
      },
      required: ['text'],
    },
    run: async (a, ctx) => {
      const c = cfgOf(ctx);
      const text = str(a.text).slice(0, 300);
      if (!text) return '要念什么？把文字给我。';
      if (!str(c.apiKey)) return '还没配置语音接口：去市场「⚙ 配置」里填 voice 插件的接口地址和 API Key。';

      const body = {
        model: str(c.model) || 'FunAudioLLM/CosyVoice2-0.5B',
        input: text,
        voice: str(a.voice) || str(c.voice) || 'FunAudioLLM/CosyVoice2-0.5B:anna',
        response_format: str(c.format) || 'mp3',
      };
      const sp = num(c.speed);
      if (Number.isFinite(sp) && sp > 0) body.speed = Math.min(Math.max(sp, 0.5), 2);

      let buf;
      try {
        const res = await fetch(baseOf(ctx) + '/audio/speech', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + str(c.apiKey) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        });
        if (!res.ok) {
          const msg = (await res.text()).slice(0, 160);
          return `语音接口返回 ${res.status}：${msg}`;
        }
        buf = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        return '连不上语音接口：' + (e.message || e) + '（检查地址是否可达、Key 是否正确）';
      }
      if (!buf || buf.length < 1000) return '语音接口返回的内容不像音频，检查模型/音色名是否正确。';

      const b64 = buf.toString('base64');
      const segment = [{ type: 'record', data: { file: 'base64://' + b64 } }];
      const gid = num(a.group_id), uid = num(a.user_id);
      try {
        if (gid) await ctx.onebot('send_group_msg', { group_id: gid, message: segment });
        else if (uid) await ctx.onebot('send_private_msg', { user_id: uid, message: segment });
        else return '语音已生成，但不知道发给谁：请带上 group_id 或 user_id。';
      } catch (e) {
        return `语音已生成（${Math.round(buf.length / 1024)}KB），但发送失败：${e.message}。检查 OneBot 是否在线、协议端是否支持语音格式。`;
      }
      return `🔊 语音已发出（${Math.round(buf.length / 1024)}KB，${text.length} 字）`;
    },
  }],
};
