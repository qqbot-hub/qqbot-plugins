# 搭桥原理：qqbot-plugins ⇄ DSH / qq-bridge / SnowLuma

本文解释市场是怎么和《DeepSeek 接入 QQ》教程的链路"连起来"的。

## 教程链路回顾

```
QQ ⇄ SnowLuma ⇄ qq-bridge ⇄ DSH ⇄ DeepSeek 模型
```

- **SnowLuma**：QQ 网关，把 QQ 消息变成 OneBot v11 格式。对外暴露 WebSocket(3001) 和 HTTP API(3000)。
- **qq-bridge**：中间人。QQ 消息 → DSH 会话；DSH 回复 → QQ。它还通过 `scripts/setup-dsh.mjs` 给 DSH 挂了三个 MCP 服务器（`snowluma` / `snowluma-host` / `web-search-safe`）。
- **DSH（DeepSeek Harness）**：本机的 DeepSeek 外壳。它的 MCP 客户端配置在 `~/.dsh/profiles/<profile>/cordis.patch.yml`。

## Hub 加在哪

`cordis.patch.yml` 是一个 YAML 数组，每项是一个补丁操作。qq-bridge 官方条目长这样：

```yaml
- insert:
    - id: mcp-snowluma
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: snowluma
        transport: stdio
        command: '<node>'
        args: ['<qq-bridge>/src/mcp-snowluma-safe.js']
        toolCallTimeoutMs: 725000
```

`scripts/register-dsh.mjs` 用注释块在同一文件里追加一个**独立托管**的条目：

```yaml
# === qqbot-plugins MCP BEGIN ===
- insert:
    - id: mcp-qqbot
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: qqbot
        transport: stdio
        command: '<node>'
        args: ['<qqbot-plugins>/mcp-server.mjs']
        toolCallTimeoutMs: 725000
# === qqbot-plugins MCP END ===
```

要点：

1. **同一个配置文件、同一种格式**——这是"搭桥"能成立的原因：DSH 只认这份清单。
2. **id / serverName 不同（`qqbot`）**，与官方条目互不覆盖；重复跑注册脚本是幂等的（先删旧块再写新块）。
3. 脚本**只动 BEGIN/END 之间的行**，并先做时间戳备份，官方条目和其他内容原样保留。
4. MCP 只在 DSH 启动时加载——**注册后必须完整退出并重启 DSH**。

## 运行时数据流

```
AI（DSH 会话里）
 │ tools/list, tools/call（stdio JSON-RPC）
 ▼
qqbot-plugins/mcp-server.mjs
 │ 读取 data/state.json 确定装了哪些插件 → 聚合各插件 tools
 ├─ 纯本地逻辑（计算/游戏/词库…）直接执行
 ├─ 联网数据（天气/汇率/B站…）走免费公开接口
 └─ 操作 QQ（发消息/禁言/查群…）走 OneBot HTTP API(3000)
      ▼
    SnowLuma ⇄ QQ 客户端
```

- 工具名：`mcp__qqbot__<name>`，如 `mcp__qqbot__qq_weather`。
- 定时类插件（remind / pomodoro）导出 `fireDue(ctx)`，MCP 进程每 15 秒兜底触发一次，到点直接经 OneBot 主动发消息。
- 危险操作（踢人、全体禁言、设管理员）在工具 schema 里要求 `confirm: true`，AI 不传就不执行。

## 与老"bot-plugins"机制的差别

一些早期市场副本通过往 `qq-bridge/bot-plugins/` 丢 `.mjs` 并重启桥接来装插件——那依赖桥接内置加载器。本项目不依赖它：

| | bot-plugins 机制 | 本项目（MCP 模式） |
| --- | --- | --- |
| 依赖 | qq-bridge 内置加载器 | 只依赖 DSH 的标准 MCP 配置 |
| 生效方式 | 重启 qq-bridge | 重启 DSH |
| 与官方条目关系 | 侵入桥接目录 | 同文件并列、互不影响 |
| 插件写法 | 桥接私有 API | 标准 MCP tools + `ctx.onebot` |

## 验证搭桥成功

按顺序验四关（`node scripts/doctor.mjs` 会自动跑）：

1. DSH 里发一句话有回复（本体可用）；
2. SnowLuma WebUI 显示 QQ 已登录、3000/3001 开启；
3. `node scripts/doctor.mjs` 全绿；
4. 重启 DSH 后新建会话，搜 `mcp__qqbot__` 能看到已装插件的工具。
