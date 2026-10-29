# 支持哪些协议端（PROTOCOLS）

> 一句话：**插件不绑定任何桥接，只认 OneBot v11。**
> 你底下跑 SnowLuma 还是 NapCat，是 qq-bridge 还是 SurfCore，插件都不用改。

## 为什么要分清楚

链路上有两类东西，容易混：

```
QQ ⇄ 协议端（SnowLuma / NapCat / Lagrange / LLOneBot / go-cqhttp）
        ⇅  OneBot v11（HTTP :3000 之类）
     桥接（qq-bridge / SurfCore）── 把消息转给 DSH
        ⇅
      DSH（大肥鱼）
        ⇅  MCP
     本市场（插件）
```

- **桥接**换掉不影响插件 —— 插件根本不跟桥接说话
- **协议端**换掉才影响插件 —— 但只要是 OneBot v11，适配层就能吃掉差异

所以本市场实际支持的是"任何说 OneBot v11 的协议端"。

## 支持哪些实现

| 协议端 | 默认 HTTP 端口 | 鉴权习惯 | 本项目的实测情况 |
| --- | --- | --- | --- |
| **SnowLuma** | 3000 | `Authorization: Bearer` | ✅ 本机实测过（1.14.20-node，见下方「实测记录」） |
| **NapCatQQ** | 3000 | `Authorization: Bearer` | ⚠️ 未实测，按实现方文档登记 |
| **LLOneBot** | 3000 | `Authorization: Bearer` | ⚠️ 未实测，按实现方文档登记 |
| **Lagrange.OneBot** | 8080（可配） | `Authorization: Bearer` | ⚠️ 未实测，按实现方文档登记 |
| **go-cqhttp** | 5700 | `Authorization: Bearer` | ⚠️ 未实测，按实现方文档登记 |
| 其他 OneBot v11 | 自定义 | 三选一 | 未验证，只要实现标准动作就行 |

配置在网页「连接设置 → 协议端」里，选哪个只是帮你**预填端口和鉴权方式**，填错了也能手动改。

> 表里"未实测"是实话：本机只有 SnowLuma 环境。**没在真实环境跑过的实现，不要写成"已验证"。**
> 拿到别的协议端后，按最后一节「怎么补一条实测记录」跑一遍再改这张表。

### 实测记录

| 日期 | 协议端 | 版本 | 跑过的动作 | 结果 |
| --- | --- | --- | --- | --- |
| 2026-10-28 | SnowLuma | 1.14.20-node | `get_login_info`、`get_version_info`、`get_group_info`、`get_group_member_info`、`_get_group_notice` | 全部正常；`get_notice` 自动落到 `_get_group_notice`；不存在的动作返回 `unknown action`，被归类为 unsupported |
| 2026-10-28 | SnowLuma | 1.14.20-node | 心跳 `heartbeat()` | 在线 42ms，识别出 SnowLuma / QQ 3996086451 / 昵称「白渡」 |

> **未做**：发群公告、踢人、禁言这类**有副作用**的动作没有在真实群里试过（会打扰真人）。
> 这部分只由 `scripts/test-bridge.mjs` 的假协议端覆盖，真机验证需要群主本人同意。

## 适配层做了什么

差异都在 `plugins/_bridge.mjs` 里吃掉，插件只写语义调用。

### ① 响应格式

```js
{ status: 'ok', retcode: 0, data: {...} }   // OneBot v11 标准
{ retcode: 0, status: 'ok', data: {...} }   // 变体
{ message_id: 1, ... }                      // 裸数据（个别实现）
```

三种都能解析；`status:'failed'` / `retcode≠0` 会抛出**可读**的错误（带 `wording` 原文）。

### ② 鉴权方式

| 方式 | 请求形态 |
| --- | --- |
| `header` | `Authorization: Bearer <token>` |
| `query` | `POST /send_group_msg?access_token=<token>` |
| `none` | 不带任何凭据 |

401/403 会翻译成「AccessToken 不对或没带，检查协议端的鉴权设置」。

### ③ 动作名差异（差异表 + 记忆）

同一件事，不同实现可能叫不同的名字。适配层维护一张**动作差异表** `ACTION_ALIASES`，
插件只写语义名（`send_notice`），由适配层按顺序试：

```js
ACTION_ALIASES = {
  send_notice: ['_send_group_notice', 'send_group_notice', 'set_group_notice'],
  get_notice:  ['_get_group_notice', 'get_group_notice'],
}
```

两个关键点：

1. **只在"动作不存在"时换名字**。网络断了、Token 错了、业务报错（群号不存在）都不会瞎重试，
   避免"重试三次把同一条公告发三遍"这类事故。
2. **学会了就记住**。第一次撞对的名字会被缓存，之后同一动作只发一次请求；
   哪天协议端升级又不认了，会自动忘掉再试其余名字。

所以**不要在插件里写 `if (是 NapCat) ...`**——差异只在这张表里加一行。

### ④ 心跳与登录信息

