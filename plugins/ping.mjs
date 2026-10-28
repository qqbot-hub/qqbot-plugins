/* ping —— 一个真的会「收消息」的插件：群里发 /ping 或 @机器人，它就回 pong
 *
 * 这个插件的意义不只是好玩：它是「消息驱动」这条链路的活体证明 ——
 * 协议端把消息上报给市场，市场经 _router.mjs 归一化 + 匹配 + 权限判断后
 * 交给这里的 run()，run 里 api.reply 再顺着同一套协议层发回去。
 *
 * 配置项 pingText 可以改回复文案（市场里的「配置」按钮会生成表单）。
 */
'use strict';

const START = Date.now();

/** 运行时长，用来证明「确实是这个进程在回，不是缓存」 */
function uptime() {
  const s = Math.floor((Date.now() - START) / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
}

export default {
  meta: {
    id: 'ping',
    name: 'ping',
    description: '测活：群里发 /ping 或 @机器人，回一条带运行时长的 pong（用于验证消息链路是否通）',
    category: '工具',
    author: '本项目',
    version: '1.0.0',
  },

  settings: {
    title: 'ping 设置',
    intro: '改回复文案用；不填就用默认的 pong。',
    fields: [
      { key: 'pingText', label: '回复文案', type: 'text', placeholder: 'pong', help: '收到 /ping 时回的这句话' },
      { key: 'replyAtMe', label: '@ 也要回', type: 'bool', default: true, help: '关掉后只认 /ping 命令，@ 机器人不回' },
    ],
  },

  handlers: [
    {
      id: 'cmd',
      match: { prefix: '/ping' },
      scope: ['group', 'private'],
      permission: 'everyone',
      cooldownMs: 2000,
      async run(msg, api) {
        const text = String((api.cfg && api.cfg.pingText) || 'pong');
        const where = msg.scope === 'group' ? '群' : '私聊';
        await api.reply(`${text}（${where}链路通，已运行 ${uptime()}）`);
      },
    },
    {
      id: 'at',
      match: () => true,
      requireAtMe: true,
      scope: ['group'],
      permission: 'everyone',
      cooldownMs: 3000,
      async run(msg, api) {
        const cfg = api.cfg || {};
        if (cfg.replyAtMe === false || cfg.replyAtMe === 'false') return;
        const text = String(cfg.pingText || 'pong');
        await api.reply(`${text}（你 @ 的是我，来自 ${msg.nickname || msg.userId}）`);
      },
    },
  ],

  tools: [{
    name: 'qq_ping',
    description: '测活：返回插件市场进程是否在线、已运行多久（排查「机器人没反应」时先用它）',
    inputSchema: { type: 'object', properties: {} },
    run: async () => `pong · 市场进程已运行 ${uptime()}`,
  }],
};
