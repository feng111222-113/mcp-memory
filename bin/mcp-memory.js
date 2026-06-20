#!/usr/bin/env bun
/**
 * MCP Memory Server — CLI entry point for npm distribution.
 *
 * Usage:
 *   bunx @mimochamber/memory-server            # via bunx
 *   bun run node_modules/@mimochamber/memory-server/bin/mcp-memory.js
 *
 * Environment:
 *   MCP_MEMORY_ROOT       Memory root directory (default: ~/.mcp-memory)
 *   OPENCODE_API_URL      OpenCode API URL for compaction polling
 *   MCP_MEMORY_POLL_INTERVAL  Poll interval in ms (default: 30000, 0=off)
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// 确保 CWD 在包目录，使相对路径正常工作
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, "..");
process.chdir(pkgDir);

// 启动 MCP 服务器
await import("../src/index.ts");
