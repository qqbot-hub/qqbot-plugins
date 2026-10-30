# 部署整条链路

> 一句话：**你只需要部署这一个网站**，剩下每一环（协议端 → 桥接 → DSH 注册 → 插件）都在市场页面里点一下就装。

这份文档讲三件事：这条链路有哪些环、每一环由哪份脚本负责、哪些步骤必须你本人动手。

---

## 一、链路全景

```
QQ 账号
  │  ① 协议端（SnowLuma / NapCat）  把 QQ 变成 OneBot v11 接口   HTTP 3000 · WS 3001
  ▼
OneBot HTTP API
  │  ② 适配层 plugins/_bridge.mjs    吃掉各家实现差异，统一动作名与错误分类
  ▼
本插件市场 mcp-server.mjs（stdio）
  │  ③ MCP 协议                     把插件工具暴露给 AI
  ▼
DSH（DeepSeek Harness）              AI 大脑，决定调哪个工具      HTTP（端口动态，脚本自动探测）
  │  ④ 可选：qq-bridge               人格 / 记忆 / 多角色接到 QQ    HTTP 3100
  ▼
群里的实际效果：发消息、禁言、记账、画图、语音……
```

市场自己（3210）不属于数据流，它是**分发与控制台**：装什么、装到哪、装没装成，都从这里管。

---

## 二、每一环是谁、谁负责装

| # | 组件 | 端口 | 安装脚本 | 能全自动吗 | 必须人工的部分 |
|---|---|---|---|---|---|
| 0 | Node.js 运行时 | — | `recipes/node.mjs` | 只能检查 | 官方安装包要你点下一步 |
| 1 | SnowLuma 协议端 | OneBot 地址可配置；2.x 面板通常 5099/5100 | `recipes/snowluma.mjs` | 检测 + 启动 + 协议心跳验登录 | 2.x 面板同意协议、启用 OneBot、扫码登录 |
| 1' | NapCat 协议端（替代） | 3000 / 3001 | `recipes/napcat.mjs` | 下载 + 解压全自动 | 在它面板里登录 QQ、开 HTTP/WS。**一键部署会自动跳过它**（SnowLuma 装成了就不重复装） |
| 2 | DSH（宿主） | 动态（脚本自动探测） | `recipes/dsh.mjs` | 检测进程 → 自动拉起 → 按指纹找到真实端口并写回配置 | 首次仍要你在 DSH 窗口里登录账号；DSH 端口不固定，别写死 3080 |
| 3 | qq-bridge 桥接（可选） | 3100 | `recipes/qqbridge.mjs` | 检测 + 启动 | 首次要填 QQ 号与协议端地址 |
| 4 | 本插件市场 | 3210 | `recipes/market.mjs` | 写 MCP 注册全自动 | 装完要**完整退出 DSH 再打开**（配置只在启动时读） |
| 5 | 调音台（可选） | 3120 | `recipes/voicelab.mjs` | 检测 + 启动 + 验接口 | 无 |
| — | 任意插件 | — | `recipes/plugin.mjs` | 校验 + 落盘 + 注册 MCP 全自动 | 插件声明了必填配置时，要你去表单里填 |

「必需」判定见 `data/catalog/components.json` 的 `required` 字段；协议端只要装一个（SnowLuma 或 NapCat）。

---

## 三、点「部署」之后到底发生了什么

引擎是 `scripts/installer.mjs`，每份 recipe 是一串步骤，每步返回四种结果之一：

| 结果 | 含义 | 引擎动作 |
|---|---|---|
| `ok` | 这步过了 | 继续下一步 |
| `skip` | 不需要做（已经满足） | 继续下一步 |
| `manual` | **必须你动手** | 停下，把 hint 显示出来；你做完再点一次，已完成的步骤会自己 skip |
| `fail` | 这步没过去 | 停下，后续步骤标 `blocked`（不会带着半成品继续装） |

真实例子（`node scripts/installer.mjs run plugin --id=clock`）：

```
[detect]  查插件清单 → 时钟（工具）· 提供 1 个工具：qq_clock
[file]    校验 plugins/clock.mjs → 1 个工具可加载
[config]  检查必填配置 → 不需要配置
[record]  写入安装状态 → data/state/plugins.json
[mcp]     确认已注册进 DSH → 已自动注册到 profile desktop
[verify]  自检 → clock 已安装，1 个工具可用
```

---

## 四、页面上的三个入口

