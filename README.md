# dsh-chat-manage

> 给 **DeepSeek Harness 桌面端**补上会话管理：右键删除对话，设置里查看 / 恢复 / 删除归档对话。

DSH 支持「归档对话」，但归档之后这些对话就再也找不到入口了——既看不到内容，也没法删除。这个插件补上两个缺口：

| 场景 | 位置 | 能力 |
| --- | --- | --- |
| 删除任意对话 | 侧边栏对话行的 `...` 菜单 → **删除对话** | 二次确认后删除，含正在查看的那一条 |
| 查看归档对话 | 设置 → **会话管理** | 搜索、批量选择、预览完整聊天记录 |
| 删除 / 恢复归档对话 | 设置 → **会话管理** | 批量删除、批量取消归档 |

删除是**真正删除**：先删磁盘上的会话工件（只删真正存在的，删完核对），再撤掉 workspace registry 里的登记引用（unpin / unarchive / detach）；如果 Host 内存里还留着这个会话，就把会话从 store 里摘掉，摘不掉才退回归档隐藏，不留点不掉的幽灵行。

## 安装

插件是普通 npm 包，通过 profile 的 `dsh.profile.bundles` 挂进桌面端。

### 官方「添加插件」输入框

设置 → 插件 → **添加插件**。输入框的标签是「包名或地址」，所以除了包名也收地址形式。往里填：

```
dsh-chat-manage                                    # 发布到 npm 之后（最稳）
github:Anixuil/dsh-chat-manage                     # 直接从仓库装
git+https://github.com/Anixuil/dsh-chat-manage.git # 完整 git 地址
```

确认弹窗里，git 类会显示成 `[git]`、URL 类显示成 `[url]`、本地路径显示成 `[path-or-other]`——那是它把来源做了脱敏，不是报错。**本包没有构建步骤**，所以走 GitHub 也不会被 pnpm 的 `allowBuilds` 卡住。本地路径（如 `D:\…\dsh-chat-manage-0.1.2.tgz`）被归到 `[path-or-other]`，官方没承诺支持，要装本地请用下面的 CLI。

### 本地目录（开发用）

```jsonc
// ~/.dsh/profiles/desktop/package.json
{
  "dependencies": {
    "dsh-chat-manage": "link:D:/code/self/all/dsh-chat-manage"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-chat-manage"]
    }
  }
}
```

然后确保包名能在 profile 的 `node_modules` 里解析到（Windows 上 `link:` 依赖有时不会生成联接，可以手动建一个）：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-chat-manage" `
  -Target "D:\code\self\all\dsh-chat-manage"
```

### 用 dsh CLI（推荐，两种等价来源）

桌面端自带 CLI，不在 PATH 里，用全路径（或加进 PATH）：

```
C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd
```

```bash
# 从 npm（发布后）—— 设置里「添加插件」里填的就是这个：dsh-chat-manage
dsh plugin --profile desktop add dsh-chat-manage

# 从 GitHub 源码 —— 本包没有构建步骤，不需要 prepare / allowBuilds
dsh plugin --profile desktop add github:Anixuil/dsh-chat-manage

# 从本地 tarball（离线或内部分发）
npm pack                                                  # → dsh-chat-manage-0.1.2.tgz
dsh plugin --profile desktop add ./dsh-chat-manage-0.1.2.tgz

# 从本地目录（开发调试，等价于上面的 link: 方式，改代码即时生效）
dsh plugin --profile desktop add D:/code/self/all/dsh-chat-manage

