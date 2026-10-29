# 与 SurfCore 共存（能不能融合？）

结论先说：**能共存，不能合并成一个。** 两者在同一个 DSH 上各挂一套 MCP，能力互补；但它们是链路里不同层的两套东西，硬"融合"只会互相打架。

## 两条路线：她的"能力"和她的"存在"

SurfCore 不是"另一种插件"，而是**另一种建法**。一句话区分：

> SurfCore 回答「她是谁」，本市场回答「她会做什么」。

| | 本市场（qqbot-plugins） | SurfCore |
| --- | --- | --- |
| 所在层 | DSH 上的 **MCP 插件层** | **整条链路**：bridge + DSH 插件 + 3 个 MCP + agent preset |
| 定位 | 能力市场，按需组合 | 意识运行时，一体化交付 |
| 起点 | 假设你已经有 qq-bridge 跑通 | 自己就是桥接，**替代** qq-bridge |
| 覆盖 | 群管、记账、备忘、签到、6 个小游戏、AI 画画、天气、汇率…… | 身份、会遗忘的记忆、作息、语音、B站、桌宠 |
| 形态 | 47 个独立插件，可装可卸 | 一个完整产品，开箱即用 |
| 演进方式 | **横向**：插件各自独立，越加越多 | **纵向**：把一件事做深，三端统一 |
| 适合谁 | 链路已通、想按需补能力 | 想直接得到一个"活着的角色" |

两条路都成立，取舍在于**你更在意"她能做多少事"还是"她像不像一个人"**。

真正的分歧点只有两个：**记忆**（两套库）和**语音**（两套引擎）。其余 60 多个插件完全互补。

## 为什么不能合并

```
QQ ⇄ SnowLuma(3000/3001) ⇄ ┬─ qq-bridge（或 SurfCore 的 bridge.js）  ← 同一层，二选一
                            │                    ⇅ DSH(3080)
                            └─ 本市场 mcp-server（MCP 插件层）        ← 另一层，可并存
```

SurfCore 是一个**完整的桥接栈**：`src/bridge.js` 就是 qq-bridge 的位置，它自己注册 MCP、自己管会话、自己做记忆卡片和语音。本市场是**挂在 DSH 上的插件层**，不碰桥接。

所以关系是：**SurfCore 替换 qq-bridge，本市场继续挂在 DSH 上**。两者并存，不是二合一。

## 三个必须知道的冲突

### ① 端口 3100：只能跑一个

SurfCore 的 `config.example.json` 里 `consolePort: 3100`，和 qq-bridge 的控制台**完全同一个端口**。两者不能同时启动。

装了 SurfCore 就**不要再启动 qq-bridge**，否则第二个会因为端口占用起不来。

### ② `cordis.patch.yml`：区块不冲突，但要按顺序装

| 项目 | 占用注释块 |
| --- | --- |
| qq-bridge / SurfCore | `# === qq-bridge MCP BEGIN/END ===`（SurfCore 沿用了 qq-bridge 的块名和 id） |
| 本市场 | `# === qqbot-plugins MCP BEGIN/END ===` |

两个脚本都只重写自己那段，**互不覆盖**。但注意：qq-bridge 和 SurfCore 用的是**同一个块**，所以它们会互相覆盖——这不影响本市场。

顺序建议：

```bash
# 1. 先装 SurfCore（会写 qq-bridge 块）
node scripts/setup-dsh.mjs          # SurfCore 的

# 2. 再装本市场（写自己的块）
node scripts/register-dsh.mjs desktop

# 3. 完整重启 DSH
```

反过来也行，只要**最后重启一次 DSH**。

### ③ 工具重叠：其实只有 3 个领域

先把数据摆出来（两边工具名逐条比对）：

| 指标 | 数值 |
| --- | --- |
| SurfCore 工具 | 39 个 |
| 本市场工具 | 75 个 |
| **完全同名的** | **0 个** |
| 功能重叠的领域 | **3 个**：记忆、语音、群成员查询 |

MCP 的工具名带服务前缀，所以**不会真的撞名字**：

```
mcp__snowluma__qq_memory_append   ← SurfCore
mcp__qqbot__qq_memory_save        ← 本市场
```

