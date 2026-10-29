# 跨部署方法装插件：三个生态，三种装法

市场里那 40 多个插件是**本平台自己的插件**（JS，跑在沙箱子进程里，见 [SANDBOX.md](SANDBOX.md)）。
但用户如果部署的是 AstrBot / NoneBot / Koishi，他想装的是**那些生态的插件** ——
这两件事完全不同，混在一起做就会出现「显示装好了，实际没生效」。

这里把三条生态的装法写清楚：装到哪、改哪个文件、怎么确认真的加载了。

| 生态 | 插件形态 | 装到哪 | 怎么被发现 | recipe |
|---|---|---|---|---|
| Koishi | npm 包 | `runtimes/koishi/node_modules` | `koishi.yml` 的 `plugins:` 段 | `recipes/koishi-plugin.mjs` |
| NoneBot | PyPI 包 | `runtimes/nonebot/.venv` | `pyproject.toml` 的 `[tool.nonebot] plugins` | `recipes/nonebot-plugin.mjs` |
| AstrBot | 目录（含 metadata.yaml） | `runtimes/astrbot/data/plugins/<名>` | 启动时扫描目录 | `recipes/astrbot-plugin.mjs` |

---

## NoneBot（已本机实测）

```bash
node scripts/installer.mjs run nonebot-plugin --package=nonebot-plugin-apscheduler
node scripts/installer.mjs run nonebot-plugin --package=nonebot-plugin-apscheduler --action=remove
```

七个步骤：检查 venv → 查 PyPI（镜像→官方回退）→ pip 装 → **解析真实 import 名** →
写清单 → 重启并查日志 → 登记。

### 三个真实踩过的坑（都不是理论问题）

1. **pip 包名 ≠ import 名**。`nonebot-plugin-apscheduler` 的 import 名是
   `nonebot_plugin_apscheduler`，但不是所有包都这么规整。所以脚本用
   `pip show -f` 列出的真实文件路径反推顶层包名，而不是按命名规则猜。
   *顺带踩到：Windows 上 `pip show -f` 用反斜杠分隔路径（`nonebot_plugin_x\__init__.py`），
   Linux 用正斜杠 —— 只认 `/` 的话在 Windows 上会解析不出来。*

2. **老部署的 `bot.py` 根本不读插件清单**。早期版本生成的 `bot.py` 是「注册适配器 → run()」，
   里面没有任何 `load_*` 调用。这种运行时就算 pip 装了插件、清单也写了，NoneBot 依然不会加载它。
   现在安装插件时会检查并就地补上：

   ```python
   if os.path.exists("pyproject.toml"):
       nonebot.load_from_toml("pyproject.toml")
   ```

   不需要为了装一个插件重跑整条部署。

3. **端口起来 ≠ 插件装好了**。NoneBot 对插件加载异常是**吞掉并继续**的：打一段 traceback，
   进程照常启动，其它插件照常加载。所以判定必须看日志里有没有
   `Succeeded to load plugin "<模块名>"`；只探端口会把一个报错的插件报成成功。
   实测就遇到一个：`nonebot-plugin-hammer-nbnhhsh` 用 `from pydantic import BaseSettings`，
   而 NoneBot 2.5 自带 pydantic 2，直接 `PydanticImportError`。
   现在这种情况会明确报「真实报错 + 这类问题通常是版本不兼容」，并**自动把它从启动清单撤下**，
   免得每次启动都往日志里灌 traceback。

### 验证方式

```bash
grep "Succeeded to load plugin" runtimes/nonebot/nonebot.log
cat runtimes/nonebot/pyproject.toml      # 看 plugins 数组
cat data/state/nonebotPlugins.json       # 看本平台登记（含 broken 状态与原因）
```

---

## AstrBot（已本机实测）

```bash
node scripts/installer.mjs run astrbot-plugin --repo=https://github.com/作者/插件仓库
node scripts/installer.mjs run astrbot-plugin --repo=... --action=remove
```

