# memory-gateway —— 记忆网关（可选组件）

> 让「大肥鱼」拥有**跨会话长期记忆**的可选进程。零依赖、Node 18+，不装任何第三方包。
> 它**不是市场的一部分**：市场服务（`server.js`）不会自动启动它，删掉这个目录市场照常运行。

```
市场  ←→  plugins/memory_bridge.mjs  ←→  memory-core:8780     （给模型三个显式工具）
桥接/DSH  ←→  gateway:8781  ←→  memory-core:8780  ←→  模型厂商  （每轮自动注入记忆）
```

两条路可以同时用，也可以只用一条：

| | 只装市场插件 `memory_bridge` | 只跑网关 | 两条都用（推荐） |
| --- | --- | --- | --- |
| 记忆每轮自动注入 | ❌ | ✅ | ✅ |
| 模型能主动回忆/记录 | ✅ `mem_recall` 等三工具 | ❌ | ✅ |
| 市场页面能看见 | ✅ 主链路直连第 8 张卡 | ❌ | ✅ |

---

## 0. 先看三条结论

1. **核心是「代理」，不是「插件」**：把调用模型的 `base_url` 指到网关（8781），每轮对话就会自动带上回忆再发给模型。市场插件只是补充。
2. **直接接记忆引擎会踩三个坑**（查询噪声 / 无用户隔离 / 无相关度门槛），网关这一层就是为它们存在的，见第 4 节。
3. **记忆引擎是 AGPL-3.0，不在本仓库里**：本目录下的代码全部是本项目重写的（MIT），但依赖的 `memory-core` 需要你另外 clone，**不要把它的 `.py` 复制进这个仓库**。

---

## 1. 目录说明

```
gateway/
├─ README.md                      ← 本文件
├─ memory-gateway.mjs             ★ 网关本体（零依赖）
├─ gateway.config.example.json      配置模板 → 复制成 gateway.config.json 后填 Key
├─ start-gateway.bat                 Windows 一键启动（双击即可）
├─ docs/API.md                    memory-core 的接口契约（实测过的请求/响应）
└─ tools/mock-upstream.mjs        离线自测用的假模型，不花钱不出网
```

> `gateway.config.json` 与 `captured-upstream.json` 已在 `.gitignore` 中排除，**不会入库**（里面有模型 Key）。

---

## 2. 部署（四步，约 10 分钟）

### 第 1 步 · 装并启动记忆引擎（AGPL，另放别处）

```bash
git clone https://github.com/peterpoal134/memory-brain.git
cd memory-brain/memory-core
python -m venv .venv
.venv/Scripts/pip install .            # Linux/macOS 用 .venv/bin/pip
```

启动（**用你自己的 DeepSeek Key**，否则实体抽取和代理都会失效）：

```bash
MEMORY_DB=./data/brain.db ^
MEMORY_TOKEN=local-token ^
MEMORY_LLM_BASE=https://api.deepseek.com/v1 ^
MEMORY_LLM_KEY=sk-你的key ^
MEMORY_LLM_MODEL=deepseek-chat ^
.venv/Scripts/python.exe -m memory_core.server
```

- 监听 `127.0.0.1:8780`，面板 `http://127.0.0.1:8780/panel`
- 依赖只有 `numpy`
- 验证：`curl -H "Authorization: Bearer local-token" http://127.0.0.1:8780/health`

> **务必把它放在本仓库之外**，理由见第 7 节。

### 第 2 步 · 启动网关

在本目录下：

```bash
cp gateway.config.example.json gateway.config.json
# 编辑 gateway.config.json：
#   upstream.apiKey  ← 你的 DeepSeek Key
#   core.token       ← 跟第 1 步的 MEMORY_TOKEN 一致（默认 local-token）
node memory-gateway.mjs --config gateway.config.json
```

Windows 也可以直接双击 `start-gateway.bat`（没有配置时会自动从模板复制一份并提示）。