真正的麻烦只有一个，但很真实：**记忆分裂**。

| 领域 | SurfCore | 本市场 | 实际影响 |
| --- | --- | --- | --- |
| 记忆 | `qq_memory_append/query/remove/clear` | `qq_memory_save/recall/card/forget` | ⚠️ **两个独立的存储**。让它记到 SurfCore 那边，你问我这边就查不到，反之亦然 |
| 语音 | `qq_send_voice`、`qq_list_voices` | `qq_tts` | 资源重复（两套引擎/两套音色），不致命，但浪费 |
| 群成员 | `qq_get_group_members`、`qq_get_active_members` | `qq_group_info/members/member` | 都是只读，无害，只是多一层选择 |
| 群管理动作 | **无** | `qq_group_ban/kick/recall/...` 8 个 | 只有本市场有 |
| 发消息/表情包/未读 | 一整套 8 个 | 无 | 只有 SurfCore 有 |

剩下的 60 多个插件（记账、签到、天气、计算、汇率、6 个小游戏、AI 画画、备忘、提醒…）**完全无重叠**，各管各的。

所以准确的说法不是"AI 会犯迷糊"，而是：**同一件事有两套实现，其中记忆会真的分家。**

**推荐分工**：SurfCore 管"像人一样聊天"（身份、记忆、语音、B站、桌宠），本市场管"替人办事"（群管、记账、游戏、画画）。

装完 SurfCore 后，到市场里把这三类插件**停用**可以减少 AI 选错工具：

- `memory`（记忆重复）
- `voice`（语音重复，除非用下面的共用引擎方案）
- `remind`（SurfCore 有 `qq_wait_for_messages`，功能有重叠，看你要不要留）

## 融合点：共用一个语音引擎

这是唯一真正能"融合"的地方，而且已经做好了。

SurfCore 的语音引擎 voxd 暴露 `POST /v1/speak/file`，**直接返回 wav 字节**：

```
请求：{ "text": "...", "format": "wav", "sr": 24000, "cache": true, "character": "大肥鱼" }
响应：wav 二进制 + X-Duration-Ms
```

本仓库的 `voice` 插件已经支持这个后端，配置方式：

| 字段 | 填什么 |
| --- | --- |
| 后端 | **SurfCore 语音引擎 voxd** |
| 接口地址 | `http://127.0.0.1:8765`（本地）或 `http://127.0.0.1:8767`（云端） |
| API Key | 留空 |
| 角色名 | 例如 `大肥鱼`（对应 SurfCore 里配的音色） |

这样两边**共用同一套音色和缓存**，不用重复配 Key，也不用装两套 TTS。

## 记忆为什么不能互通

SurfCore 的记忆是"记忆卡片"，存在 `~/.dsh/surfcore/` 下，按它自己的字段（权重、衰减、人物卡）组织；
本市场的 `memory` 插件存在 `data/store/memory/db.json`，是 2-字切片 + 时间衰减的检索。

两边格式不同、语义不同，**硬接会让两边都变脆**。建议：

- 想要 SurfCore 那套记忆（人物卡、关系、衰减）→ 停用本市场的 `memory`
- 想要本市场的简单记忆（不依赖它的运行时）→ 不装 SurfCore 的记忆，或接受两套并存

## 实操清单

```bash
# 1. 装 SurfCore（它会接替 qq-bridge，占 3100）
#    按它 README 的步骤：npm install → config.json → node scripts/setup-dsh.mjs

# 2. 确认 qq-bridge 已停（否则 3100 冲突）

# 3. 装本市场
node scripts/register-dsh.mjs desktop

# 4. 体检（会检查 DSH / SnowLuma / 桥接 / 工具数）
node scripts/doctor.mjs

# 5. 完整重启 DSH，然后在 DSH 里分别搜 mcp__snowluma__ 和 mcp__qqbot__
```

两套工具都能搜到 = 共存成功。

## 一句话总结

SurfCore 给的是**一个活着的角色**，本市场给的是**一箱能干活的工具**。
前者负责"她是谁"，后者负责"她能做什么"。并排放，别合并。