```js
const hb = await bridge.heartbeat();
// { online, impl: 'snowluma', app: 'SnowLuma', version: '1.14.20-node',
//   selfId: 3996086451, nickname: '白渡', latencyMs: 42,
//   checkedAt: '2026-10-28T11:21:50.327Z', httpUrl, authMode, hasToken, error }
```

- 实现名不靠猜端口：读 `get_version_info` 的 `app_name`，识别不出才退回配置里的预设
- 心跳结果有 5 秒 TTL 缓存，页面轮询不会把协议端打爆
- 离线时**不抛异常**，返回 `online:false` + 中文 `error`，方便页面直接显示

网页哪儿用到它：

- 侧栏「运行状态」：协议端一行 + 下面一小行 `「昵称」· QQ 号 · 心跳 24ms`，每 20 秒刷一次
- 接口：`GET /api/status`（只做心跳，轻量，给轮询用）、`GET /api/health`（完整体检）
- 命令行：`node scripts/doctor.mjs` 的「② 协议端身份」

## 插件怎么写（开发者）

插件里不要直接拼 HTTP，用 `ctx.bridge`：

```js
import { bridgeOf } from './_lib.mjs';

run: async (a, ctx) => {
  const br = bridgeOf(ctx);
  await br.banMember(groupId, userId, 10);      // 禁言 10 分钟
  await br.sendText({ groupId }, '已处理');      // 发文字
  await br.sendRecord({ groupId }, wavBase64);  // 发语音
  const list = await br.getMembers(groupId);     // 群成员
  await br.setNotice(groupId, '公告内容');        // 群公告（自动兜底动作名）
  const me = await br.getLoginInfo();            // 机器人自己的 QQ / 昵称
}
```

可用方法：

| 方法 | 说明 |
| --- | --- |
| `sendText(target, text)` | `target = {groupId}` 或 `{userId}` |
| `sendImage(target, base64)` | 发图片 |
| `sendRecord(target, base64)` | 发语音条 |
| `getGroupInfo(id)` / `getMembers(id)` / `getMember(id, uid)` | 群资料 |
| `banMember(gid, uid, minutes)` | 禁言（分钟，自动换算秒） |
| `kickMember(gid, uid)` | 踢人 |
| `recall(messageId)` | 撤回 |
| `setCard(gid, uid, card)` / `setTitle(gid, uid, title)` | 名片 / 头衔 |
| `wholeBan(gid, enable)` / `setAdmin(gid, uid, enable)` | 全体禁言 / 设管理 |
| `setNotice(gid, content)` / `getNotice(gid)` | 群公告（动作名兜底） |
| `getLoginInfo()` | 机器人自己的 QQ 号 / 昵称 |
| `heartbeat(opts)` | 协议端在线状态（带缓存） |
| `probe()` | 底层探测（含实现名与版本） |
| `raw(action, params)` | 逃生舱：直接调原始动作（如 SnowLuma 的空间扩展接口） |

`ctx.onebot(action, params)` 仍然保留（低层逃生舱），但**新插件请用 `ctx.bridge`**。

错误统一分 5 类（`classifyError`），插件想判断可以 import：

| 类型 | 含义 | 典型处理 |
| --- | --- | --- |
| `offline` | 连不上协议端 | 提示检查协议端是否启动 |
| `auth` | 401/403 | 提示填 AccessToken |
| `timeout` | 超时（默认 20 秒，可配 `timeoutMs`） | 提示协议端卡住/地址不对 |
| `unsupported` | 动作名不被支持 | 适配层会自动换名字 |
| `business` | 业务失败（群号不存在等） | 原样把 `wording` 给用户看 |

## 换协议端要做什么

1. 装好新协议端，开启 HTTP 接口、记下端口和 token
2. 网页 →「连接设置」→ 协议端选对应名字（或"其他"）→ 填地址和 token
3. 点「刷新」，左侧「协议端 · xxx」变绿，下面会显示「昵称 · QQ 号 · 心跳」即可
4. **不需要重启 DSH** —— 配置每次调用都会重读

> 只有一种情况要重启 DSH：你改了 `mcp-server.mjs` 的代码。改配置不用。

## 自测

```bash
node scripts/test-bridge.mjs      # 适配层 19 项：3 种响应格式 / 3 种鉴权 / 动作名兜底+记忆 /
                                  # 错误分类 5 类 / 登录信息 / 心跳在线离线 / 路径前缀 / 超时
node scripts/verify-plugins.mjs   # 全部 84 个工具（不碰真实 QQ）
```

`test-bridge.mjs` 会起本地假服务器，不需要真的 QQ 账号，也不会往真实群里发东西。

### 怎么补一条实测记录

1. `cp config.example.json config.json`，填好新协议端的地址和 token
2. `node scripts/doctor.mjs` —— 先确认「② 协议端身份」认出了正确实现名和 QQ 号
3. `node scripts/test-bridge.mjs` —— 确认适配层行为没退化
4. 在**征得群主同意**的前提下，挑一个自己的小群试一次发言 / 一次公告
5. 把上面的「实测记录」表补一行，并改「支持哪些实现」里对应那行的实测状态