AstrBot 的插件是目录型：`data/plugins/<目录名>/{main.py, metadata.yaml}`。
装法就是浅克隆仓库到那个目录（和 AstrBot 自己的 `_PluginUpdater` 一样：
`git clone --depth 1 --single-branch --no-tags`，装完删掉 `.git`）。

**元数据校验**不是可选项 —— AstrBot 源码里写死了必需字段：

```python
# astrbot/core/star/updater.py
PLUGIN_METADATA_REQUIRED_FIELDS = ("name", "desc", "version", "author")
```

少一个就会被抛「插件元数据校验失败」。所以脚本在装完立刻自己校一遍，不合格直接报错，
不让你到 WebUI 里才发现装了个废的。

实测记录（AstrBot 4.29.3 + 官方示例插件 `Soulter/helloworld`）：

- `metadata.yaml` 里是**行内注释**写法（`name: helloworld # 插件唯一识别名`），
  解析时必须剥掉注释，否则插件名会变成「helloworld # 插件唯一识别名」
- 版本号作者常写成 `v1.3.0`，再拼一个 `v` 就成了 `vv1.3.0`，要判重
- 日志判定用 `Loading plugin <目录名>`（AstrBot 的成功日志是
  `star.star_manager: Loading plugin xxx ...`），配合 `Failed to import plugin` 排除

### 三个环境层面的坑（都是本机真实撞上的）

1. **首次启动要下载 WebUI**（约 5MB，`astrbot-registry.soulter.top`）。
   本机网速只有 60KB/s，AstrBot 自己下载中途断了，于是启动直接失败。
   解决：手动把 `dist.zip` 解压到 `data/dist`（里面要带 `assets/version`），
   之后启动就认得这份资产、不再下载。

2. **WebUI 默认绑 `0.0.0.0:6185`**，本机正好有别的程序占着这个 IP:端口
   （`netstat` 能看到 CLOSE_WAIT），于是 `PermissionError: [WinError 10013]`。
   解决：`data/cmd_config.json` 里把 `dashboard.host` 改成 `127.0.0.1`。

3. **不能用 `spawn(detached)` 启 AstrBot**。Windows 上它和安装器共享 console，
   安装器一退出，AstrBot 跟着退（现象：起来了，十几秒后 6185 就没了）。
   现在改成写一个 `_run_astrbot.cmd` 再用 `cmd /c start "" /b` 拉起，进程能活下来。
   *另一个坑：用 `ctx.exec` 调 `start /b` 会让子进程继承管道，导致安装命令永不返回
   （实测被 SIGTERM）——必须用 `stdio: 'ignore'`。*

### 验证方式

```bash
grep "Loading plugin" runtimes/astrbot/astrbot.log
ls runtimes/astrbot/data/plugins/
curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" http://127.0.0.1:6185/
```

实测结论：通过**服务端**（网页点安装 → 常驻进程内跑 installer）触发时，AstrBot 稳定常驻
并加载插件（6185 返回 200、日志有 `Loading plugin helloworld`）；
用一次性 CLI 命令触发时，进程会随命令会话被清理 —— 这是终端的进程树清理行为，
不是安装逻辑的问题，日常使用请走网页。

### 本机 git 的一个坑

这台机器的 git 走 schannel，`git clone` 会报
`CRYPT_E_NO_REVOCATION_CHECK`（证书吊销列表检查失败），而 `-c http.schannelCheckRevoke=false`
也没用。可用的是 `GIT_SSL_NO_VERIFY=1` / `-c http.sslVerify=false`。
脚本的处理是：先正常克隆，**只有报错属于证书/TLS 类**才降级重试一次
（仓库不存在之类的错误不会重试，避免把「地址写错」拖成两次超时）。

---

## Koishi（已本机实测）

```bash
node scripts/installer.mjs run koishi-plugin --package=koishi-plugin-dataview
```

