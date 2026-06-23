/**
 * MCP Memory Server
 *
 * 跨会话持久化记忆系统。Markdown 文件即记忆 + SQLite FTS5 搜索。
 * 后台轮询 OpenCode API 自动捕获 compaction 摘要。
 *
 * 环境变量:
 *   MCP_MEMORY_ROOT       - 记忆存储根目录（默认 ~/.mcp-memory）
 *   OPENCODE_API_URL      - OpenCode API 地址（默认 http://127.0.0.1:4096）
 *   MCP_MEMORY_POLL_INTERVAL - [OpenCode] 轮询间隔 ms（默认 0=关闭，设为 30000 启用）
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MemoryStore } from "./store";
import { Embedder } from "./embedder";

// Windows 控制台编码修复：确保中文 UTF-8 输出
if (process.platform === "win32") {
  try {
    Bun.spawnSync(["chcp", "65001"], { stdio: "ignore" } as any);
  } catch {}
}

// ---------------------------------------------------------------------------
// 命名常量
// ---------------------------------------------------------------------------

const POLL_INTERVAL_DEFAULT = 0;
const API_URL_DEFAULT = "http://127.0.0.1:4096";
const POLL_CONCURRENCY = 5;
const POLL_FETCH_TIMEOUT = 5000;
const POLL_MESSAGE_LIMIT = 5;
const SEEN_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const SEEN_MAX_SIZE = 10000;
const SEEN_PRUNE_RATIO = 0.2;
const OLLAMA_REFRESH_INTERVAL = 60_000;
const SHUTDOWN_TIMEOUT = 5_000;

const SCOPE_GLOBAL = "global" as const;
const SCOPE_PROJECTS = "projects" as const;
const SCOPE_SESSIONS = "sessions" as const;
const ALL_SCOPES = [SCOPE_GLOBAL, SCOPE_PROJECTS, SCOPE_SESSIONS] as const;

// ---------------------------------------------------------------------------
// 可选向量嵌入器
// ---------------------------------------------------------------------------

const embedder = new Embedder(process.env.OLLAMA_URL);

// ---------------------------------------------------------------------------
// 初始化存储
// ---------------------------------------------------------------------------

const store = new MemoryStore(process.env.MCP_MEMORY_ROOT, embedder);

// 启动时执行一次完整 reconcile
store.reconcile().then((r) => {
  console.error(`[mcp-memory] reconciled: ${r.indexed} indexed, ${r.pruned} pruned`);
});

// ---------------------------------------------------------------------------
// MCP 服务器
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "mcp-memory", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// --- ListTools ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "memory_save",
      description: "保存一条记忆到 .md 文件并更新搜索索引。内容可以是笔记、配置、对话摘要等。",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "记忆内容" },
          scope: {
            type: "string",
            enum: ALL_SCOPES,
            description: "作用域：global=跨项目，projects=项目级，sessions=会话级",
          },
          scope_id: { type: "string", description: "项目或会话 ID（scope=global 时忽略）" },
          type: {
            type: "string",
            enum: ["free", "memory", "checkpoint", "compaction", "notes"],
            description: "记忆类型（默认 free）",
          },
        },
        required: ["content"],
      },
    },
    {
      name: "memory_recall",
      description: "搜索记忆。默认 hybrid 模式：FTS5 BM25 + 语义向量融合，关键词不匹配也能搜到相关内容。自动降级纯 FTS5（无 Ollama 时）。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索词（自然语言即可）" },
          scope: { type: "string", enum: ALL_SCOPES, description: "过滤：作用域" },
          scope_id: { type: "string", description: "过滤：项目/会话 ID" },
          type: { type: "string", enum: ["memory", "checkpoint", "compaction", "notes", "free"], description: "过滤：记忆类型" },
          limit: { type: "number", description: "返回条数（默认 10）" },
          search_mode: { type: "string", enum: ["fts", "hybrid"], description: "hybrid=全文+语义融合（默认），fts=纯关键词匹配" },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_list",
      description: "列出已存储的记忆条目（不返回 body 以节省上下文）",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string" },
          scope_id: { type: "string" },
          type: { type: "string" },
          limit: { type: "number", description: "默认 20" },
          offset: { type: "number", description: "默认 0" },
        },
      },
    },
    {
      name: "memory_get",
      description: "按 path 获取单条记忆全文（search/list 默认不返回 body 以节省上下文）",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "记忆文件路径" },
        },
        required: ["path"],
      },
    },
    {
      name: "memory_update",
      description: "更新已有记忆条目（根据 path 定位）",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "要更新的 .md 文件完整路径" },
          content: { type: "string", description: "新内容" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "memory_delete",
      description: "删除指定记忆文件",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "要删除的 .md 文件完整路径" },
        },
        required: ["path"],
      },
    },
    {
      name: "memory_stats",
      description: "记忆系统统计信息",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "memory_batch_delete",
      description: "按条件批量删除记忆条目",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ALL_SCOPES, description: "必填：作用域" },
          scope_id: { type: "string", description: "项目或会话 ID" },
          type: { type: "string", description: "记忆类型" },
        },
        required: ["scope"],
      },
    },
    {
      name: "memory_reconcile",
      description: "手动触发磁盘 .md 文件 → FTS 索引增量同步",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "memory_embed_status",
      description: "检查语义搜索（Ollama embedding）是否可用",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "memory_save_checkpoint",
      description: "保存结构化 checkpoint（session 工作状态快照），包含 intent/next_action/task_tree/errors_fixes 等字段",
      inputSchema: {
        type: "object",
        properties: {
          scope_id: { type: "string", description: "session ID" },
          intent: { type: "string" },
          next_action: { type: "string" },
          constraints: { type: "string" },
          task_tree: { type: "string" },
          working_on: { type: "string" },
          files: { type: "array", items: { type: "string" }, description: "涉及的文件列表" },
          cross_task_findings: { type: "string", description: "跨任务发现" },
          errors_fixes: { type: "string", description: "错误与修复" },
          runtime_state: { type: "string" },
          design_decisions: { type: "string" },
          notes: { type: "string" },
        },
        required: ["scope_id"],
      },
    },
    {
      name: "memory_promote",
      description: "将 session 级记忆提升到更高作用域（projects/global），使其跨 session 持久可用",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "记忆文件路径" },
          target_scope: { type: "string", enum: [SCOPE_PROJECTS, SCOPE_GLOBAL], description: "目标作用域" },
          target_scope_id: { type: "string", description: "项目 ID" },
          type: { type: "string", description: "可选的类型覆盖" },
        },
        required: ["path", "target_scope"],
      },
    },
    {
      name: "memory_notes_append",
      description: "向 session notes.md 追加笔记（scratchpad 模式），writer checkpoint 时消费并清空",
      inputSchema: {
        type: "object",
        properties: {
          scope_id: { type: "string", description: "session ID" },
          note: { type: "string", description: "笔记内容" },
        },
        required: ["scope_id", "note"],
      },
    },
    {
      name: "memory_notes_flush",
      description: "读取并清空 session notes.md，返回已清空的笔记内容用于路由",
      inputSchema: {
        type: "object",
        properties: {
          scope_id: { type: "string", description: "session ID" },
        },
        required: ["scope_id"],
      },
    },
  ],
}));

// --- CallTool ---

type HandlerFn = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

const toolHandlers: Record<string, HandlerFn> = {
  memory_save: async (args) => {
    const result = await store.save({
      content: String(args?.content ?? ""),
      scope: (args?.scope as "global" | "projects" | "sessions") ?? SCOPE_SESSIONS,
      scope_id: args?.scope_id as string | undefined,
      type: args?.type as "free" | "memory" | "checkpoint" | "compaction" | "notes" | undefined,
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },

  memory_update: async (args) => {
    const result = await store.update({
      path: String(args?.path ?? ""),
      content: String(args?.content ?? ""),
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },

  memory_recall: async (args) => {
    const results = await store.search({
      query: String(args?.query ?? ""),
      scope: args?.scope as string | undefined,
      scope_id: args?.scope_id as string | undefined,
      type: args?.type as string | undefined,
      limit: typeof args?.limit === "number" ? args.limit : undefined,
      search_mode: args?.search_mode as "fts" | "hybrid" | undefined,
    });
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
  },

  memory_list: async (args) => {
    const entries = store.list({
      scope: args?.scope as string | undefined,
      scope_id: args?.scope_id as string | undefined,
      type: args?.type as string | undefined,
      limit: typeof args?.limit === "number" ? args.limit : undefined,
      offset: typeof args?.offset === "number" ? args.offset : undefined,
    });
    return { content: [{ type: "text", text: JSON.stringify(entries) }] };
  },

  memory_get: async (args) => {
    const content = store.get(String(args?.path ?? ""));
    return { content: [{ type: "text", text: content || JSON.stringify({ error: "not found" }) }] };
  },

  memory_delete: async (args) => {
    const deleted = await store.delete(String(args?.path ?? ""));
    return { content: [{ type: "text", text: JSON.stringify({ deleted }) }] };
  },

  memory_batch_delete: async (args) => {
    const result = await store.deleteByScope({
      scope: String(args?.scope ?? ""),
      scope_id: args?.scope_id as string | undefined,
      type: args?.type as string | undefined,
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },

  memory_stats: async () => {
    const stats = store.stats();
    return { content: [{ type: "text", text: JSON.stringify(stats) }] };
  },

  memory_reconcile: async () => {
    const result = await store.reconcile();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },

  memory_embed_status: async () => {
    const available = await embedder.isAvailable();
    return { content: [{ type: "text", text: JSON.stringify({
      available,
      model: "nomic-embed-text",
      dimension: embedder.dimension,
      note: available
        ? "Ollama nomic-embed-text 可用，memory_recall 支持 search_mode=hybrid"
        : "Ollama 不可用或 nomic-embed-text 未安装。hybrid 搜索降级为纯 FTS5。",
    }) }] };
  },

  memory_save_checkpoint: async (args) => {
    const result = await store.saveCheckpoint(
      String(args?.scope_id ?? ""),
      {
        intent: args?.intent as string | undefined,
        next_action: args?.next_action as string | undefined,
        constraints: args?.constraints as string | undefined,
        task_tree: args?.task_tree as string | undefined,
        working_on: args?.working_on as string | undefined,
        files: args?.files as string[] | undefined,
        cross_task_findings: args?.cross_task_findings as string | undefined,
        errors_fixes: args?.errors_fixes as string | undefined,
        runtime_state: args?.runtime_state as string | undefined,
        design_decisions: args?.design_decisions as string | undefined,
        notes: args?.notes as string | undefined,
      },
    );
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },

  memory_promote: async (args) => {
    const result = await store.promote({
      path: String(args?.path ?? ""),
      target_scope: args?.target_scope as "projects" | "global",
      target_scope_id: args?.target_scope_id as string | undefined,
      type: args?.type as string | undefined,
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },

  memory_notes_append: async (args) => {
    const result = await store.notesAppend(String(args?.scope_id ?? ""), String(args?.note ?? ""));
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },

  memory_notes_flush: async (args) => {
    const content = await store.notesFlush(String(args?.scope_id ?? ""));
    return { content: [{ type: "text", text: content || "[]" }] };
  },
};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = toolHandlers[name];
  if (!handler) {
    return { isError: true, content: [{ type: "text", text: "Unknown tool: " + name }] };
  }
  try {
    return await handler(args ?? {});
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: String(error) }] };
  }
});

// ---------------------------------------------------------------------------
// 后台轮询 — 自动检测 OpenCode compaction 事件
// ---------------------------------------------------------------------------

const pollInterval = parseInt(process.env.MCP_MEMORY_POLL_INTERVAL ?? String(POLL_INTERVAL_DEFAULT), 10);
const apiUrl = (process.env.OPENCODE_API_URL || API_URL_DEFAULT).replace(/\/+$/, "");

interface PolledSession {
  id: string;
  updated_at?: number;
  status?: string;
}

interface PolledMessage {
  id: string;
  parts?: Array<{ type: string; text?: string }>;
  role?: string;
  created_at?: number;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

/** ② Compaction ID 去重：追踪已处理的会话+消息ID，避免重复保存 */
const seenCompactions = new Map<string, boolean>();

