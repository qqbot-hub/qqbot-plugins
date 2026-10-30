# qqbot-plugins 完整交接文档

> **给你的大肥鱼一个完整的人生。**
> 这份文档是接手本项目所需的全部信息。从「这是什么」到「怎么发版」，从架构到踩过的每一个坑。
> 读这一份就够了，其余 docs/ 下的文档是各子系统的深度展开。

| 项目 | 内容 |
|---|---|
| 文档版本 | v1.0 |
| 生成时间 | 2026-10-30 21:10 (GMT+8) |
| 对应提交 | `1063202` |
| 代码版本 | package.json `1.3.0` |
| 仓库 | https://github.com/qqbot-hub/qqbot-plugins |
| 分支 | `main`（共 54 次提交） |
| 许可证 | MIT © 2026 xiazhuo123456789 |
| 交流群 | QQ 群 **973971153** |

---

## 目录

- [1. 一句话概览](#1-一句话概览)
- [2. 当前状态快照](#2-当前状态快照)
- [3. 本次交接做了什么](#3-本次交接做了什么)
- [4. 系统架构](#4-系统架构)
- [5. 运行环境与启动](#5-运行环境与启动)
- [6. 配置与密钥体系](#6-配置与密钥体系)
- [7. API 全景](#7-api-全景)
- [8. 插件系统](#8-插件系统)
- [9. 部署形态与发布流程](#9-部署形态与发布流程)
- [10. 测试体系](#10-测试体系)
- [11. 维护操作手册 SOP](#11-维护操作手册-sop)
- [12. 已知问题与坑](#12-已知问题与坑)
- [13. 安全注意事项](#13-安全注意事项)
- [14. 资源索引](#14-资源索引)

---

## 1. 一句话概览

**它是抖音那套「DeepSeek 接进 QQ」教程的官方插件补充包，同时也是一个「部署方法 × 插件」的聚合平台。**

教程做到的是「QQ 消息 ⇄ DeepSeek 对话」，但 AI 只会说话、不会做事——不能禁言、不能查群成员、不能记账、聊三天就忘了你是谁。这个市场补上 **50 个插件 / 84 项能力**，网页上点一下安装，就变成 AI 能自己调用的 MCP 工具（`mcp__qqbot__*`）。

```
QQ  ⇄  SnowLuma（协议端:3000/3001）  ⇄  qq-bridge（:3100）  ⇄  DSH 大肥鱼（:3080）  ⇄  DeepSeek
                                                                    │
                                                                    └── ⇄  qqbot-plugins（:3210）
                                                                          MCP 插件层 · 50 插件 / 84 工具
```

**关键设计：它不改你的教程环境。** 不 fork qq-bridge、不往别人仓库塞文件，只在 DSH 的 `cordis.patch.yml` 里并列追加一个 MCP 服务器条目（`mcp-qqbot`），和官方 `mcp__snowluma__` 用同一份文件、同一种格式，互不冲突。

| | 只有教程 | 加上本市场 |
| --- | --- | --- |
| 能聊天 | ✅ | ✅ |
| 查天气/翻译/汇率 | ❌ 只会凭记忆瞎编 | ✅ 真调接口拿真实数据 |
| 禁言/踢人/撤回/公告 | ❌ | ✅ 带白名单和二次确认 |
| 签到/记账/备忘/定时提醒 | ❌ | ✅ 数据落地保存 |
| 成语接龙/21点/猜数字 | ❌ | ✅ 会记住上一句 |

### 「装到 QQ 上」到底是什么意思

不需要把插件文件复制进 qq-bridge 目录。插件由**市场自己的进程**（`mcp-server.mjs`）提供，DSH 通过 MCP 标准协议调用它，插件再通过 SnowLuma 的 OneBot API 操作 QQ。所以：

- **装插件** = 在市场点「安装」（只改一个状态文件）
- **生效** = 首次注册时重载 DSH 配置；后续安装会通知 MCP 客户端刷新工具列表
- **卸载** = 点「卸载」，运行中的 MCP 服务会更新工具列表

---

## 2. 当前状态快照

### 2.1 三处代码位置

| 位置 | 路径 / 地址 | 说明 |
|---|---|---|
| **GitHub 仓库** | https://github.com/qqbot-hub/qqbot-plugins | 唯一权威源，分支 `main` |
| **本地工作副本** | `C:/Users/xj200/WorkBuddy/2026-10-30-11-42-03/qqbot-plugins-repo` | 日常开发、推送起点。**已装 node_modules** |
| **公网发布目录** | `C:/Users/xj200/WorkBuddy/2026-10-28-19-16-50/qqbot-publish` | 发公网用的干净副本，**不含 node_modules / config.json / 运行数据** |

### 2.2 线上应用

| 项目 | 值 |
|---|---|
| 应用名 | AI QQ 机器人插件市场 |
| appId | `wbapp_O9vqsPnIMzmE0aRhi1A5et` |
| 访问链接 | **https://qqbot-plugin-market.app.workbuddy.host/?sharecode=FRMQR6M3FU** |
| 域名前缀 | `qqbot-plugin-market` |
| 运行时 | node，`node server.js` |
| 管理入口 | 设置 — 数据管理 — 应用 |

> ⚠️ **访问必须带 `?sharecode=FRMQR6M3FU` 参数**（分享链接自带）。不带参数会显示「链接不完整」占位页，这是托管平台机制，不是 bug。

### 2.3 最近 6 次提交（本次交接产生）

| 提交 | 说明 |
|---|---|
| `1063202` | style(ui)：交流群/求星入口改为吸顶工具栏胶囊，放大至 38px 并修复窄屏重叠 |
| `bfaf654` | feat：语音/视频实验室与交接修复 — voice-lab 页面、ffmpeg/本地音乐/SnowLuma runtime、patch-qqbridge、handoff/lab 测试 |
| `6134132` | feat(deploy)：部署链路修复版 — bootstrap.ps1、bridge 守护进程、启动编排、e2e/集成测试 |
| `303acdc` | fix(package)：`install` 脚本改名 `install:run`（npm 生命周期钩子冲突） |
| `30cdd95` | feat：首次从本地工作区同步（deploy-to-dsh 工具链、AGENT-DEPLOY 文档、公网只读测试） |
| `e331c70` | fix：同步动态市场统计与文档 |

### 2.4 规模数据

| 指标 | 数量 |
|---|---|
| 插件 | 50 个 / 84 个工具（`plugins/` 下 56 个 .mjs，含 6 个内部模块） |
| 部署方法 | 10 条路线 |
| 三生态目录 | 1368 条（NoneBot 619 / AstrBot 300 / Koishi 455） |
| 全网插件源 | 6 个源 / 204 个仓库 |
| 测试用例 | 283 项，0 失败 |
| 项目文件 | 174 个（不含 node_modules，不含本文件） |
| server.js | 1976 行 |
| 运行时依赖 | **仅 `yaml@2.8.3` 一个** |

---

## 3. 本次交接做了什么

2026-10-30 全天的工作，按时间顺序：

### 3.1 三次 zip 全量同步（GitHub + 公网双端）

用户先后给了三个 zip，每个都要求「完整上传 GitHub 仓库并同步更新公网」：

| 轮次 | 文件 | GitHub 提交 | 规模 |
|---|---|---|---|
| 1 | `qqbot-plugins-f39a6d5.zip` | `30cdd95` | 17 文件 +572/-8 |
| 2 | `qqbot-plugins-37026dc-部署修复.zip` | `6134132` | 41 文件 +1206/-537 |
| 3 | `qqbot-plugins-e8fd384.zip` | `bfaf654` | 38 文件 +600/-184 |

三轮均无文件删除，且都验证了 `.gitignore` 正确拦住了 `config.json`、`data/state/`、密钥文件。

### 3.2 修复 npm 生命周期钩子冲突（关键）

**现象**：第一次发布时云端 `npm install` 失败。

**根因**：`package.json` 里有个名为 `"install"` 的脚本（`node scripts/installer.mjs run`）。npm 在 `npm install` 完成后会**自动执行**名为 `install` 的生命周期钩子，而 `installer.mjs run` 需要参数，于是在干净环境里必然报错。

**修复**：改名为 `install:run`（提交 `303acdc`）。**后续新增脚本时，绝不可使用 `install`、`prepare`、`postinstall` 这类 npm 保留名。**

### 3.3 UI 改版：交流群 / 求星入口

用户提出两轮需求，演化路径：

> ① 两个卡片太丑 → ② 但不想占主内容布局，又要显眼 → ③ 改完的胶囊太小 → ④ 通过并上传

**最终方案**：两张卡片从主内容区移入**吸顶工具栏**（`.topbar-row`，`position:sticky`）里的胶囊，零纵向占位、滚动常驻。

**被否掉的两个位置（及原因）**——这是重要决策记录，别再走一遍：

- **侧栏底部**：侧栏在 900px 高度下已被「导航 13 项 + 运行状态」填满，塞进去要么被折叠线切掉，要么吸底时盖住「运行状态」
- **侧栏顶部**：会把导航整体往下推 200 多像素，等于拆东墙补西墙

**最终实现**（提交 `1063202`，仅改 `public/index.html`，+83/-33）：

```
[👥 插件交流群　QQ 群 973971153　[复制]]   [❤ 去 GitHub 点 Star　[2 颗心 · 谢谢 ❤]]
```

- 左 `cta-group`（青绿）：线性人群图标 + 「插件交流群」+ 群号（等宽数字）+ 复制小胶囊，`id="joinBtn"`，`onclick="copyGroup()"`，点整条即复制，复制后闪一下变「已复制」
- 右 `cta-star`（粉）：跳动的心形 + 「请给我点一颗免费的心」+「去 GitHub 点 Star」+ 星数 `#starCount`（由 `/api/stars` 实时更新）
- 尺寸：高 **38px** / 字号 **13px** / 图标 **16px**（初版 30px/11.5px/13px，用户嫌小放大一档）

**修复的布局 bug**：胶囊放大后空间不够——1040px 宽度下与右侧搜索框**重叠 23px**；1080px（用户窗口）下面包屑被挤折行，把吸顶栏从 64px 撑到 80px。

解法：面包屑后半段包进 `.crumb-sub`，≤1240px 时隐藏 + 全局禁止面包屑折行。修完实测 10 个宽度，吸顶栏恒定 64px、零横向溢出、胶囊与搜索框稳定留 10px 间隙。

**响应式断点（逐级收窄，绝不换行）**：

| 断点 | 收起什么 |
|---|---|
| ≤1240px | 面包屑副标题「/ AI QQ 机器人」 |
| ≤1400px | 求星胶囊的「请给我点一颗免费的心」 |
| ≤1300px | 实时星数标签 |
| ≤1010px | 交流群胶囊的「插件交流群」四个字 |
| ≤980px | 两个胶囊落到工具栏第二行，各占半宽 |

---

## 4. 系统架构

### 4.1 目录结构

```
qqbot-plugins/
├─ server.js            市场服务端（登录/API/体检/搭桥/安装任务）1976 行
├─ mcp-server.mjs       MCP stdio 服务器（暴露插件工具给 DSH）
├─ plugins/             50 个插件（每个 .mjs 自包含）+ _template/ 模板
│                       + _router/_bridge/_protocol/_satori/_lib/_images 内部模块
├─ recipes/             15 个安装配方（协议端/桥/DSH/插件/三生态/ffmpeg/voice lab…）
├─ data/
│  ├─ catalog/          清单：plugins(28KB) / companions / components
│  │                   / methods(27KB) / permissions(20KB)
│  ├─ sources/          外部插件源定义 + ecosystem.json（三生态真实目录 1368 条）
│  ├─ snapshots/        外部源抓取快照（hub.json）
│  └─ state/            安装状态 + 任务记录 + 审核记录 + 密钥（**不入库**）
├─ scripts/             34 个脚本（安装引擎/体检/注册/同步/测试）
│  └─ lib/              22 个库模块（paths/ecosystem/updates/version/registry/
│                       sandbox/secrets/deploy-agent/ffmpeg/voice-lab…）
├─ public/              前端（原生 HTML/JS 暗色主题，index.html 约 217KB）
├─ docs/                17 篇文档（含本文件）
├─ docker/              两个 compose 方案（astrbot-official / napcat-astrbot）
├─ bootstrap.ps1        Windows 环境自检与依赖安装
├─ deploy-to-dsh.bat    主链路一键部署入口
├─ config.example.json  配置模板（真实 config.json 不入库）
└─ package.json         依赖仅 yaml@2.8.3
```

### 4.2 三个进程

| 进程 | 入口 | 职责 | 生命周期 |
|---|---|---|---|
| **市场服务端** | `server.js` | 网页、API、体检、安装任务、消息路由 | 常驻，用户启动 |
| **MCP 服务器** | `mcp-server.mjs` | stdio JSON-RPC，把插件工具暴露给 DSH | 由 DSH 拉起 |
| **插件沙箱** | `scripts/lib/sandbox.mjs` | 独立子进程执行插件，Node 权限模型限制 | 每次调用，超时 20 秒 |

插件跑在独立子进程里，写文件 / 起子进程由 Node 权限模型直接拒绝（可用 `QQBOT_SANDBOX=0` 关闭，调试用）。沙箱**拦不住**：网络出站、CPU 配额、代码签名。详见 `docs/SANDBOX.md`。

### 4.3 消息流

```
QQ 用户发消息
  → SnowLuma（OneBot v11）
  → POST /api/onebot/event（免登录，仅本机 IP + 可选 token）
  → normalizeOneBot() 归一化
  → messageRuntime().dispatch(msg)
  → 沙箱内执行 handler
  → api.reply() 经 SnowLuma HTTP API(:3000) 发回 QQ
```

`handlerCache`（server.js L576）缓存已安装且已启用插件的 handlers，由 `refreshHandlers()`（L609）刷新，调用点：启动时、`/api/messages`、审核新插件落地后、`/api/op` 装/卸/启停后。

**明确不支持**：Satori 收消息（Satori 只有 WS `/v1/events` 且需自定义鉴权头，Node 内置 WebSocket 不支持）。

### 4.4 状态管理的一个坑

`STATE`（server.js L68）是内存中的安装状态对象，**但子模块（installer 等）会绕过内存直接写文件**。所以有 `stateFresh()`（L81–89）——读之前比对 `STATE_MTIME`，不一致就重新从磁盘加载。改动状态相关代码时务必注意这一点。

---

## 5. 运行环境与启动

### 5.1 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **≥ 20** | 插件沙箱用 Node 权限模型 `--permission`，20 以下没这个开关，市场能起但插件全部无法执行。**别用 18** |
| qq-bridge | Node ≥ 22.13.0 | 上游要求 |
| SnowLuma | 优先用发行包自带 Node | — |
| 平台 | Windows / macOS / Linux | `start.bat` 只是 Windows 快捷方式 |
| 依赖 | `yaml@2.8.3`（唯一） | 用于 `cordis.patch.yml` 读写 |

### 5.2 端口与环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3210` | 优先 env → `config.json.port` → 3210 |
| `HOST` | `127.0.0.1` | **存在 `PORT` 环境变量时自动变 `0.0.0.0`**（托管平台注入 PORT 的场景） |
| `QQBOT_STATE_FILE` | `data/state/plugins.json` | 可覆盖状态文件路径 |
| `QQBOT_SECRET_PASSPHRASE` | — | 设置后用 scrypt 派生密钥，而非密钥文件 |
| `QQBOT_SANDBOX` | `1` | 设 `0` 关闭插件沙箱（调试用） |
| `DEEPSEEK_API_KEY` | — | AI 辅助部署需要，市场进程需继承 |

**相关端口**：SnowLuma HTTP `3000` / WS `3001`、DSH `3080`、qq-bridge `3100`、SurfCore `3100`（与 qq-bridge 二选一）、Voice Lab `3120`、市场 `3210`。

### 5.3 启动方式

```bash
# 推荐：一键部署（首次）
git clone https://github.com/qqbot-hub/qqbot-plugins.git
cd qqbot-plugins
npm ci --ignore-scripts          # 注意：用 --ignore-scripts，见 12.1
node server.js
# 打开 http://127.0.0.1:3210 → 侧栏「部署链路」点一键部署

# 主链路也可直接双击（Windows）
deploy-to-dsh.bat
# 或
npm.cmd run deploy:primary

# 搭桥：把市场注册进 DSH
node scripts/register-dsh.mjs desktop

# 体检
node scripts/doctor.mjs
```

启动顺序（`server.js` L1962–L1976）：**先 `initSecrets()` 再 `listen()`**（避免第一个 `/api/health` 因 token 未解出而显示未配置）→ 回环地址时启动 10 秒一次的 `refreshConnections()` 发现定时器 → 打印三行日志 → 异步 `refreshHandlers()` 挂载消息处理器。

---

## 6. 配置与密钥体系

### 6.1 config.json（**不入库**）

```json
{
  "password": "",              // 访问口令，空=不鉴权（仅本机安全）
  "port": 3210,
  "snowluma": {},
  "dsh": { "cliPath": "" },    // DSH CLI 路径，AI 辅助部署需要
  "bridge": {},
  "plugins": {},
  "lab": { "url": "http://127.0.0.1:3120", "mode": "builtin" },
  "secrets": { "napcat-astrbot.modelApiKey": "enc:v1:..." }
}
```

配置模板见 `config.example.json`。**改完立即生效**——`mcp-server.mjs` 每次被 AI 调用时都会重新读这份配置，不用重启 DSH。

### 6.2 需要填的连接信息

| 字段 | 说明 |
|---|---|
| OneBot HTTP 地址 | SnowLuma 的 HTTP API，默认 `http://127.0.0.1:3000`。发消息、禁言、查群都走这里 |
| AccessToken | SnowLuma 配了 token 才填；留空表示不修改已保存的值 |
| WebSocket 端口 | 默认 3001，仅用于体检探测 |
| DSH 地址 / profile 名 | 默认 `http://127.0.0.1:3080` 和 `desktop` |

### 6.3 密钥加密

- **算法**：AES-256-GCM，IV 12 字节，密文格式 `enc:v1:<iv>:<tag>:<ct>`（base64 拼接）
- **密钥文件**：`data/state/.secrets.key`，32 字节随机，权限 `0o600`，首次使用时自动生成
- **这个文件丢了就解不回来**——要备份就跟 `config.json` 一起备份
- 接口只回「配过没有」，**永不回明文**；解密结果只留内存
- `initSecrets()`（L113）会自动把历史明文 token 迁移为加密值，迁移前先备份 `config.json` 为 `config.backup-<时间戳>.json`
- 解密失败不抛异常，返回空串

### 6.4 .gitignore 规则（**改之前想清楚**）

```
node_modules/
config.json                    # 真实配置
data/state.json
data/store/
*.bak  *.log
data/state/*.json              # 安装状态（含 QQ 号等隐私）
data/state/mcp-observers/
data/state/.secrets.key        # 加密密钥，绝不入库
config.backup-*.json           # 迁移备份里含历史明文 token
runtimes/
.shots/
```

---

## 7. API 全景

鉴权：所有 `/api/*` 需 Cookie `qm=<token>`（有口令时）。免认证白名单：`POST/GET /login`、`POST /api/onebot/event`（协议端上报，仅本机 IP + 可选 token）、`POST /api/deploy/tool`（仅回环 + Bearer capability）、**带扩展名的静态资源**（`.js/.css/.png/.svg/.ico`，L1946–L1950 未做鉴权判断）、公网只读模式下的 `POST /api/registry/submit`。

### 7.1 部署 Agent（L1369–1419）

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/deploy/tool` | 本机 Agent 能力调用（Bearer capability），仅回环 |
| POST | `/api/deploy/token` | 取部署票据 |
| POST | `/api/deploy/qzone-probe` | QQ 空间可用性验证（带 busy 去重，429） |
| POST | `/api/deploy/snowluma-runtime` | 查询/配置 SnowLuma 运行时 |
| POST | `/api/deploy/reload` | 请求 MCP 刷新工具列表 |
| POST | `/api/deploy/allowlist` | 设置桥接白名单 |
| POST | `/api/deploy/agent` | 启动部署任务（限 `goal==='primary'`） |
| POST | `/api/deploy/status` \| `continue` \| `cancel` | 任务状态 / 继续 / 取消 |

### 7.2 插件目录 / 生态 / 上架

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/list` | 插件总览：安装/启用状态、健康度、权限、兼容方法 |
| GET | `/api/ecosystem` | 第三方生态插件目录（搜索/框架/分类/分页） |
| POST | `/api/ecosystem/sync` | 后台触发一次生态目录抓取 |
| GET | `/api/registry` | 上架提交列表 + 统计 |
| GET | `/api/registry/item` \| `/versions` | 单条详情 / 版本列表 |
| POST | `/api/registry/submit` | 提交上架（**公网只读模式下唯一放行的写操作**） |
| POST | `/api/registry/review` | 审核通过/驳回，落地后清 schemaCache 并 refreshHandlers |
| GET | `/api/plugin/updates` | 检查插件更新（可 `force=1`） |

### 7.3 运行时状态 / 体检

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/messages` | 消息路由状态、handler 列表、统计 |
| GET | `/api/monitor` | 8 个服务的端口+指纹探测、协议心跳、最近任务 |
| GET / POST | `/api/protocol` | 当前协议与能力表 / 保存并实测 |
| GET | `/api/health` | 精简体检（bridge/snowluma/dsh/onebot/tools） |
| GET | `/api/status` | 轻量心跳，供页面轮询 |
| GET | `/api/doctor` | 完整体检 |
| GET | `/api/tools` | 已安装且已启用插件的工具清单 |
| GET | `/api/components` | 链路组件列表 + 实时端口/心跳 |

### 7.4 安装任务

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/install/recipes` | 列出所有安装配方 |
| GET | `/api/install/jobs` \| `/job` | 任务列表 / 单条详情 |
| GET | `/api/install/events` | **SSE** 安装日志流（20 秒 ping 保活） |
| POST | `/api/install` | 发起安装（服务端合并已存密钥） |
| POST | `/api/install/rollback` | 回滚某次部署产生的目录/进程/compose |

### 7.5 方法 / 密钥 / 全网源 / 其他

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/methods` \| `/methods/one` | 部署方法清单+兼容矩阵 / 单条详情 |
| GET | `/api/compat` | 兼容性矩阵 |
| POST | `/api/secrets` | 写入/清除密钥（只回有没有配） |
| GET | `/api/hub` \| POST `/api/hub/sync` | 全网插件源快照 / 触发抓取（60 秒冷却） |
| GET | `/api/verify` | 实测结果（30 分钟缓存） |
| GET | `/api/stars` | 仓库 star 数（服务端代取，10 分钟缓存） |
| GET/POST | `/api/lab/config` | 调音台配置（密钥加密） |
| POST | `/api/lab/preview` | 语音试听（3 秒节流） |
| GET | `/api/lab/backends` \| `/status` | 可用语音后端 / 在线状态 |
| GET | `/api/tunnel` | 内网穿透开关与 URL |
| POST | `/api/op` | install/uninstall/toggle/restart + 生态插件 update |
| POST | `/api/bridge/register-dsh` | 注册进 DSH 的 cordis.patch.yml |
| GET/POST | `/api/settings` \| `/api/plugin-config` | 全局连接设置 / 单插件配置 |

### 7.6 静态路由

`STATIC` 映射表（L1357）**只有 3 条**：

| 路径 | 文件 |
|---|---|
| `/` `/index.html` | `public/index.html` |
| `/login` | `public/login.html` |

**`/lab/` 不在映射表里**，由 L1925–1930 单独处理：

- `/lab` → 302 到 `/lab/`
- **内置模式**（`builtinLab()` L939：未配 `cfg.lab.url` 或 `mode==='builtin'`）→ 直接返回 `public/voice-lab.html`
- 否则**反向代理**到 `cfg.lab.url`（默认 `http://127.0.0.1:3120`），并给首页注入「返回市场」浮标

> 注意：**直接访问 `/voice-lab.html` 是 404**——它挂在 `/lab/` 路由下，这是设计而非 bug。

透传给外部调音台的前缀：`/audio/`、`/api/state`、`/api/synth`、`/api/voices`、`/api/presets`、`/api/upload`、`/api/save-voice`、`/api/send`、`/api/bot/voice`。

---

## 8. 插件系统

### 8.1 插件一览（50 个 / 84 工具）

| 分类 | 数量 | 插件 |
|---|---|---|
| 工具 | 24 | calc weather translate exchange unit baseconv morse passgen abbr remind memo ledger birthday clock jukebox pomodoro coin color bilihot bingimg **voice(TTS)** **vision(识图/OCR)** **video(认视频)** ping |
| 娱乐 | 14 | fortune dice draw sensoji tarot zodiac meihua hitokoto joke quote riddle poem gacha **imagine(AI 画画)** |
| 小游戏 | 6 | blackjack guess bombgame idiom wordle roulette |
| 群管理 | 2 | group_admin（禁言/踢人/撤回/名片/头衔/公告）· group_info（群资料/成员列表） |
| 群互动 | 4 | signin qzone **sticker(偷图/发表情)** **memory(长期记忆/好感度)** |

分类与数量由 `data/catalog/plugins.json` 统一驱动。另有 1 个配套桌面程序（dsh-pet 桌面宠物），单独成区、不占 MCP 工具位。

### 8.2 来源与实测（说清楚，避免误会）

| 内容 | 真实来源 |
|---|---|
| 50 个插件的名称、功能描述、工具名、参数说明 | 抓取自公开的 QQ 插件市场站点的目录数据 |
| 卡片上的「源自 xxx」 | 上游出处（AstrBot / NoneBot / Koishi / Yunzai 社区同名插件），附仓库链接 |
| **每个插件的可执行代码** | **本项目重新实现**，全部改写为零依赖 MCP 工具 |

准确说法：**目录来自网络社区，实现由本项目重写**。

最近一次实测（`node scripts/verify-plugins.mjs`，本机、未开 QQ）：

| 结果 | 数量 | 含义 |
|---|---|---|
| ✅ 实测通过 | **64** | 真实调用并正常返回（含联网插件拿真实数据） |
| 🔌 需 QQ 在线 | 16 | group_admin(8) + group_info(3) + qzone(4) + sticker(1) |
| 🔑 需配置 | 4 | voice(1) / vision(2) / video(1)，填 Key 即可 |
| ❌ 失败 | **0** | — |

> ⚠️ 实测脚本跑出「一项都没通过」会进入 **60 分钟冷却**（`VERIFY_BAD_COOL`，L1159/L1088），这是防止把「84 项全失败」挂到公网上的保护。

### 8.3 开发插件

两套出口，可只写一套：

| 出口 | 用途 | 触发方 |
|---|---|---|
| `tools` | 给 AI 调用的能力 | DSH 里的 AI |
| `handlers` | 群里有人发消息就响应 | 真实 QQ 消息 |

**直接复制模板** `plugins/_template/`（`index.mjs` 骨架 + `test.mjs` 自检）。自检不用连 QQ：`node plugins/_template/test.mjs` → 21 项断言。

最小例子（工具型）：

```js
export default {
  meta: { id: 'hello', name: 'hello', description: '打招呼', category: '娱乐' },
  tools: [{
    name: 'qq_hello',
    description: '跟某人说你好',
    inputSchema: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] },
    run: async ({ who }) => `你好，${who}！`,
  }],
};
```

消息驱动型（真收群消息）：

```js
export default {
  meta: { id: 'mycmd', name: 'mycmd', description: '响应 /hi', category: '工具' },
  handlers: [{
    id: 'hi',
    match: { prefix: '/hi' },        // 也支持正则 / 字符串 / {contains} / 函数
    scope: ['group', 'private'],
    permission: 'everyone',           // everyone | admin | owner
    cooldownMs: 3000,
    async run(msg, api) { await api.reply(`你好，${msg.nickname}`); },
  }],
};
```

放到 `plugins/<id>.mjs`、在 `data/catalog/plugins.json` 加一条，市场里就能看到。
**加了新插件必须重建权限表**：`node scripts/build-permissions.mjs`（否则新插件没有权限标注，用户安装时看不到二次确认）。

### 8.4 插件上架流程

走「插件上架」板块：提交（填清单 + 贴 `.mjs` 代码，立刻跑 `node --check` 验语法）→ 审核（通过/拒绝，拒绝必须写原因）→ 通过即真落地（代码写进 `plugins/<id>.mjs` → 登记进目录 → **重建权限表**）→ 版本（同 id 换版本号再提交形成历史，`live` 是最后通过的版本）。

> 边界要说清楚：这是**单机登记流程**，没有多用户身份认证，审核拦的是明显不合格的提交，**不是防恶意投毒**。没有代码签名、没有多租户。

### 8.5 三个进阶能力

**memory（长期记忆）**：`qq_memory_save` / `recall` / `card` / `forget`。不依赖向量库——用「中文二字切片 + 时间半衰期衰减」做检索，纯 JSON 存 `data/store/memory/`。

**voice（TTS）**：`qq_tts` 走 OpenAI 兼容 `/audio/speech`，可接硅基流动 / OpenAI / 自建 GPT-SoVITS / 本地 Breeze-TTS-2.cpp。QQ 语音对编码有要求（silk/amr），多数 OneBot 实现自动转码。

**imagine（AI 画画）**：`qq_imagine`，默认 `pollinations` 后端（免费不需 Key，约 1 秒出图，按 IP 限流，插件已做 10 分钟缓存 + 三次退避重试），可切 `openai` 后端。

### 8.6 协议端兼容

插件**不绑定桥接**，只依赖 OneBot v11。适配层 `plugins/_bridge.mjs` 已吃掉四种差异：响应格式（`status`/`retcode`/裸数据）、鉴权方式（Header/query token/不鉴权）、个别动作名（如群公告，**学会就记住**）、心跳探测。

支持 SnowLuma / NapCat / LLOneBot / Lagrange / go-cqhttp。网页「连接设置 → 协议端」里选一下即可，**改完不用重启 DSH**。

---

## 9. 部署形态与发布流程

### 9.1 三种部署形态

| 形态 | 监听 | 能力 |
|---|---|---|
| **本机市场**（默认） | `127.0.0.1:3210` | 全功能：安装、部署、调音台、AI 辅助部署 |
| **带口令** | 同上 + password | 同上 + 登录鉴权，30 天 HttpOnly Cookie |
| **公网演示站** | `0.0.0.0`（平台注入 PORT） | **只读**，见下 |

### 9.2 公网只读模式机制

**判定条件**（L1444–1448，内联守卫，无独立函数名）：

```
非 GET 方法  +  未配置 password  +  HOST 非回环  →  403
「公网演示站为只读；本机部署请在回环地址打开，管理操作需配置访问口令」
```

唯一例外：`POST /api/registry/submit`（插件提交）。

另有一套更严的判断函数 `localDeployRequest`（`scripts/lib/deploy-agent.mjs:26`，三条件：监听 host 回环 + 远端 IP 回环 + Host 头 hostname 回环且端口等于 PORT 且 Origin 同源），用于：

- 所有 `/api/deploy/*`（除 tool）→ 403「公网演示站不能操作你的电脑」
- `/api/lab/config`、`/lab/preview`、`/lab/backends` → 403「调音台配置及试听仅限本机市场」

**公网下的自动降级**：`refreshConnections()`（L871）在非回环时直接 return，整个服务自动发现跳过；L1965 的 10 秒发现定时器也不启动。

> 这就是为什么公网访客看到「运行状态全灭」——它探测的是托管服务器，**不是访客的电脑**。侧栏已明确标注探测的是哪台机器（提交 `5b09034`）。

### 9.3 发布流程 SOP（**重点**）

用户给新 zip 或本地改完代码后，双端同步的标准动作：

```bash
# ① 解压并体检新版
cd C:/Users/xj200/WorkBuddy/2026-10-30-11-42-03
rm -rf qqbot-plugins-vN && mkdir qqbot-plugins-vN
unzip -oq "C:/Users/xj200/Desktop/<新zip>" -d ./qqbot-plugins-vN
cd qqbot-plugins-vN/qqbot-plugins          # 注意：zip 通常带一层同名目录
grep -n '"install"' package.json           # 必须无输出！见 12.1
ls config*.json                            # 应只有 config.example.json
ls -d node_modules runtimes                # 应不存在

# ② 同步到 GitHub 工作副本
cd C:/Users/xj200/WorkBuddy/2026-10-30-11-42-03
git -C qqbot-plugins-repo pull origin main
cp -r qqbot-plugins-vN/qqbot-plugins/. qqbot-plugins-repo/
cd qqbot-plugins-repo
git add -A && git status --short           # 检查是否有意外文件（config.json / node_modules）
git -c user.name="qqbot-hub" -c user.email="qqbot-hub@users.noreply.github.com" \
    commit -m "feat: <说明>" -m "来源：<zip名>（完整同步）"
git push origin main

# ③ 同步到公网发布目录（**只拷改动文件，别整目录 cp**）
DST="C:/Users/xj200/WorkBuddy/2026-10-28-19-16-50/qqbot-publish"
cp qqbot-plugins-repo/public/index.html "$DST/public/index.html"
# 若改动文件多，用循环排除 .git 和 node_modules：
# for f in qqbot-plugins-repo/* qqbot-plugins-repo/.[!.]*; do
#   n=$(basename "$f"); [ "$n" = ".git" ] && continue; [ "$n" = "node_modules" ] && continue
#   cp -r "$f" "$DST/";
# done

# ④ 发布（调用 WorkBuddy 发布工具）
#    action=deploy, appName="AI QQ 机器人插件市场"
#    directory=C:/Users/xj200/WorkBuddy/2026-10-28-19-16-50/qqbot-publish
#    domainPrefix=qqbot-plugin-market, language=node, startCmd="node server.js"

# ⑤ 验证
curl -s "https://qqbot-plugin-market.app.workbuddy.host/api/health?sharecode=FRMQR6M3FU"
curl -s "https://qqbot-plugin-market.app.workbuddy.host/?sharecode=FRMQR6M3FU" -o /tmp/live.html
#     检查字节数与本地是否一致、新特征是否存在
```

**发布目录必须排除**：`config.json`（真实配置）、`data/state/`（运行数据）、`runtimes/`、`node_modules/`、`.git/`。`config.example.json` 是模板，可以留。

---

## 10. 测试体系

```bash
# 跑全部
for t in scripts/test-*.mjs; do node "$t"; done

# 常用单项
node scripts/test-bridge.mjs         # 协议适配 19 项
node scripts/test-hub.mjs            # 全网源 11 项
node scripts/test-registry.mjs       # 上架 46 项
node scripts/test-router.mjs         # 消息路由 62 项
node scripts/test-satori.mjs         # Satori 36 项
node scripts/test-version.mjs        # 版本解析 45 项
node scripts/test-installer.mjs      # 安装引擎 15 项
node scripts/test-methods.mjs        # 部署方法 28 项
node plugins/_template/test.mjs      # 插件模板 21 项
node scripts/build-permissions.mjs --check   # 权限表是否与源码一致

# npm 快捷方式
npm test                             # verify + 12 个测试串跑
npm run test:fresh                   # e2e 全新环境
npm run test:deploy-integration
```

**当前状态：283 项，0 失败**（bridge 19 / hub 11 / installer 15 / methods 28 / registry 46 / router 62 / satori 36 / version 45 / 模板 21）。

### 测试脚本清单（34 个脚本）

`bridge-supervisor` `build-permissions` `deploy-primary` `doctor` `dsh-deploy-plugin` `e2e-fresh` `hub-sync` `installer` `patch-qqbridge` `register-dsh` `startup` `sync-ecosystem` `verify-plugins` + 22 个 `test-*.mjs` + `scripts/lib/` 下 22 个库模块。

---

## 11. 维护操作手册 SOP

### 11.1 常见故障排查

| 现象 | 处理 |
|---|---|
| DSH 里搜不到 `mcp__qqbot__` | 检查注册 profile（`~/.dsh/profiles/` 下的真实目录名），首次注册需加载 DSH 配置并刷新 MCP 工具列表 |
| 装了插件但 AI 说没有这个工具 | 查看卡片是否已加载；新版 MCP 会热更新，客户端未响应通知时手动刷新工具列表 |
| `register-dsh` 报 profile 目录不存在 | 打开 `~\.dsh\profiles\` 看子目录名，用真实名字 |
| 禁言/踢人失败 | 机器人需要群管理员权限；SnowLuma 的 HTTP API(3000) 必须开启 |
| 定时提醒没发出来 | 提醒由 Hub 的 MCP 进程触发，保持 DSH 开着；确认 OneBot HTTP 可用 |
| 天气/汇率等联网插件失败 | 依赖免费公开接口（Open-Meteo / er-api / nbnhhsh / B站 / 必应），检查网络；全部无需 Key |
| 云端 `npm install` 失败 | 检查 package.json 是否有 `install`/`prepare`/`postinstall` 保留名脚本（见 12.1） |
| 公网站显示「链接不完整」 | 访问必须带 `?sharecode=FRMQR6M3FU` |
| `/voice-lab.html` 404 | 正确路径是 `/lab/` |
| 实测结果全是失败 | 可能进入 60 分钟冷却（`VERIFY_BAD_COOL`），等冷却或检查网络 |

### 11.2 新增一个部署方法

改 `data/catalog/methods.json`（27KB），然后跑 `node scripts/test-methods.mjs`（28 项）。规则：**本机能自动的才给「部署」按钮，只给步骤的绝不放假按钮**。详见 `docs/METHODS.md`。

### 11.3 新增一个插件（完整流程）

1. 复制 `plugins/_template/` → `plugins/<id>.mjs`
2. 在 `data/catalog/plugins.json` 加一条
3. `node plugins/_template/test.mjs` 自检
4. `node scripts/build-permissions.mjs` 重建权限表
5. `node scripts/verify-plugins.mjs` 实测
6. 提交

### 11.4 改动前端后的注意事项

`public/index.html` 是 217KB 的单文件，含全部 HTML/CSS/JS。**改动时**：

- 任何 UI 改动后至少验证 **1080px（用户窗口）、1440px（宽屏）、420px（移动）** 三个宽度
- 验证方式：起本地服务（`PORT=3210 node server.js`），用无头浏览器截图或 DOM 测量
- **模型看不了图时的替代验证法**：在 `public/` 下临时放一个测量页，用 iframe 以不同宽度加载首页并 `getBoundingClientRect()` 测量，配合
  `msedge --headless=new --dump-dom --virtual-time-budget=30000` 取回 JSON。
  注意：静态文件根是 `ROOT=__dirname`（项目根），访问路径要写 `/public/xxx.html` 而非 `/xxx.html`；**测完务必删除临时文件**

---

## 12. 已知问题与坑

### 12.1 npm 生命周期钩子冲突（**已修，别再犯**）

`package.json` 里名为 `install` / `prepare` / `postinstall` 的脚本会被 npm 自动执行。本项目曾因 `"install": "node scripts/installer.mjs run"` 导致云端 `npm install` 必然失败（脚本需要参数）。已改名为 `install:run`。

**新增脚本前先确认名字不在 npm 生命周期列表里。** 本地安装也建议用 `npm ci --ignore-scripts`。

### 12.2 拷贝时 `.git` 冲突

`cp -r qqbot-plugins-repo/. <目标>/` 会因 `.git` 目录权限报错中断。**用循环逐个拷并跳过 `.git` 和 `node_modules`**，或只拷改动的文件。

### 12.3 静态资源不走鉴权

`server.js` L1946–1950：带 `.js/.css/.png/.svg/.ico` 扩展名的资源**直接返回，未做 `authed` 判断**。这是有意为之（登录页需要 CSS），但意味着设了口令后这些资源仍可被匿名获取。

### 12.4 状态文件的内存/磁盘不一致

`STATE` 在内存里，但子模块会直接写文件。改动状态相关代码时务必通过 `stateFresh()`（L81–89）读取，否则会读到脏数据。

### 12.5 各种冷却时间

| 冷却 | 时长 | 触发 |
|---|---|---|
| `VERIFY_BAD_COOL` | 60 分钟 | 实测脚本跑出「一项都没通过」 |
| hub 同步 | 60 秒 | GitHub 未登录限流 |
| 生态目录同步 | 约 10 秒抓一次 | — |
| `/api/verify` 缓存 | 30 分钟 | — |
| `/api/stars` 缓存 | 10 分钟 | — |
| `/api/lab/preview` | 3 秒节流 | — |

### 12.6 几处既成行为（别当 bug 修）

- **L39–L40**：`deploy-agent.mjs` 在模块顶层就发起 import，且把尚未定义的 `doctor` 传进去——依赖函数声明提升，能跑，但改动时小心
- **L115**：`SEC = await secretsLib()` 赋的是整个模块（而非 `{decrypt, encrypt}`），`decryptSync` 用 `SEC.decrypt` 恰好可用
- **Satori 收消息不支持**：Satori 只有 WS `/v1/events` 且需自定义鉴权头，Node 内置 WebSocket 不支持，这是能力边界不是缺陷

### 12.7 边界：哪些事它做不了

- **不抓版权内容**：点歌插件只返回搜索链接，不下载音频
- **群管理受权限限制**：机器人本身得是群管理员
- **管理员白名单是护栏不是铁门**：`operator_id` 由 AI 传入，真正兜底的是机器人自身群权限 + 只在可信群使用
- **沙箱拦不住**：网络出站、CPU 配额、代码签名

---

## 13. 安全注意事项

### 13.1 🚨 待办：GitHub Token 已泄露（**优先处理**）

**一个 GitHub Personal Access Token 在本次交接的对话记录中被明文发送过**，形如 `ghp_FfuN...`。

更严重的是：**本地工作副本的 git remote 里现在嵌着这个明文 token**：

```
origin  https://ghp_FfuN...@github.com/qqbot-hub/qqbot-plugins.git
```

**需要立刻做的两件事**：

1. 到 GitHub → Settings → Developer settings → Personal access tokens，**撤销该 token 并重新生成**
2. 把 remote 改回干净 URL，改用环境变量或 Git Credential Manager 管理凭据：

```bash
cd C:/Users/xj200/WorkBuddy/2026-10-30-11-42-03/qqbot-plugins-repo
git remote set-url origin https://github.com/qqbot-hub/qqbot-plugins.git
```

### 13.2 三条安全底线（与教程一致）

1. **白名单填具体**：机器人能操作群管理，务必只在可信群里使用
2. **用小号**：机器人自动行为容易触发风控
3. **危险操作有确认**：踢人/全体禁言/设管理员要求 `confirm=true`

### 13.3 访问控制

默认**只监听 `127.0.0.1`**（局域网扫不到）且**不设口令**（本机谁都能进）——这两条是配套的。做了端口转发或放到有别人的机器上，**必须先设口令**：

```json
// config.json
{ "password": "换成你自己的口令" }
```

设了之后打开页面会跳登录页，登录后种 HttpOnly Cookie（30 天）。`/api/onebot/event` 例外（协议端上报入口，只收本机来源 + 可选 AccessToken）。

### 13.4 密钥备份

`data/state/.secrets.key` **丢了就解不回来**。要备份就跟 `config.json` 一起备份。
config.json、`data/state/`、`runtimes/` 都在 `.gitignore` 里，别手滑提交上去。

---

## 14. 资源索引

### 14.1 文档

| 文档 | 内容 |
|---|---|
| **HANDOFF.md**（本文件） | 完整交接 |
| `AGENT-DEPLOY.md` | AI 辅助部署手册（三个工具、headless profile、额度消耗） |
| `INSTALL.md` | 一键部署与侧栏「部署链路」 |
| `BRIDGE.md` | 搭桥原理：怎么和教程链路连起来 |
| `METHODS.md` | 10 条部署路线详解与兼容性矩阵 |
| `PROTOCOLS.md` | 协议端适配（SnowLuma/NapCat/LLOneBot/Lagrange） |
| `PLUGIN_SPEC.md` | 插件规范（`tools`/`handlers`/`settings` 声明） |
| `MESSAGE.md` | 消息接入：命令、权限、限流 |
| `ECOSYSTEM.md` | 三生态插件（NoneBot/AstrBot/Koishi）安装原理与坑 |
| `REGISTRY.md` | 插件上架：提交/审核/版本 |
| `HUB.md` | 全网插件源（6 源 204 仓库） |
| `SANDBOX.md` | 插件沙箱边界（含拦不住什么） |
| `PRIMARY-SETUP.md` | 主链路（SnowLuma+qq-bridge+DSH）搭建 |
| `INTEGRATION-SURFCORE.md` | 与 SurfCore 共存（端口 3100 二选一） |
| `DEPLOYMENT-FIXES-2026-10-30.md` | 部署链路修复记录 |
| `HANDOFF-FIXES-2026-10-30.md` | 交接修复记录 |
| `PROTOCOL.md` | 协议细节 |

### 14.2 外部链接

| 资源 | 地址 |
|---|---|
| 仓库 | https://github.com/qqbot-hub/qqbot-plugins |
| 公网演示站 | https://qqbot-plugin-market.app.workbuddy.host/?sharecode=FRMQR6M3FU |
| 交流群 | QQ 群 **973971153** |
| 大肥鱼（无隶属关系） | https://gitee.com/luo_sang/qqbot |
| 贡献者名单 | `CONTRIBUTORS.md` |

### 14.3 与「大肥鱼」的关系

抖音上那套「大肥鱼」是**单体 Python 程序**（`bot.py` + `persons.py`），**没有插件系统**——没有 `plugin/` 目录、没有插件 API 或钩子。所以「把它的插件导入这里」做不到。

两者**互补**：大肥鱼负责「像人一样聊天」（人格、语气、记忆、心情），本市场负责「替人办事」（查数据、管群、记账、游戏、提醒）。本项目与该开源项目**没有隶属关系**，未使用其代码、素材或预设。

### 14.4 版权与第三方说明

| 内容 | 来源 |
|---|---|
| 界面（HTML/CSS）、图标、Logo | 本仓库原创手写，纯 CSS + 手绘 SVG，**未使用任何第三方 UI 框架、图标库、字体或图片素材** |
| 50 个插件的代码 | 本仓库原创实现，零第三方依赖 |
| 「源自 xxx」标签 | 仅是对同类功能上游项目的**文字致谢**，不包含、不复制其任何代码 |
| 联网插件接口 | Open-Meteo、er-api、nbnhhsh、一言、B站公开接口、必应每日图等公开接口，无需 Key |

字体走系统字体栈，不发网络请求；不抓取任何版权音视频内容。仓库整体 MIT 协议。

> ⚠️ 若使用本地 Breeze-TTS-2.cpp：源码 Apache-2.0，但**模型权重是非商用许可（BreezeBlue）**，商用需另行授权；其服务无鉴权，务必只绑定 `127.0.0.1`。

---

## 附录：一页纸速查

```bash
# 起服务
cd C:/Users/xj200/WorkBuddy/2026-10-30-11-42-03/qqbot-plugins-repo && node server.js
# → http://127.0.0.1:3210

# 发版三连
git -C qqbot-plugins-repo pull origin main
cd qqbot-plugins-repo && git add -A && git commit -m "..." && git push origin main
cp public/index.html C:/Users/xj200/WorkBuddy/2026-10-28-19-16-50/qqbot-publish/public/
# 然后用 WorkBuddy 发布工具发布 qqbot-publish 目录

# 体检
node scripts/doctor.mjs
curl "https://qqbot-plugin-market.app.workbuddy.host/api/health?sharecode=FRMQR6M3FU"

# 测试
for t in scripts/test-*.mjs; do node "$t"; done

# 装依赖（务必 --ignore-scripts）
npm ci --ignore-scripts

# 三个必查宽度
# 1080px（用户窗口） / 1440px（宽屏） / 420px（移动）
```

**三个绝不能忘**：
1. package.json 里不能有 `install` / `prepare` / `postinstall` 命名的脚本
2. 发布目录不能带 `config.json`、`data/state/`、`node_modules`、`.git`
3. 公网访问必须带 `?sharecode=FRMQR6M3FU`

---

*文档结束。接手后如有疑问，QQ 群 973971153。*