npm 装进 `runtimes/koishi`，然后往 `koishi.yml` 的 `plugins:` 段**只追加一行**，
不动用户已有配置；重启后用控制台是否稳定 + 日志里有没有 `apply plugin <key>` 双重确认。

已知：`@koishijs/plugin-adapter-onebot@6` 与 Koishi 4.18 的 `@satorijs/core` 版本冲突，
所以固定装 5.x。

---

## 三条生态的共同原则

1. **装完必须验证「真的被加载」**，不是「命令返回 0」
2. **失败要在用户的配置里留干净状态**（撤清单、登记 broken），不留每次启动都报错的残骸
3. **UI 上标清楚哪个是真的验证过**：`verified: false` 的方法不会写成「一键可用」

---

## 把生态插件摆进市场：目录从哪来

「市场里能看到 AstrBot 插件」这件事，前提是**真的去抓了别人的商店**，不是拿几个名字编条目。

`scripts/sync-ecosystem.mjs` → `data/sources/ecosystem.json`，三个源三种形状：

| 源 | 地址 | 拿到什么 | 本机实测 |
|---|---|---|---|
| NoneBot | `registry.nonebot.dev/plugins.json` | 947 条，过滤 `valid:false` 后 **619** | ✅ 直接可用，字段最规整 |
| AstrBot | GitHub `search/repositories?q=topic:astrbot-plugin` | **300** 条（按 star 排序，取前 3 页） | ✅ 需要放宽 TLS（见下） |
| Koishi | `registry.npmmirror.com/-/v1/search?text=koishi-plugin` | **455** 条 | ✅ npm 官方搜索接口 |

合计 **1368 条**，每条都归一化成同一个结构（`id / name / description / category / author /
framework / version / homepage / install{target,params} / needsMethod`）。

`install` 是**真参数**：点「安装」直接交给 `recipes/nonebot-plugin.mjs` 之类，不是假按钮。
`needsMethod` 说明得先有哪个框架的运行时 —— 原生插件装不进别的地方，这一点在卡片上明写。

### 两个抓取时踩到的真问题

**1. GitHub API 在这台机器上 `fetch failed`**

不是墙的问题：`git clone` 能过（之前用 `GIT_SSL_NO_VERIFY=1`），Node 的 fetch 直连报
`fetch failed`。原因是本机 schannel 的证书吊销检查（OCSP/CRL）拿不到结果。

处理方式**不是全局关校验**：`scripts/lib/ecosystem.mjs` 里先正常请求，**只在失败且错误像证书问题时**
才设 `NODE_TLS_REJECT_UNAUTHORIZED=0` 重试一次，并打印一行提示。DNS 错、超时不走这条路
（那些重试也没用，还会掩盖真问题）。

**2. 关键词分类不能按前缀匹配**

第一版用 `/^(...|chat|...)/` 匹配 tags，结果 Koishi 插件里泛滥的 `chatbot` 全被算成 AI ——
**436 条误分类**。改成：关键词按 `-` `_` 空格拆成词，**逐词整词匹配**。
`ai-chat` 拆出 `ai` 能命中，`chatbot` 拆完还是 `chatbot` 不命中。重新统计后 AI 类 179 条、
「工具」还剩 6 条，符合直觉。

分类统计不再靠猜，`node scripts/sync-ecosystem.mjs --status` 直接打印各框架条数。

---

## 已装插件的更新检查

`GET /api/plugin/updates` → `scripts/lib/updates.mjs`

| 生态 | 最新版从哪查 |
|---|---|
| NoneBot | PyPI JSON（清华镜像 → 阿里云 → 官方，三级回退） |
| Koishi | `registry.npmmirror.com/<pkg>/latest` |
| AstrBot | GitHub `releases/latest`，没有 release 就翻 `tags` |

**三种状态必须分清**：`update` / `latest` / `unknown`（带原因）。
查不到就是查不到，绝不写成「已是最新」—— 那是最容易骗过自己的一种假成功。