- 监听 `127.0.0.1:8781`
- 验证：`curl http://127.0.0.1:8781/health` → `{"status":"ok","core":"ok",...}`

### 第 3 步 · 让桥接 / DSH 指向网关（关键一步）

| 项 | 原来 | 改成 |
| --- | --- | --- |
| base_url | `https://api.deepseek.com/v1` | `http://127.0.0.1:8781/v1` |
| api_key | 真实 Key | 随便填（Key 在网关自己手里），建议 `local` |
| model | `deepseek-chat` | 保持不变 |
| user | 需要带上 | `qq:10001`（见下） |

**必须带 `user`**，否则网关返回 400 —— 这是防止所有人的记忆混在一起：

- 私聊：`user: "qq:10001"`
- 群聊：`user: "qq:10001"` + 请求头 `x-channel: group` + `x-group: 888`

如果你的桥接没法自定义 `user` 或请求头，改 `memory-gateway.mjs` 里读 `body.user` 那一行即可。

### 第 4 步 · 装市场插件（可选）

插件已经在本仓库里了（`plugins/memory_bridge.mjs`，主链路直连第 8 张卡「🧠 记忆大脑」），
在市场页面点**安装 → 配置**：

| 配置项 | 值 |
| --- | --- |
| `coreUrl` | `http://127.0.0.1:8780` |
| `coreToken` | `local-token` |

然后重启 DSH，模型就多了三个工具：`mem_recall`（主动回忆）、`mem_remember`（主动记录）、`mem_stats`（看库存有多大）。

---

## 3. 验收清单

前置：记忆引擎在 8780，网关在 8781。

```bash
# ① 引擎活着
curl -H "Authorization: Bearer local-token" http://127.0.0.1:8780/health

# ② 网关活着
curl http://127.0.0.1:8781/health

# ③ 不带 user 应被拒（400）
curl -s -X POST http://127.0.0.1:8781/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -d "{\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"

# ④ 带 user 能正常回复
curl -s -X POST http://127.0.0.1:8781/v1/chat/completions ^
  -H "Content-Type: application/json" -H "x-channel: private" ^
  -d "{\"user\":\"qq:10001\",\"messages\":[{\"role\":\"user\",\"content\":\"我叫小明，我养了一只橘猫叫团子\"}]}"
```

**⑤ 隔一轮再问（最关键）**：再发一句「我的猫叫什么来着」，看模型答不答得出「团子」。
答不出 → 网关日志里应有 `召回 N 条`，没有就把 `debug` 开成 `true` 看清洗后的 query 和分数。

**⑥ 验证隔离**：换成 `user:"qq:22222"` 问同样的话，**不应该**答出团子。

**⑦ 离线自测**（不想花 token 时）：

```bash
node tools/mock-upstream.mjs                       # 起假模型 8799
# 把 gateway.config.json 的 upstream.baseUrl 改成 http://127.0.0.1:8799/v1
# 发一轮请求后看 captured-upstream.json —— 里面能看到注进去的记忆块
```

---

## 4. 三个坑（网关已解决，接手时不用重踩）

| 坑 | 实测现象 | 网关怎么处理 |
| --- | --- | --- |
| **查询噪声** | 问「团子最近怎么样」，先命中《三体》——「最近」命中了它的文本，真正答案排第二 | 检索前先剔掉 `记得/最近/怎么样/吗/呢/什么` 等虚词 |
| **无用户隔离** | `memories` 表没有 `user_id`，`recall` 也不接收 user，全库共享 → 群里 A 的记忆会被 B 召回 | 写入时加前缀标签 `〔u|qq:10001〕` / `〔g|888〕`，检索后按标签过滤再剥掉 |
| **无相关度门槛** | `k=5` 是硬条数，0.2 分也会塞进 prompt | 加 `minScore`（默认 0.35）+ `maxBytes`（默认 1400）双重限制 |

