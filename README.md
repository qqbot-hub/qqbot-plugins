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

- **市场侧**：登录 → 浏览/搜索 43 个插件 → 一键安装/卸载/启停，实时探测链路状态
- **AI 侧**：`node scripts/register-dsh.mjs desktop` 把市场注册进 DSH（与官方 `mcp__snowluma__` 同一机制、同一配置文件，互不冲突）→ 重启 DSH → AI 工具列表里出现全部已装插件
- **安全侧**：踢人/全体禁言等危险操作必须 `confirm=true` 才执行，AI 不会手滑

## 快速开始

```bash
# 0. 前置：已按教程跑通 SnowLuma + qq-bridge + DSH（DSH 里发一句话有回复）

# 1. 拉取并启动市场
git clone https://github.com/xiazhuo123456789/awesome-qqbot-plugins.git
cd QQ-Plugin-Hub
node server.js
# 浏览器打开 http://127.0.0.1:3210

# 2. 配置（可选）
copy config.example.json config.json   # 按需改端口 / 口令 / SnowLuma token

# 3. 搭桥：把市场注册进 DSH（profile 名看 ~/.dsh/profiles/ 下的子目录名）
node scripts/register-dsh.mjs desktop

# 4. 【关键】完整退出并重启 DSH（MCP 只在启动时加载）
#    然后在 DSH 里搜 mcp__qqhub__ —— 能搜到即搭桥成功 ✅

# 5. 链路体检（随时可跑）
node scripts/doctor.mjs
```

之后在 QQ 里对机器人说"帮我禁言他十分钟""查下北京天气""开一局成语接龙"，AI 就会自己调用对应插件。

## 插件一览（43 个）

| 分类 | 插件 |
| --- | --- |
| 工具 (15) | calc 计算 · weather 天气(Open-Meteo) · translate 翻译 · exchange 汇率 · unit 单位换算 · baseconv 进制 · morse 摩斯电码 · passgen 密码 · abbr 缩写解释 · remind 定时提醒(主动消息) · memo 群备忘 · ledger 群记账 · birthday 倒计时 · clock 报时 · jukebox 点歌链接 |
| 群管理 (2) | group_admin 禁言/踢人/撤回/名片/头衔/公告 · group_info 群资料/成员列表 |
| 群互动 (4) | signin 签到积分榜 · qzone 空间说说 · gacha 抽群友卡 · roulette 轮盘点名 |
| 娱乐 (12) | fortune 今日运势 · draw 抽签 · sensoji 赛博浅草寺 · tarot 塔罗 · zodiac 星座 · meihua 梅花易数 · hitokoto 一言 · joke 冷笑话 · quote 毒鸡汤 · riddle 脑筋急转弯 · poem 古诗 · color 颜色卡 |
| 小游戏 (6) | blackjack 21点 · guess 猜数字 · bombgame 数字炸弹 · idiom 成语接龙 · wordle 猜单词 · dice 骰子 |
| 随机/换算 (4) | coin 抛硬币 · bilihot B站热门 · bingimg 必应每日图 · hitokoto(联网) |

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

## License

MIT © 2026 [xiazhuo123456789](https://github.com/xiazhuo123456789)
