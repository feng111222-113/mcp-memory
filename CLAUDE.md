# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build / Test Commands

```bash
# Run all tests (sequential)
bun run test.mjs && bun run test-dedup.mjs && bun run test-compaction.mjs

# Run individual test
bun run test.mjs               # smoke test (save/recall/stats/list)
bun run test-dedup.mjs          # dedup: verify 3 saves → 1 doc
bun run test-compaction.mjs     # compaction: single-file append mode

# Type-check only (no emit)
bun run tsc

# Start server local dev
bun run src/index.ts

# Dry-run publish
.\scripts\publish.ps1
# Actual publish
.\scripts\publish.ps1 -Execute
```

Tests spawn the server as a subprocess, talk stdio JSON-RPC, then clean up `.test-memory/`. No test framework — pure `.mjs` scripts.

## Architecture

**MCP Memory Server** — cross-session persistent memory for AI coding assistants (OpenCode / Claude Code). Markdown files as the source of truth + SQLite FTS5 for search.

### Data flow

```
Agent (LLM) ↔ stdin/stdout (JSON-RPC) ↔ src/index.ts (MCP server) ↔ src/store.ts (MemoryStore) ↔ .md files on disk + SQLite FTS5 index
```

### Key source files

| File | Role |
|------|------|
| `src/index.ts` | MCP server setup, 8 tool handlers, background compaction poller (periodic fetch to OpenCode API) |
| `src/store.ts` | `MemoryStore` class: save, search (FTS5 BM25), list, delete, reconcile, stats. LRU compaction body cache, file-write serialization queue. |
| `src/paths.ts` | Path parsing regex (`/memory/{scope}/{scope_id?}/{key}.md`), safe path construction with traversal guards, `resolveProjectId()` for stable project hashes |
| `src/types.ts` | All TypeScript interfaces: `Scope`, `MemoryType`, `SaveInput`, `SearchInput` (now with `search_mode`), `MemoryEntry`, etc. |
| `src/fts-query.ts` | `buildFtsQuery()` — free-text → FTS5 MATCH, tokenize by `[\p{L}\p{N}_]+`, OR-join for recall, quoted for safety |
| `src/cjk.ts` | `addCjkSpacing()` / `removeCjkSpacing()` — insert spaces between CJK chars so FTS5 unicode61 tokenizer indexes each character individually |
| `src/embedder.ts` | Optional Ollama embedding integration. `Embedder` class with `isAvailable()`, `embed()` (nomic-embed-text, 768d), `cosineSimilarity()`. Async, fail-soft — Ollama down → pure FTS5. |
| `src/embedder.ts` | Ollama embedding (nomic-embed-text, 768d). `Embedder` class: `isAvailable()`, `embed()`, `cosineSimilarity()`. Async fail-soft. |

### Storage model

Three scopes: `global` (cross-project), `projects` (per-repo hash), `sessions` (per-session).

Memory types: `free`, `memory`, `checkpoint`, `compaction`, `notes`, `progress`. Inferred from file name prefix (e.g. `memory-*` → `memory`, `checkpoint-*` → `checkpoint`).

Compaction entries use **single-file append** (`compactions.md`), cached in memory to avoid re-reading on each append. All other types create new `.md` files per save.

### Search strategy

- FTS5 `content=` external content table with triggers for sync
- Tokenizer: `porter unicode61` — CJK spacing bridges the gap for Chinese/Japanese/Korean
- Query: OR-join tokens for high recall, then BM25 ranking + relative score floor (keep ≥15% of top score)
- Snippet via `snippet()` function with custom markers and 32-char context

### Anti-bloat

1. **Content dedup**: exact body match per (scope, scope_id, type) → returns `deduplicated: true`
2. **Compaction ID dedup**: in-memory Map of `sessionID:messageID`, prunes oldest 20% when >10k
3. **Single-file append**: compactions append to one file, not N files

### Reconcile

`reconcile()` walks `.md` files on disk with `Bun.Glob("**/*.md")`, compares `size-mtimeMs` fingerprint, inserts/updates/deletes from FTS index to match disk state. Runs once at startup.

## Common patterns

- **Adding a new tool**: declare schema in `ListToolsRequestSchema`, add `case` in `CallToolRequestSchema`, wire through `MemoryStore` method
- **New memory type**: add to `MemoryType` union in `types.ts`, add `TYPE_PATTERNS` entry in `paths.ts`
- **Error handling**: all tool handlers wrap in try/catch, return `{ isError: true, content: [{ type: "text", text: String(error) }] }`
