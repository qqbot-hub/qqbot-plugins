# 全网插件源（HUB）

> 一句话：**市场是平台，不是厨师**——像外卖平台把各家店摆上同一张桌子，这里把
> Yunzai / NoneBot / Koishi / AstrBot / OneBot 生态里真实存在的插件仓库聚到一起统一检索。
> 能直接装进机器人的仍然只有本市场自己实现的 `.mjs` 插件；外部仓库提供的是**目录 + 适配入口**。

## 数据从哪来

- 上游定义：`data/sources.json`。每条 = 一个真实的 GitHub 查询（topic / 关键词），加一条源**不用改代码**
- 抓取：`node scripts/hub-sync.mjs`，走 GitHub Search API（**公开、只读**，不克隆、不下载、不改任何上游仓库）
- 快照：`data/hub.json`（随仓库提交，页面离线也有内容；里面带 `fetchedAt` 和每个源的成功状态）
- 去重：同一个仓库命中多个源时只留一条（星数高的为主），`sources` 数组记录它命中了哪些源
- 截止 2026-10-28 首次同步：6/6 个源全部成功，共 204 个仓库

## 目前接了哪些源

| 源 | 查询 | 数量级 |
| --- | --- | --- |
| Yunzai / 云崽 | `yunzai plugin in:name,description` | 数百，取星数前 40 |
| NoneBot | `topic:nonebot-plugin` | 146+，取前 40 |
| Koishi | `topic:koishi-plugin` | 79+，取前 40 |
| AstrBot | `topic:astrbot-plugin` | 548+，取前 40 |
| OneBot 生态 | `topic:onebot-plugin` | 13（全收） |
| QQ 机器人通用 | `qq bot plugin in:name,description` | 225+，按插件关键词过滤 |

## 边界（别越线的部分）

- **目录接入 ≠ 能直接装**：Yunzai 插件是 JS 目录、NoneBot 是 Python 包、Koishi 是 npm 包，
  各自依赖自家加载器，本市场装不了它们，也不会假装能装
- 每张卡片给两件事：**看源码**（原仓库）和**复制适配提示词**——把提示词粘给 AI，
  就能按本市场规范（零依赖 `.mjs` + `ctx.bridge`）重写成一个能装的插件
- 快照里的星数/描述是抓取那一刻的，不代表最新；页面有「重新抓取」按钮

## 限流与令牌

- GitHub 未登录：搜索接口 10 次/分钟，`hub-sync.mjs` 会在源之间等 6.5 秒，一轮约 40 秒
- 页面「重新抓取」有 **60 秒冷却**，防止连点把额度烧光
- 要快可以配令牌：`config.json` 加 `"hub": { "githubToken": "ghp_xxx" }`（该文件已 gitignore），
  或环境变量 `GITHUB_TOKEN`；有令牌时间隔缩短到 1.5 秒
- 本机装了会拦截 TLS 的代理/杀软导致 Node 报 `unable to verify the first certificate` 时，
  `scripts/lib/net.mjs` 会自动退回系统 `curl`（走 Windows 证书库），不需要改任何设置

## 接口

| 接口 | 说明 |
| --- | --- |
| `GET /api/hub?q=&platform=&sort=stars\|updated\|name&page=&perPage=` | 读快照 + 过滤 + 分页，返回 facets（各平台计数） |
| `POST /api/hub/sync` | 后台重新抓取（60 秒冷却），立即返回 |
| `GET /api/lab/status` | 调音台在不在（`{ online, url, proxy }`） |
| `/lab/*` | 反向代理到本机调音台（默认 `127.0.0.1:3120`，可用 `config.json` 的 `lab.url` 改） |
| `/audio/*`、`/api/state`、`/api/synth`、`/api/voices`、`/api/presets`、`/api/upload`、`/api/save-voice`、`/api/send`、`/api/bot/voice` | 调音台页面用的绝对路径，在市场根上原样转给它 |

## 调音台是怎么接进来的

调音台（Voice Lab）是独立进程（`node D:\tts\voicelab\server.mjs`，端口 3120），**不属于本仓库**。
市场不复制它的代码，只做反向代理：市场页面里点「配套工具与桌面程序 → 调音台 → 在市场里打开」，
会在当前页弹出内嵌窗口（iframe 加载 `/lab/`），弹窗右上角也留了「新窗口打开 ↗」兜底；
它跑没跑由卡片上的绿点实时显示。
市场侧不转发登录口令（Cookie 在代理层被剥掉），调音台自己的令牌逻辑不受影响。

## 自测

```bash
node scripts/test-hub.mjs         # 起 3222 临时进程测接口/过滤/分页/代理，11 项
node scripts/hub-sync.mjs         # 真实抓取一轮（约 40 秒，会打 GitHub）
```

`test-hub.mjs` 故意**不打 GitHub**（不烧限流额度），只测市场自己的逻辑。
