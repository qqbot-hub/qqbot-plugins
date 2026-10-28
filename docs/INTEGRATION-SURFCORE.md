# 与 SurfCore 共存（能不能融合？）

结论先说：**能共存，不能合并成一个。** 两者在同一个 DSH 上各挂一套 MCP，能力互补；但它们是链路里不同层的两套东西，硬"融合"只会互相打架。

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

### ③ 工具重复：AI 会犯迷糊

| 能力 | SurfCore | 本市场 | 建议 |
| --- | --- | --- | --- |
| 记忆 | `qq_memory_append/query/remove/clear` | `qq_memory_save/recall/card/forget` | **只留一套**，否则记忆会分裂在两个地方 |
| 语音 | `qq_send_voice`（走 voxd 8765/8767） | `qq_tts` | 只留一个；或用下面的「共用一个引擎」方案 |
| 消息收发 | `qq_send_message` / `qq_reply` / `qq_wait_for_messages` 等 | 无 | SurfCore 负责 |
| 群管 | 无 | `group_admin`（禁言/踢人/公告） | 本市场负责 |
| 记账 / 备忘 / 签到 / 天气 / 计算 / 汇率 | 无 | 有 | 本市场负责 |
| 小游戏（成语接龙、21点、猜数字…） | 无 | 6 个 | 本市场负责 |
| AI 画画 | 无 | `imagine` | 本市场负责 |
| B站 | 有（扫码登录、动态、分享） | 无 | SurfCore 负责 |
| 桌宠 | 有（SurfPet） | 无（只有下载入口） | SurfCore 负责 |

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