1. **部署整条链路**（侧栏「部署链路」）
   列出全部组件与实时端口状态；顶部「一键部署整条链路」按 `order` 顺序串起来跑，遇到 `manual` 就停在那一环并告诉你做什么。
2. **插件卡片的「安装」**
   走 `recipes/plugin.mjs`：校验 → 查配置 → 落盘 → 注册 MCP → 自检。装完 DSH 会多出 `mcp__qqbot__*` 工具。
3. **安装面板**
   弹窗里逐步显示状态、detail 与日志（`/api/install/events` 的 SSE 实时流）；失败时红色日志 + 黄色 hint，可整段复制。

---

## 五、数据与代码的目录约定

```
data/
  catalog/
    plugins.json      50 个自有插件（能装进机器人、走 MCP 暴露工具）
    companions.json   3 个配套程序（桌面宠物 / TTS 引擎 / 调音台，独立运行）
    components.json   链路上的运行时组件（协议端 / 桥 / DSH / 市场本体），带 recipe 映射
  sources/
    external.json     外部插件源定义（GitHub 查询式，加源只加一行）
  snapshots/
    hub.json          外部源抓取快照（离线可看，带 fetchedAt）
  state/
    plugins.json      插件安装状态（installed / enabled / installedAt）
    jobs.json         最近 20 次安装任务（含步骤与尾部日志）

recipes/              每个可安装对象一份脚本，一份 = 一个组件的全部安装知识
scripts/
  installer.mjs       安装引擎（CLI + 库 + SSE 事件源）
  lib/paths.mjs       所有数据文件的唯一路径出口（新结构优先、旧位置回退）
```

所有路径都从 `scripts/lib/paths.mjs` 取，不再各处拼字符串。

---

## 六、写一份新 recipe

```js
// recipes/xxx.mjs
export default {
  id: 'xxx',
  title: '显示名',
  kind: 'protocol',           // prereq | protocol | host | bridge | market | companion | plugin
  steps: [
    {
      key: 'detect',           // 唯一、稳定（前端按 key 定位这一行）
      title: '给人看的步骤名',
      hint: '这步失败或需要人工时，告诉用户具体做什么（带命令/路径/链接）',
      async run(ctx) {
        // ctx.log('...')           写一行日志（页面实时看到）
        // ctx.exec(cmd, args)      跑命令，输出自动进日志，永不抛错
        // ctx.spawnDetached(...)   起常驻进程（协议端/桥/调音台），不等它结束
        // ctx.portOpen(host, port) 探端口
        // ctx.httpGet(url)         发 GET，返回 { status, ok, text, json }
        // ctx.cfg() / ctx.saveCfg(patch)   读写 config.json
        // ctx.state.xxx            跨步骤传值
        // ctx.params               页面传进来的参数（插件安装用 { id }）
        return { status: 'ok', detail: '这步做了什么（一句话，具体数字）' };
      },
    },
  ],
};
```

硬性要求：

1. **幂等**：已经装好的再跑一次要 `skip`，不能重装、不能重复写配置。
2. **有 detail**：写清「查到了什么」，不要只说“成功”。
3. **有 hint**：可能失败或需要人工的步骤，hint 必须是可执行的下一步（命令 / 路径 / 链接）。
4. **不静默改系统**：下载只落到 `runtimes/<id>/`，配置只写 `config.json`；卸载/删除这类破坏性动作不要放在 recipe 里。

---

## 七、命令行用法

```bash
node scripts/installer.mjs list                    # 看有哪些脚本
node scripts/installer.mjs run node                # 检查运行时
node scripts/installer.mjs run snowluma            # 检查/启动协议端并读 QQ 身份
node scripts/installer.mjs run plugin --id=clock   # 装一个插件（含 MCP 注册）
```

