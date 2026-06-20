# MCP Memory Server

跨会话持久化记忆系统。**Markdown 文件即记忆** + **SQLite FTS5 全文搜索**。

给 OpenCode / Claude Code 等 AI 编码助手提供跨会话持久记忆能力，会话结束不遗忘。

---

## 快速开始

```bash
# 一行命令启动
bunx @mimochamber/memory-server
```

然后在 `opencode.json` 中注册：

```json
{
  "mcp": {
    "mcp-memory": {
      "type": "local",
      "command": ["bunx", "@mimochamber/memory-server"],
      "env": {
        "OPENCODE_API_URL": "http://127.0.0.1:4096"
      }
    }
  }
}
```

重启 OpenCode，Agent 就能使用 `memory_save` / `memory_recall` 等工具了。

---

## 安装

### 方式一：全局安装（推荐）

```bash
bun install -g @mimochamber/memory-server
```

### 方式二：项目依赖

```bash
# package.json
{
  "devDependencies": {
    "@mimochamber/memory-server": "github:你的组织/mcp-memory"
  }
}
```

### 方式三：直接运行（无需安装）

```bash
bunx @mimochamber/memory-server
```

---

## 使用

### 配置到 OpenCode

在 `opencode.json`（用户级或项目级）中添加 MCP server 配置：

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

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MCP_MEMORY_ROOT` | `~/.mcp-memory` | 记忆存储根目录 |
| `OPENCODE_API_URL` | `http://127.0.0.1:4096` | OpenCode API 地址（用于轮询 compaction） |
| `MCP_MEMORY_POLL_INTERVAL` | `30000` | 轮询间隔（ms），设为 0 关闭 |

---

## MCP 工具

### memory_save

保存一条记忆。写入 `.md` 文件并同步到 FTS5 搜索索引。

```
参数:
  content:  string        # 记忆内容（必填）
  scope:    "global" | "projects" | "sessions"   # 作用域
  scope_id: string        # 项目/会话 ID
  type:     string        # free|memory|notes|compaction

返回: { path, type, indexed_at, deduplicated }
```

### memory_recall

搜索记忆。FTS5 全文搜索 + BM25 排序。

```
参数:
  query:    string        # 搜索词（必填）
  scope?:   string        # 过滤
  limit?:   number        # 返回条数（默认 10）

返回: [{ path, snippet, score, scope, scope_id, type }]
```

### 其他工具

| 工具 | 说明 |
|------|------|
| `memory_list` | 列出记忆条目（支持分页） |
| `memory_delete` | 删除记忆（指定 path） |
| `memory_stats` | 统计信息（总条数、各作用域分布） |
| `memory_reconcile` | 手动触发磁盘文件 ↔ 索引同步 |

---

## 工作原理

```
Agent (LLM)              MCP Memory Server                  磁盘
   │                          │                             │
   │── memory_save ──────▶   │── 写入 .md 文件 ──────────▶  │
   │                          │── 更新 FTS5 索引              │
   │                          │                             │
   │── memory_recall ────▶   │── FTS5 搜索                   │
   │◀── results (BM25) ──── │  BM25 排序 + 相对分数过滤      │
   │                          │                             │
   │               后台轮询 ──▶│── GET /api/sessions           │
   │                          │── 发现 compaction → 存记忆     │
```

### 核心技术

- **存储格式**：Markdown 文件（`.md`），人类可读可编辑
- **搜索引擎**：SQLite FTS5 全文搜索 + BM25 排序
- **查询策略**：OR-join（高召回）+ 相对分数过滤（防噪声）
- **增量同步**：基于 `size-mtimeMs` fingerprint 的懒 reconcile
- **零源码改动**：纯 MCP 协议接入

### 记忆目录结构

```
~/.mcp-memory/
├── global/
│   └── MEMORY.md              # 跨项目记忆（用户偏好）
├── projects/
│   └── <project-hash>/
│       └── MEMORY.md           # 项目级记忆
└── sessions/
    └── <session-id>/
        ├── notes.md            # 自由笔记
        └── compactions.md      # 自动 compaction 摘要（追加模式）
```

---

## 防膨胀机制

### ① 内容去重
相同作用域下完全重复的内容自动跳过，返回 `deduplicated: true`。

### ② Compaction ID 去重
轮询器追踪已处理的 `session.id + message.id`，避免重复保存。

### ③ 单文件追加
同一会话的 compaction 摘要追加到 `compactions.md`，不创建新文件。

---

## 开发

```bash
# 克隆
git clone https://github.com/你的组织/mcp-memory.git
cd mcp-memory
bun install

# 测试
bun run test.mjs                # 冒烟测试
bun run test-dedup.mjs          # 去重测试
bun run test-compaction.mjs     # Compaction 追加测试
```

### 发布到 npm

```powershell
.\scripts\publish.ps1           # 预览
.\scripts\publish.ps1 -Execute  # 正式发布
```

---

## 技术栈

- **运行时**: Bun（`bun:sqlite` 内置）
- **协议**: MCP（`@modelcontextprotocol/sdk`）
- **搜索**: SQLite FTS5 + BM25
- **存储**: Markdown 文件 + SQLite 索引
- **平台**: Windows / macOS / Linux

## License

MIT
