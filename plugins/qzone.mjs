/* qzone —— QQ 空间动态（SnowLuma 扩展 API；不可用时给出明确降级提示） */
'use strict';
import { num } from './_lib.mjs';
import { bridgeOf } from './_lib.mjs';

/* OneBot v11 标准没有空间接口；SnowLuma 提供了扩展端点。
 * 若当前 OneBot 实现不支持，会返回友好提示而不是报错。 */
async function tryExtension(ctx, action, params) {
  try {
    const r = await bridgeOf(ctx).raw(action, params);
    return r;
  } catch (e) {
    throw new Error('当前 OneBot 实现（SnowLuma）不支持空间接口：' + (e && e.message ? e.message : action));
  }
}

export default {
  meta: { id: 'qzone', name: 'qzone', description: 'QQ 空间动态：发一条说说、删掉自己的说说、看看自己和好友的动态', category: '群互动' },
  tools: [
    {
      name: 'qq_qzone_post', description: '发一条 QQ 空间说说（默认公开；可设好友可见/私密）',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '说说内容' },
          visibility: { type: 'string', description: 'public=公开（默认）/ friends=好友可见 / private=私密' },
        },
        required: ['content'],
      },
      run: async (a, ctx) => {
        const r = await tryExtension(ctx, 'set_qq_zone_feed', { content: String(a.content).slice(0, 500), visibility: a.visibility || 'public' });
        return r && r.tid ? `✏️ 说说已发出（tid: ${r.tid}）。` : '✏️ 说说已发出。';
      },
    },
    {
      name: 'qq_qzone_list', description: '看我自己最近发的说说',
      inputSchema: { type: 'object', properties: {} },
      run: async (a, ctx) => {
        const r = await tryExtension(ctx, 'get_qq_zone_feeds', { self: true, count: 5 });
        const list = (r && r.feeds) || [];
        if (!list.length) return '最近没有发过说说，或拿不到数据。';
        return '🖼️ 我最近的说说：\n' + list.slice(0, 5).map((f, i) => `${i + 1}. ${String(f.content).slice(0, 40)}（tid: ${f.tid}）`).join('\n');
      },
    },
    {
      name: 'qq_qzone_feeds', description: '看好朋友们最近的空间动态',
      inputSchema: { type: 'object', properties: {} },
      run: async (a, ctx) => {
        const r = await tryExtension(ctx, 'get_qq_zone_feeds', { self: false, count: 5 });
        const list = (r && r.feeds) || [];
        if (!list.length) return '好友空间暂时没有新动态。';
        return '👀 好友动态：\n' + list.slice(0, 5).map((f, i) => `${i + 1}. ${f.nickname || '好友'}：${String(f.content).slice(0, 40)}`).join('\n');
      },
    },
    {
      name: 'qq_qzone_delete', description: '删掉我发过的一条说说（需要 tid）',
      inputSchema: {
        type: 'object',
        properties: { tid: { type: 'string', description: '说说的 tid（先查列表）' } },
        required: ['tid'],
      },
      run: async (a, ctx) => {
        await tryExtension(ctx, 'del_qq_zone_feed', { tid: String(a.tid) });
        return `🗑️ 已删除说说（tid: ${a.tid}）。`;
      },
    },
  ],
};
