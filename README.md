# 🐟 QQ-Plugin-Hub — AI QQ 机器人插件市场

**给 AI QQ 机器人（DeepSeek / SnowLuma / qq-bridge / DSH 链路）一键装上 43 个插件、69 个能力。**
装完即自动变成 AI 可调用的 MCP 工具（`mcp__qqhub__*`），机器人从此能在 QQ 里查天气、管群、记账、签到、玩小游戏……

> 零第三方依赖 · 一个命令启动 · 一个命令搭桥 · MIT 开源

![QQ-Plugin-Hub 插件市场界面](docs/screenshot.png)

[![Node](https://img.shields.io/badge/node-%E2%89%A518-blue)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Plugins](https://img.shields.io/badge/插件-43%20个%20%2F%2069%20工具-orange)](#插件一览)

---

## 这是什么

如果你按过《DeepSeek 接入 QQ》教程把 DeepSeek 装进了 QQ（链路：**QQ ⇄ SnowLuma ⇄ qq-bridge ⇄ DSH ⇄ DeepSeek**），你会发现机器人本体只会聊天——它缺"手"。

**QQ-Plugin-Hub 就是那双手**：一个本地插件市场，浏览器里点一下"安装"，插件能力就以 MCP 工具的形式挂进 DSH，AI 在 QQ 里就能直接调用：

```
QQ ⇄ SnowLuma ⇄ qq-bridge ⇄ DSH ⇄ DeepSeek
                                    ⇘
                                  QQ-Plugin-Hub（MCP: mcp__qqhub__*）
                                    ⇘
                          43 个插件 ⇄ OneBot API ⇄ QQ
```

- **市场侧**：登录 → 浏览/搜索 43 个插件 → 一键安装/卸载/启停/配置，实时探测链路状态
- **AI 侧**：`node scripts/register-dsh.mjs desktop` 把市场注册进 DSH（与官方 `mcp__snowluma__` 同一机制、同一配置文件，互不冲突）→ 重启 DSH → AI 工具列表里出现全部已装插件
- **配置侧**：连接渠道（OneBot 地址/Token）、群管理白名单、默认城市等，全部在网页里填，存成 `config.json`，改完立即生效
- **安全侧**：踢人/全体禁言等危险操作必须 `confirm=true`；群管理还支持管理员 QQ 白名单与「只允许操作的群」双重护栏

### 「装到 QQ 上」到底是什么意思

不需要把插件文件复制进 qq-bridge 目录。插件由**市场自己的进程**（`mcp-server.mjs`）提供，DSH 通过 MCP 标准协议调用它，插件再通过 SnowLuma 的 OneBot API 操作 QQ。所以：

- 装插件 = 在市场点「安装」（只改一个状态文件，不往别人的仓库里塞东西）
- 生效 = 重启 DSH（AI 的工具列表在启动时加载）
- 卸载 = 点「卸载」再重启，工具就从 AI 手里消失了

## 快速开始

```bash
# 0. 前置：已按教程跑通 SnowLuma + qq-bridge + DSH（DSH 里发一句话有回复）

# 1. 拉取并启动市场
git clone https://github.com/xiazhuo123456789/qqbot-plugins.git
cd qqbot-plugins
node server.js
# 浏览器打开 http://127.0.0.1:3210

# 2. 填连接渠道（推荐在网页里点「连接设置」；也可以复制配置文件手改）
copy config.example.json config.json

# 3. 搭桥：把市场注册进 DSH（profile 名看 ~/.dsh/profiles/ 下的子目录名）
node scripts/register-dsh.mjs desktop

# 4. 【关键】完整退出并重启 DSH（MCP 只在启动时加载）
#    然后在 DSH 里搜 mcp__qqhub__ —— 能搜到即搭桥成功 ✅

# 5. 链路体检（随时可跑）
node scripts/doctor.mjs
```

之后在 QQ 里对机器人说"帮我禁言他十分钟""查下北京天气""开一局成语接龙"，AI 就会自己调用对应插件。

## 配置（都在网页里填）

### 1）连接设置 —— 插件和 QQ 通信的渠道

左侧导航点「连接设置」，或搭桥区点「连接设置」：

| 字段 | 说明 |
| --- | --- |
| OneBot HTTP 地址 | SnowLuma 的 HTTP API，默认 `http://127.0.0.1:3000`。发消息、禁言、查群都走这里 |
| AccessToken | SnowLuma 配了 token 才需要填；留空表示不修改已保存的值 |
| WebSocket 端口 | 默认 3001，仅用于体检探测 |
| DSH 地址 / profile 名 | 默认 `http://127.0.0.1:3080` 和 `desktop`，用于体检与一键搭桥 |

改完**立即生效**——`mcp-server.mjs` 每次被 AI 调用时都会重新读这份配置，不用重启 DSH（只有增删插件才需要重启）。

### 2）插件配置 —— 群管理等需要权限的插件

有配置项的插件，卡片上会多一个「⚙ 配置」按钮。目前：

**group_admin（群管理）**

| 字段 | 作用 |
| --- | --- |
| 管理员 QQ 白名单 | 非空时，只有名单里的人发起，禁言/踢人/公告等才会执行；AI 必须如实传 `operator_id` |
| 允许操作的群号 | 非空时，只对这些群生效，防止 AI 在别的群误操作 |
| 默认禁言时长 | 群友没说"禁多久"时用这个分钟数 |
| 危险操作需二次确认 | 保持开启时，踢人/全体禁言/设管理员必须带 `confirm=true` |

**weather（天气）**：默认城市，群友只说"今天天气怎么样"也能直接查。

> 白名单是"防误操作"的护栏，不是绝对安全边界——`operator_id` 由 AI 传入。真正兜底的是机器人自己的群权限（SnowLuma 侧）和只在可信群里使用。要加新的可配置插件，看 [docs/PLUGIN_SPEC.md](docs/PLUGIN_SPEC.md) 里的 `settings` 声明方式。


## 插件一览（43 个）

| 分类 | 数量 | 插件 |
| --- | --- | --- |
| 工具 | 20 | calc 计算 · weather 天气 · translate 翻译 · exchange 汇率 · unit 单位换算 · baseconv 进制 · morse 摩斯电码 · passgen 密码 · abbr 缩写解释 · remind 定时提醒(主动消息) · memo 群备忘 · ledger 群记账 · birthday 生日倒计时 · clock 报时 · jukebox 点歌链接 · pomodoro 番茄钟(主动消息) · coin 抛硬币 · color 颜色卡 · bilihot B站热门 · bingimg 必应每日图 |
| 娱乐 | 13 | fortune 今日运势 · dice 骰子/多选一 · draw 抽签 · sensoji 赛博浅草寺 · tarot 塔罗 · zodiac 星座 · meihua 梅花易数 · hitokoto 一言 · joke 冷笑话 · quote 毒鸡汤 · riddle 脑筋急转弯 · poem 古诗 · gacha 抽群友卡 |
| 小游戏 | 6 | blackjack 21点 · guess 猜数字 · bombgame 数字炸弹 · idiom 成语接龙 · wordle 猜单词 · roulette 轮盘点名 |
| 群管理 | 2 | group_admin 禁言/踢人/撤回/名片/头衔/公告 · group_info 群资料/成员列表 |
| 群互动 | 2 | signin 群签到积分榜 · qzone QQ空间说说 |

合计 **43 个插件 / 69 个工具**。分类与数量由 `data/plugins.json` 统一驱动，市场页面按此分组筛选。

> 插件灵感与能力对标 AstrBot / NoneBot / Koishi / Yunzai 生态的同类插件（目录数据中保留了对应上游出处），但实现全部为本仓库原创、零依赖、面向 MCP 工具调用设计。部分联网插件使用免费公开接口（Open-Meteo / er-api / nbnhhsh / B站 / 必应），无需任何 API Key。

## 搭桥原理（为什么能和教程里的方法连起来）

详见 [docs/BRIDGE.md](docs/BRIDGE.md)。一句话版本：

1. qq-bridge 官方通过 `~/.dsh/profiles/<profile>/cordis.patch.yml` 给 DSH 挂 MCP 服务器（`snowluma`、`web-search-safe` 等）；
2. 本项目用**同一配置文件、同一格式**追加一个自己的条目 `mcp-qqhub`（serverName `qqhub`），指向本仓库的 `mcp-server.mjs`（stdio JSON-RPC）；
3. DSH 启动时加载它，全部已安装插件的工具以 `mcp__qqhub__<tool>` 出现；
4. 插件内部需要操作 QQ 时，走 SnowLuma 的 OneBot HTTP API（端口 3000）——和 qq-bridge 用的是同一条通道。

所以：**不 fork qq-bridge、不改它任何文件、不和它的 MCP 冲突**，教程链路原样保留，只做加法。

## 开发自己的插件

看 [docs/PLUGIN_SPEC.md](docs/PLUGIN_SPEC.md)。一个插件 = 一个 `.mjs` 文件：

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

放到 `plugins/` 下、在 `data/plugins.json` 加一条，市场里就能看到、AI 里就能用。`ctx` 注入 `ctx.onebot(action, params)`（OneBot 调用）与 `ctx.storage`（持久化）。

## 目录结构

```
QQ-Plugin-Hub/
├─ server.js            市场服务端（登录/API/体检/搭桥，零依赖）
├─ mcp-server.mjs       MCP stdio 服务器（暴露插件工具给 DSH）
├─ plugins/             43 个插件（每个 .mjs 自包含）
├─ data/plugins.json    插件目录数据
├─ scripts/
│  ├─ register-dsh.mjs  写 cordis.patch.yml 搭桥（自动备份/幂等/--remove）
│  └─ doctor.mjs        四关体检（DSH/SnowLuma/bridge/工具数）
├─ public/              市场前端（原生 HTML/JS，暗色主题）
└─ docs/                搭桥原理 & 插件开发规范
```

## 常见问题

| 现象 | 处理 |
| --- | --- |
| DSH 里搜不到 `mcp__qqhub__` | 没重启 DSH。完整退出桌面程序再打开（关浏览器标签不算） |
| 装了插件但 AI 说没有这个工具 | 装/卸/启停后都要重启 DSH 才刷新工具列表 |
| `register-dsh` 报 profile 目录不存在 | 打开 `~\.dsh\profiles\` 看子目录名，用真实名字 |
| 禁言/踢人失败 | 机器人需要群管理员权限；SnowLuma 的 HTTP API(3000) 必须开启 |
| 定时提醒没发出来 | 提醒由 Hub 的 MCP 进程触发，保持 DSH 开着；并确认 OneBot HTTP 可用 |
| 天气/汇率等联网插件失败 | 依赖免费公开接口，检查网络；全部接口无需 Key |

## 安全提醒（和教程一致的三条）

1. **白名单填具体**：机器人能操作群管理，务必只在可信群里使用；
2. **用小号**：机器人自动行为容易触发风控；
3. **危险操作有确认**：踢人/全体禁言/设管理员要求 `confirm=true`，出现意外行为可在市场里一键停用插件。

## 版权与第三方说明（不侵权）

本项目从零实现，可以放心使用和二次分发：

| 内容 | 来源 |
| --- | --- |
| 界面（HTML/CSS）、图标、Logo | 本仓库原创手写，仅使用纯 CSS 与手绘 SVG，**未使用任何第三方 UI 框架、图标库、字体或图片素材** |
| 43 个插件的代码 | 本仓库原创实现，零第三方依赖 |
| 插件目录里的「源自 xxx」标签 | 仅是对同类功能上游项目的**文字致谢**（AstrBot / NoneBot / Koishi / Yunzai 社区），不包含、不复制其任何代码；这些项目各自遵循其自身许可 |
| 联网插件调用的接口 | Open-Meteo、er-api、nbnhhsh、一言、B 站公开接口、必应每日图等公开接口，按其公开使用条款调用，无需 Key |

字体走系统字体栈，不发网络请求；不抓取任何版权音视频内容（点歌插件只返回平台搜索链接）。仓库整体采用 MIT 协议。

## License

MIT © 2026 [xiazhuo123456789](https://github.com/xiazhuo123456789)