# 卸载
dsh plugin --profile desktop remove dsh-chat-manage
```

`--profile desktop` 是桌面端；Web 端换成 `--profile web`。`add` 会自己写入 `dsh.profile.bundles`，不需要手改 `cordis.patch.yml`。

```bash
dsh plugin --profile desktop list        # 确认装到了哪个 profile、什么来源
```

### 从 tarball 手工安装

```bash
npm pack                 # 生成 dsh-chat-manage-0.1.2.tgz
```

把它装进 profile 的 `node_modules`，并在 `dsh.profile.bundles` 里加上 `"dsh-chat-manage"`；或者直接交给上面的 `dsh plugin add`。

**装完必须完全退出再打开 DSH Desktop**：Host 半的 Loader 行和浏览器半的 `client.js` 都只在启动时加载。

## 使用

### 删除一条对话

侧边栏任意对话行 → `...` → **删除对话**。确认框里会显示对话标题，并说明「聊天记录会从磁盘上删除，无法恢复」。

- 删的是**当前正在查看**的对话时，插件会先自动开一个新对话再删除旧的那条，不需要手动切走。
- 就算目标对话“看起来还开着”，也不会拦你：Host 内存里留着会话对象不代表有人在看它。万一仍被拒绝，客户端会自动开新对话并重试一次。
- 删掉的是 Host 还留在内存里的对话时，插件会先把会话从 Host 的 store 里摘掉（等于它再也不是「活会话」），行立刻消失；摘不掉的（后端还在列的、从未落盘的会话）改用归档藏起来，也不会掉进「未分组」占着位置删不掉，重启 DSH 后连这条隐藏记录也会自动清掉。
- 如果这条对话正被一个**还在跑**的 agent 占用，删除会被拒绝并给出提示。这是有意的：半途删掉工作目录会让运行中的会话直接报错。等它跑完再删。

### 会话管理（设置里）

设置 → **会话管理**（排在「通用」之后、「模型」之前）。这一页列出所有归档对话：

- **顺序**：按归档时间**倒序**，最近归档的在最上面
- **列**：标题、所属工作区、最后活动时间、磁盘占用
- **搜索**：按标题或工作区名过滤，输入即筛
- **查看**：打开预览弹窗，按 user / assistant / tool 三种角色渲染完整聊天记录
- **恢复所选**：取消归档，对话回到自己的工作区列表（不动磁盘）
- **删除所选**：批量真删，带一次汇总确认

排序说明：DSH 不给每条归档记录存时间戳，`archivedSessionIds` 是一个**追加写入**的数组（每次归档 push 到末尾），所以数组顺序本身就是归档顺序，倒过来就是「最近归档在前」，精确且不需要额外状态。行里显示的是**最后活动时间**（消息时间），不是归档时间——一条三天前聊过、今天才归档的对话会排在最前面，但仍显示三天前的日期，这是正常的。恢复后再归档会重新追加到末尾，于是又回到最前面。

预览只渲染最近 `transcriptBlocks` 条事件，超出时弹窗底部会提示「已截断」。工具调用只显示工具名和一句参数摘要，不展开完整参数。

## 工作原理

DSH 没有「删除会话」的 API，`SessionPersistence` 只提供读，`WorkspaceRegistry` 只提供 archive / unarchive。所以插件自己编排删除流程：

```
活动检查 (waterfall: workspace/session-activity)
   ↓ 只有真的在跑（turn / 子代理 / 定时任务）才拒绝
等一会儿让 Host 放掉会话对象（最多 releaseWaitMs）
   ↓ 只是尽力而为
删工件：persistence.locate(header).path + 会话目录
        + 扫 persistence.root 下各项目目录里的同名 <id>
   ↓ 先看文件系统到底有什么（locate 给的路径可能根本不存在）
   ↓ 删完核对确实不在了（Windows 上句柄没放开会 EPERM，重试 4 次）
撤偏好：unpinSession / unarchiveSession
   ↓
还有谁在列这个 id？
   ├─ 后端自己还认（从未落盘的 pending 会话）→ archiveSession 藏起来 + 记 tombstone
   └─ 只有内存里的会话对象          → liveEntryFor + detachEntered 把会话逐出 store
   ↓
撤工作区登记：entity.detachSession
   ↓
