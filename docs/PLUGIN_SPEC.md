# 插件开发规范（PLUGIN_SPEC）

一个 qqbot-plugins 插件 = `plugins/` 下的一个自包含 `.mjs` 文件。零依赖、ESM、直接用 Node 内置模块。

## 最小示例

```js
// plugins/hello.mjs
export default {
  meta: {
    id: 'hello',           // 唯一 ID，与文件名、data/catalog/plugins.json 里的 id 一致
    name: 'hello',
    description: '打招呼',
    category: '娱乐',       // 工具 / 群管理 / 群互动 / 娱乐 / 小游戏
  },
  tools: [{
    name: 'qq_hello',      // 工具名（DSH 里显示为 mcp__qqbot__qq_hello）
    description: '跟某人说你好。有人喊"打个招呼"时用。',
    inputSchema: {         // JSON Schema，AI 靠它填参数
      type: 'object',
      properties: { who: { type: 'string', description: '对谁说' } },
      required: ['who'],
    },
    run: async (args, ctx) => `你好，${args.who}！`,   // 返回字符串即可
  }],
};
```

## 上架

1. 把文件放进 `plugins/`；
2. 在 `data/catalog/plugins.json` 追加一条（id/name/description/category/tools 同 `meta`）；
3. 刷新市场页面 → 安装 → 重启 DSH。

## 可配置项（可选）

插件自己声明 `settings`，市场会自动在卡片上生成「⚙ 配置」按钮和表单，保存到 `config.json` 的 `plugins.<id>`，并在每次工具调用时通过 `ctx.cfg` 注入：

```js
export default {
  meta: { ... },
  settings: {
    title: '群管理权限',
    intro: '不填 = 不做限制。',
    fields: [
      { key: 'admins', label: '管理员 QQ 白名单', type: 'list', placeholder: '每行一个', help: '...' },
      { key: 'defaultBanMinutes', label: '默认禁言分钟', type: 'number', default: 10 },
      { key: 'requireConfirm', label: '危险操作需确认', type: 'boolean', default: true },
      { key: 'mode', label: '模式', type: 'select', options: [{ value: 'a', label: 'A 模式' }] },
      { key: 'city', label: '城市', type: 'text' },
      { key: 'secret', label: '密钥', type: 'password' },
    ],
  },
  tools: [{
    name: 'qq_demo',
    description: '示例',
    inputSchema: { type: 'object', properties: {} },
    run: async (args, ctx) => {
      const c = ctx.cfg || {};          // 就是市场里填的那份配置
      return '默认值：' + (c.defaultBanMinutes ?? 10);
    },
  }],
};
```

字段类型：`text` / `number` / `boolean` / `list`（多行，按空白或逗号切分）/ `password` / `select`。
`list` 会在保存时变成字符串数组，可直接 `Array.isArray` 使用。

## ctx 注入了什么

| 成员 | 用途 |
| --- | --- |
| `ctx.bridge` | **推荐**：协议端语义接口，见 [PROTOCOLS.md](PROTOCOLS.md)。例：`await ctx.bridge.banMember(gid, uid, 10)`、`ctx.bridge.sendText({ groupId }, '好')`、`ctx.bridge.heartbeat()`。动作名差异、鉴权、超时都已收敛在适配层，插件里不要写协议端判断。 |
| `ctx.onebot(action, params)` | 低层逃生舱：直接调 OneBot v11 HTTP API。例：`await ctx.onebot('set_group_ban', { group_id, user_id, duration: 600 })`。失败会抛错（含 action 名）。 |
| `ctx.cfg` | 本插件在市场里填的配置对象（`config.json` 的 `plugins.<id>`），没配就是 `{}` |
| `ctx.config` | 整份 `config.json`（含 `snowluma.httpUrl` 等连接渠道） |

## 持久化（直接从共享库导入，不经过 ctx）

```js
import { storage, sessionOf, todayKey } from './_lib.mjs';

const st = storage('hello');           // 存到 data/store/hello/
st.set('db', { a: 1 });
st.get('db', {});                      // 带默认值
```

会话识别约定：工具的 `inputSchema` 里带上可选的 `group_id` / `user_id`（AI 在群聊里知道这两个号），用 `sessionOf(args)` 归一化成 `group:<gid>` / `private:<uid>` 作为存储键。

## 主动消息（定时类插件）

导出 `export function fireDue(ctx)`，MCP 进程每 15 秒会调用一次；到点时用 `ctx.onebot('send_group_msg', …)` / `send_private_msg` 主动推送。参考 `plugins/remind.mjs`。

## 消息驱动（可选，第二套出口）

`tools` 是「等 AI 来调」，`handlers` 是「群里有消息就响应」。两者可以写在同一个插件里。

```js
export default {
  meta: { id: 'hello', name: 'hello', description: '收到 /hi 就打招呼', category: '工具' },
  handlers: [{
    id: 'hi',                          // 同一插件内多个 handler 用 id 区分
    match: { prefix: '/hi' },          // 正则 / 字符串(完全相等) / {prefix} / {contains} / 函数
    scope: ['group', 'private'],        // 默认两者都听
    permission: 'everyone',             // everyone | admin | owner
    cooldownMs: 3000,                   // 同一人同一 handler 的冷却
    requireAtMe: false,                 // true = 只处理 @机器人 的消息
    async run(msg, api) {
      await api.reply(`你好，${msg.nickname}`);
    },
  }],
};
```

### msg（两种协议归一化后完全一致）

`protocol` · `scope` · `groupId` · `userId` · `nickname` · `role`（owner/admin/member）·
`text` · `atMe` · `messageId` · `selfId` · `time` · `raw`（原始事件）

### api

| 方法 | 说明 |
| --- | --- |
| `api.reply(text)` | 回到消息来的地方（群→群，私聊→私聊），走统一协议层 |
| `api.sendText({groupId｜userId}, text)` | 发给指定会话 |
| `api.cfg` | 本插件配置（同 `ctx.cfg`） |
| `api.log(msg)` | 写日志，自动带插件名前缀 |

### 路由层替你做了什么

- 机器人自己发的消息直接丢弃（防自触发死循环）
- 权限不够时**根本不执行 `run`**，并计入「权限拦」统计
- 一个插件抛错不影响其它插件收这条消息
- 匹配函数自己抛错 → 当作不匹配，不崩路由

完整说明与排查表见 [MESSAGE.md](MESSAGE.md)；可直接复制的骨架见 `plugins/_template/`，
自检命令 `node plugins/_template/test.mjs`（21 项断言，不需要连 QQ）。

## 规范与红线

1. **危险操作必须要求 `confirm: true`**（踢人/全体禁言/设管理员/删数据），schema 里写清楚，run 里先校验；
2. **description 写"什么时候该用"**——AI 靠它决定何时调用，比名字更重要；
3. 不抓取版权音频/视频内容，点歌类只返回平台链接；
4. 联网一律免费公开接口、显式超时、失败给友好中文提示（参考 `plugins/weather.mjs`）；
5. 输出尽量短（QQ 消息），多行用 `\n`，少用 Markdown（桥接会转纯文本）；
6. 同一插件文件内可以有多个 tools（如 signin 的签到+排行榜）。
