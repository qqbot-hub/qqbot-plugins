/* ============================================================
 * index.mjs —— 插件开发模板（复制这一份改成你自己的插件）
 *
 * 三步上手：
 *   1. 复制整个 _template 目录到 plugins/ 下，改名为 <你的插件id>（目录名不重要，
 *      真正起作用的是下面 meta.id 和 plugins/<meta.id>.mjs 的文件名）
 *   2. 改 meta / settings / handlers
 *   3. 跑测试：node plugins/_template/test.mjs
 *
 * 注意：文件必须叫 plugins/<id>.mjs 才会被加载（单个 .mjs 文件，不是目录）。
 *       所以实际做法是：复制这个 index.mjs → plugins/你的id.mjs
 *
 * 插件能用的两套出口（可以只写一套，也可以都写）：
 *   handlers —— 收到群/私聊消息时被触发（消息驱动）
 *   tools    —— 暴露成 AI 可调用的工具（MCP）
 * ============================================================ */
'use strict';

export default {
  /* ---------- 元信息：市场页面显示这些 ---------- */
  meta: {
    id: 'example-echo',                 // 必须和文件名一致（plugins/example-echo.mjs）
    name: 'echo',
    description: '示例插件：演示收消息、发文本、发图片、权限判断、配置声明',
    category: '工具',
    author: '你的名字',
    version: '1.0.0',
    homepage: '',                       // 可选，填了市场会显示「上游」链接
  },

  /* ---------- 配置声明：市场会自动生成表单，值存在 config.json 的 plugins.<id> ---------- */
  settings: {
    title: 'echo 设置',
    intro: '这些字段会在插件卡片上生成配置表单，用户填完保存就能用。',
    fields: [
      { key: 'greeting', label: '打招呼语', type: 'text', placeholder: '在的', help: '收到 /hi 时回这句话' },
      { key: 'adminOnlyCmd', label: '管理命令前缀', type: 'text', placeholder: '/admin', help: '演示权限判断：只有管理员能用' },
    ],
  },

  /* ---------- 消息处理：收到消息时按顺序匹配，命中就执行 ---------- */
  handlers: [
    {
      id: 'hi',
      /* match 支持四种写法：正则 / 完全相等的字符串 / {prefix} / 函数 */
      match: { prefix: '/hi' },
      scope: ['group', 'private'],      // 默认两者都听
      permission: 'everyone',           // everyone / admin / owner
      cooldownMs: 3000,                 // 同一个人 3 秒内重复触发只算一次
      async run(msg, api) {
        const who = msg.nickname || msg.userId;
        const greet = String((api.cfg && api.cfg.greeting) || '在的');
        /* api.reply 直接回到消息来的地方（群 → 群，私聊 → 私聊） */
        await api.reply(`${greet}，${who}。\n（收到你的消息：${msg.text.slice(0, 40)}）`);
      },
    },
    {
      id: 'at-me',
      match: () => true,                // 任何消息都可能命中，靠 requireAtMe 收窄
      requireAtMe: true,                // 只有 @机器人 时才触发
      scope: ['group'],
      permission: 'everyone',
      cooldownMs: 5000,
      async run(msg, api) {
        await api.reply('你 @ 我了。这条来自 requireAtMe 规则。');
      },
    },
    {
      id: 'admin-demo',
      match: { prefix: '/mute-test' },
      scope: ['group'],
      permission: 'admin',              // 非管理员会被路由层拦掉，run 根本不会执行
      async run(msg, api) {
        /* api.sendText 可以发给任意会话；这里演示回到当前群 */
        await api.sendText({ groupId: msg.groupId }, '管理员命令执行成功（这条只有管理员能看到）');
      },
    },
  ],

  /* ---------- AI 工具（可选）：暴露给 MCP 宿主，让 AI 主动调用 ---------- */
  tools: [
    {
      name: 'qq_example_echo',
      description: '示例工具：把传入的文字原样返回，用来验证工具链路是否通',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: '要回显的文字' } },
        required: ['text'],
      },
      /* run(input, ctx)；ctx.cfg 是这个插件的配置，ctx.onebot 是协议客户端 */
      run: async ({ text }, ctx) => `echo: ${String(text || '')}（配置的打招呼语：${(ctx && ctx.cfg && ctx.cfg.greeting) || '未设置'}）`,
    },
  ],
};
