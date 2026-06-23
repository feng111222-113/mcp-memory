# mcp-memory — Agent Guide

Bun-only MCP server for persistent memory across OpenCode sessions. Markdown files on disk + SQLite FTS5 search.

## Runtime & Build

- **Bun only** — uses `bun:sqlite`, runs `.ts` directly. NOT Node.js-compatible.
- `tsconfig.json` has `noEmit: true`; no compile step needed.
- Only dependency: `@modelcontextprotocol/sdk`.

## Key Commands

```bash
bun install                          # install
bun run src/index.ts                 # dev / run directly
bunx @mimochamber/memory-server      # run published version
```

### Tests (all are child-process integration tests over JSON-RPC stdio)

```bash
bun run test.mjs                # smoke test
bun run test-dedup.mjs          # dedup test
bun run test-compaction.mjs     # compaction append test
```

- Tests spawn the server as a child process via `bun run src/index.ts`.
- All set `MCP_MEMORY_POLL_INTERVAL=0` to disable compaction polling.
- Use `.test-memory/` temp dir (in `.gitignore`), cleaned up after run.
- No test framework — plain `.mjs` scripts, JSON-RPC over stdin/stdout.
- There is no CI pipeline (no `.github/workflows/`).

### Publishing

```powershell
.\scripts\publish.ps1            # dry-run (npm pack --dry-run)
.\scripts\publish.ps1 -Execute   # npm publish --access public
```

## Architecture

Single module, 5 source files:

```
src/
  index.ts      — MCP server setup, tool handlers, compaction poller
  store.ts      — MemoryStore: SQLite DB + file ops (core logic)
  fts-query.ts  — Builds FTS5 MATCH expression from user query (OR-join tokens)
  paths.ts      — Memory directory layout, path parsing/building, safety checks
  types.ts      — TypeScript types
bin/
  mcp-memory.js — npm binary entry (chdirs to pkg dir, imports src/index.ts)
```

### Entry point

- **Dev**: `src/index.ts` — imports directly, Bun runs it.
- **Production**: `bin/mcp-memory.js` — changes CWD to package root, then `import("../src/index.ts")`.

### MemoryStore (`src/store.ts`)

- SQLite DB (`memory.db`) with FTS5 virtual table in external-content mode.
- FTS5 tokenizer: `porter unicode61` (does NOT split CJK individually by default).
- **CJK preprocessing**: `addCjkSpacing()` inserts spaces after every CJK character before FTS5 indexing, so each CJK character becomes a separate FTS5 token. `removeCjkSpacing()` reverses this on search results. Both query and content go through this pretreatment.
- Triggers auto-sync `memory_fts` table ↔ FTS5 index on INSERT/UPDATE/DELETE.
- Fingerprint = `${size}-${mtimeMs}` for incremental reconcile.
- Path safety: `assertSafeComponent` rejects `..`, null bytes, Windows absolute paths.
- Write safety: per-file `writeQueue` serializes concurrent compaction appends.

### Compaction poller (`src/index.ts`)

- Background polling of OpenCode API (`GET /api/sessions`, `GET /api/sessions/:id/messages`).
- Detects messages with `part.type === "compaction"`, saves via `saveSummary()`.
- **Concurrency**: processes up to 5 sessions in parallel per batch.
- Dedup: seenCompactions Map with `sessionId:msgId` keys; prunes oldest 20% at 10k entries (10min interval).

## MCP Tools

| Tool | Notes |
|---|---|
| `memory_save` | Default scope=`sessions`, type=`free`. Content validated: required, max 1MB. Compaction type uses **append-only single file** (`compactions.md`). Exact dedup: same scope+scope_id+type+body returns `deduplicated: true`. |
| `memory_recall` | FTS5 BM25 search. Returns ≥15% of top score (relative floor filter). Default limit=10. CJK queries auto-preprocessed for correct tokenization. |
| `memory_list` | Paginated: default limit=50, offset=0. Hard cap at 1000 rows. |
| `memory_reconcile` | Syncs disk `.md` ↔ FTS index (two-way). Called once at startup. |
| `memory_stats` | Returns `total_docs`, `total_size` (bytes), `last_reconciled`, `scopes` breakdown. |

## Search Quirk

FTS5 MATCH uses OR-join of quoted tokens (`"token1" OR "token2"`) — high recall, BM25 handles ranking. Single-token queries work fine.

### CJK Search

Bun's SQLite `unicode61` tokenizer treats consecutive CJK characters as ONE token. To work around this, the server preprocesses both content and queries:

- **Content indexing**: `addCjkSpacing()` inserts a space after every CJK character before FTS5 insert
- **Query**: same preprocessing applied to user query before `buildFtsQuery()`
- **Display**: `removeCjkSpacing()` strips the spacing from snippets and list results

This means "持久化" is indexed as `持 久 化` (3 FTS5 tokens) and queried as `"持" OR "久" OR "化"` → matches correctly.

## Memory Directory Layout

```
~/.mcp-memory/
  global/               # scope=global (scope_id ignored)
  projects/<hash>/      # scope=projects, scope_id=SHA256(abspath)[:12]
  sessions/<id>/        # scope=sessions, includes notes.md + compactions.md
```

- `resolveProjectId(abspath)` produces 12-char hex SHA256 hash for stable project IDs.
- Type inferred from filename prefixes: `memory`/`memory-` → type=memory, `checkpoint`/`checkpoint-` → type=checkpoint, `compaction-` → type=compaction, `tasks/*/progress` → type=progress, `tasks/*/notes` → type=notes.

## Env Variables

| Variable | Default | Notes |
|---|---|---|
| `MCP_MEMORY_ROOT` | `~/.mcp-memory` | Set to change storage location. Tests end up in `.test-memory/` relative to CWD because test env uses `MCP_MEMORY_POLL_INTERVAL=0` without setting ROOT. |
| `OPENCODE_API_URL` | `http://127.0.0.1:4096` | API endpoint for compaction polling. |
| `MCP_MEMORY_POLL_INTERVAL` | `30000` | ms. Set to `0` to disable polling (all tests do this). |

## Platform Notes

- All paths normalized with `.replace(/\\/g, "/")` — works on Windows and POSIX.
- `defaultMemoryRoot()` falls back to `USERPROFILE` on Windows, `HOME` on POSIX.
- Memory files are plain `.md` — human-readable, editable outside the server.
- **Windows test quirk**: if `bun` is installed via npm (`node_modules/bun/bin/bun.exe`), `child_process.spawn("bun")` fails because it's a `.cmd` wrapper. Tests set `shell: true` on Windows to work around this.
- **Windows encoding quirk**: Bun writes UTF-8 to stdout, but Windows console defaults to code page 936 (GBK). For proper CJK display, the server runs `chcp 65001` on startup.
