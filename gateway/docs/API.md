# memory-core 接口契约（实测版）

> 所有示例都在 Windows + Python 3.12 + memory-core 0.1.0 上真实跑通过。
> 服务地址默认 `http://127.0.0.1:8780`，鉴权头 `Authorization: Bearer <MEMORY_TOKEN>`。

---

## 启动

```bash
cd memory-core
python -m venv .venv && .venv/Scripts/pip install .
MEMORY_DB=./data/brain.db \
MEMORY_TOKEN=local-token \
MEMORY_LLM_BASE=https://api.deepseek.com/v1 \
MEMORY_LLM_KEY=sk-xxx \
MEMORY_LLM_MODEL=deepseek-chat \
.venv/Scripts/python.exe -m memory_core.server
```

| 环境变量 | 必需 | 说明 |
| --- | --- | --- |
| `MEMORY_DB` | 否 | SQLite 路径，默认 `./data/brain.db` |
| `MEMORY_TOKEN` | **是**（对外时） | 不带会被 401 |
| `MEMORY_HOST` / `MEMORY_PORT` | 否 | 默认 `127.0.0.1:8780` |
| `MEMORY_LLM_BASE` / `_KEY` / `_MODEL` | 否 | 不配则 `/v1` 代理和实体抽取不可用 |
| `MEMORY_EMBED_URL` | 否 | 如 Ollama `http://127.0.0.1:11434/api/embed`；不配走纯关键词 |

---

## 1. GET /health

```bash
curl -H "Authorization: Bearer local-token" http://127.0.0.1:8780/health
```

```json
{"status":"ok","report":"【记忆体检】\n记忆 4 条（归档 0），实体 0，关系 0\n重复（≥0.92）：0 组\n没有实体的记忆：4 条（如 #1）\n低价值旧事实：0 条\n未处理冲突：0 组\n跨可见性相似（≥0.85）：0 组"}
```

> 不带 token 返回 401 `{"status":"error","message":"unauthorized"}`。
> `实体 0` 说明没配 LLM：实体抽取是模型做的。

---

## 2. POST /remember

```json
{
  "text": "他养了一只叫团子的橘猫，很粘人",
  "kind": "fact",              // episode | fact | preference | relation | skill
  "importance": 0.8,           // 0~1
  "visibility": "public"       // public | private | group
}
```

响应：`{"status":"ok","data":{"id":1}}`

可选字段：`valence`（-1~1 情绪）、`arousal`（0~1 强度）、`meta`（任意 JSON）、`entities`、`relations`。

> ⚠️ 必须用 UTF-8 发（`Content-Type: application/json; charset=utf-8`）。
> Git Bash + Windows 控制台直接 `curl -d '中文'` 会按 GBK 发送，服务端报
> `'utf-8' codec can't decode byte ...`。把 JSON 写成文件再 `--data-binary @file.json` 即可。

---

## 3. POST /recall

```json
{
  "query": "团子",
  "k": 5,
  "visibility": ["public", "private", "group"],
  "mood_valence": 0.0          // 可选：心情，影响情绪一致性打分
}
```

响应：

```json
{
  "status": "ok",
  "data": {
    "hits": [
      {"id":1,"text":"他养了一只叫团子的橘猫，很粘人","kind":"fact","score":0.682,
       "importance":0.8,"visibility":"public","created_at":1793413066.1}
    ],
    "block": "1. [2026-10-31] 他养了一只叫团子的橘猫，很粘人"
  }
}
```

要点：

- **`block` 可直接拼进 system prompt**（这就是代理模式的注入内容）
- **`hits` 不含 `meta`** —— 所以外部拿不到写入时带的 meta，只能靠文本前缀做归属标记
- **`visibility` 是白名单**：传 `["group"]` 只会返回标记为 group 的记忆；群里应传 `["public","group"]`
- **没有分数下限**：`k=5` 就返回 5 条（哪怕分数 0.2），需要自己加门槛

---

## 4. GET /stats

```json
{"status":"ok","data":{"active":4,"archived":0,"entities":0,"relations":0,"vectors":0,
 "oldest":1793413066.16,"kinds":{"episode":1,"fact":2,"preference":1},"avg_importance":0.675}}
```

---

## 5. POST /v1/chat/completions（OpenAI 兼容）

```json
{
  "user": "qq:10001",                 // 必填，否则 400
  "model": "memory-core",
  "messages": [{"role":"user","content":"团子最近怎么样"}]
}
```

它做的事：取最后一条 user 消息 → `/recall` → 拼一条 system 注入 → 转发给 `MEMORY_LLM_BASE` → 返回上游响应。

实测上游收到的请求：

```
[0] system: 以下是你记得的旧事，用来接话，不要逐条复述：
            1. [2026-10-31] 他最近在读《三体》，读到第二部了
            2. [2026-10-31] 他养了一只叫团子的橘猫，很粘人
[1] user:   团子最近怎么样
```

错误示例：

| 情况 | 响应 |
| --- | --- |
| 不带 user | 400 `必须带 user 字段（或 user_id / session_id），避免不同用户共用 default 记忆` |
| 没配 LLM | `{"status":"error","message":"没有配置 MEMORY_LLM_BASE"}` |

> 注意：`user` 只用于原始消息落库和提醒，**不参与 recall 过滤**——记忆仍是全库共享。
> 这正是需要外面加网关的原因。

---

## 6. 其他可用端点

| 端点 | 用途 |
| --- | --- |
| `GET /panel` | 可视化面板（力导向图、评估页 `#eval`） |
| `GET /graph` | 图谱数据 |
| `GET /conflicts` | 冲突列表 |
| `POST /decay` | 手动跑一次衰减 |
| `POST /archive` | 手动归档 |
| `POST /maintenance/run` | 跑维护 |
| `POST /digest/extract` `/digest/reflect` `/digest/profile` | 日档提炼 / 反思 / 人物画像 |
| `GET /life/state` | 自主生活循环状态 |
| `GET /reminders/due` | 到期提醒 |

---

## 7. 数据模型（SQLite）

```sql
memories(id, kind, text, importance, valence, arousal,
         created_at, last_access, access_count, status, source, meta,
         visibility, archived_at)          -- 注意：没有 user_id
memories_fts(tokens)                        -- FTS5，字符二元组（中文不分词）
vectors(memory_id, dim, vec BLOB)           -- 可选
entities(id, name, type, mention_count, first_seen, last_seen, aliases)
memory_entities(memory_id, entity_id, weight)
relations(src, dst, relation, weight, memory_id, created_at)
episodes_raw(session_id, msg_id, role, sender, text, created_at)
```

打分（`engine.py`，实测权重）：

```
0.18 语义 + 0.46 关键词 + 0.14 重要性 + 0.11 新鲜度(半衰期14天) + 0.11 图谱
```

`kind` 五类：`episode` / `fact` / `preference` / `relation` / `skill`。

---

## 8. 已知行为（不是 bug，但要知道）

1. **全库共享**：没有 user 维度，多人会串；靠外面前缀标签 + 过滤解决。
2. **无分数门槛**：`k` 是硬条数，低分也会返回。
3. **常用词干扰**：没有停用词/IDF，`最近/怎么样` 这类词能压过实词。
4. **实体抽取依赖 LLM**：不配 `MEMORY_LLM_*` → `entities` 恒为 0，图谱那一路失效。
5. **问句也会被记住**（如果走 `/v1` 自动记忆）→ 网关里已加过滤。
