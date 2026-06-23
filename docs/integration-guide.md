# MCP Memory 接入与设计指南

> 覆盖 **Claude Code** 与 **OpenCode** 两种 AI 编码助手的集成方式，  
> 包含 **记忆生命周期**、**触发时机分析** 和 **设计评审**。

---

## 目录

1. [准备工作](#1-准备工作)
2. [Claude Code 集成](#2-claude-code-集成)
3. [OpenCode 集成](#3-opencode-集成)
4. [验证接入](#4-验证接入)
5. [配置语义搜索（可选）](#5-配置语义搜索可选)
6. [记忆生命周期与触发时机](#6-记忆生命周期与触发时机)
7. [高级配置](#7-高级配置)
8. [故障排查](#8-故障排查)
9. [设计评审](#9-设计评审)

---

## 1. 准备工作

### 1.1 安装依赖

```bash
# 全局安装（推荐）
bun install -g @mimochamber/memory-server

# 或直接运行（无需安装）
bunx @mimochamber/memory-server

# 或本地开发
git clone <repo>
cd mcp-memory
bun install
```

### 1.2 验证服务器自检

```bash
# 确认服务器能正常启动并输出工具列表
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | bun run src/index.ts 2>/dev/null

# 应输出 14 个工具的 JSON schema，包含：
# memory_save / memory_recall / memory_list / memory_get
# memory_update / memory_delete / memory_batch_delete / memory_stats
# memory_reconcile / memory_embed_status / memory_save_checkpoint
# memory_promote / memory_notes_append / memory_notes_flush
```

---

## 2. Claude Code 集成

### 2.1 CLI 添加（推荐）

```bash
# 在项目目录下执行
cd your-project
claude mcp add mcp-memory "bun" "run" "path\to\mcp-memory\src\index.ts"
```

这会写入 `~/.claude.json` 的项目级配置段。**下次启动新会话时自动加载**。

### 2.2 手动编辑配置文件

配置文件路径优先级：
1. 项目级: `项目根目录/.claude/settings.local.json`
2. 项目级: `项目根目录/.claude/settings.json`
3. 用户级: `~/.claude.json`（`projects.<项目绝对路径>.mcpServers`）

```jsonc
// ~/.claude.json  → projects → "D:/Project/xxx" → mcpServers
{
  "type": "stdio",
  "command": "bun",
  "args": ["run", "D:/path/to/mcp-memory/src/index.ts"],
  "env": {
    "MCP_MEMORY_ROOT": "D:/data/mcp-memory",   // 可选，默认 ~/.mcp-memory
    "OLLAMA_URL": "http://127.0.0.1:11434"      // 可选，启用语义搜索
  }
}
```

**Windows路径注意**：使用双反斜杠 `\\` 或正斜杠 `/`。

### 2.3 验证注入

新会话启动后：

```
/mcp                   # 应看到 mcp-memory 状态为 ✔ Connected
claude mcp list        # CLI 侧确认
```

> **关键**：MCP server 在 **会话启动时加载**，`claude mcp add` 后需重启会话。

### 2.4 更换记忆根目录

```bash
claude mcp add mcp-memory -e MCP_MEMORY_ROOT="D:/my-memories" -- "bun" "run" "D:\path\to\mcp-memory\src\index.ts"
```

---

## 3. OpenCode 集成

### 3.1 配置文件

OpenCode 通过 `opencode.json`（项目级或用户级）管理 MCP server：

```jsonc
// opencode.json（项目根目录）
{
  "mcp": {
    "mcp-memory": {
      "type": "local",
      "command": ["bun", "run", "D:/path/to/mcp-memory/src/index.ts"],
      "env": {
        "MCP_MEMORY_ROOT": "~/.mcp-memory",
        "MCP_MEMORY_POLL_INTERVAL": "30000",    // 开启后台轮询
        "OPENCODE_API_URL": "http://127.0.0.1:4096"
      }
    }
  }
}
```

### 3.2 自动 compaction 轮询（OpenCode 专属）

OpenCode 会在对话结束时发送 compaction 摘要到自身 API。  
设置 `MCP_MEMORY_POLL_INTERVAL=30000` 后，mcp-memory 每 30s 轮询 OpenCode API 获取并保存：

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `OPENCODE_API_URL` | `http://127.0.0.1:4096` | OpenCode API 地址 |
| `MCP_MEMORY_POLL_INTERVAL` | `0`（关闭） | 轮询间隔（ms），设 30000 启用 |

> 如需 memos 捕获，运行 `opencode server` 使 API 可用。

### 3.3 用户级配置

```jsonc
// ~/.config/opencode/opencode.json
{
  "mcp": {
    "mcp-memory": {
      "type": "local",
      "command": ["bunx", "@mimochamber/memory-server"],
      "env": {}
    }
  }
}
```

---

## 4. 验证接入

### 4.1 快速冒烟测试

在所有 MCP tool 可用后，依次发送：

```
# 1. 保存一条记忆
memory_save
  content: "MCP Memory 接入指南完成。Markdown 源 + FTS5 搜索。"
  scope: "projects"
  scope_id: "mcp-memory"

# 2. 搜索记忆
memory_recall
  query: "MCP Memory"

# 3. 统计
memory_stats

# 4. 列出条目
memory_list

# 5. 获取全文
memory_get
  path: "上面返回的 path 值"
```

预期：
- `memory_save` → 返回 `{ path, type, indexed_at, deduplicated: false }`
- `memory_recall` → 返回带 `score` 和 `snippet` 的结果列表
- `memory_stats` → 返回 `total_docs`, `scopes` 分布

### 4.2 命令行自检

```bash
# 直接向服务器发请求（无需客户端）
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | bun run src/index.ts 2>/dev/null
```

---

## 5. 配置语义搜索（可选）

hybrid 搜索 = FTS5 BM25（关键词） + 向量余弦相似度（语义），加权融合 `0.6 vec + 0.4 fts`。

```bash
# 1. 安装 Ollama
# 2. 拉取嵌入模型
ollama pull nomic-embed-text

# 3. 重启 mcp-memory
#    需设置环境变量 OLLAMA_URL（默认 http://127.0.0.1:11434）

# 4. 验证可用性
memory_embed_status  # → { available: true, model: "nomic-embed-text", dimension: 768 }
```

| 状态 | 搜索行为 |
|------|----------|
| Ollama 可用 | hybrid 模式（FTS5 + 向量融合） |
| Ollama 不可用 | 自动降级纯 FTS5，无感知 |

---

## 6. 记忆生命周期与触发时机

### 6.1 谁触发、何时触发、触发后做什么

| 操作 | 触发者 | 触发时机 | 执行流程 |
|------|--------|----------|----------|
| **memory_save** | Agent（LLM） | Agent 主动调用 | ① `scope+type+body` 去重检查 → ② compaction 单文件追加 / 普通写 `.md` 文件 → ③ upsert FTS5 索引 → ④ **异步** embedding（fire-and-forget） |
| **memory_save_checkpoint** | Agent（LLM） | Agent 在关键断点主动调用 | ① 11 字段拼 Markdown → ② 调 `save()` 写 `type=checkpoint` |
| **memory_notes_append** | Agent（LLM） | Agent 随时追加零散笔记 | ① 追加一行到 `notes.md` → ② 重新读取全文更新 FTS 索引 |
| **memory_promote** | Agent（LLM） | 需将 session 记忆提升到 project/global | ① 读取原条目 → ② 以新 scope/scope_id 重新 save |
| **memory_recall** | Agent（LLM） | Agent 需要回忆信息时主动搜索 | ① hybrid 模式（Ollama 可用）→ FTS5 BM25 + 向量余弦融合；② 否则纯 FTS5 BM25 → ③ 相对分数 ≥15% top score → ④ 返回 snippet+path+score（**无 body**） |
| **memory_list** | Agent（LLM） | 浏览存储条目 | SQL 查 `memory_fts`，**无 body**，默认 20 条 |
| **memory_get** | Agent（LLM） | 需看某条全文 | SQL 按 path 查 body |
| **memory_reconcile** | ① **系统（启动时）** ② Agent 手动 | ① **服务器启动时自动执行一次** ② 任意时刻手动 | ① `Bun.Glob("**/*.md")` 扫磁盘 → ② 与 FTS 索引比对指纹 `size+mtimeMs` → ③ 新增/更新/删除索引 → ④ 删除磁盘已不存在的索引记录 |
| **Compaction 轮询** | **系统（后台定时器）** | 当 `MCP_MEMORY_POLL_INTERVAL > 0`，每隔 N ms | ① `GET /api/sessions` → ② 并行取各 session 最近消息 → ③ 检测 `part.type === "compaction"` → ④ 按 `sessionID:messageID` 去重 → ⑤ `saveSummary()` → `save(type=compaction)` |
| **Embedding 计算** | **系统（异步）** | `memory_save` / `memory_update` 写入索引后 | `tryEmbedAsync()` — fire-and-forget，**不阻塞**返回。Ollama 不可用静默跳过 |
| **seenCompactions 清理** | **系统（定时器）** | 每 10 分钟 | `seenCompactions` Map > 10000 条 → 清除最旧的 20% |

### 6.2 进程生命周期时间线

```
服务器启动
  ├─ store.reconcile()       ← 磁盘 .md → FTS 索引同步（一次，启动必做）
  ├─ compaction poller       ← 若 POLL_INTERVAL>0，定时循环
  └─ MCP 协议就绪 → 等待 stdio 上的 JSON-RPC 请求

会话进行中
  ├─ Agent 调 memory_save         ← 写 .md + FTS + 异步 embedding
  ├─ Agent 调 memory_recall       ← FTS 搜索（+ 可选向量融合）
  ├─ Agent 调 memory_notes_append ← 追加 notes.md + 更新 FTS
  ├─ Agent 调 memory_notes_flush  ← 读空 notes.md + 删除 FTS 条目
  ├─ Agent 调 memory_save_checkpoint ← 写结构化快照
  └─ Agent 调 memory_promote      ← 提升作用域

后台无声运行
  ├─ Embedding 异步计算      ← save/update 后 0 延迟触发
  ├─ Compaction 轮询         ← 若开启，每 30000ms 拉 OpenCode API
  └─ seenCompactions 清理    ← 每 10min 检查并修剪

进程退出
  ├─ clearInterval(pollTimer)
  ├─ store.close()           ← 关闭 SQLite
  └─ exit(0)
```

### 6.3 关键设计语义

| 属性 | 说明 |
|------|------|
| **存储即源** | 所有记忆最终落地为 `.md` 文件，FTS 只是索引缓存。删除 `.md` 或手动编辑后，reconcile 会自动同步索引 |
| **无隐式自动保存** | 所有写入都是 Agent **显式调用**工具。不存在"会话结束时自动 dump"。Agent 需要在适当时机自行决定 save/checkpoint |
| **搜索不返回 body** | `memory_recall` 和 `memory_list` 默认只返回 snippet/path。要看全文必须显式调 `memory_get`，这是防膨胀设计 |
| **写入不阻塞搜索** | embedding 是 fire-and-forget，save 在 FTS 写入完成后即返回，embedding 后算 |
| **去重是软性的** | 同 scope+type+body 完全相同才跳过去重。语义相似但文字不同的内容不触发去重 |

---

## 7. 高级配置

### 7.1 环境变量总表

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MCP_MEMORY_ROOT` | `~/.mcp-memory` | 记忆存储根目录 |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama 服务地址 |
| `OPENCODE_API_URL` | `http://127.0.0.1:4096` | OpenCode API 地址 |
| `MCP_MEMORY_POLL_INTERVAL` | `0` | 轮询间隔（ms），0=关闭 |

### 7.2 记忆目录结构

```
~/.mcp-memory/
├── global/
│   └── MEMORY.md              # 跨项目记忆（用户偏好）
├── projects/
│   └── <project-hash>/
│       ├── memory-*.md        # 项目级记忆文件
│       └── note-*.md          # 自由笔记
└── sessions/
    └── <session-id>/
        ├── notes.md           # scratchpad 笔记（追加模式）
        ├── note-*.md          # 普通记忆文件
        ├── checkpoint-*.md    # 结构化 checkpoint
        └── compactions.md     # compaction 摘要（单文件追加）
```

### 7.3 防膨胀机制

| 机制 | 说明 |
|------|------|
| **内容去重** | 同 scope+type+body 完全重复跳过，返回 `deduplicated: true` |
| **Compaction ID 去重** | 内存 Map 追踪已处理 `sessionID:messageID`，超 10k 修剪 20% |
| **单文件追加** | compaction 追加到单文件，不创建新文件 |
| **search 无 body** | 只返回 snippet+path，不返回全部正文 |
| **list limit 20** | 默认 20 条，无 body |
| **按需取全文** | `memory_get(path)` 单独调用 |

### 7.4 作用域说明

| 作用域 | 适用场景 | 示例 scope_id |
|--------|----------|----------------|
| `global` | 用户偏好、通用知识 | 忽略 |
| `projects` | 项目约定、架构决策 | 项目 git 根的 SHA256[:12] |
| `sessions` | 会话临时笔记 | session UUID |

使用 `memory_promote` 将 session 级记忆提升到 project 或 global。

---

## 8. 故障排查

### 8.1 MCP server 连不上

```bash
# 1. 测试服务器是否能独立启动
bun run D:/path/to/mcp-memory/src/index.ts
# 应输出 [mcp-memory] server running on stdio

# 2. 检查配置文件语法
claude mcp list

# 3. Windows 路径问题
#    - 用正斜杠: D:/path/to/mcp-memory/src/index.ts
#    - 或用双反斜杠: D:\\path\\to\\mcp-memory\\src\\index.ts
#    - JSON 中单个反斜杠是转义，必须写成 \\ 或 /
```

### 8.2 中文搜索不准

CJK 字符依赖 FTS5 `unicode61` tokenizer 逐字索引。系统自动通过 `addCjkSpacing()` 在汉字间插空格保证可搜。

```bash
# 验证 CJK 间距处理
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"memory_recall","arguments":{"query":"中文测试"}}}' \
  | bun run src/index.ts 2>/dev/null
```

如果结果不佳，安装 Ollama 启用语义搜索（hybrid 模式对中文更好）。

### 8.3 工具未出现在列表中

```
情况：/mcp 显示 mcp-memory 但不是 ✔ Connected
原因：配置文件格式错误或路径不对
修复：claude mcp remove mcp-memory → claude mcp add 重新添加
```

```
情况：配置文件正确但新会话仍无工具
原因：Claude Code 版本 < 2.0 不支持 MCP
修复：claude --version 确认 ≥ 2.0
```

### 8.4 记忆文件丢失

```bash
# 手动触发磁盘→索引同步
memory_reconcile
```

### 8.5 语义搜索不可用

```bash
memory_embed_status
# → { available: false, error: "connect ECONNREFUSED 127.0.0.1:11434" }
# 修复: ollama serve 确认运行中
```

---

## 9. 设计评审

### 9.1 架构总评

整体设计采用 **Markdown-as-source-of-truth + FTS5 索引** 的两层存储模型，兼顾了人类可读性和机器搜索效率。以下从多个维度分析。

### 9.2 ✅ 合理的设计

| 设计 | 理由 |
|------|------|
| **启动时 reconcile** | 确保手动编辑 `.md` 文件后索引自动同步。指纹比对 `size+mtimeMs` 效率高，避免了全量重读 |
| **异步 embedding** | `tryEmbedAsync()` fire-and-forget，save 在 FTS 写入后立即返回。用户感知的延迟 = 写入延迟，不含推理延迟 |
| **搜索无 body 返回** | `memory_recall` / `memory_list` 只返回 snippet+path。要全文需单独 `memory_get`。这对 LLM 上下文窗口友好 |
| **CJK 空格包装** | FTS5 `unicode61` tokenizer 无法逐字索引连续 CJK，`addCjkSpacing()` 以字符间插入空格绕过此限制 |
| **内容去重** | 同 scope+type+body 完全匹配时返回 `deduplicated: true`，不重复写入。简单有效 |
| **Compaction 单文件追加** | 避免 compaction 频繁写入创建 N 个文件。单文件追加 + 内存 LRU 缓存正文 |
| **写入串行队列** | `withFileLock()` 按文件粒度串行化写入，防止 compaction append 并发冲突 |
| **FTS 外键级联删除** | `memory_embeddings` 的 `FOREIGN KEY ... ON DELETE CASCADE` 确保删除记忆时 embedding 自动清理 |
| **fallback 降级** | Ollama 不可用 → 静默降为纯 FTS5。搜索不会因外部依赖不可用而中断 |
| **作用域分层** | sessions → projects → global，`memory_promote` 可在不同粒度间提升记忆，区分临时与持久 |

### 9.3 ⚠️ 潜在风险与改进建议

| # | 问题 | 影响 | 建议 |
|---|------|------|------|
| 1 | **无 session 自动保存** | Agent 必须显式调 `save/checkpoint`。若 Agent 崩溃或未触发保存，整轮 session 记忆丢失。对比 OpenCode 内置 compaction 是自动的 | 在 MCP 层增加"会话关闭前自动 flush notes + 自动触发 compaction save"的 hook |
| 2 | **Embedding 不回填** | 若写入时 Ollama 不可用，embedding 直接跳过，**永远不会重试**。部分条目永久无向量 | 增加后台 re-embed 任务：定期（如每小时）扫 `memory_fts` 中 `LEFT JOIN memory_embeddings WHERE embedding IS NULL` 的条目补算 |
| 3 | **`notes_flush` 破坏性读取** | flush 返回内容后删除 `notes.md` 并移除 FTS 索引。若调用了 flush 但消费方丢失返回值，笔记永久丢失 | 考虑"标记已消费"而非删除，或保存一份归档。需要和 Agent 约定 flush 后路由到 writer |
| 4 | **BM25 分数门槛可能漏数据** | `BM25_FLOOR_RATIO = 0.15` 过滤掉 <15% top score 的结果。对于短查询或 corpus 太小，BM25 分布可能异常，导致有效结果被过滤 | 建议分数门槛自适应：若结果总数 < limit 则不截断，或增加 `minResults` 保底机制 |
| 5 | **Compaction 缓存无持久化** | `compactionBodies` 是内存 LRU，重启后首次 append 需重读整个文件。O(文件大小) 的开销 | 将缓存指纹写入 SQLite meta 表，重启后校验文件未变则直接使用缓存 |
| 6 | **文件名计数器是进程内单调递增** | `filenameCounter++` 在进程重启后重置，遇到毫秒级冲突的理论可能（极小概率） | 改用 `crypto.randomUUID()` 或 `Date.now().toString(36) + randomBytes(4).toString('hex')` |
| 7 | **`_buildFilterConditions` 的 tableAlias 未转义** | 当前 tableAlias 均为硬编码（`memory_fts` / `f` / `e`），无注入风险。但若将来扩展为动态传入则存在 SQL 注入 | 加断言或白名单校验 |
| 8 | **单事件循环阻塞** | Bun 的 `db.query().run()` 是同步的，长 SQL 可能阻塞事件循环。WAL 模式减轻了锁争用，但大数据量 reconcile 时仍有风险 | 超大 reconcile 可分批或使用 `db.run()` 的异步变体（如 `await db.run(...)`） |

### 9.4 与 Claude Code 内置 `/memory` 对比

| 特性 | `/memory`（内置） | `mcp-memory` |
|------|------------------|--------------|
| 搜索方式 | 文件名 grep | FTS5 BM25 + 可选向量 |
| 语义搜索 | ❌ | ✅ (Ollama) |
| 搜索精度 | 关键词完全匹配 | BM25 ranking + snippet 高亮 |
| 结构化 checkpoint | ❌ | ✅ 11 字段 |
| 作用域提升 | ❌ | ✅ promote |
| scratchpad 笔记 | ❌ | ✅ notes_append/flush |
| 批量删除 | ❌ | ✅ |
| OpenCode 轮询 | ❌ | ✅ |
| 存储格式 | 专有格式 | **标准 Markdown 文件** |
| 自动保存 | 会话开始/结束抓取 | Agent 主动调用 |

### 9.5 总结

```
适用于: 需要跨 session 持久记忆、CJK 中文搜索、可审计的 Markdown 存储、混合语义搜索的场景
不适用于: 需要全自动无感记忆（需配合 Agent 调用的约定）、多进程/多用户共享写入（单 SQLite 非集群友好）
总体评价: 设计务实，防膨胀意识强，降级策略完备。核心短板在"无自动持久化钩子"和"embedding 不回填"
```