清本地 metadata 缓存
```

顺序是刻意的：**先把磁盘删干净，再动登记**。以前是反过来的，那才是「删了掉进未分组、再删删不掉」的根源——登记先撤、工件没删成，这一行就成了没人认领的孤儿。

**「删掉」到底要抹掉什么**：官方的 `session.list` 是「磁盘记录 ∪ 内存中活着的会话」的并集（`sessionQuery.listSessions()` 会把 `ctx.sessions.list()` 里的活会话也塞进结果），而活会话在这个进程里不会被回收，所以只删日志不足以让行消失。更要紧的是，JSONL 后端的 `list()` 还会吐出 `tracker.pendingEntries()` —— **本进程创建过、但从未落盘**的会话：它们没有任何目录，`rm` 找不到东西，`stat()` 却照样返回 header。于是「删除成功、界面没变化」就是这么来的（用户核对的现象：磁盘 17 个、workspace.json 17 个，一一对应，未分组里那些行在磁盘上根本不存在）。

所以删除分两条腿：**只删真正存在的东西**，然后**确认没有谁还在列这个 id**。

- 会话对象还在 `ctx.sessions` 里 → 用 `liveEntryFor(session)` 拿到 store 里的条目、`detachEntered(entry)` 把它摘掉（就是 store 自己 fiber 卸载时用的那一对方法，摘掉后还会发 `session/disposed`）。这样它连「活会话」都不是了，行直接消失，不需要额外记账。
- 后端自己还在列（pending 会话）→ 没有 API 能清掉 tracker 里的登记，只能用归档把行藏起来：归档的会话在侧边栏默认视图不显示。同时把 id 写进 `~/.dsh/chat-manage/tombstones.json`，之后 Host 重启（此时内存和 tracker 都空了）或下一次列表/删除请求时回收——确认会话既不在内存也不在磁盘后，再把那条归档记录取消。这类 id 也不出现在「会话管理」页里，免得用户点「恢复」把它重新弄回侧边栏。

两个都做不到时（比如 registry 不认识这个 id 又藏不起来），删除会**明确报错**并保留登记，而不是假装成功：那一行留在它原来的分组里，而不是掉进「未分组」变成删不掉的幽灵。

**关于「正在打开」**：Host 的 `sessions.get(id)` 只说明这个会话对象还在内存里，不等于用户正在看它——用户切走后对象仍会留着，而且会一直留到这个进程结束。所以这里不以它作为拒绝条件（早期版本这么做，导致「明明没打开也删不掉」）。真正需要保护的是**正在跑**的会话，那个会拒绝。若目标是当前屏幕上的对话，客户端会先 `startSession()` 开一个新对话再删；万一 Host 仍报 `in-use`，客户端会自动再开一次新对话并重试一遍，不会把「请先切换对话」丢给用户。

### 两个半区

```
index.js       Host 半：注册 /dsh-chat-manage 前缀的 HTTP 路由
sessions.js    纯逻辑：读事件流、折叠成对话块、按 id 清理（只依赖 node: 内置模块）
client.js      浏览器半：菜单行、确认弹窗、设置页（window.__ModuleLoader__ 加载，无构建步骤）
cordis.patch.yml  Loader 行插入
```

HTTP 接口（都挂在 `/dsh-chat-manage` 下，只服务本机 web 端口）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/list` | 归档集合 + 元数据（标题、工作区、时间、大小、计数） |
| `GET` | `/api/transcript?id=…&limit=…` | 单条对话，渲染成块 |
| `POST` | `/api/delete` `{ ids }` | 删除，逐条返回结果 |
| `POST` | `/api/restore` `{ ids }` | 取消归档 |

批量删除单次上限 200 条；请求体上限 256 KB。两个 POST 必须声明 `content-type: application/json`，否则返回 415：浏览器能不经预检就发出 `text/plain` 的跨站请求，而这个前缀只服务本机端口，若不卡住这类请求，任意网页只要猜到端口就能删你的对话。

### 从 JSONL 到对话块

会话工件是 `~/.dsh/sessions/<cwd-slug>/<sessionId>/session.v4.jsonl.zstd`，多 zstd frame 拼接。`sessions.js` 按 magic `28 b5 2f fd` 逐帧解压，再折叠事件：

- `session/title` → 标题（取最新一个非空的）
- `user/message` → 用户发言块
- `assistant/message` → 助手发言块
- `tool/call` → 工具块（名字 + 参数摘要）

