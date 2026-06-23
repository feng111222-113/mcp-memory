# MCP Memory Server

跨会话持久化记忆系统。**Markdown 文件即记忆** + **SQLite FTS5 全文搜索** + **可选 Ollama 语义搜索**。

给 OpenCode / Claude Code 等 AI 编码助手提供跨会话持久记忆能力，会话结束不遗忘。

---

## 快速使用

```bash
# 一行命令启动
bunx @mimochamber/memory-server
```

服务启动后在 stdio 上暴露 MCP 协议，**共 14 个工具**，兼容任何 MCP 客户端。

---

## 安装

### 方式一：全局安装（推荐）

```bash
bun install -g @mimochamber/memory-server
```

### 方式二：项目依赖

```bash
bun add -d @mimochamber/memory-server
```

### 方式三：直接运行（无需安装）

```bash
bunx @mimochamber/memory-server
```

---

## 配置到客户端

### Claude Code

在 `claude_desktop_config.json` 或项目 `.mcp.json` 中添加：

```json
{
  "mcpServers": {
    "mcp-memory": {
      "type": "local",
      "command": ["bunx", "@mimochamber/memory-server"]
    }
  }
}
```

### OpenCode

在 `opencode.json`（用户级或项目级）中添加：

```json
{
  "mcp": {
    "mcp-memory": {
      "type": "local",
      "command": ["bunx", "@mimochamber/memory-server"],
      "env": {
        "OPENCODE_API_URL": "http://127.0.0.1:4096",
        "MCP_MEMORY_POLL_INTERVAL": "30000"
      }
    }
  }
}
```

---

## 14 个 MCP 工具一览

| 工具名 | 功能 | 类别 |
|--------|------|------|
| `memory_save` | 保存一条记忆（笔记/配置/对话摘要） | 核心 |
| `memory_recall` | 搜索记忆（默认 hybrid：FTS5+语义融合，关键词不匹配也能搜到） | 核心 |
| `memory_list` | 列出已存储条目（不返回 body，节省上下文） | 核心 |
| `memory_get` | 按 path 获取单条记忆全文 | 核心 |
| `memory_update` | 更新已有记忆 | 核心 |
| `memory_delete` | 删除指定记忆 | 管理 |
| `memory_batch_delete` | 按条件批量删除 | 管理 |
| `memory_stats` | 记忆系统统计 | 管理 |
| `memory_reconcile` | 手动触发磁盘文件 ↔ 索引同步 | 管理 |
| `memory_embed_status` | 检查语义搜索（Ollama）是否可用 | 增强 |
| `memory_save_checkpoint` | 保存结构化 checkpoint（11 字段的 session 快照） | 增强 |
| `memory_promote` | 将 session 记忆提升到 project/global 作用域 | 增强 |
| `memory_notes_append` | 向 notes.md 追加零散笔记（scratchpad） | 增强 |
| `memory_notes_flush` | 读取并清空 notes.md（writer 路由后调用） | 增强 |

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MCP_MEMORY_ROOT` | `~/.mcp-memory` | 记忆存储根目录 |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama 服务地址（启用以支持语义搜索） |
| `OPENCODE_API_URL` | `http://127.0.0.1:4096` | [仅 OpenCode] API 地址 |
| `MCP_MEMORY_POLL_INTERVAL` | `0` | [仅 OpenCode] 轮询间隔 ms，设 30000 开启 |

**语义搜索**：安装 Ollama 并 `ollama pull nomic-embed-text`，重启服务后 `memory_recall` 自动使用 hybrid 模式（FTS5+向量融合）。Ollama 不可用时自动降级为纯 FTS5。

---

## MCP 工具详情

### memory_save

保存一条记忆。写入 `.md` 文件并同步到 FTS5 搜索索引。

```
参数:
  content:  string        # 记忆内容（必填）
  scope:    "global" | "projects" | "sessions"   # 作用域（默认 sessions）
  scope_id: string        # 项目/会话 ID
  type:     "free"|"memory"|"checkpoint"|"compaction"|"notes"

返回: { path, type, indexed_at, deduplicated }
```

### memory_recall

