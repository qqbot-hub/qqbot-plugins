# 消息接入：让插件真的能「收到」群消息

## 为什么要有这一层

在这之前，这套市场的插件都是**工具**：等 AI 来调，或者等用户点。群里的消息一条也进不来。
所以「插件响应群消息」这件事，在代码层面原本是空的 —— 不是没做，是没有入口。

这一层补的就是入口：

```
QQ 群消息
   │
   ├─ OneBot v11 协议端（NapCat / SnowLuma / LLOneBot）
   │     │  HTTP 上报（POST）
   │     ▼
   │  http://127.0.0.1:3210/api/onebot/event
   │
   ▼
_router.mjs 归一化 ──► 统一 msg 结构 ──► 按插件声明的 handlers 匹配
                                              │
                                     权限判断 ──► 限流 ──► 执行 run()
                                                              │
                                                     api.reply() ──► 统一协议层 ──► 发回群里
```

关键点：**发消息走的是同一套协议抽象层**（`_protocol.mjs`），所以插件作者不需要知道
底下是 OneBot 还是 Satori，也不需要知道端口是多少。

## 怎么配（3 步）

1. 打开市场 →「运行监控」→「消息接入」，复制那里的**上报地址**
2. 到协议端里填上（以 NapCat 为例：网络配置 → HTTP 服务器 → 上报地址）
   | 项 | 怎么填 |
   |---|---|
   | 主机 | `127.0.0.1` |
   | 端口 | `3210` |
   | 上报地址 | `/api/onebot/event?token=你的AccessToken` |
   | 消息格式 | `array`（默认） |
   | 心跳 | 可以不填（我们不依赖心跳判断在线） |

3. 装一个带 `handlers` 的插件（例如市场里的 **ping**），群里发 `/ping`

「运行监控 → 消息接入」里的计数会立刻变化：**收到 / 命中 / 执行 / 权限拦 / 限流 / 失败**。
如果「收到」不动，说明协议端没在往这里发；如果「收到」动了但「执行」不动，说明匹配或权限没过 ——
这两种情况的排查方向完全不同，所以分成两个计数。

## 安全边界（这一层自己守的）

- **只接受本机来源**：协议端必须和本服务在同一台机器上，非同机直接 403
- **配了 AccessToken 就校验**：请求必须带 `?token=` 或 `X-OneBot-Token` 头，不匹配 403
- **机器人自己发的消息直接丢弃**：否则插件回一句就被自己再触发一次，会死循环
- **权限拿不到就按最低算**：事件里没有 `role` 字段时按普通成员处理，不会默认给管理员

## 插件怎么写 handler

完整可跑的模板在 `plugins/_template/`（`node plugins/_template/test.mjs` 可直接自检，不连 QQ）。

```js
export default {
  meta: { id: 'my-plugin', name: 'my-plugin', description: '…', category: '工具' },
  handlers: [{
    id: 'greet',
    match: { prefix: '/hi' },          // 正则 / 字符串 / {prefix} / {contains} / 函数
    scope: ['group', 'private'],        // 默认两者都听
    permission: 'everyone',             // everyone | admin | owner
    cooldownMs: 3000,                   // 同一个人 3 秒内只算一次
    requireAtMe: false,                 // true 时只有 @机器人 才触发
    async run(msg, api) {
      await api.reply(`你好，${msg.nickname}`);
    },
  }],
};
```

### msg 结构（两个协议归一化后完全一致）

| 字段 | 说明 |
|---|---|
| `protocol` | `onebot` / `satori` |
| `scope` | `group` / `private` |
| `groupId` | 群号（私聊为空串） |
| `userId` / `nickname` | 发消息的人 |
| `role` | `owner` / `admin` / `member`（拿不到就是 `member`） |
| `text` | 纯文本 |
| `atMe` | 这条消息有没有 @ 机器人 |
| `messageId` | 消息 id（撤回时用） |
| `raw` | 原始事件，需要协议特有字段时用 |

### api 提供什么

| 方法 | 说明 |
|---|---|
| `api.reply(text)` | 回到消息来的地方（群→群，私聊→私聊） |
| `api.sendText({groupId｜userId}, text)` | 发给指定会话 |
| `api.cfg` | 本插件的配置（市场「配置」按钮存的值） |
| `api.log(msg)` | 写日志（会带插件名前缀） |

## 明确不支持的（写在前面，别踩空）

| 项 | 状态 | 原因 |
|---|---|---|
| Satori 协议收消息 | **不支持** | Satori 只有 WS `/v1/events` 能收事件，且鉴权必须用 `Authorization` 头；Node 内置 WebSocket 不支持自定义头。要用消息驱动，请走 OneBot 路线的 HTTP 上报 |
| 图片/语音的接收内容 | 只取文本 | `msg.text` 只拼文本段；图片消息段会被忽略（插件拿不到图片二进制）。要处理图片得自己读 `msg.raw` |
| 多账号 | 不支持 | 一套配置一个协议端 |
| 消息存档 | 不做 | 这层只做路由，不落库；要存档自己写插件 |

## 排查速查表

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 「收到」一直是 0 | 协议端没配上报告地址 | 检查上报地址、端口、协议端是否重启过 |
| 403 token 不匹配 | AccessToken 不一致 | 上报地址里带上 `?token=`，值要和配置里的一致 |
| 收到有，执行 0 | 没有插件匹配，或被权限拦 | 看「命中」和「权限拦」两个计数 |
| 执行有，但群里没消息 | 发送失败（机器人被踢/禁言/没权限） | 看「最近错误」，里面是协议端返回的原文 |
| 装了插件但没出现在「已挂载」 | 插件没启用，或没声明 `handlers` | 市场里点「启用」；确认插件文件里有 `handlers: [...]` |
