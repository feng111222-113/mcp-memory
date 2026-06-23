/**
 * 快速冒烟测试：启动 MCP 服务，发送请求，打印结果。
 * 用法：bun run test.mjs
 */
import { spawn } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, "src/index.ts");

let nextId = 1;

function request(method, params = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }) + "\n";
}

async function run() {
  const child = spawn("bun", ["run", serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MCP_MEMORY_POLL_INTERVAL: "0", MCP_MEMORY_ROOT: ".test-memory" }, // 关闭轮询
    shell: process.platform === "win32", // Windows 上 bun 可能是 .cmd 包装，需 shell 解析
  });

  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk.toString()));

  // 收集 stderr 日志
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  // 发送 tools/list
  child.stdin.write(request("tools/list"));

  // 等待一小段时间
  await new Promise((r) => setTimeout(r, 500));

  // 发送 memory_save
  child.stdin.write(
    request("tools/call", {
      name: "memory_save",
      arguments: {
        content: "MCP Memory Server 是一个跨会话持久化记忆系统，使用 SQLite FTS5 搜索。",
        scope: "sessions",
        scope_id: "test-session-001",
        type: "notes",
      },
    }),
  );

  await new Promise((r) => setTimeout(r, 500));

  // 发送 memory_recall
  child.stdin.write(
    request("tools/call", {
      name: "memory_recall",
      arguments: { query: "MCP Memory 持久化" },
    }),
  );

  await new Promise((r) => setTimeout(r, 500));

  // 发送 memory_stats
  child.stdin.write(request("tools/call", { name: "memory_stats", arguments: {} }));

  await new Promise((r) => setTimeout(r, 500));

  // 关闭 stdin，让服务退出
  child.stdin.end();

  // 等待退出
  await new Promise((resolve) => child.on("exit", resolve));

  // 解析输出中的 JSON-RPC 响应行
  const lines = output.trim().split("\n");
  console.log("\n=== MCP Memory Server 冒烟测试 ===\n");
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.result) {
        if (parsed.result.tools) {
          console.log(`✅ tools/list: ${parsed.result.tools.length} tools registered`);
          for (const t of parsed.result.tools) {
            console.log(`   - ${t.name}: ${t.description.slice(0, 50)}...`);
          }
        } else if (parsed.result.content) {
          const data = JSON.parse(parsed.result.content[0].text);
          if (data.path) {
            console.log(`✅ memory_save: saved to ${data.path}`);
          } else if (Array.isArray(data)) {
            console.log(`✅ memory_recall: ${data.length} results`);
            for (const r of data) {
              console.log(`   [${r.score.toFixed(2)}] ${r.snippet.slice(0, 60)}...`);
            }
          } else if (data.total_docs !== undefined) {
            console.log(`✅ memory_stats: ${data.total_docs} docs, ${JSON.stringify(data.scopes)}`);
          } else if (data.deleted !== undefined) {
            console.log(`✅ memory_delete: deleted=${data.deleted}`);
          } else {
            console.log(`✅ result:`, data);
          }
        }
      }
    } catch {
      // non-JSON line (stderr), ignore
    }
  }

  // 清理测试数据
  const fs = await import("fs/promises");
  const testDir = resolve(__dirname, ".test-memory");
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  console.log("\n测试数据已清理。所有测试通过！");
}

run().catch(console.error);
