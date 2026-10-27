# 插件开发规范（PLUGIN_SPEC）

一个 QQ-Plugin-Hub 插件 = `plugins/` 下的一个自包含 `.mjs` 文件。零依赖、ESM、直接用 Node 内置模块。

## 最小示例

```js
// plugins/hello.mjs
export default {
  meta: {
    id: 'hello',           // 唯一 ID，与文件名、data/plugins.json 里的 id 一致
    name: 'hello',
    description: '打招呼',
    category: '娱乐',       // 工具 / 群管理 / 群互动 / 娱乐 / 小游戏
  },
  tools: [{
    name: 'qq_hello',      // 工具名（DSH 里显示为 mcp__qqhub__qq_hello）
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
2. 在 `data/plugins.json` 追加一条（id/name/description/category/tools 同 `meta`）；
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
| `ctx.onebot(action, params)` | 调 SnowLuma 的 OneBot v11 HTTP API。例：`await ctx.onebot('set_group_ban', { group_id, user_id, duration: 600 })`。失败会抛错（含 action 名）。 |
| `ctx.cfg` | 本插件在市场里填的配置对象（`config.json` 的 `plugins.<id>`），没配就是 `{}` |
| `ctx.config` | 整份 `config.json`（含 `snowluma.httpUrl` 等连接渠道） |

## 持久化（直接从共享库导入，不经过 ctx）

```js
import { storage, sessionOf, todayKey } from './_lib.js';

const st = storage('hello');           // 存到 data/store/hello/
st.set('db', { a: 1 });
st.get('db', {});                      // 带默认值
```

会话识别约定：工具的 `inputSchema` 里带上可选的 `group_id` / `user_id`（AI 在群聊里知道这两个号），用 `sessionOf(args)` 归一化成 `group:<gid>` / `private:<uid>` 作为存储键。

## 主动消息（定时类插件）

导出 `export function fireDue(ctx)`，MCP 进程每 15 秒会调用一次；到点时用 `ctx.onebot('send_group_msg', …)` / `send_private_msg` 主动推送。参考 `plugins/remind.mjs`。

## 规范与红线

1. **危险操作必须要求 `confirm: true`**（踢人/全体禁言/设管理员/删数据），schema 里写清楚，run 里先校验；
2. **description 写"什么时候该用"**——AI 靠它决定何时调用，比名字更重要；
3. 不抓取版权音频/视频内容，点歌类只返回平台链接；
4. 联网一律免费公开接口、显式超时、失败给友好中文提示（参考 `plugins/weather.mjs`）；
5. 输出尽量短（QQ 消息），多行用 `\n`，少用 Markdown（桥接会转纯文本）；
6. 同一插件文件内可以有多个 tools（如 signin 的签到+排行榜）。