搜索记忆。默认 hybrid 模式，Ollama 不存在时自动降级纯 FTS5。

```
参数:
  query:       string              # 搜索词（必填，自然语言即可）
  scope?:      string              # 过滤作用域
  scope_id?:   string              # 过滤项目/会话 ID
  type?:       string              # 过滤记忆类型
  limit?:      number              # 返回条数（默认 10）
  search_mode: "fts" | "hybrid"    # 默认 hybrid

返回: [{ path, snippet, score, scope, scope_id, type }]
```

### memory_list / memory_get / memory_update / memory_delete

```
memory_list:   列出条目（无 body，limit 默认 20）
memory_get:    按 path 取全文（search/list 不返回 body）
memory_update: 按 path 更新内容
memory_delete: 按 path 删除
```

### memory_save_checkpoint

保存结构化 session 快照，11 个可选字段。适合 llm 在 checkpoint 点保存工作状态。

```
参数:
  scope_id:   string    # session ID（必填）
  intent:     string    # 当前意图/目标
  next_action: string   # 下一步动作
  constraints: string   # 工作约束
  task_tree:  string    # 任务树
  working_on: string    # 当前工作在做什么
  files:      string[]  # 涉及的文件列表
  cross_task_findings: string  # 跨任务发现
  errors_fixes: string  # 错误与修复
  runtime_state: string # 运行时状态
  design_decisions: string  # 设计决策
  notes:      string    # 杂项笔记
```

### memory_promote

```
memory_promote(path, target_scope: "projects"|"global", target_scope_id?)
将 session 级记忆提升到更高作用域，使其跨 session 持久可用。
```

### memory_notes_append / memory_notes_flush

```
memory_notes_append(scope_id, note)   # 追加笔记到 scratchpad
memory_notes_flush(scope_id)          # 读取并清空笔记（返回内容用于路由）
```

---

## 记忆目录结构

```
~/.mcp-memory/
├── global/
│   └── MEMORY.md              # 跨项目记忆（用户偏好）
├── projects/
│   └── <project-hash>/
│       └── MEMORY.md          # 项目级记忆
└── sessions/
    └── <session-id>/
        ├── notes.md           # 自由笔记（scratchpad 模式）
        ├── note-*.md          # 普通记忆文件
        └── compactions.md     # compaction 摘要（追加模式）
```

---

## 防膨胀机制

| 机制 | 说明 |
|------|------|
| ① 内容去重 | 同作用域下完全重复内容跳过，返回 deduplicated=true |
| ② Compaction ID 去重 | 追踪已处理的 session+message ID，避免重复保存 |
| ③ 单文件追加 | compaction 追加到单文件，不创建新文件 |
| ④ search 无 body | 只返回 snippet+path，不看全文 |
| ⑤ list 无 body+limit 砍半 | 默认 20 条，不返回 body |
| ⑥ 按需取全文 | 想看详情调 memory_get |

---

## 语义搜索

1. 安装 [Ollama](https://ollama.ai)
2. `ollama pull nomic-embed-text`
3. 重启 mcp-memory 服务
4. `memory_embed_status` 确认可用

之后 `memory_recall` 默认开启 hybrid 模式：
- FTS5 BM25（关键词匹配）
- 向量余弦相似度（语义匹配）
- 加权融合（0.6 vec + 0.4 fts）

Ollama 不可用时自动降级纯 FTS5，无感知。

---

## 开发

```bash
git clone https://github.com/你的组织/mcp-memory.git
cd mcp-memory
bun install

# 冒烟测试
bun run test.mjs
bun run test-dedup.mjs
bun run test-compaction.mjs

# 类型检查
bun run tsc
```

### 发布到 npm

```powershell
.\scripts\publish.ps1           # dry-run
.\scripts\publish.ps1 -Execute  # 正式发布
```

---

## 技术栈

- **运行时**: Bun（`bun:sqlite` 内置 SQLite FTS5）
- **协议**: MCP（`@modelcontextprotocol/sdk`）
- **搜索**: SQLite FTS5 + BM25 + 可选 Ollama 向量嵌入
- **存储**: Markdown 文件 + SQLite 索引
- **平台**: Windows / macOS / Linux

## License

MIT
