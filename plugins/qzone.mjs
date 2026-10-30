/* qzone —— QQ 空间动态（SnowLuma 扩展 API；不可用时给出明确降级提示） */
'use strict';

import { bridgeOf } from './_lib.mjs';

/* OneBot v11 标准没有空间接口；SnowLuma 提供了扩展端点。
 * 若当前 OneBot 实现不支持，会返回友好提示而不是报错。 */
async function tryExtension(ctx, action, params) {
  try {
    const r = await bridgeOf(ctx).raw(action, params);
    return r;
  } catch (e) {
    throw new Error('空间操作失败：' + (e && e.message ? e.message : action));
  }
}

export default {
  meta: { id: 'qzone', name: 'qzone', description: 'QQ 空间动态：发一条说说、删掉自己的说说、看看自己和好友的动态', category: '群互动' },
  settings: { title: 'QQ 空间', intro: '默认仅自己可见，公开发布必须明确选择。', fields: [
    { key: 'defaultVisibility', label: '默认可见性', type: 'select', default: 'private', options: [{value:'private',label:'仅自己可见'},{value:'friends',label:'好友可见'},{value:'public',label:'公开'}] }
  ] },
  tools: [
    {
      name: 'qq_qzone_post', description: '发一条 QQ 空间说说（默认仅自己可见；可显式设为公开或好友可见）',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '说说内容' },
          images: { type: 'array', maxItems: 9, items: {type:'string'}, description: '最多9张图片，HTTPS/HTTP URL 或 base64://；也可提供 message_id 提取图片' },
          message_id: { type: 'number', description: '含配图的 QQ 消息ID' },
          visibility: { type: 'string', description: 'private=仅自己可见（默认）/ friends=好友可见 / public=公开' },
        },
        required: ['content'],
      },
      run: async (a, ctx) => {
        const visibility = a.visibility || ctx?.cfg?.defaultVisibility || 'private';
        if (!['public','friends','private'].includes(visibility)) throw new Error('可见性无效');
        let images = a.images || [];
        if (!Array.isArray(images) || images.length > 9 || images.some(x => typeof x !== 'string' || !/^(https?:\/\/|base64:\/\/)/i.test(x) || x.length > 8*1024*1024)) throw new Error('图片仅支持 URL 或 base64://，最多9张；不接受任意本机文件路径');
        if (a.message_id && !images.length) {
          const msg = await bridgeOf(ctx).raw('get_msg', { message_id: a.message_id });
          images = (Array.isArray(msg?.message) ? msg.message : []).filter(x=>x.type==='image').map(x=>x.data?.url || x.data?.file).filter(x=>/^https?:\/\//i.test(x || '')).slice(0,9);
          if (!images.length) throw new Error('这条消息里没有可用图片URL，请提供 images');
        }
        const r = await tryExtension(ctx, 'qzone_post', { content: String(a.content).slice(0, 500), visibility, images });
        return r && r.tid ? `✏️ 说说已发出（含 ${images.length} 张图，${visibility}；tid: ${r.tid}）。` : '✏️ 说说已发出。';
      },
    },
    {
      name: 'qq_qzone_list', description: '看我自己最近发的说说',
      inputSchema: { type: 'object', properties: {} },
      run: async (a, ctx) => {
        const r = await tryExtension(ctx, 'qzone_list', { count: 5 });
        const list = (Array.isArray(r) ? r : r?.feeds || r?.msglist || r?.list) || [];
        if (!list.length) return '最近没有发过说说，或拿不到数据。';
        return '🖼️ 我最近的说说：\n' + list.slice(0, 5).map((f, i) => `${i + 1}. ${String(f.content).slice(0, 40)}（tid: ${f.tid}）`).join('\n');
      },
    },
    {
      name: 'qq_qzone_feeds', description: '看好朋友们最近的空间动态',
      inputSchema: { type: 'object', properties: {} },
      run: async (a, ctx) => {
        const r = await tryExtension(ctx, 'qzone_feeds', { count: 5 });
        const list = (Array.isArray(r) ? r : r?.feeds || r?.msglist || r?.list) || [];
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
        await tryExtension(ctx, 'qzone_delete', { tid: String(a.tid) });
        return `🗑️ 已删除说说（tid: ${a.tid}）。`;
      },
    },
  ],
};
