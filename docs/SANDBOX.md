# 插件运行时沙箱

插件是第三方代码。一条群消息或一次 AI 工具调用就会执行它，所以不能让它在市场进程里
想干什么干什么。

以前这里的说法是「权限是声明 + 安装前二次确认」——那只管住「你不知道它要干什么」，
管不住「它真去干了」。现在换成：**插件跑在独立子进程里，用 Node 的权限模型从内核层面
压住能力**，然后由父进程按 `pluginId` 校验后替它做允许的事。

---

## 一、怎么做的

一次工具调用/一条消息触发的完整路径：

```
市场进程 (父子)
  │  1. 读该插件的数据 data/store/<id>/，随任务一起下发
  │  2. spawn(node --permission --allow-fs-read=... sandbox-runner.mjs)
  ├──────────────► 子进程
  │                  import 插件 → 调 tool.run() / handler.run()
  │                  ├─ 要发消息？ ctx.onebot / api.reply  ──┐
  │                  ├─ 要存数据？ storage() 走内存         │  IPC
  │◄────────────────────────────────────────────────────────┘
  │  3. 父进程执行：调 OneBot、发消息、落盘（校验 pluginId）
  │  4. 子进程退出，脏数据回传后由父进程写盘
  ▼
调用方拿到结果
```

### 子进程的权限（`scripts/lib/sandbox.mjs`）

启动参数由 `permissionArgs()` 生成，默认只有读：

```
--permission
--allow-fs-read=<hub>/plugins          # 读得到插件代码
--allow-fs-read=<hub>/scripts/lib      # 读得到共享库与执行器
--allow-fs-read=<执行器所在目录>
```

- **没有任何 `--allow-fs-write`**：哪怕在 `meta.permissions` 里声明了 `file:write` 也不给。
- **`--allow-child-process` 只在权限表扫出 `exec` 时才加**。当前 47 个插件没有一个需要。
- `--allow-worker`、`--allow-addons` 一律不加。

顺带堵住的两条侧门：

- 子进程的环境变量里，名字带 `SECRET` / `PASSPHRASE` / `TOKEN` / `PASSWORD` / `API_KEY`
  的全部删掉（`childEnv()`）。
- 传给子进程的配置先剥掉 `secrets` 段（`sanitizeConfig()`）。密钥文件在 `data/` 下，
  本来就不在可读列表里。

> 踩过的坑：父进程的 `NODE_OPTIONS` 可能带着 `--require=.../shim.cjs` 注入，
> 沙箱里读不到那个文件会直接 `ERR_ACCESS_DENIED` 起不来。`cleanNodeOptions()` 会剔除
> `--require` / `--import` / `--loader`，保留其他选项。

### 插件存数据怎么办

插件的 `storage()` 是**同步 API**（`get` / `set` / `update`），跨进程做异步 IPC 会逼着
47 个插件全改写。所以反过来做：

1. 父进程把该插件的数据整个读出来，随任务下发；
2. 子进程里 `_lib.mjs` 检测到 `__QQBOT_SANDBOX__`，`storage()` 切成内存实现，读写都是同步的；
3. 执行完把脏数据回传，父进程校验 `pluginId` 后写进 `data/store/<pluginId>/`。

插件代码一行没改。子进程里没有写权限，跨插件的读写会被直接拒绝：

```
沙箱拒绝：evil-store 的进程不能访问 other-plugin 的数据
```

---

## 二、实测拦住了什么

`node scripts/test-sandbox.mjs`（25 项）在临时目录里造恶意插件来验证：

| 插件试图做的事 | 结果 |
|---|---|
| `fs.writeFileSync('pwned.txt')` | `ERR_ACCESS_DENIED`，文件没被创建 |
| `execSync('echo hacked')` | 拒绝（未声明 `exec`） |
| 读 `config.json` 里的密钥密文 | 拒绝（不在可读列表） |
| `storage('other-plugin')` | 拒绝（跨插件） |
| `while(true){}` | 超时强杀，父进程不受影响 |
| `process.exit(9)` | 捕获为「插件进程意外退出」，本次调用失败，宿主存活 |
| 抛异常 | 只影响这一次调用 |
| `pluginId = '../evil'` | 两处都拒绝（启动参数校验 + 落盘路径校验） |

76 个真实工具在沙箱里跑一遍（`node scripts/verify-plugins.mjs`，默认就是沙箱模式）：
**0 项失败**。

---

## 三、没拦住什么（别把它当铁桶）

写在这里，免得以后有人以为它能顶住一切：

- **网络**。Node 的权限模型目前不管 `net` / `fetch`，网络仍属代码层约束。插件要联网发数据，
  这套沙箱拦不住。真要防，得上容器或系统级防火墙。
- **CPU / 内存**。只做了单次调用超时（默认 20~25 秒）强杀，没有做整体配额。
  多个插件同时跑会抢资源。
- **逻辑漏洞**。插件在它被允许的能力范围内做的事（发消息、调 OneBot、写自己的数据）
  不会被审查。比如它能往群里刷屏——那是权限内的事。
- **供应链**。没有代码签名，审核靠人看。
- **本地运行时**。子进程用的是同一个 Node，插件若发现 Node 权限模型的绕过方式，
  边界就破了。这依赖 Node 自身的实现质量。

---

## 四、性能与开关

每次调用起一个短命进程，实测 **90~130ms**（Node 启动 + import 插件）。

- `QQBOT_SANDBOX=0`：临时退回进程内执行，用来排查「到底是插件坏了还是沙箱配置不对」。
  默认开。
- `QQBOT_VERIFY_MODE=inline`：只影响 `verify-plugins.mjs`，让它不进沙箱。

注意 `data/store` 重定向：沙箱的 `readStore` / `writeStore` 也认 `QQBOT_STORE`，
和 `_lib.mjs` 保持一致——自动化测试靠它把数据写到临时目录，不污染真实数据。

---

## 五、权限表从哪来

不是手写的，是 `node scripts/build-permissions.mjs` 静态扫描 `plugins/*.mjs` 生成
`data/catalog/permissions.json`（手写必漂移）。沙箱启动时的能力开关就读这份：

```js
permsFor(hubRoot, pluginId)   // 扫描结果 ∪ 插件自声明
```

读不到权限表就按「什么都没声明」处理——权限只会更少，不会更多。