本机实测（4 个已装插件）：

```
astrbot  helloworld                     1.3.0 → (查不到)  unknown  仓库没有 release 也没有版本 tag
koishi   koishi-plugin-dataview         2.7.8 → 2.7.8     latest
nonebot  nonebot-plugin-apscheduler     0.5.0 → 0.5.0     latest
nonebot  nonebot-plugin-hammer-nbnhhsh  1.0.0 → 1.0.0     latest
```

### 更新为什么不能只是"重装一遍"

`pip install` / `npm install` 本身幂等，问题在于**后面那步重启**：重启一次 NoneBot/Koishi，
群里的对话会断一次。如果版本根本没变，让用户承担这个代价是没道理的。

所以三个 recipe 都在 `check` 阶段算出 `upToDate`：

- NoneBot：`pip show` 读 venv 里的真实版本（不是我们记的账）
- Koishi：读 `node_modules/<pkg>/package.json`
- 已是最新 → 装、启用、重启**全部 skip**，日志明确写「已是 v0.5.0（最新版），不重启 NoneBot」

实测：对 `nonebot-plugin-apscheduler@0.5.0` 跑 `--action=update`，6 步里 3 步 skip，进程没被碰。

AstrBot 是目录型插件，没有注册表版本可比，所以「更新」= 重新拉一次仓库；
`check` 阶段会明确提示「插件目录里的本地改动会丢」，不藏这个代价。

---

## AstrBot 的三个环境坑（本机实测，都不是理论）

### 1. 6185 被 QQNT 自己占着

AstrBot 的 dashboard 默认端口 `6185`，和**桌面版 QQ（QQNT）**用的端口撞了。
`netstat` 里长这样：

```
TCP  0.0.0.0:6185  ...  BOUND  24980   ← QQ.exe
```

注意状态是 **BOUND 不是 LISTEN**。这种占位有两个后果：

- `connect` 探测显示"不通"（看起来端口是空闲的）
- 真去 `bind` 却失败 → AstrBot 启动几秒后静默退出，日志里只有正常的启动行，没有报错

所以判断端口能不能用，**必须用 bind 试**，不能用 connect 试：

```js
function canBind(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}
```

`recipes/astrbot-plugin.mjs` 现在会在启动前检查：不能 bind 就从 `6199–6218` 里挑一个，
写回 `data/cmd_config.json` 的 `dashboard.port`，并在步骤日志里说明
「6185 端口被别的程序占着（本机是 QQNT 占了 6185），已把 AstrBot WebUI 改到 6199」。

### 2. 判断顺序：先停旧的，再判端口

第一版写成「先判端口 → 再停旧进程」，结果：AstrBot 自己正在 6185 上跑，
`canBind(6185)` 必然失败 → 被当成"别人占了" → 每跑一次更新就换一个端口，端口号一路往上漂。

正确顺序：

```
1. 读配置里的端口 → 按这个端口找到并停掉旧进程
2. 停完后才 canBind 判断（此时自己已经不占了，竞争条件消失）
3. 启动 → 等起来 → 8 秒后复检一次还活着
```

实测：AstrBot 正在 6185 运行时再跑一次更新，端口保持 6185 不变，任务 6 步全 done。

### 3. 进程存活：谁来拉起它很重要

同一条「经 cmd 的 `start /b` 启动」命令：

| 触发方式 | 结果 |
|---|---|
| `node scripts/installer.mjs run astrbot-plugin`（CLI） | 起来了，但**命令一结束进程就跟着没了** |
| `POST /api/install`（常驻的市场服务进程） | 稳定存活 |

原因是 Windows 的 console 进程组：CLI 跑完退出时，它那一组的子进程会被一起收掉。
**这不是脚本写错了，是环境行为**，所以：

- 只想验证一次：用网页/接口触发，别用 CLI 起长期服务
- 要长期跑：把它做成开机启动项或 Windows 服务，别挂在某个终端窗口下
