# pi-billion-memory

[![npm version](https://img.shields.io/npm/v/pi-billion-memory.svg)](https://www.npmjs.com/package/pi-billion-memory)
[![CI](https://github.com/tjp72/pi-billion-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/tjp72/pi-billion-memory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
的长期记忆扩展：**白名单内的 ACP 压缩块 → SQLite FTS5 → `memory_search`**。

ACP 插件会把长对话压缩成摘要。本扩展从**白名单允许的压缩文件**中收集这些压缩块，
写入一个可搜索的本地 SQLite 库，并注册 `memory_search` 工具，模型可以随时调用。
兼容目标是压缩块 / 压缩 sidecar 格式；在 pi 上推荐的上游是
[billion-context-pi](#与-billion-context-pi-的关系)。

## 与 billion-context-pi 的关系

本项目是**独立的社区项目**，**不是 billion-context-pi 官方项目，也不是它的分支**，
与 [billion-context-pi](https://github.com/ranxianglei/billion-context-pi) 没有隶属或
背书关系。

- billion-context-pi 是 pi 上**推荐的可选上游**。它生成
  `<session>.jsonl.acp.json` 压缩 sidecar 文件；本扩展只读这些文件并建立索引。
  如果你需要 pi 侧的压缩记忆，请单独安装：
  ```bash
  pi install npm:billion-context-pi
  ```
- 本扩展**只读**这些 sidecar 文件。它不 import、不打包、不调用、不修改
  billion-context-pi，也没有代码依赖。
- billion-context-pi 是**可选的**。没有它，pi session 就不会产生 sidecar 文件；
  如果你配置了 opencode 源，本扩展仍然可以索引 opencode-acp 的 state 文件。
- 本扩展**不会 hook pi 的 `context` 事件**，只注册 `memory_search` 工具和
  `/memory` 命令，因此可以和 billion-context-pi 同时运行，不会参与上下文压缩的
  顺序竞争，也不会覆盖压缩结果。
- sidecar 格式是 billion-context-pi 的内部实现，可能变化。本扩展针对
  billion-context-pi `0.1.52` 的 sidecar 格式做过测试；如果上游格式变化，
  可能需要更新适配器。
- billion-context-pi 使用 MIT 许可证；它的名称和 logo 归其作者所有。
  本项目的 MIT 许可证只覆盖本项目代码。

## 功能

- **白名单优先**：扫描范围只来自白名单文件中的 root/pattern，不会全局发现所有
  session 或消息文件，因此即使 session 很多，扫描成本也可控。
- **只处理压缩块**：pi 适配器读取 `<session>.jsonl.acp.json`；opencode 适配器
  读取 `ses_*.json` state 文件。**入库时**不解析原始对话消息。
- **增量且持久**：每个源文件用 `mtime + size` 水位线记录进度；
  `UNIQUE(source_file, block_id)` + `INSERT OR IGNORE` 去重；`prune()` 会写
  tombstone，后续 rescan 不会复活已删除的块。
- **中文友好搜索**：3 个字符及以上使用 FTS5 `trigram`；1–2 个字符使用
  `LIKE` 对 `summary OR topic` 做 AND 匹配；长短混合查询两种模式并用。
  不调用 LLM 翻译或生成关键词。
- **惰性项目解析**：只有在 sidecar 需要（重新）入库时才读取 pi session 文件的
  **第一行**（`cwd` 等 header 元数据）；未变化的库不会产生 header 读取。
- **可选块展开**：开启 `expandEnabled` 后，`memory_expand` 可按需把某个块记录的
  消息指针还原成原始 session 消息。两段式（先看清单，再显式选段）、有硬上限、
  走与入库相同的过滤，并且**不写回本地库**。
- **不 hook context**：扩展只负责索引和搜索压缩摘要，不参与 pi 的上下文压缩。

## 环境要求

- **Node.js >= 22.19.0**（内置 `node:sqlite`；推荐并测试了 Node 24）。
  `node:sqlite` 在 Node 中仍标记为实验性，启动时可能打印
  `ExperimentalWarning`；对本扩展来说可以忽略。
- **pi coding agent >= 0.85.1**（使用公开扩展 API；已测试 0.85.1）。
- 至少一个启用的压缩源：
  - [billion-context-pi](https://github.com/ranxianglei/billion-context-pi)
    （pi sidecar，**推荐**），或
  - [opencode-acp](https://www.npmjs.com/package/opencode-acp) state 文件。
- 无第三方运行时依赖；只使用 Node 内置模块和 pi 宿主 API
  （`@earendil-works/pi-coding-agent`，peer dependency）。可选的
  billion-context-pi sidecar 只从磁盘读取。

## 安装

### npm（发布后推荐）

```bash
pi install npm:pi-billion-memory
```

### GitHub（私有或公开仓库）

```bash
# SSH（私有仓库推荐）
pi install git:git@github.com:tjp72/pi-billion-memory.git@v0.4.0

# HTTPS（公开仓库；凭据由 git 处理）
pi install git:https://github.com/tjp72/pi-billion-memory.git@v0.4.0
```

> `pi install git:...` 会 clone 仓库并执行 `npm install --omit=dev`，**不会执行
> build**，所以构建产物 `dist/` 必须提交到仓库。打 tag 前不要删除 `dist/`。

### 本地开发安装

```bash
npm install --legacy-peer-deps
npm run build
pi install /absolute/path/to/pi-billion-memory
```

### 验证

```bash
pi list
```

在 pi session 中：

- `/memory` — 查看库统计（sources / blocks / compressed tokens）；
- `/memory sources` — 查看当前白名单；
- `/memory rescan` — 强制全量重新扫描；
- `/memory prune <days>` — 持久删除 N 天前的块；
- 让模型调用 `memory_search`，例如问“我之前在做什么？”。

### 卸载

```bash
pi remove npm:pi-billion-memory
# 或
pi remove git:git@github.com:tjp72/pi-billion-memory.git
```

本地数据库不会自动删除。如需一并清理：

```bash
rm -f ~/.pi/pi-billion-memory.db ~/.pi/pi-billion-memory.db-wal ~/.pi/pi-billion-memory.db-shm
rm -f ~/.pi/pi-billion-memory.log ~/.pi/pi-billion-memory.sources.jsonl ~/.pi/pi-billion-memory.json
```

**不要**为了卸载本扩展而删除 pi session 文件（`.jsonl`、`.jsonl.acp.json`）、
opencode 数据库或 `~/.pi/agent/settings.json`。

## 工作原理

```
pi sidecars (.jsonl.acp.json) ─┐
                                ├─ 白名单 ─► scanSources() ─► ~/.pi/pi-billion-memory.db
opencode-acp ses_*.json ────────┘                              (SQLite + FTS5 trigram)
                                                                      │
                                                                      ▼
                                                       memory_search 工具（按需调用）
```

1. `session_start` 在后台执行白名单扫描（可用 `scanOnStartup` 关闭）。
2. `agent_settled` 和 `session_shutdown` 增量扫描当前 pi session。
3. 每次 `memory_search` 先做一次轻量白名单扫描，再查询 SQLite。
4. 对于白名单内的 pi sidecar，只有当它需要（重新）入库时才读取对应 session
   文件的**第一行**来解析 `cwd` 项目名；消息行永远不会被读取。
5. 对于 opencode 源，`opencode.db` 以只读（或 `query_only`）方式打开，仅用于把
   session ID 映射到工作目录，不会读取对话内容。

## 数据与隐私

- **无网络**：扩展不发起网络请求，没有遥测。
- **入库时不读原始消息**：只入库压缩块/sidecar；需要解析项目名时，只读 pi
  session 文件第一行的 header（`cwd`、`id`、`timestamp`、`type`、`version`）。
  只有在显式开启 `expandEnabled` 并调用 `memory_expand` 时，才会读取“被某个块
  指向的那些具体消息”。
- **敏感信息与网址过滤**：入库前扫描块的 `topic`/`summary`，命中常见凭据（密码、API key、
  token、私钥、JWT、Authorization 头、Cookie、中文标签等）时替换为 `[REDACTED]`，命中网址
  时替换为 `[REDACTED_URL]`，并在日志里记录命中数量（不记录值本身）。这是尽力而为的
  安全网，不是保证。过滤器只作用于新入库/更新的块；已有行不会被重写（可删除
  `~/.pi/pi-billion-memory.db*` 后重新扫描重建）。
- **不 hook context**：不会 hook pi 的 `context` 事件。
- **不写 session 文件**：扩展永远不会写入 session 文件。
- **本地存储**：SQLite 库、日志、配置、白名单默认都在 `~/.pi/` 下，数据留在本机。

## 配置

`~/.pi/pi-billion-memory.json` 是可选的。默认值：

```json
{
  "dbPath": "~/.pi/pi-billion-memory.db",
  "sourcesPath": "~/.pi/pi-billion-memory.sources.jsonl",
  "logPath": "~/.pi/pi-billion-memory.log",
  "maxSummaryChars": 20000,
  "debug": false,
  "excludeDirs": [],
  "scanOnStartup": true,
  "expandEnabled": false,
  "expandMaxChars": 40000,
  "expandMaxMessages": 200,
  "expandMaxReadBytes": 33554432
}
```

- `dbPath`：SQLite 库路径；
- `sourcesPath`：JSONL 白名单路径；
- `logPath`：日志路径（超过 1 MB 自动截断）；
- `maxSummaryChars`：入库时截断超长摘要。修改它不会重写已有行；删除 `*.db*`
  并重启 pi 可从源文件重建；
- `debug`：详细日志；
- `excludeDirs`：在 pi-sidecar 源 root 内要跳过的目录名；
- `scanOnStartup`：启动时是否后台全量扫描。关闭后，当前 session 仍会强制扫描
  一次，其他源由后续扫描逐步发现；
- `expandEnabled`：是否注册可选的 `memory_expand` 工具（默认 `false`），
  详见下文“展开块”；
- `expandMaxChars`：单次 `memory_expand` 返回字符数硬上限（默认 40000）；
- `expandMaxMessages`：单次 `memory_expand` 渲染消息数硬上限（默认 200）；
- `expandMaxReadBytes`：单次 `memory_expand` 读取 session 文件的字节数硬上限
  （默认 33554432，即 32 MB）。

## 白名单源

`~/.pi/pi-billion-memory.sources.jsonl` 是可选的。文件不存在时使用以下内置默认值：

```jsonl
{"id":"pi","adapter":"pi-sidecar","root":"~/.pi/agent/sessions","pattern":"**/*.jsonl.acp.json","enabled":true}
{"id":"opencode","adapter":"opencode-acp","root":"~/.local/share/opencode/storage/plugin/acp","pattern":"ses_*.json","enabled":true,"opencodeDb":"~/.local/share/opencode/opencode.db"}
```

- 每个非空、非注释行是一个 JSON 对象；
- `enabled: false` 可以禁用某个源而不删除该行；
- `root` 支持 `~` 表示当前用户 home 目录；
- `pattern` 支持递归 `**/*.jsonl.acp.json` 形式或扁平 `ses_*.json` 形式；
- `opencodeDb` 对 opencode 源可选但推荐：用于只读解析每个 state 文件对应的
  工作目录（项目名）。

例如只扫描一个 pi sessions 子树和一个额外的 sidecar root：

```jsonl
{"id":"pi-work","adapter":"pi-sidecar","root":"~/.pi/agent/sessions","pattern":"**/*.jsonl.acp.json","enabled":true}
{"id":"pi-archive","adapter":"pi-sidecar","root":"~/archive/compressions","pattern":"**/*.jsonl.acp.json","enabled":true}
```

运行 `/memory sources` 确认，然后 `/memory rescan`。

## 搜索行为

- `memory_search` 接受 `query`、可选的 `project`、可选的 `limit`（默认 6，
  最大 20），返回匹配块的 `source`、`project`、`topic`、`tier`、`createdAt`、
  `compressedTokens` 和预览；
- **3 个字符及以上**的查询使用 FTS5 `trigram` 索引，可匹配中文子串、中英混合
  文本和代码标识符；
- **1–2 个字符**的查询使用 `LIKE` 对 `summary` 和 `topic` 做 AND 匹配；
- **长短混合查询**对长 token 用 FTS、短 token 用 `LIKE`，并保持 AND 语义；
- 纯 `LIKE` 查询不会 join FTS 表，而是用 `idx_blocks_created` 排序；
- schema 是普通 JSON，不依赖 `typebox` 或其他运行时依赖。

## 展开块（可选）

`memory_search` 返回的是摘要。当确切的原始措辞重要时，可以开启一个可选工具，
把块里记录的消息指针还原成它当初压缩掉的 session 消息：

```json
{
  "expandEnabled": true
}
```

写入 `~/.pi/pi-billion-memory.json` 后重启 pi（或 `/reload`）。只有开启时才会
注册 `memory_expand` 工具。

展开被**故意设计成两段式**，避免还原文本把压缩刚省下的上下文又悄悄花掉：

```text
memory_expand({ block: "b1" })
  -> 只返回清单：每条被压缩消息的序号、role、大小、ref，不含任何正文
memory_expand({ block: "b1", mode: "full", select: [1, 2] })
  -> 只渲染第 1、2 条
```

- `block` 来自 `memory_search` 的结果。同一个块 id 可能存在于多个 session，
  结果不唯一时用 `source`（`Source:` 标签的子串，如 session 文件名或项目名）消歧；
- `limit` 和 `chars` 限制单次调用；它们还会被 `expandMaxMessages` /
  `expandMaxChars` 二次压制；
- 只有 pi 源（`*.jsonl.acp.json`）可展开；opencode-acp state 文件不暴露消息引用；
- 引用带 `#call_...` 后缀时，只渲染那一次工具调用，不含它所在的 assistant 消息；
- 引用的消息已不存在（session 文件被删除或截断）时，报告为缺失，而不是让调用失败；
- 展开出的文本会走与入库相同的敏感信息/网址过滤，且不会写回本地库。

0.5.0 之前入库的块没有记录指针。升级后会重置一次水位线账本，使下一次扫描重新
读取已有 sidecar 并补全指针，且不会重复插入块：`INSERT OR IGNORE` 仍然保护已存的
摘要正文，tombstone 仍然阻止复活。想立即触发补全可执行 `/memory rescan`。

## 规模与清理

摘要属于蒸馏知识，是否还有价值只有模型能判断，因此**没有自动过期**。手动清理：

```text
/memory prune 365   # 删除 365 天前压缩的块
/memory prune 0     # 删除所有带时间戳的块
/memory rescan      # 只添加新块；已删除的块不会复活
```

`prune` 是持久的：每个被删除的块都会写入 tombstone，水位线账本会让
“已 prune 且未变化”的源继续跳过，因此 rescan 不会复活它们。只有上游用新的
`blockId` 重新发出该块（或手动删除 tombstone 行）时，它才可能回来。

粗略估算：每个块约 1 KB 正文；数据库文件约为正文的 5–7 倍（SQLite + FTS 索引）。
720 个块约 0.7 MB 正文 / 4.9 MB 数据库；1 万个块约 15–20 MB。到几十万块之前
通常不需要干预。

## 开发

```bash
npm install --legacy-peer-deps
npm run build        # tsup + tsc -> dist/
npm run typecheck    # tsc --noEmit
npm run lint         # oxlint
npm test             # node --import tsx --test tests/*.test.ts
npm run check        # format check + typecheck + lint + test + build
npm run e2e          # 加载 dist/ 并验证 pi 注册项
npm run verify:dist  # 构建并检查已提交的 dist/ 是否过期
```

仓库结构：

- `src/` — TypeScript 源码模块，pi 扩展入口是 `src/index.ts`；
- `dist/` — 已提交的构建产物。`pi install git:...` 需要它，因为 pi 的 git 安装
  只执行 `npm install --omit=dev`，不会执行 build；
- `tests/` — 使用 Node test runner + `tsx` 的自测；
- `scripts/` — 开发辅助脚本；
- `.github/workflows/` — CI 和发布流程。

修改规则见 `CONTRIBUTING.md` 和 `AGENTS.md`。

## 已知限制

- 记忆内容是 ACP 压缩摘要，不是原始消息；未实现语义（embedding）搜索，
  trigram 是字面子串匹配。`memory_expand` 只能还原 pi 源、且只能还原记录了消息
  指针的块。
- 如果上游重写了某个块，已入库的**摘要正文**不会更新（`INSERT OR IGNORE`），
  只有消息指针会被刷新；`/memory rescan` 会补上新的块。
- 上游压缩格式是内部实现，可能变化。适配器会跳过格式错误/写到一半的文件并
  在下次扫描重试，但格式变化仍可能需要更新适配器。
- 多层级块**故意不去重**：tier-2/3 父块和 tier-1 子块可能同时命中。
  父块摘要以 `Source: bN+bM …` 开头，标识它聚合了哪些子块。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
