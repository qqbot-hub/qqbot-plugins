# 协议抽象层（Satori + OneBot v11）

> 2026-10-28 阶段二第一部分交付。插件只认一套语义方法，底下跑哪个协议由配置决定。

## 为什么需要这一层

之前 46 个插件只能跑在 OneBot v11 协议端（SnowLuma / NapCat / LLOneBot…）。
要让同样的插件跑进 Koishi、Chronocat 这些 Satori 生态，就需要第二个协议后端。
`plugins/_protocol.mjs` 就是统一入口：

```
插件代码（不变）
      │ ctx.bridge.sendText(...) / banMember(...) / getMembers(...)
      ▼
plugins/_protocol.mjs        ← 按配置选择后端，声明能力表
      ├── onebot → plugins/_bridge.mjs（SnowLuma / NapCat / LLOneBot / Lagrange / go-cqhttp）
      └── satori → plugins/_satori.mjs （Koishi / Chronocat 生态）
```

切换方式：网页「运行监控 → 当前协议 → 切换」，或 `POST /api/protocol`。
配置存在 `config.json` 的 `protocol` 与 `satori` 字段；Satori 令牌走加密存储。

## Satori 协议事实（全部来自本机真实服务端，不是凭印象）

服务端：`runtimes/satori-srv`（koishi 4.18.11 + @koishijs/plugin-server-satori 2.9.1），
真实安装版本的行为，源码在 `node_modules/@satorijs/plugin-server/lib/index.mjs`：

| 事实 | 说明 |
|---|---|
| 路由 | `POST {baseUrl}/v1/{resource}.{method}`，例如 `/satori/v1/message.create`；meta 也是 POST，用 GET 会拿到 405 |
| 鉴权 | `Authorization: Bearer <token>`；不符返回 **403 "invalid token"**（不是 401） |
| 选实例 | 必须带 `satori-platform` + `satori-user-id` 两个请求头；找不到对应实例返回 **403 "login not found"** |
| 未知方法 | **404 "method not found"** |
| 成功响应 | 200 + JSON（键名 snake_case） |
| 失败响应 | 纯文本，不是 JSON —— 客户端不能无脑 `res.json()` |
| 参数单位 | 禁言 duration 是**毫秒**（OneBot 是秒，适配器里已换算） |
| 方法表 | 共 37 个，字段定义来自 @satorijs/protocol 1.7.0 的 `Methods`（如 `message.create: channel_id, content`） |

## 能力差异（如实声明，不假装全兼容）

Satori 原生没有这些动作，适配器会抛 `unsupported` 并写明原因：

- 群公告（setNotice / getNotice）
- 全员禁言（wholeBan）—— 只有按成员禁言 `guild.member.mute`
- 群名片（setCard）、专属头衔（setTitle）
- 设置管理员（setAdmin）—— Satori 的 `guild.member.role.set` 需要角色 ID，与 OneBot 语义不等价

能力表通过 `PROTOCOLS[id].capabilities` 暴露，前端可据此置灰按钮。

## 测试

`node scripts/test-satori.mjs` —— 36 项，分三段：

- **A. 协议契约**（本地 stub，按真实服务端行为构造）：请求形态、鉴权头、实例头、
  元素格式、错误分类（auth / notlogin / unsupported / offline / timeout）、毫秒换算、数据归一化
- **B. 统一层**：默认协议向后兼容、两个后端方法集一致、能力表键一致
- **C. 真实服务端**：连本机 5142 的真实 Koishi Satori Server，验证
  `login not found → notlogin`、`invalid token → auth`、`foo.bar → unsupported`

## 已知边界（不隐瞒）

1. **发消息没有端到端实测**。本机没有可用的平台实例：`@satorijs/adapter-onebot`
   与 koishi 4.18 存在 `@satorijs/core` 双版本冲突（2.7.4 vs 4.6.1），适配器在
   `prepare` 阶段就抛 TypeError，连接请求根本发不出去；该适配器官方也已宣布弃用。
   所以成功路径只有契约级验证（A 段），真实服务端只验证到错误分类（C 段）。
   之前把「Koishi 连不上 QQ」归因为「SnowLuma 拒绝第三方 WS」是**错误归因**，已更正。
2. **satori-lab 目录已废弃**：曾把 adapter-onebot 装进去，污染了 `@satorijs/core`，
   导致整个 Satori 路由挂掉（全部 404）。干净的测试台是 `runtimes/satori-srv`（端口 5142）。
3. **Koishi 生态插件安装已实测跑通**（`recipes/koishi-plugin.mjs`）：
   koishi-plugin-dataview 2.7.8 —— npm 安装、写 koishi.yml（只追加不覆盖）、
   直接用 `node node_modules/koishi/bin.js start` 重启（绕过 cmd.exe 一层，
   避免父进程退出连带杀掉）、日志确认插件加载。但机器人收发消息仍不可用，原因见第 1 条。
4. **启动判定修掉了假成功**：之前探测到 200 就报成功，实际进程随后退出；
   现在必须「起来 + 8 秒后仍活着 + 日志有插件加载记录」三样齐全。

## 监控

`GET /api/monitor` + 网页「运行监控」板块。原则：只报探测到的事实。

- 端口用 TCP 探；NoneBot / Koishi / Satori 三个再做**内容指纹**，
  指纹对不上就显示「端口被别的程序占着」，绝不因为端口亮就报绿
  （本机 8080 被 ApplicationWebServer.exe 占用，监控如实显示橙色「端口被占」）
- Satori 指纹用协议固定文本（`login not found` / `invalid token` 等），
  注意**不能**把泛化的 "Not Found" 算通过 —— koa 默认 404 也是这句话
