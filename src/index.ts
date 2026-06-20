/**
 * MCP Memory Server
 *
 * 跨会话持久化记忆系统。Markdown 文件即记忆 + SQLite FTS5 搜索。
 * 后台轮询 OpenCode API 自动捕获 compaction 摘要。
 *
 * 环境变量:
 *   MCP_MEMORY_ROOT       - 记忆存储根目录（默认 ~/.mcp-memory）
 *   OPENCODE_API_URL      - OpenCode API 地址（默认 http://127.0.0.1:4096）
 *   MCP_MEMORY_POLL_INTERVAL - 轮询间隔 ms（默认 30000）
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { MemoryStore } from "./store";

// ---------------------------------------------------------------------------
// 初始化存储
// ---------------------------------------------------------------------------

const store = new MemoryStore(process.env.MCP_MEMORY_ROOT);

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
            enum: ["global", "projects", "sessions"],
            description: "作用域：global=跨项目，projects=项目级，sessions=会话级",
          },
          scope_id: {
            type: "string",
            description: "项目或会话 ID（scope=global 时忽略）",
          },
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
      description: "搜索记忆。使用 SQLite FTS5 全文搜索 + BM25 排序。支持自然语言查询。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索词" },
          scope: {
            type: "string",
            enum: ["global", "projects", "sessions"],
            description: "过滤：作用域",
          },
          scope_id: { type: "string", description: "过滤：项目/会话 ID" },
          type: {
            type: "string",
            enum: ["memory", "checkpoint", "compaction", "notes", "free"],
            description: "过滤：记忆类型",
          },
          limit: { type: "number", description: "返回条数（默认 10）" },
        },
        required: ["query"],
      },
    },
    {
      name: "memory_list",
      description: "列出已存储的记忆条目",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string" },
          scope_id: { type: "string" },
          type: { type: "string" },
          limit: { type: "number", description: "默认 50" },
          offset: { type: "number", description: "默认 0" },
        },
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
      name: "memory_reconcile",
      description: "手动触发磁盘 .md 文件 → FTS 索引增量同步",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

// --- CallTool ---

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "memory_save": {
        const result = await store.save({
          content: String(args?.content ?? ""),
          scope: (args?.scope as "global" | "projects" | "sessions") ?? "sessions",
          scope_id: args?.scope_id as string | undefined,
          type: args?.type as "compaction" | "free" | undefined,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      }

      case "memory_recall": {
        const results = store.search({
          query: String(args?.query ?? ""),
          scope: args?.scope as string | undefined,
          scope_id: args?.scope_id as string | undefined,
          type: args?.type as string | undefined,
          limit: typeof args?.limit === "number" ? args.limit : undefined,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(results) }],
        };
      }

      case "memory_list": {
        const entries = store.list({
          scope: args?.scope as string | undefined,
          scope_id: args?.scope_id as string | undefined,
          type: args?.type as string | undefined,
          limit: typeof args?.limit === "number" ? args.limit : undefined,
          offset: typeof args?.offset === "number" ? args.offset : undefined,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(entries) }],
        };
      }

      case "memory_delete": {
        const deleted = await store.delete(String(args?.path ?? ""));
        return {
          content: [{ type: "text", text: JSON.stringify({ deleted }) }],
        };
      }

      case "memory_stats": {
        const stats = store.stats();
        return {
          content: [{ type: "text", text: JSON.stringify(stats) }],
        };
      }

      case "memory_reconcile": {
        const result = await store.reconcile();
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      }

      default:
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
        };
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: String(error) }],
    };
  }
});

// ---------------------------------------------------------------------------
// 后台轮询 — 自动检测 OpenCode compaction 事件
// ---------------------------------------------------------------------------

const pollInterval = parseInt(process.env.MCP_MEMORY_POLL_INTERVAL || "30000", 10);
const apiUrl = (process.env.OPENCODE_API_URL || "http://127.0.0.1:4096").replace(/\/+$/, "");

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
const seenCompactions = new Set<string>();
const SEEN_CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 分钟清理一次
const SEEN_MAX_SIZE = 10000; // 最多保留 10000 条记录

// 周期性清理 seenCompactions，防止内存泄漏
setInterval(() => {
  if (seenCompactions.size > SEEN_MAX_SIZE) {
    seenCompactions.clear();
    console.error(`[mcp-memory] cleared compaction dedup set (size exceeded ${SEEN_MAX_SIZE})`);
  }
}, SEEN_CLEANUP_INTERVAL).unref();

async function pollCompaction() {
  try {
    // 获取活跃会话列表
    const sessionsRes = await fetch(`${apiUrl}/api/sessions`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!sessionsRes.ok) return;

    const sessions: PolledSession[] = await sessionsRes.json();
    if (!Array.isArray(sessions)) return;

    for (const session of sessions) {
      if (!session.id) continue;

      // 获取该会话的最新消息（取后 5 条检查是否包含 compaction）
      const msgsRes = await fetch(
        `${apiUrl}/api/sessions/${session.id}/messages?limit=5&order=desc`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5000) },
      );
      if (!msgsRes.ok) continue;

      const messages: PolledMessage[] = await msgsRes.json();
      if (!Array.isArray(messages)) continue;

      for (const msg of messages) {
        if (!msg.parts || !msg.id) continue;

        // ② Compaction ID 去重
        const dedupKey = `${session.id}:${msg.id}`;
        if (seenCompactions.has(dedupKey)) continue;

        for (const part of msg.parts) {
          if (part.type === "compaction" && part.text) {
            // 检测到 compaction 摘要 → 保存到记忆
            await store.saveSummary(part.text, session.id);
            seenCompactions.add(dedupKey);
            console.error(`[mcp-memory] captured compaction for session ${session.id} msg ${msg.id}`);
          }
        }
      }
    }
  } catch {
    // OpenCode 可能未运行或 API 不可达，静默跳过
  }
}

// 启动轮询
if (pollInterval > 0) {
  pollTimer = setInterval(pollCompaction, pollInterval);
  console.error(`[mcp-memory] compaction poller started (interval: ${pollInterval}ms, api: ${apiUrl})`);
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

// 清理
process.on("SIGINT", () => {
  if (pollTimer) clearInterval(pollTimer);
  store.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  if (pollTimer) clearInterval(pollTimer);
  store.close();
  process.exit(0);
});
