/**
 * 去重测试：保存相同内容两次，验证第二次返回 deduplicated=true
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

  // 发送请求
  const sends = [
    callTool("memory_save", { content: "这是去重测试内容", scope: "sessions", scope_id: "test-dedup", type: "notes" }),
    callTool("memory_save", { content: "这是去重测试内容", scope: "sessions", scope_id: "test-dedup", type: "notes" }),
    callTool("memory_save", { content: "这是去重测试内容", scope: "sessions", scope_id: "test-dedup", type: "notes" }),
    callTool("memory_stats", {}),
  ];

  for (const s of sends) {
    child.stdin.write(s);
    await new Promise((r) => setTimeout(r, 300));
  }

  child.stdin.end();
  await new Promise((resolve) => child.on("exit", resolve));

  // 解析 JSON-RPC 响应
  for (const line of output.trim().split("\n")) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.result?.content) {
        results.push(JSON.parse(parsed.result.content[0].text));
      }
    } catch {}
  }

  console.log("=== 去重测试 ===\n");

  // 验证结果
  console.log(`第一次保存: path=${results[0]?.path?.slice(-30)}, deduplicated=${results[0]?.deduplicated}`);
  console.log(`第二次保存: path=${results[1]?.path?.slice(-30)}, deduplicated=${results[1]?.deduplicated}`);
  console.log(`第三次保存: path=${results[2]?.path?.slice(-30)}, deduplicated=${results[2]?.deduplicated}`);
  console.log(`最终统计: ${results[3]?.total_docs} 条文档`);

  const allDeduped = results[1]?.deduplicated && results[2]?.deduplicated;
  const singleDoc = results[3]?.total_docs === 1;

  if (allDeduped && singleDoc) {
    console.log(`\n✅ 去重生效：3 次保存只产生 1 条文档，后 2 次返回 deduplicated=true`);
  } else {
    console.log(`\n❌ 去重异常：${JSON.stringify(results)}`);
  }

  // 清理
  const fs = await import("fs/promises");
  const testDir = resolve(__dirname, ".test-memory");
  await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
}

run().catch(console.error);
