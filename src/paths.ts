import { createHash } from "crypto";
import path from "path";
import type { MemoryLocator, MemoryType, Scope } from "./types";

/**
 * Memory 目录中 .md 文件的路径匹配正则。
 *
 * /memory/(global|projects|sessions)(?:/([^/]+))?/(.+)\.md$
 *         scope             scope_id         key
 */
const MEMORY_PATH_RE = /\/memory\/(global|projects|sessions)(?:\/([^/]+))?\/(.+)\.md$/;

/** 类型检测模式：根据文件名前缀推断 type */
const TYPE_PATTERNS: Array<{ match: RegExp; type: MemoryType }> = [
  { match: /^memory$/i, type: "memory" },
  { match: /^memory-/i, type: "memory" },
  { match: /^checkpoint$/, type: "checkpoint" },
  { match: /^checkpoint-/, type: "checkpoint" },
  { match: /^compaction-/, type: "compaction" },
  { match: /^tasks\/[^/]+\/progress$/, type: "progress" },
  { match: /^tasks\/[^/]+\/notes$/, type: "notes" },
];

function detectType(key: string): MemoryType {
  for (const p of TYPE_PATTERNS) {
    if (p.match.test(key)) return p.type;
  }
  return "free";
}

/**
 * 解析 .md 文件绝对路径，提取 scope / scope_id / type。
 * 路径必须在 memory/ 目录树内。返回 null 表示不在记忆布局内。
 */
export function parsePath(absPath: string): MemoryLocator | null {
  const m = absPath.match(MEMORY_PATH_RE);
  if (!m) return null;
  const [, scope, idMaybe, keyRaw] = m;
  const scope_id = scope === "global" ? "" : idMaybe ?? "";
  return { scope: scope as Scope, scope_id, type: detectType(keyRaw), key: keyRaw };
}

/**
 * 安全构建记忆文件路径。防路径穿越（.. 和 / 开头）。
 */
function assertSafeComponent(value: string) {
  for (const segment of value.split("/")) {
    if (segment === "..") throw new Error(`buildPath: invalid path component: ${value}`);
  }
  if (value.startsWith("/")) throw new Error(`buildPath: invalid path component: ${value}`);
}

export function buildPath(input: {
  root: string;
  scope: Scope;
  scope_id?: string;
  key: string;
}): string {
  if (input.scope_id !== undefined) assertSafeComponent(input.scope_id);
  assertSafeComponent(input.key);
  const parts = [input.root, input.scope];
  if (input.scope !== "global") parts.push(input.scope_id ?? "");
  parts.push(`${input.key}.md`);
  return path.join(...parts);
}

/** 用 SHA256 哈希生成稳定、简短的项目 ID */
export function resolveProjectId(absRepoPath: string): string {
  return createHash("sha256").update(absRepoPath).digest("hex").slice(0, 12);
}

/** 默认的记忆目录根路径 */
export function defaultMemoryRoot(): string {
  // 优先使用环境变量，否则用 $HOME/.mcp-memory
  return process.env.MCP_MEMORY_ROOT || path.join(process.env.HOME || process.env.USERPROFILE || ".", ".mcp-memory");
}