接口（市场运行时）：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/components` | 组件清单 + 端口实时状态 |
| GET | `/api/install/recipes` | 可用脚本与步骤数 |
| POST | `/api/install` | 起一个任务 `{ target, params }` → `{ jobId }` |
| GET | `/api/install/events` | SSE：`start` / `step` / `log` / `done` / `fail` / `manual` |
| GET | `/api/install/job?id=` | 单任务详情（轮询兜底） |
| GET | `/api/install/jobs` | 最近任务列表 |

---

## 八、边界（写在明面上）

- **不能替你登录 QQ**。扫码/密码这一步任何协议端都绕不过，市场只能检测「登没登」并告诉你差这一步。
- **桌面程序仍要登录**。DSH 的进程脚本能自动拉起（在常见安装位置找 exe → 后台启动 → 按响应指纹探测动态端口），首次登录账号还是要你来。
- **外部生态的插件不能一键装**。Yunzai / NoneBot / Koishi 的插件依赖各自加载器，格式不通用；「全网插件源」里给的是目录 + 适配提示词，粘给 AI 改写成 `.mjs` 才能装（见 [HUB.md](HUB.md)）。
- **下载依赖网络**。GitHub 在部分网络下需要代理；`scripts/lib/net.mjs` 会在 fetch 失败时退回系统 `curl`。

### SnowLuma 2.x 新电脑部署

Windows x64 的新安装会下载官方固定 v2.2.1 并校验 GitHub 发布 SHA256，再检查压缩包路径并解压。元数据或网络不可用时返回人工提示。也可把完整发行包手动解压到项目 `runtimes/snowluma`，不需要向 C 盘根目录写文件。`snowluma.installDir` 可指定已有目录；`C:\SnowLuma` 仍作为兼容位置。`index.mjs` 必须直接位于安装目录。

脚本优先使用发行包自带 `node.exe`，并用该 Node 执行发行包的 `check-node-version.cjs`。市场要求 Node >=20 不代表满足 SnowLuma 的要求；2.2.1 要求 `^24.22.1 || >=26.12.1`。版本检查失败会在启动前提示，不会循环拉起实例。

SnowLuma 2.x 首次启动只出现面板是正常状态。默认检测本机 5099/5100，也可设置 `snowluma.webuiUrl` 指向实际的本机 HTTP 面板。面板端口上必须返回 SnowLuma 标识，其他程序占用端口不会算成功。已记录的启动 PID 仍存活时不会重复启动；PID 可能被系统复用，若脚本提示进程存活但程序已退出，请先人工核实进程，再清理安装目录内 `.market-process.json` 后重试，不要盲目结束其他进程。

在面板自行完成 EULA/PRIVACY、管理员登录、启用 OneBot v11 HTTP、QQ 扫码。面板密码由 SnowLuma 提供，市场不读取或展示。HTTP 地址及 AccessToken 必须与市场连接设置一致；WebSocket 仅按 qq-bridge 的配置需要启用。回到市场继续部署，最终以 OneBot 协议心跳通过为准；仅面板可打开时会返回“需要人工操作”。

1.14.20 是 qq-bridge 文档中的历史验证版本，不自动降级现有版本。2.2.1 已适配安装流程，但完整 qq-bridge + DSH 消息收发尚需在真实账号环境验证，不能将面板启动或模拟测试视为全链路通过。

### 本次部署修复后的运行方式

首次执行 `npm ci --ignore-scripts`，Windows 可双击 start.bat。无 Node 时可运行 `powershell -File .\bootstrap.ps1`（winget 安装需要你处理系统提示）。主链路要求市场 Node >=22.13.0。

一键部署按 Node → DSH → SnowLuma → qq-bridge → 市场注册执行。人工步骤不会阻止其他组件准备；继续时跳过已完成组件，未完成组件重新验证。桥接白名单默认关闭全部会话，页面提供 QQ 号/群号输入，至少填写一项后继续。不要以空白名单测试模式作为验收。

新下载的 qq-bridge 固定 v0.2.1-r1（a49877f4e58d04e47532d44b803360d0f001160d），已有安装不会强制切版本。市场运行期间发现 DSH 动态 Web 端口与 SnowLuma 账号 HTTP/WS 凭据后同步桥接配置。本次启动的桥接由专用监督进程管理，配置变化后只重启它自己的子进程；已由用户手动启动的旧桥接需要用户在控制台应用新配置或手动重启。

首次 MCP 注册需 DSH 加载配置；后续插件增删发出 tools/list_changed。卡片分已安装、已注册、已加载、只读能力可用，缺 Key、缺接口、离线均不报绿。QQ 空间兼容新旧动作名，并以只读探测判断，不能按 SnowLuma 版本判定不支持；云端语音/识图不自动发送付费请求。

可选登录启动：`node scripts/startup.mjs --enable`；关闭：`node scripts/startup.mjs --disable`。仅设置当前用户登录启动，不安装系统服务。

隔离验收：`npm run test:fresh`。它验证模拟新环境中的注册、凭据、检查点和真实 MCP 子进程热更新，不代表已经在干净虚拟机完成 QQ 收发消息。完整验收仍须扫码、配置白名单、在 QQ 发消息确认回复。