另外网关还做了：问句不写入（「上海那边怎么样」不是事实）、太短不写入、纯表情不写入、
**记忆引擎挂了就降级为无记忆继续聊天**（不会把机器人卡死）。

---

## 5. 参数速查（`gateway.config.json`）

| 参数 | 默认 | 说明 | 调大会怎样 |
| --- | --- | --- | --- |
| `port` / `host` | `8781` / `127.0.0.1` | 监听地址 | 改 host 会对外暴露，**不建议** |
| `core.url` / `core.token` | `http://127.0.0.1:8780` / `local-token` | 记忆引擎 | token 不一致会 401 |
| `upstream.baseUrl` / `apiKey` / `model` | deepseek | 上游模型 | 换任何 OpenAI 兼容端都行 |
| `recall.k` | 6 | 候选检索条数 | 更全但更慢 |
| `recall.minScore` | 0.35 | 相关度门槛 | 更宽松但噪声变多 |
| `recall.maxBytes` | 1400 | 注入字节上限 | 记得更多，每轮更贵 |
| `recall.maxItems` | 5 | 最多注入几条 | 同上 |
| `remember.enabled` | true | 是否自动记 | — |
| `remember.minChars` | 6 | 多短就不记 | 太小会记一堆废话 |
| `remember.importance` | 0.4 | 默认重要度 | 影响遗忘速度 |
| `debug` | false | 打印召回分数 | 排查时开 |

环境变量可以覆盖：`MG_PORT` / `MG_CORE_URL` / `MG_CORE_TOKEN` / `MG_UPSTREAM_BASE` / `MG_UPSTREAM_KEY` / `MG_UPSTREAM_MODEL`。

---

## 6. 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 网关 502 | 上游 Key 没填或网络不通 | 看 `upstream.apiKey`，curl 一下 `upstream.baseUrl` |
| `/health` 返回 `core: down` | 记忆引擎没起或端口不对 | 检查 8780、`MEMORY_TOKEN` 是否与 `core.token` 一致 |
| 一直召回 0 条 | 查询被清洗过度或门槛太高 | 开 `debug: true`；临时把 `minScore` 调到 0.2 |
| 记忆串人 | 请求没带 `user`，或标签格式被改坏 | 确认 `user` 带上；确认文本前缀是 `〔u|qq:xxx〕` |
| 中文乱码 | 客户端按 GBK 发了请求 | `Content-Type` 要写 `application/json; charset=utf-8` |
| 实体数一直是 0 | 没配 `MEMORY_LLM_*` | 配上 DeepSeek Key 后重启记忆引擎 |

---

## 7. 许可与边界（务必遵守）

| 事项 | 结论 |
| --- | --- |
| `memory-core`（memory-brain） | **AGPL-3.0**。可以运行、可以研究、可以调它的 HTTP 接口；**不要复制其 `.py` 进本仓库（MIT）** |
| 本目录的代码 | 本项目重写的零依赖实现，随本仓库 MIT 分发 |
| 数据隐私 | 记忆库是本机 SQLite（在 `memory-core/data/brain.db`），不上传；`visibility` 控制群/私聊可见性 |

**三条不要做**：

- ❌ 不要把 `memory-brain` 的 Python 源码复制进本仓库（AGPL 污染 MIT 仓库）
- ❌ 不要把 8780 / 8781 暴露到公网（只有一个 Bearer token，没有速率限制）
- ❌ 不要关掉网关的 `user` 校验（会让所有人的记忆混在一起）

---

## 8. 相关文档

| 文档 | 内容 |
| --- | --- |
| `docs/API.md` | memory-core 的接口契约：6 类端点、打分权重、数据模型、已知行为 |
| `../README.md` →「记忆 / 语音 / 画画」 | 市场自带的轻量记忆插件（`qq_memory_*`，纯 JSON，不需要网关） |
| `../docs/HANDOFF.md` | 整个市场的交接文档 |
