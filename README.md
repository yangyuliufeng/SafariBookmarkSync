# Safari Bookmark Sync

**English** | [中文](#中文)

> A fully local Chrome extension that mirrors Safari's **bookmarks and
> reading list** into Chrome. Click the toolbar button, pick Safari's
> `Bookmarks.plist`, and Chrome's side is rebuilt to match.
> No server, no sign-in, no data ever leaves your machine.

---

## ⚠️ Read This Before You Use It

This is **one-way, overwrite-style sync**: `Safari → Chrome`. Every sync
**wipes Chrome's Bookmarks Bar, Other Bookmarks and Reading List**, then
rebuilds them from Safari's data.

- Bookmarks you created in Chrome **will be deleted**.
- Changes you make in Chrome **never flow back** to Safari.

**It only makes sense if Safari is your primary browser** and Chrome is just
a secondary viewer for your bookmarks. If Chrome is your main browser, or you
actively manage bookmarks on both sides, this extension is not for you.

## Features

- 📚 **Full mirror** — Chrome's bookmark tree and reading list end up exactly
  matching Safari's, including folder structure and ordering.
- 🔒 **100% local** — no network permission, no `fetch`/`WebSocket` anywhere;
  the only permissions are `bookmarks`, `readingList` and `storage`.
- ⏭ **Incremental skip** — if the file hasn't changed since the last sync
  (SHA-256), nothing is touched.
- 🛑 **Empty-tree abort** — a plist that parses to 0 bookmarks aborts the sync
  instead of wiping Chrome (protects against picking the wrong file).
- ↩️ **Rollback on failure** — if the rebuild fails midway, the partial tree
  is removed so Chrome is never left half-written.
- 🩹 **Per-node tolerance** — a bookmark Chrome rejects (e.g. a `javascript:`
  bookmarklet) is skipped and logged, not fatal.
- 🌐 **Bilingual UI** — English / 中文, following the browser's UI language.

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this folder.

## Usage

1. Click the extension's toolbar button.
2. Click **Pick Bookmarks.plist & Replace All**.
3. In the file picker, press **⌘⇧G**, paste
   `~/Library/Safari/Bookmarks.plist` and confirm.
4. Read the inline warning and confirm — Chrome's bookmarks and reading list
   are rebuilt from Safari's file. The popup reports what was created,
   removed and written to the reading list.

Notes:

- Safari keeps its bookmarks at `~/Library/Safari/Bookmarks.plist`, an Apple
  binary property list — the extension parses it locally (bundled
  `bplist-parser`, no conversion tools needed).
- The classic `<input type="file">` picker is used on purpose: Chrome's File
  System Access API (`showOpenFilePicker`) refuses everything under
  `~/Library` ("contains system files"), while the legacy input opens the
  same native panel without that blocklist.
- If macOS privacy protection (TCC) blocks reading `~/Library/Safari`, grant
  Chrome **Full Disk Access** (System Settings → Privacy & Security), or copy
  the plist elsewhere and pick the copy.
- The **Reading List read/unread state resets to unread** — Safari's plist
  has no reliable read-state field.

## How It Works

```
~/Library/Safari/Bookmarks.plist
        │  (binary plist, read from a file picker)
        ▼
  bplist-parser  →  Safari bookmark tree (unified JSON)
        ▼
  SHA-256 hash  →  unchanged? skip entirely
        ▼
  FULL REPLACE:
    1. wipe Chrome Bookmarks Bar + Other Bookmarks + Reading List
    2. rebuild the tree in Safari's order
    3. rewrite the reading list
        ▼
  chrome.bookmarks / chrome.readingList
```

Why full replace instead of a merge/diff? It is deterministic and
idempotent: the plist is the single source of truth, so Chrome's state can
never drift from Safari's no matter what happened on either side. The sync
runs serialized in the background service worker and all destructive actions
are confirmed via an **inline DOM bar** — never `window.confirm()`, which on
some macOS builds crashes the whole Chrome process when the file picker is
shown over the native alert.

## Permissions

| Permission    | Why                                          |
| ------------- | -------------------------------------------- |
| `bookmarks`   | Rebuild Chrome's bookmark tree               |
| `readingList` | Mirror Safari's reading list into Chrome     |
| `storage`     | Persist the last-sync hash for change detection |

Explicitly **not** requested: `tabs`, `history`, `cookies`, or any
`host_permissions` — the extension cannot touch the network at all.

## Project Layout

```
├── manifest.json        # MV3 manifest (bookmarks/readingList/storage only)
├── background.js        # service worker: message handling + sync orchestration
├── popup.html/.js       # toolbar popup: file picker, inline confirm, status
├── i18n.js              # runtime string table (en/zh)
├── _locales/            # chrome.i18n static strings (en, zh_CN)
├── parser/safari-plist.js  # plist object → unified bookmark tree
├── sync/
│   ├── chrome.js        # full-replace engine, rollback, per-node tolerance
│   ├── diff.js          # tree stats / helpers
│   └── storage.js       # chrome.storage.local state (hash, etc.)
├── lib/bplist-parser.js # bundled Apple binary plist parser
└── test/e2e.js          # offline end-to-end test (no browser needed)
```

## Development & Test

The sync engine runs against an in-memory mock of the Chrome APIs, so the
whole pipeline (parse → diff → replace) can be tested without a browser:

```bash
node test/e2e.js
```

To test in a real browser, load the extension unpacked (see
[Install](#install)) and run a sync against a copy of your
`Bookmarks.plist`.

## Roadmap

- **Automatic sync on Safari changes** — a tiny native agent watching
  `Bookmarks.plist` (e.g. `fsnotify` in Go) and pushing updates through
  Native Messaging. Not built yet; today every sync is manual.

---

## 中文

> 一个纯本地 Chrome 扩展，把 Safari 的**书签和阅读清单**镜像到 Chrome。
> 点击工具栏按钮，选择 Safari 的 `Bookmarks.plist`，Chrome 一侧即被重建为
> 与 Safari 完全一致。无服务器、免登录，数据不出本机。

### ⚠️ 使用前必读

本插件是**单向覆盖式同步**：`Safari → Chrome`。每次同步都会**清空 Chrome
的书签栏、其他书签和阅读清单**，然后按 Safari 的数据完整重建。

- 你在 Chrome 里新建的书签**会被删除**；
- 你在 Chrome 里做的改动**不会回流** Safari。

**只适合主用 Safari 的用户**（Chrome 只是用来看书签的辅助浏览器）。
如果你主要用 Chrome，或者两边都经常整理书签，这个插件不适合你。

### 功能

- 📚 **完全镜像**：Chrome 书签树和阅读清单与 Safari 保持一致，含目录结构与顺序。
- 🔒 **100% 本地**：无网络权限，代码里没有任何 `fetch`/`WebSocket`；
  仅申请 `bookmarks`、`readingList`、`storage` 三个权限。
- ⏭ **增量跳过**：文件与上次同步一致（SHA-256）时完全不改动。
- 🛑 **空树中止**：解析出 0 条书签时直接中止，避免选错文件误清空 Chrome。
- ↩️ **失败回滚**：重建中途出错时清除已写入的部分，Chrome 不会停留在“写了一半”。
- 🩹 **单点容错**：个别被 Chrome 拒绝的书签（如 `javascript:` 小书签）计为跳过，
  不影响整体同步。
- 🌐 **双语界面**：跟随浏览器语言显示中文 / English。

### 安装

1. 克隆或下载本仓库；
2. 打开 `chrome://extensions`；
3. 开启右上角**开发者模式**；
4. 点击**加载已解压的扩展程序**，选择本目录。

### 使用

1. 点击工具栏上的扩展图标；
2. 点击**选择 Bookmarks.plist 并完全替换**；
3. 在文件选择器中按 **⌘⇧G**，粘贴 `~/Library/Safari/Bookmarks.plist` 并确认；
4. 阅读内联警告并确认 —— Chrome 的书签与阅读清单将按 Safari 文件重建，
   弹窗会显示清除 / 写入 / 阅读清单的条数。

注意事项：

- Safari 书签位于 `~/Library/Safari/Bookmarks.plist`，是 Apple 二进制
  plist 格式，扩展在本地直接解析（内置 `bplist-parser`，无需任何转换工具）。
- 特意使用传统 `<input type="file">` 选择器：Chrome 的 File System Access
  API（`showOpenFilePicker`）会拒绝 `~/Library` 下的所有文件（“含有系统文件”），
  而传统选择框打开的是同一个原生面板、不受该限制。
- 若 macOS 隐私保护（TCC）拦截读取 `~/Library/Safari`，请在
  系统设置 → 隐私与安全性 → **完全磁盘访问权限** 中授权 Chrome，
  或先把 plist 拷贝到别的目录再选择。
- **阅读清单的已读/未读状态会重置为未读** —— Safari plist 中没有可靠的已读字段。

### 工作原理

```
~/Library/Safari/Bookmarks.plist
        │（二进制 plist，文件选择器读取）
        ▼
  bplist-parser → Safari 书签树（统一 JSON）
        ▼
  SHA-256 哈希 → 未变化则整体跳过
        ▼
  完全替换：
    1. 清空 Chrome 书签栏 + 其他书签 + 阅读清单
    2. 按 Safari 的顺序重建书签树
    3. 重写阅读清单
        ▼
  chrome.bookmarks / chrome.readingList
```

为什么用完全替换而不是合并/diff？因为确定性、幂等：plist 是唯一事实来源，
无论两侧发生过什么，Chrome 的状态都不会与 Safari 漂移。同步在后台
service worker 中串行执行；所有破坏性操作都通过**内联确认条**确认 ——
绝不使用 `window.confirm()`（在部分 macOS 版本上，在原生源弹窗之上再弹出
文件选择面板会导致整个 Chrome 进程崩溃）。

### 权限

| 权限           | 用途                                   |
| -------------- | -------------------------------------- |
| `bookmarks`    | 重建 Chrome 书签树                     |
| `readingList`  | 把 Safari 阅读清单镜像进 Chrome        |
| `storage`      | 保存上次同步哈希，用于增量检测         |

明确**不申请**：`tabs`、`history`、`cookies` 以及任何 `host_permissions`
—— 扩展无法访问网络。

### 目录结构

```
├── manifest.json        # MV3 清单（仅 bookmarks/readingList/storage）
├── background.js        # service worker：消息处理与同步编排
├── popup.html/.js       # 弹窗：文件选择、内联确认、状态展示
├── i18n.js              # 运行时字符串表（中/英）
├── _locales/            # chrome.i18n 静态文案（en、zh_CN）
├── parser/safari-plist.js  # plist 对象 → 统一书签树
├── sync/
│   ├── chrome.js        # 完全替换引擎、回滚、单点容错
│   ├── diff.js          # 树统计 / 工具函数
│   └── storage.js       # chrome.storage.local 状态（哈希等）
├── lib/bplist-parser.js # 内置 Apple 二进制 plist 解析器
└── test/e2e.js          # 离线端到端测试（无需浏览器）
```

### 开发与测试

同步引擎基于内存版 Chrome API mock 运行，整条链路（解析 → 比对 → 替换）
无需浏览器即可测试：

```bash
node test/e2e.js
```

真机验证：按上文「安装」加载未打包扩展，用一份 `Bookmarks.plist`
副本跑一次同步即可。

### 路线图

- **Safari 变更后自动同步** —— 通过一个小型 native agent 监听
  `Bookmarks.plist`（如 Go 的 `fsnotify`）并经由 Native Messaging 推送更新。
  尚未实现，目前每次同步均为手动触发。
