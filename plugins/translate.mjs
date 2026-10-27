/* translate —— 翻译（MyMemory 免费接口，无需 key） */
'use strict';
import { httpJson } from './_lib.mjs';

const LANG = { zh: 'zh-CN', 中文: 'zh-CN', en: 'en', 英文: 'en', 日: 'ja', ja: 'ja', 韩: 'ko', ko: 'ko', 法: 'fr', 德: 'de', 俄: 'ru', es: 'es' };

export default {
  meta: { id: 'translate', name: 'translate', description: '翻译：中英互译（免费接口，长句可能不准）', category: '工具' },
  tools: [{
    name: 'qq_translate',
    description: '翻译一段话。不指定语言时自动中英互译。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要翻译的内容' },
        to: { type: 'string', description: '目标语言，如 en/ja/zh，默认自动（中文译英、其他译中）' },
      },
      required: ['text'],
    },
    run: async ({ text, to }) => {
      const s = String(text || '').trim();
      if (!s) return '要翻译什么呀？';
      const hasCJK = /[\u4e00-\u9fff]/.test(s);
      const target = LANG[String(to || '').toLowerCase()] || (hasCJK ? 'en' : 'zh-CN');
      const source = hasCJK ? 'zh-CN' : 'en';
      try {
        const r = await httpJson(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(s)}&langpair=${source}|${target}`);
        const t = r && r.responseData && r.responseData.translatedText;
        if (!t) return '翻译失败了，换个说法试试。';
        return `🌐 ${t}`;
      } catch { return '翻译服务这会儿连不上，稍后再试。'; }
    },
  }],
};
