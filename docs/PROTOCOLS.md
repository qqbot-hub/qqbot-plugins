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

## 已验证支持的实现

| 协议端 | 默认 HTTP 端口 | 鉴权习惯 | 备注 |
| --- | --- | --- | --- |
| **SnowLuma** | 3000 | `Authorization: Bearer` | 本项目的参考环境（WS 3001） |
| **NapCatQQ** | 3000 | `Authorization: Bearer` | 部分版本用 `?access_token=` |
| **LLOneBot** | 3000 | `Authorization: Bearer` | |
| **Lagrange.OneBot** | 8080（可配） | `Authorization: Bearer` | 端口常被改，按实际填 |
| **go-cqhttp** | 5700 | `Authorization: Bearer` | 老项目，仍可用 |
| 其他 OneBot v11 | 自定义 | 三选一 | 只要实现标准动作就行 |

配置在网页「连接设置 → 协议端」里，选哪个只是帮你**预填端口和鉴权方式**，填错了也能手动改。

## 适配层做了什么

三种差异都在 `plugins/_bridge.mjs` 里吃掉了：

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

### ③ 动作名差异

绝大多数动作是标准名。已知有差异的是**群公告**，适配层按顺序尝试：

```
_send_group_notice → send_group_notice → set_group_notice
```

第一个不通就换下一个，全不通才报「当前协议端不支持发群公告」。

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
| `setNotice(gid, content)` | 群公告（动作名兜底） |
| `raw(action, params)` | 逃生舱：直接调原始动作（如 SnowLuma 的空间扩展接口） |
| `probe()` | 探测协议端身份 |

`ctx.onebot(action, params)` 仍然保留（低层逃生舱），但**新插件请用 `ctx.bridge`**。

## 换协议端要做什么

1. 装好新协议端，开启 HTTP 接口、记下端口和 token
2. 网页 →「连接设置」→ 协议端选对应名字（或"其他"）→ 填地址和 token
3. 点「刷新」，左侧「协议端 · xxx」变绿即可
4. **不需要重启 DSH** —— 配置每次调用都会重读

> 只有一种情况要重启 DSH：你改了 `mcp-server.mjs` 的代码。改配置不用。

## 自测

```bash
node scripts/test-bridge.mjs      # 适配层：3 种响应格式 / 3 种鉴权 / 错误提示 / 动作兜底
node scripts/verify-plugins.mjs   # 全部插件
```

`test-bridge.mjs` 会起本地假服务器，不需要真的 QQ 账号。
