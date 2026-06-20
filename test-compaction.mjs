/**
 * Compaction 测试：验证单文件追加模式
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

function callTool(name, args) {
  return request("tools/call", { name, arguments: args });
}

async function run() {
  const child = spawn("bun", ["run", serverPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MCP_MEMORY_POLL_INTERVAL: "0" },
  });

  let output = "";
  const results = [];
  child.stdout.on("data", (chunk) => (output += chunk.toString()));
  child.stderr.on("data", () => {});

  const sends = [
    callTool("memory_save", { content: "第一次 compaction 摘要", scope: "sessions", scope_id: "test-cmp", type: "compaction" }),
    callTool("memory_save", { content: "第二次 compaction 摘要（新的）", scope: "sessions", scope_id: "test-cmp", type: "compaction" }),
    callTool("memory_recall", { query: "compaction" }),
    callTool("memory_stats", {}),
  ];

  for (const s of sends) {
    child.stdin.write(s);
    await new Promise((r) => setTimeout(r, 300));
  }

  child.stdin.end();
  await new Promise((resolve) => child.on("exit", resolve));

  for (const line of output.trim().split("\n")) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.result?.content) {
        results.push(JSON.parse(parsed.result.content[0].text));
      }
    } catch {}
  }

  console.log("=== Compaction 单文件测试 ===\n");

  const path1 = results[0]?.path || "";
  const path2 = results[1]?.path || "";

  console.log(`第一次路径: ${path1}`);
  console.log(`第二次路径: ${path2}`);
  console.log(`同一文件: ${path1 === path2 ? "✅" : "❌"}`);

  const recall = results[2] || [];
  console.log(`搜索 'compaction' 结果数: ${recall.length}`);
  if (recall.length >= 2) {
    console.log("✅ 两条 compaction 内容都能搜到");
  }

  console.log(`最终统计: ${results[3]?.total_docs} 条文档`);
  if (results[3]?.total_docs === 1) {
    console.log("✅ 只有 1 条文档（单文件追加）");
  }

  // 清理
  const fs = await import("fs/promises");
  const testDir = resolve(__dirname, ".test-memory");
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
}

run().catch(console.error);
