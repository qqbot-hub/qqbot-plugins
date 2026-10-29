# 部署方法与兼容性矩阵（Phase 1）

> 数据源：`data/catalog/methods.json`（方法清单）· `data/catalog/permissions.json`（权限扫描）
> 代码：`scripts/lib/methods.mjs`（可用性判断 + 矩阵）· `recipes/{nonebot,koishi,compose}.mjs`（真部署）
> 页面：首页「部署方法」「兼容性矩阵」两个板块

## 这一层解决什么问题

以前所有可装的东西共用一个「部署」按钮，用户不知道哪条路线真的能一键、哪条只是步骤。
现在的规则是**每条方法自己声明自动化程度，前端照实给按钮**：

| level | 含义 | 前端按钮 |
|---|---|---|
| `oneclick` | 有 recipe，真的建环境/装包/起进程/探端口 | 「部署」（依赖缺了就禁用并写明缺什么） |
| `compose` | 有 compose 文件，真跑 `docker compose up -d` | 「部署」（没装 Docker 第一步就会报清楚） |
| `assisted` | 能自动的部分自动（如拉起 DSH），凭据类必须人工 | 「部署」+ 手工步骤清单 |
| `guide` | 只有步骤，没有脚本 | 「查看步骤」，**不放假按钮** |

`deploy.verified` 只能由实测写 true，且必须带 `verifiedNote`（时间、做了什么、结果）。
测试 `scripts/test-methods.mjs` 会检查：标 true 的必须有验证记录，标 false 的必须写明原因。

## 现状（2026-10-28）

- **oneclick（已实测）**：`snowluma-dsh`（node→snowluma→qqbridge→dsh）、`napcat-nonebot`、`napcat-koishi`
- **compose（文件已写、本机无 Docker 未验证）**：`napcat-astrbot`、`astrbot-official`
- **assisted**：`dsh-official`（DSH 可自动拉起，AppID/Secret 必须人工）
- **guide**：`llonebot-astrbot`、`napcat-yunzai`、`snowluma-maibot`、`napcat-ncatbot`

## 兼容性矩阵的口径（不许改成"全兼容"）

1. 本市场 47 个插件是零依赖 `.mjs`，跑在 MCP 的子进程里 → **只有 DSH 宿主的方法能装**；
2. 插件里凡调协议端动作（发消息/禁言/公告…，由 `build-permissions.mjs` 扫源码得出 `needsBridge`）
   → 还要求方法讲 **OneBot v11**；所以官方通道（`dsh-official`）只能装纯本地工具；
3. AstrBot / Koishi / NoneBot / Yunzai / MaiBot / NcatBot 的原生插件只在各自框架内可用（`native`），
   跨框架一律 `no` —— 跨框架要等 Phase 2 的统一插件抽象层。

## 密钥安全

- 存储：AES-256-GCM，密钥在 `data/state/.secrets.key`（gitignore）；密文在 `config.json` 的 `cfg.secrets`
- 启动时自动把历史明文 AccessToken 迁入加密存储（原 config 备份为 `config.backup-*.json`）
- 接口只回「有没有配」，永不回明文；安装日志与 `jobs.json` 里的密钥参数一律打码（`***`）
- 安装任务执行时，服务端把已存密钥合并进 params —— **浏览器全程接触不到 token 明文**
- 不收集、不存储 QQ 密码：所有登录一律扫码，这条写在方法详情里

## 权限与二次确认

`node scripts/build-permissions.mjs` 扫 `plugins/*.mjs` 的真实 API 使用，生成五类权限：
`exec` / `file:write` / `file:read` / `message:send` / `network`。
安装命中前两类或 `message:send` 时，前端弹确认框，列出「它会做的事」，勾选才能装。
`--check` 模式用于测试：源码变了清单没更新就直接 fail，防止权限表与代码漂移。

## 回滚

安装引擎给 recipe 两个新能力：
- `ctx.record({kind:'dir'|'file'|'compose', value, why})` 登记造出来的东西；`spawnDetached` 自动登记 pid
- `rollbackJob(jobId)`：结束登记的进程（pid）→ `docker compose down`（保留数据卷）→ 删 runtimes/ 里的目录

安全边界：目录/文件**只在 `runtimes/` 内**才会删；compose 用 `down` 不用 `down -v`（数据卷里可能是登录态）。
失败的前端会在安装面板底部出现「回滚这次部署」按钮。

## 验证方法

```bash
# 1. 自检（28 项）
node scripts/test-methods.mjs

# 2. 既有测试回归
node scripts/test-installer.mjs && node scripts/test-bridge.mjs && node scripts/test-hub.mjs

# 3. 真部署验证（以 nonebot 为例）
node scripts/installer.mjs run nonebot
#   预期：venv → pip 装 nonebot2 → 写 .env → 8080 监听 → 自检通过
#   回滚验证：node scripts/installer.mjs rollback <jobId>（jobs.json 里找 id）

# 4. compose 路线（有 Docker 的机器上）
node scripts/installer.mjs run compose --method=napcat-astrbot

# 5. 页面
#   http://127.0.0.1:3210 → 「部署方法」看 10 张卡与按钮差异
#   「兼容性矩阵」看 10 × 8 表格；插件卡上有权限 chip 与「兼容 N 种部署方法」
```

## Phase 2 预告（本阶段未实现，不虚标）

- 统一插件接口（收消息/发文本/发图片/权限判断/配置声明）与 OneBot v11 之外的适配器
- 插件跨部署方法一键安装
- 开发者上架模板：`examples/` 会提供「原生插件 → 统一插件」改造示例