**一个坑**：`user/message` 事件里不只有用户真正打的字，还有 Host 注入的运行时上下文（runtime context、skill catalog、时间上下文、subagent 结算通知）。这些的 `data.source.kind` 不是 `'user'`，会被过滤掉——否则预览开头会是一大段 `Current runtime context…`。标题回退也走同一个判断。

## 配置

`cordis.patch.yml` 的 `config` 里有几个可调项，全部可选，都有默认值：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `transcriptBlocks` | `600` | 单次预览最多渲染多少条事件 |
| `listCacheSeconds` | `15` | 归档行的元数据缓存多久（`revision` 变化会立刻失效） |
| `releaseWaitMs` | `2500` | 删除时等 agent 释放会话的上限 |
| `tombstones` | `~/.dsh/chat-manage/tombstones.json` | 「藏起来的活会话」记录文件，一般不用改 |

改完重启 Host 生效。卸载时 Loader 行随 bundle 层一起消失，不需要单独关。

## 开发

```bash
npm test          # 三套自测，全部离线，不碰真实数据
npm run smoke     # 只跑 Host 逻辑单测
npm run http      # 只跑 HTTP 路由集成
npm run contract  # 只跑浏览器半契约
npm run layout    # 生成 dev/preview.html，用真实样式表看窄面板下的排版
```

- `dev/smoke.mjs` — 纯逻辑单测（21 项）：id 规范化、内容折叠、标题提取与回退、注入上下文过滤、列表与 workspace 关联、截断、删除（含 running 拒绝、「驻留会话被逐出而不是归档」、「从未落盘的 pending 会话只隐藏不谎报删除」、「老版本留下的幽灵行再删一次能清掉」、墓碑在会话消失后回收、「恢复后再归档」顺序、工件缺失清理）、恢复、服务缺失降级。
- `dev/http.mjs` — 路由集成测试（13 项）：真起一个 `http.Server`，把插件挂上去，然后用 `fetch` 打四个路由。校验状态码、JSON 结构、`no-store` 头、空 id 与缺 id 的拒绝、配置项对预览窗口的约束、非 JSON 的 POST 被拒（防跨站删除）、「从未落盘的会话被隐藏且不在归档页出现」，以及 fiber 释放后路由确实被卸载。
- `dev/client-contract.mjs` — 浏览器半契约测试（8 项）：复现 shell 的加载方式，校验包名注册、三个 slot 的 id/order/label、菜单面能唤起弹层请求、设置面暴露的方法齐全，**组件用到的 `dcm-*` 类名与样式表里的规则必须一一对应**（反向也查：没有死 CSS），以及删除流程的两个顺序保证：**先导航再请求**、**被拒后自动开新对话重试一次**。
- `dev/layout.mjs` — 排版夹具：把 `client.js` 里的样式表原样抽出来，按组件同样的 DOM 结构在 470px 宽度下渲染成 `dev/preview.html`。设置面板只有这么宽，列表挤爆过一次（标题列被压成 0、操作列溢出），这类问题看代码看不出来。

前三套都只读 `node:` 内置模块和假对象，不需要 DSH 在跑；`layout.mjs` 只是生成一个静态页，用浏览器或截图看即可。

## 装完怎么确认

重启后看三处：

1. 侧边栏任意对话行 `...` 里多出 **删除对话**（带垃圾桶图标，红色 hover）。
2. 设置左侧导航在「通用」和「模型」之间多出 **会话管理**。
3. 浏览器里能打开 `http://127.0.0.1:<host 端口>/dsh-chat-manage/api/list`，返回 `{"ok":true,...}`。

三个都没出现时按顺序查：

- `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里有 `dsh-chat-manage` 吗？
- `~/.dsh/profiles/desktop/node_modules/dsh-chat-manage/package.json` 能读到吗（联接是否建好）？
- 是不是没重启？Host 行和 `client.js` 都是启动时加载的。

## 注意

- 删除**不可逆**，没有回收站。
- 只在 DSH Desktop 的 web 前端上验证过（`platform: web`）。
- 预览只读最前面的若干条事件；超长对话会被截断提示，不会一次读进内存。

## License

MIT