// 周期性清理 seenCompactions，防止内存泄漏
setInterval(() => {
  if (seenCompactions.size > SEEN_MAX_SIZE) {
    const size = seenCompactions.size;
    const toDelete = Math.floor(size * SEEN_PRUNE_RATIO);
    const keys = [...seenCompactions.keys()];
    for (let i = 0; i < toDelete; i++) {
      seenCompactions.delete(keys[i]);
    }
    console.error(`[mcp-memory] pruned ${toDelete} oldest compaction dedup entries (size was ${size})`);
  }
}, SEEN_CLEANUP_INTERVAL_MS).unref();

let pollFailures = 0;

async function pollCompaction() {
  try {
    // 指数退避：连续失败次数越多，跳过本轮
    if (pollFailures > 0) {
      const skip = Math.min(Math.pow(2, pollFailures), 64);
      if (Math.random() > 1 / skip) return;
    }
    const sessionsRes = await fetch(`${apiUrl}/api/sessions`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(POLL_FETCH_TIMEOUT),
    });
    if (!sessionsRes.ok) { pollFailures++; return; }

    const sessions: PolledSession[] = await sessionsRes.json();
    if (!Array.isArray(sessions)) { pollFailures++; return; }

    const CONCURRENCY = POLL_CONCURRENCY;
    const activeSessions = sessions.filter((s: PolledSession) => s.id);
    for (let i = 0; i < activeSessions.length; i += CONCURRENCY) {
      const batch = activeSessions.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (session: PolledSession) => {
          try {
            const msgsRes = await fetch(
              `${apiUrl}/api/sessions/${session.id}/messages?limit=${POLL_MESSAGE_LIMIT}&order=desc`,
              { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(POLL_FETCH_TIMEOUT) },
            );
            if (!msgsRes.ok) return;

            const messages: PolledMessage[] = await msgsRes.json();
            if (!Array.isArray(messages)) { pollFailures++; return; }

            for (const msg of messages) {
              if (!msg.parts || !msg.id) continue;

              const dedupKey = `${session.id}:${msg.id}`;
              if (seenCompactions.has(dedupKey)) continue;

              for (const part of msg.parts) {
                if (part.type === "compaction" && part.text) {
                  await store.saveSummary(part.text, session.id);
                  seenCompactions.set(dedupKey, true);
                  console.error(`[mcp-memory] captured compaction for session ${session.id} msg ${msg.id}`);
                }
              }
            }
          } catch (err) {
            if (err instanceof TypeError && (err as Error).message?.includes("fetch")) {
              console.error(`[mcp-memory] compaction poller: network error (is OpenCode running?)`);
            } else {
              console.error(`[mcp-memory] compaction poller error:`, err);
            }
          }
        }),
      );
    }
    pollFailures = 0; // 成功重置退避计数
  } catch (err) {
    pollFailures++;
    if (err instanceof TypeError && (err as Error).message?.includes("fetch")) {
      console.error(`[mcp-memory] compaction poller: network error (is OpenCode running?)`);
    } else {
      console.error(`[mcp-memory] compaction poller error:`, err);
    }
  }
}

