import { Database } from "bun:sqlite";
import fs from "fs/promises";
import { mkdirSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { buildFtsQuery } from "./fts-query";
import { buildPath, defaultMemoryRoot, parsePath } from "./paths";
import { addCjkSpacing, removeCjkSpacing } from "./cjk";
import { Embedder } from "./embedder";
import type { BatchDeleteInput, ListInput, MemoryEntry, MemoryStats, SaveInput, SearchInput, SearchResult, UpdateInput, Scope, CheckpointData, PromoteInput } from "./types";

const DB_FILENAME = "memory.db";
const SCHEMA_VERSION = 1;
const MAX_CONTENT_SIZE = 1024 * 1024;
const MAX_LIST_LIMIT = 1000;
const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_SEARCH_LIMIT = 10;
const FETCH_MULTIPLIER = 3;
const MAX_FETCH_LIMIT = 200;
const BM25_FLOOR_RATIO = 0.15;
const MAX_COMPACTION_CACHE = 100;

export class MemoryStore {
  private db: Database;
  readonly root: string;
  private writeQueue = new Map<string, Promise<void>>();
  private compactionBodies = new Map<string, { body: string; size: number }>();
  private embedder: Embedder | null = null;
  /** 脏 session 追踪：有未消费 notes_append 的 session，进程退出时自动 flush */
  private dirtySessions = new Set<string>();

  constructor(root?: string, embedder?: Embedder) {
    this.root = root ?? defaultMemoryRoot();
    const dbPath = path.join(this.root, DB_FILENAME);
    mkdirSync(this.root, { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode=WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.embedder = embedder ?? null;
    if (this.embedder) this.embedder.isAvailable().catch(() => {});
    this.init();
  }

  private init() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);
    const version = this.db
      .query("SELECT value FROM memory_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (!version) {
      this.db.run("INSERT INTO memory_meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_fts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        scope TEXT NOT NULL,
        scope_id TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL,
        body TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        last_indexed_at INTEGER NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_fts_scope ON memory_fts(scope, scope_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_fts_type ON memory_fts(type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_fts_dedup ON memory_fts(scope, scope_id, type, body)`);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        path TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (path) REFERENCES memory_fts(path) ON DELETE CASCADE
      )
    `);
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_idx USING fts5(
        body,
        content='memory_fts',
        content_rowid='id',
        tokenize='porter unicode61'
      )
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory_fts BEGIN
        INSERT INTO memory_fts_idx(rowid, body) VALUES (new.id, new.body);
      END
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory_fts BEGIN
        INSERT INTO memory_fts_idx(memory_fts_idx, rowid, body) VALUES('delete', old.id, old.body);
      END
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE ON memory_fts BEGIN
        INSERT INTO memory_fts_idx(memory_fts_idx, rowid, body) VALUES('delete', old.id, old.body);
        INSERT INTO memory_fts_idx(rowid, body) VALUES (new.id, new.body);
      END
    `);
  }

  async save(input: SaveInput): Promise<{ path: string; type: string; indexed_at: number; deduplicated?: boolean }> {
    const type = input.type ?? "free";
    const scope_id = input.scope_id ?? "";
    if (!input.content || typeof input.content !== "string") {
      throw new Error("content is required and must be a string");
    }
    if (input.content.length > MAX_CONTENT_SIZE) {
      throw new Error("content exceeds maximum length (1MB)");
    }
    const spacedContent = addCjkSpacing(input.content);
    const dup = this.db
      .query(
        `SELECT path, last_indexed_at FROM memory_fts
         WHERE scope = ? AND scope_id = ? AND type = ? AND body = ?
         ORDER BY last_indexed_at DESC LIMIT 1`,
      )
      .get(input.scope, scope_id, type, spacedContent) as { path: string; last_indexed_at: number } | undefined;
    if (dup) {
      return { path: dup.path, type, indexed_at: dup.last_indexed_at, deduplicated: true };
    }
    if (type === "compaction") {
      return this.saveCompaction(input.content, input.scope, scope_id);
    }
    const key = `note-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const filePath = buildPath({ root: this.root, scope: input.scope, scope_id, key });
    const fullPath = filePath.replace(/\\/g, "/");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await Bun.write(filePath, input.content);
    const stat = await fs.stat(filePath);
    const fingerprint = `${stat.size}-${stat.mtimeMs}`;
    const now = Date.now();
    this.db.run("BEGIN IMMEDIATE");
    try {
      this._upsertMemoryEntry({ path: fullPath, scope: input.scope, scope_id, type, body: spacedContent, fingerprint, indexedAt: now });
      this.db.run("COMMIT");
    } catch (e) {
      this.db.run("ROLLBACK");
      throw e;
    }
    this.tryEmbedAsync(fullPath, spacedContent);
    return { path: fullPath, type, indexed_at: now };
  }

  private async saveCompaction(
    content: string,
    scope: string,
    scope_id: string,
  ): Promise<{ path: string; type: string; indexed_at: number }> {
    const filePath = buildPath({ root: this.root, scope: scope as Scope, scope_id, key: "compactions" });
    const fullPath = filePath.replace(/\\/g, "/");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const entry = `\n## ${new Date().toISOString()}\n\n${content}\n`;
    await this.withFileLock(fullPath, async () => {
      await fs.appendFile(filePath, entry, "utf-8");
    });
    let body: string;
    let fileSize: number;
    const cached = this.compactionBodies.get(fullPath);
    if (cached) {
      body = cached.body + entry;
      fileSize = cached.size + Buffer.byteLength(entry, "utf-8");
    } else {
      const fullContent = await Bun.file(filePath).text().catch(() => "");
      body = fullContent || entry;
      fileSize = Buffer.byteLength(body, "utf-8");
    }
    if (this.compactionBodies.size >= MAX_COMPACTION_CACHE && !this.compactionBodies.has(fullPath)) {
      const firstKey = this.compactionBodies.keys().next().value;
      if (firstKey) this.compactionBodies.delete(firstKey);
    }
    this.compactionBodies.set(fullPath, { body, size: fileSize });
    const now = Date.now();
    // 使用磁盘 stat 生成指纹，确保与 reconcile 的格式一致
    const fileStat = await fs.stat(filePath);
    const fingerprint = `${fileStat.size}-${fileStat.mtimeMs}`;
    this.db.run("BEGIN IMMEDIATE");
    try {
      this._upsertMemoryEntry({ path: fullPath, scope, scope_id, type: "compaction", body: addCjkSpacing(body), fingerprint, indexedAt: now });
      this.db.run("COMMIT");
    } catch (e) {
      this.db.run("ROLLBACK");
      throw e;
    }
    return { path: fullPath, type: "compaction", indexed_at: now };
  }

  async update(input: UpdateInput): Promise<{ path: string; indexed_at: number }> {
    const normalizedPath = input.path.replace(/\\/g, "/");
    const existing = this.db.query("SELECT path FROM memory_fts WHERE path = ?").get(normalizedPath) as { path: string } | undefined;
    if (!existing) throw new Error(`Entry not found: ${input.path}`);
    await Bun.write(normalizedPath, input.content);
    const stat = await fs.stat(normalizedPath);
    const spacedContent = addCjkSpacing(input.content);
    const fingerprint = `${stat.size}-${stat.mtimeMs}`;
    const now = Date.now();
    this.db.query("UPDATE memory_fts SET body = ?, fingerprint = ?, last_indexed_at = ?, scope = COALESCE(?, scope), scope_id = COALESCE(?, scope_id), type = COALESCE(?, type) WHERE path = ?")
      .run(spacedContent, fingerprint, now, input.scope ?? null, input.scope_id ?? null, input.type ?? null, normalizedPath);
    this.tryEmbedAsync(normalizedPath, spacedContent);
    return { path: normalizedPath, indexed_at: now };
  }

  async search(input: SearchInput): Promise<SearchResult[]> {
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
    const mode = input.search_mode ?? "hybrid";
    if (mode !== "hybrid" || !this.embedder) {
      return this._ftsSearch(input.query, input);
    }
    const ftsResults = this._ftsSearch(input.query, { ...input, limit: limit * FETCH_MULTIPLIER });
    const qVec = await this.embedder.embed(input.query);
    if (!qVec || ftsResults.length === 0) return ftsResults.slice(0, limit);
    const filter = this._buildFilterConditions({
      scope: input.scope, scope_id: input.scope_id, type: input.type,
    });
    const filterJoin = filter.conditions.length > 0
      ? `JOIN memory_fts f ON f.path = e.path WHERE ${filter.conditions.join(" AND ")}`
      : "";
    const vecRows = this.db.query(`
      SELECT e.path, e.embedding FROM memory_embeddings e
      ${filterJoin}
    `).all(...filter.params) as { path: string; embedding: Buffer }[];
    const vecScores = new Map<string, number>();
    for (const r of vecRows) {
      const stored = new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4);
      vecScores.set(r.path, this.embedder.cosineSimilarity(qVec, stored));
    }
    if (vecScores.size === 0) return ftsResults.slice(0, limit);
    const ftsMax = ftsResults[0]?.score ?? 1;
    const ftsMap = new Map(ftsResults.map((r) => [r.path, r.score / ftsMax]));
    const vecMax = Math.max(...vecScores.values(), 0.0001);
    for (const [k, v] of vecScores) vecScores.set(k, v / vecMax);
    const fused = new Map<string, number>();
    for (const [path, vs] of vecScores) {
      const fs = ftsMap.get(path) ?? 0;
      fused.set(path, 0.6 * vs + 0.4 * fs);
    }
    for (const [path, fs] of ftsMap) {
      if (!fused.has(path)) fused.set(path, 0.4 * fs);
    }
    const sorted = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    const ftsByPath = new Map(ftsResults.map((r) => [r.path, r]));
    return sorted.map(([path]) => ftsByPath.get(path)!).filter(Boolean);
  }

  private _ftsSearch(query: string, filterInput: { scope?: string; scope_id?: string; type?: string; limit?: number }): SearchResult[] {
    const limit = filterInput.limit ?? DEFAULT_SEARCH_LIMIT;
    const ftsQuery = buildFtsQuery(addCjkSpacing(query));
    if (!ftsQuery) return [];
    const filter = this._buildFilterConditions({
      scope: filterInput.scope,
      scope_id: filterInput.scope_id,
      type: filterInput.type,
      tableAlias: "memory_fts",
    });
    const whereClause = filter.conditions.length > 0 ? `AND ${filter.conditions.join(" AND ")}` : "";
    const fetchLimit = Math.min(limit * FETCH_MULTIPLIER, Math.max(limit, MAX_FETCH_LIMIT));
    const rows = this.db.query(`
      SELECT memory_fts.path, memory_fts.scope, memory_fts.scope_id, memory_fts.type,
             snippet(memory_fts_idx, 0, '<<', '>>', '...', 32) AS snippet,
             bm25(memory_fts_idx) AS score
      FROM memory_fts_idx
      JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid
      WHERE memory_fts_idx MATCH ?
      ${whereClause}
      ORDER BY score
      LIMIT ?
    `).all(ftsQuery, ...filter.params, fetchLimit) as any[];
    const mapped = rows.map((r: any) => ({
      path: r.path,
      scope: r.scope,
      scope_id: r.scope_id,
      type: r.type,
      snippet: removeCjkSpacing(r.snippet),
      score: -r.score,
    }));
    if (mapped.length === 0) return [];
    if (mapped.length <= limit) return mapped;
    const topScore = mapped[0].score;
    const cutoff = topScore * BM25_FLOOR_RATIO;
    return mapped.filter((r, i) => i === 0 || r.score >= cutoff).slice(0, limit);
  }

  list(input: ListInput): MemoryEntry[] {
    const limit = Math.min(input.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const offset = input.offset ?? 0;
    const filter = this._buildFilterConditions({
      scope: input.scope, scope_id: input.scope_id, type: input.type,
    });
    const whereClause = filter.conditions.length > 0 ? `WHERE ${filter.conditions.join(" AND ")}` : "";
    return this.db.query(`
      SELECT id, path, scope, scope_id, type, fingerprint, last_indexed_at
      FROM memory_fts
      ${whereClause}
      ORDER BY last_indexed_at DESC
      LIMIT ? OFFSET ?
    `).all(...filter.params, limit, offset) as MemoryEntry[];
  }

  async delete(filePath: string): Promise<boolean> {
    const normalized = filePath.replace(/\\/g, "/");
    const result = this.db.query("DELETE FROM memory_fts WHERE path = ?").run(normalized);
    try { await fs.unlink(normalized); } catch {}
    return result.changes > 0;
  }

  async reconcile(): Promise<{ indexed: number; pruned: number }> {
    const diskFiles = new Set<string>(await this.walkMemoryDir(this.root));
    const indexed = new Map<string, string>(
      (this.db.query("SELECT path, fingerprint FROM memory_fts").all() as { path: string; fingerprint: string }[]).map((r) => [r.path, r.fingerprint]),
    );
    let pruned = 0;
    for (const p of indexed.keys()) {
      if (!diskFiles.has(p)) { this.db.query("DELETE FROM memory_fts WHERE path = ?").run(p); pruned++; }
    }
    let indexedCount = 0;
    const diskArray = [...diskFiles];
    const RECONCILE_CONCURRENCY = 20;
    for (let i = 0; i < diskArray.length; i += RECONCILE_CONCURRENCY) {
      const batch = diskArray.slice(i, i + RECONCILE_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (p) => {
          const loc = parsePath(p);
          if (!loc) return null;
          const stat = await fs.stat(p).catch(() => null);
          if (!stat) return null;
          const fingerprint = `${stat.size}-${stat.mtimeMs}`;
          if (indexed.get(p) === fingerprint) return null;
          const body = await Bun.file(p).text();
          return { p, loc, body, fingerprint };
        }),
      );
      for (const r of results) {
        if (!r) continue;
        this.db.query(
          `INSERT INTO memory_fts (path, scope, scope_id, type, body, fingerprint, last_indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             scope = excluded.scope, scope_id = excluded.scope_id, type = excluded.type,
             body = excluded.body, fingerprint = excluded.fingerprint, last_indexed_at = excluded.last_indexed_at`,
        ).run(r.p, r.loc.scope, r.loc.scope_id, r.loc.type, addCjkSpacing(r.body), r.fingerprint, Date.now());
        indexedCount++;
      }
    }
    this.db.query("INSERT INTO memory_meta (key, value) VALUES ('last_reconciled_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(Date.now()));
    return { indexed: indexedCount, pruned };
  }

  stats(): MemoryStats {
    const total = this.db.query("SELECT COUNT(*) as count FROM memory_fts").get() as { count: number };
    const scopeRows = this.db.query("SELECT scope, COUNT(*) as count FROM memory_fts GROUP BY scope").all() as { scope: string; count: number }[];
    const scopes: Record<string, number> = {};
    for (const r of scopeRows) scopes[r.scope] = r.count;
    const lastReconciled = (this.db.query("SELECT value FROM memory_meta WHERE key = 'last_reconciled_at'").get() as { value: string } | undefined)?.value;
    return {
      total_docs: total.count,
      total_size: (this.db.query("SELECT LENGTH(body) AS len FROM memory_fts").all() as { len: number }[]).reduce((sum, r) => sum + r.len, 0),
      last_reconciled: lastReconciled ? Number(lastReconciled) : 0,
      scopes,
    };
  }

  async saveSummary(summary: string, sessionID: string): Promise<void> {
    await this.save({ content: summary, scope: "sessions", scope_id: sessionID, type: "compaction" });
  }

  private async walkMemoryDir(dir: string): Promise<string[]> {
    const out: string[] = [];
    try {
      for await (const entry of new Bun.Glob("**/*.md").scan({ cwd: dir, absolute: true })) {
        out.push(entry.replace(/\\/g, "/"));
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return out;
      console.error(`[mcp-memory] walkMemoryDir error:`, e);
      throw e;
    }
    return out;
  }

  private _buildFilterConditions(input: { scope?: string; scope_id?: string; type?: string; tableAlias?: string }): { conditions: string[]; params: (string | number)[] } {
    const ALIAS_WHITELIST = new Set(["memory_fts", "f", "e"]);
    if (input.tableAlias && !ALIAS_WHITELIST.has(input.tableAlias))
      throw new Error(`Invalid table alias: ${input.tableAlias}`);
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    const prefix = input.tableAlias ? `${input.tableAlias}.` : "";
    if (input.scope) { conditions.push(`${prefix}scope = ?`); params.push(input.scope); }
    if (input.scope_id) { conditions.push(`${prefix}scope_id = ?`); params.push(input.scope_id); }
    if (input.type) { conditions.push(`${prefix}type = ?`); params.push(input.type); }
    return { conditions, params };
  }

  private _upsertMemoryEntry(params: { path: string; scope: string; scope_id: string; type: string; body: string; fingerprint: string; indexedAt: number }): void {
    this.db.query(
      `INSERT INTO memory_fts (path, scope, scope_id, type, body, fingerprint, last_indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         body = excluded.body, fingerprint = excluded.fingerprint, last_indexed_at = excluded.last_indexed_at`,
    ).run(params.path, params.scope, params.scope_id, params.type, params.body, params.fingerprint, params.indexedAt);
  }

  private async withFileLock(filePath: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.writeQueue.get(filePath);
    const next = (prev ?? Promise.resolve()).then(() => fn(), () => fn());
    this.writeQueue.set(filePath, next.finally(() => {
      if (this.writeQueue.get(filePath) === next) this.writeQueue.delete(filePath);
    }));
    return next;
  }

  async deleteByScope(input: BatchDeleteInput): Promise<{ deleted: number }> {
    const filter = this._buildFilterConditions(input);
    const whereClause = filter.conditions.length > 0 ? `WHERE ${filter.conditions.join(" AND ")}` : "";
    if (!whereClause) return { deleted: 0 };
    const paths = this.db.query(`SELECT path FROM memory_fts ${whereClause}`).all(...filter.params) as { path: string }[];
    this.db.query(`DELETE FROM memory_fts ${whereClause}`).run(...filter.params);
    for (const p of paths) { try { await fs.unlink(p.path); } catch {} }
    return { deleted: paths.length };
  }

  /** 按 path 获取单条记忆全文 */
  get(path: string): string | null {
    const row = this.db.query("SELECT body FROM memory_fts WHERE path = ?").get(path) as { body: string } | undefined;
    return row ? removeCjkSpacing(row.body) : null;
  }

  // ---- MiMo Code 启发的新功能 ----

  /** 写入结构化 checkpoint（11 字段，覆盖 session 工作状态） */
  async saveCheckpoint(scope_id: string, data: CheckpointData): Promise<{ path: string; indexed_at: number }> {
    const NL = "\n";
    const pairs: [string, string][] = [
      ["intent", data.intent ?? ""],
      ["next_action", data.next_action ?? ""],
      ["constraints", data.constraints ?? ""],
      ["task_tree", data.task_tree ?? ""],
      ["working_on", data.working_on ?? ""],
      ["findings", data.cross_task_findings ?? ""],
      ["errors_fixes", data.errors_fixes ?? ""],
      ["runtime_state", data.runtime_state ?? ""],
      ["decisions", data.design_decisions ?? ""],
      ["notes", data.notes ?? ""],
    ];
    const fields: string[] = [];
    for (const [k, v] of pairs) {
      if (v) fields.push("## " + k + NL + NL + v);
    }
    if (data.files?.length) fields.push("## files" + NL + NL + data.files.join(NL));
    const content = fields.join(NL + NL + "---" + NL + NL);
    return this.save({ content, scope: "sessions", scope_id, type: "checkpoint" });
  }

  /** 将记忆从低作用域提升到高作用域（session -> projects -> global） */
  async promote(input: PromoteInput): Promise<{ path: string; indexed_at: number }> {
    const row = this.db.query("SELECT scope, scope_id, type, body FROM memory_fts WHERE path = ?").get(input.path) as
      { scope: string; scope_id: string; type: string; body: string } | undefined;
    if (!row) throw new Error("Entry not found: " + input.path);
    return this.save({
      content: removeCjkSpacing(row.body),
      scope: input.target_scope,
      scope_id: input.target_scope_id ?? "",
      type: (input.type ?? row.type) as any,
    });
  }

  /** 追加笔记到 notes.md（scratchpad 模式，Agent 随时写，writer 定期消费） */
  async notesAppend(scope_id: string, note: string): Promise<{ path: string; indexed_at: number }> {
    const filePath = buildPath({ root: this.root, scope: "sessions", scope_id, key: "notes" });
    const fullPath = filePath.replace(/\\/g, "/");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const entry = "\n- " + new Date().toISOString() + ": " + note + "\n";
    await fs.appendFile(filePath, entry, "utf-8");
    const body = await Bun.file(fullPath).text().catch(() => "");
    const now = Date.now();
    this.db.query(
      "INSERT INTO memory_fts (path, scope, scope_id, type, body, fingerprint, last_indexed_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET body=excluded.body, fingerprint=excluded.fingerprint, last_indexed_at=excluded.last_indexed_at",
    ).run(fullPath, "sessions", scope_id, "notes", addCjkSpacing(body), "0-" + now, now);
    this.dirtySessions.add(scope_id);
    return { path: fullPath, indexed_at: now };
  }

  /** 读取并清空 notes.md（writer 路由后调用，将零散笔记归入结构化字段） */
  async notesFlush(scope_id: string): Promise<string> {
    const filePath = buildPath({ root: this.root, scope: "sessions", scope_id, key: "notes" });
    const fullPath = filePath.replace(/\\/g, "/");
    const content = await Bun.file(fullPath).text().catch(() => "");
    if (!content) { this.dirtySessions.delete(scope_id); return ""; }
    // 归档副本，防消费方丢失
    const archivePath = buildPath({ root: this.root, scope: "sessions", scope_id, key: `notes-archive-${Date.now()}` });
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await Bun.write(archivePath, content);
    await Bun.write(fullPath, "");
    this.db.query("DELETE FROM memory_fts WHERE path = ?").run(fullPath);
    this.dirtySessions.delete(scope_id);
    return content;
  }

  /** 为缺少 embedding 的条目补算向量，每次最多 50 条 */
  async reembedMissing(): Promise<number> {
    if (!this.embedder || !(await this.embedder.isAvailable())) return 0;
    const rows = this.db.query(`
      SELECT f.path, f.body FROM memory_fts f
      LEFT JOIN memory_embeddings e ON f.path = e.path
      WHERE e.path IS NULL
      LIMIT 50
    `).all() as { path: string; body: string }[];
    let count = 0;
    const CONCURRENCY = 5;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (r) => {
          const vec = await this.embedder!.embed(removeCjkSpacing(r.body));
          if (!vec) return null;
          const blob = Buffer.from(vec.buffer);
          return { path: r.path, blob };
        }),
      );
      for (const res of results) {
        if (!res) continue;
        this.db.query(
          `INSERT INTO memory_embeddings (path, embedding, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET embedding = excluded.embedding, updated_at = excluded.updated_at`,
        ).run(res.path, res.blob, Date.now());
        count++;
      }
    }
    return count;
  }

  /** Embedding 去抖缓存：避免短时间内重复嵌入同一 path */
  private embedDebounce = new Map<string, number>();
  private readonly EMBED_DEBOUNCE_MS = 2000;

  private tryEmbedAsync(path: string, body: string): void {
    if (!this.embedder) return;
    const now = Date.now();
    const last = this.embedDebounce.get(path);
    if (last && now - last < this.EMBED_DEBOUNCE_MS) return;
    this.embedDebounce.set(path, now);
    this.embedder.isAvailable().then((ok) => {
      if (!ok) return;
      return this.embedder!.embed(body).then((vec) => {
        if (!vec) return;
        const blob = Buffer.from(vec.buffer);
        this.db
          .query(
            `INSERT INTO memory_embeddings (path, embedding, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET embedding = excluded.embedding, updated_at = excluded.updated_at`,
          )
          .run(path, blob, Date.now());
      });
    }).catch(() => {});
    // 清理过期缓存，防止内存泄漏
    if (this.embedDebounce.size > 1000) {
      const cutoff = now - this.EMBED_DEBOUNCE_MS;
      for (const [k, t] of this.embedDebounce) {
        if (t < cutoff) this.embedDebounce.delete(k);
      }
    }
  }

  /** flush 所有脏 session 的笔记 → 持久化记忆 */
  async flushDirtySessions(): Promise<number> {
    if (this.dirtySessions.size === 0) return 0;
    const sessions = [...this.dirtySessions];
    let count = 0;
    for (const sid of sessions) {
      const notes = await this.notesFlush(sid);
      if (!notes) continue;
      try {
        await this.save({ content: notes, scope: "sessions", scope_id: sid, type: "notes" });
        count++;
      } catch (e) {
        console.error(`[mcp-memory] flushDirtySessions save error for ${sid}:`, e);
      }
    }
    return count;
  }

  /** 返回脏 session 列表 */
  getDirtySessions(): string[] {
    return [...this.dirtySessions];
  }

  close() {
    this.db.close();
  }
}
