# 插件上架：提交 → 审核 → 落地

这份文档讲的是**第三方插件怎么进市场**，以及这个流程**不做什么**。

## 一、先说边界

| 它是什么 | 它不是什么 |
|---|---|
| 单机/小团队的登记流程 | 多用户系统：没有账号、没有角色、没有权限分级 |
| 拦「明显不合格」的提交 | 防恶意投毒：没有代码签名、没有可信度评分 |
| 审核通过后真的落盘能用 | 权限声明本身只是声明；真正拦住越权的是运行时沙箱（子进程 + Node 权限模型） |

上面右列的东西都需要额外工程（身份体系、签名链、进程隔离），**当前没有，也不假装有**。
插件运行时的沙箱在 [SANDBOX.md](SANDBOX.md) 里单独写了一份。
如果你要对外开一个公共市场，这套只能当起点，不能当终态。

## 二、完整的四条路径

### 1. 提交

页面：插件市场 → 插件上架 → 「提交新插件」

```bash
curl -X POST http://127.0.0.1:3210/api/registry/submit \
  -H 'Content-Type: application/json' \
  -d '{
    "pluginId": "word-count",
    "name": "字数统计",
    "version": "1.0.0",
    "author": "你的名字",
    "category": "工具",
    "description": "统计一段文字的字数和中文占比",
    "permissions": [],
    "code": "export default { meta: {...}, tools: [...] }"
  }'
```

提交时就会做三件事，不合格**当场退回**，不让你等到审核：

1. **字段校验** —— id 规则、三段式版本号、必填项，一次把问题全列出来（不是只报第一个）
2. **语法校验** —— 真跑 `node --check`，不是正则猜
3. **敏感权限说明** —— 勾了 `exec` / `file:write` / `message:send`，简介必须写清用途

返回值：`{ ok: true, id: "sub-...", status: "pending", detail: "已提交 xxx@1.0.0，等审核" }`

### 2. 审核

页面：「通过」/「拒绝」按钮。拒绝**必须写原因**（会存下来给作者看）。

```bash
# 通过
curl -X POST http://127.0.0.1:3210/api/registry/review \
  -H 'Content-Type: application/json' \
  -d '{"id":"sub-xxx","action":"approve","note":"没问题"}'

# 拒绝
curl -X POST http://127.0.0.1:3210/api/registry/review \
  -H 'Content-Type: application/json' \
  -d '{"id":"sub-xxx","action":"reject","note":"简介没说清用途"}'
```

**通过 ≠ 改个状态字段。** 通过时会依次做：

1. `plugins/<pluginId>.mjs` 写入代码（文件已存在且没勾「允许覆盖」→ 直接失败，不静默覆盖）
2. `data/catalog/plugins.json` 登记条目（`origin: "submitted"`，带版本号）
3. 重建权限表（`scripts/build-permissions.mjs`）

第 3 步很关键：不重建的话，新插件在市场里**没有权限标注**，用户点安装就不会看到二次确认 —— 等于绕过安全提示。

任何一步失败，状态**不会**变成 approved（避免出现「显示已上架但市场里没有」）。

### 3. 落地后发生什么

- 市场 `/api/list` 立刻能看到（不用重启服务）
- 消息路由会重新加载 handler（新插件的消息处理器立即生效）
- 安装流程和本平台插件完全一样

没提交代码的会被标成「只登记」，通过后**不会**出现在市场里 —— 这是设计，不是 bug。

### 4. 版本

同一个 `pluginId` 再提交一次、换个版本号，就是新版本：

```bash
curl 'http://127.0.0.1:3210/api/registry/versions?pluginId=word-count'
```

返回：

```json
{
  "pluginId": "word-count",
  "live": "1.0.0",
  "items": [
    { "version": "1.0.0", "status": "approved", "changelog": "首个版本", "submittedAt": "..." },
    { "version": "1.1.0", "status": "pending",  "changelog": "修了个小问题", "submittedAt": "..." }
  ]
}
```

`live` 是**最后一个通过审核的版本**。新版未审完时，线上仍是旧版 —— 页面上会同时显示这两个数字。

## 三、接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/registry?status=pending` | 提交列表（**不返回代码正文**，几百 KB 会拖死页面，只给 `codeSize`） |
| GET | `/api/registry/item?id=xxx` | 单条详情（含代码，给详情弹窗用） |
| GET | `/api/registry/versions?pluginId=xxx` | 版本历史 + 当前线上版本 |
| POST | `/api/registry/submit` | 提交 |
| POST | `/api/registry/review` | 审核（`approve` / `reject`） |

## 四、数据在哪

```
data/state/registry.json     提交记录与审核状态（运行时数据，已在 .gitignore 里）
plugins/<pluginId>.mjs       审核通过后落地的代码
data/catalog/plugins.json    市场目录（通过后自动登记）
data/catalog/permissions.json 权限表（通过后自动重建）
```

`registry.json` 里的代码正文是完整保存的 —— 审核时能看到原始提交，不会因为后来改了文件就丢失。

## 五、自测

```bash
node scripts/test-registry.mjs
```

46 项，**在临时目录里跑完整的「提交 → 拒绝 → 通过 → 文件落盘 → 市场登记 → 版本历史」**，
用 `QQBOT_REGISTRY_FILE` / `QQBOT_PLUGINS_JSON` / `QQBOT_PLUGIN_DIR` 把路径指到临时目录，
不会污染真实 `plugins/`。只测返回值不测文件，等于没测「审核通过到底做了什么」。

## 六、已知不足

| 不足 | 影响 | 补它需要什么 |
|---|---|---|
| 没有身份认证 | 任何能打开页面的人都能提交/审核 | 账号体系 + 会话 |
| 没有代码审查工具 | 恶意代码只能靠人眼看 | 静态分析、依赖扫描 |
| 没有沙箱 | ~~插件与市场同进程，能读写任何本机文件~~（已修：见 [SANDBOX.md](SANDBOX.md)） | 已做：子进程 + 能力白名单 |
| 没有版本回滚 | 新版本装坏了只能手动改回 | 保留历史文件 + 一键回退 |
| 没有签名 | 无法确认「这是作者本人发的」 | 密钥对 + 发布签名 |