if (pollInterval > 0) {
  pollTimer = setInterval(pollCompaction, pollInterval);
  console.error(`[mcp-memory] compaction poller started (interval: ${pollInterval}ms, api: ${apiUrl})`);
}

// ---------------------------------------------------------------------------
// Ollama 可用性定期刷新（若 OLLAMA_URL 设置了但 Ollama 在 mcp-memory 之后才启动）
// ---------------------------------------------------------------------------

let ollamaRefreshTimer: ReturnType<typeof setInterval> | null = null;
if (process.env.OLLAMA_URL) {
  ollamaRefreshTimer = setInterval(() => {
    embedder.refresh().catch(() => {});
  }, OLLAMA_REFRESH_INTERVAL).unref();
}

// ---------------------------------------------------------------------------
// 后台 re-embed 定时器 — 补算缺失的 embedding
// ---------------------------------------------------------------------------

const reembedInterval = parseInt(process.env.MCP_MEMORY_REEMBED_INTERVAL ?? "0", 10);
let reembedTimer: ReturnType<typeof setInterval> | null = null;
if (reembedInterval > 0) {
  reembedTimer = setInterval(() => {
    store.reembedMissing().catch((e) => console.error("[mcp-memory] reembed error:", e));
  }, reembedInterval).unref();
  console.error(`[mcp-memory] re-embedder started (interval: ${reembedInterval}ms)`);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-memory] server running on stdio");
}

main().catch((error) => {
  console.error("[mcp-memory] fatal:", error);
  process.exit(1);
});

async function shutdown() {
  if (pollTimer) clearInterval(pollTimer);
  if (reembedTimer) clearInterval(reembedTimer);
  if (ollamaRefreshTimer) clearInterval(ollamaRefreshTimer);
  try {
    const flushed = await Promise.race([
      store.flushDirtySessions(),
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error("flush timeout")), SHUTDOWN_TIMEOUT),
      ),
    ]);
    if (flushed > 0) console.error(`[mcp-memory] flushed ${flushed} dirty sessions before shutdown`);
  } catch (e) {
    console.error("[mcp-memory] flush error on shutdown:", e);
  }
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
