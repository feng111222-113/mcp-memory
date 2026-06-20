import { Database } from "bun:sqlite";
import fs from "fs/promises";
import path from "path";
import { buildFtsQuery } from "./fts-query";
import { buildPath, defaultMemoryRoot, parsePath } from "./paths";
import type { ListInput, MemoryEntry, MemoryStats, SaveInput, SearchInput, SearchResult, Scope } from "./types";

const DB_FILENAME = "memory.db";
const SCHEMA_VERSION = 1;

export class MemoryStore {
  private db: Database;
  readonly root: string;

  constructor(root?: string) {
    this.root = root ?? defaultMemoryRoot();
    const dbPath = path.join(this.root, DB_FILENAME);
    fs.mkdir(this.root, { recursive: true }).catch(() => {});
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode=WAL");
    this.init();
  }

  /** 初始化表结构和 FTS5 索引 */
  private init() {
    // 元数据表
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    // 检查 schema 版本
    const version = this.db
      .query("SELECT value FROM memory_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    if (!version) {
      this.db.run("INSERT INTO memory_meta (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
    }

    // 内容索引表
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

    // 辅助索引
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_memory_fts_scope ON memory_fts(scope, scope_id)
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_memory_fts_type ON memory_fts(type)
    `);

    // FTS5 全文搜索虚拟表（external content 模式）
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_idx USING fts5(
        body,
        content='memory_fts',
        content_rowid='id',
        tokenize='porter unicode61'
      )
    `);

    // 自动同步触发器
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

  /** 保存一条记忆到 .md 文件并索引 */
  async save(input: SaveInput): Promise<{ path: string; type: string; indexed_at: number; deduplicated?: boolean }> {
    const type = input.type ?? "free";
    const scope_id = input.scope_id ?? "";

    // ① Exact dedup：相同作用域下完全重复的内容跳过
    const dup = this.db
      .query(
        `SELECT path, last_indexed_at FROM memory_fts
         WHERE scope = ? AND scope_id = ? AND type = ? AND body = ?
         ORDER BY last_indexed_at DESC LIMIT 1`,
      )
      .get(input.scope, scope_id, type, input.content) as { path: string; last_indexed_at: number } | undefined;
    if (dup) {
      return { path: dup.path, type, indexed_at: dup.last_indexed_at, deduplicated: true };
    }

    // ③ Compaction 使用单文件追加模式
    if (type === "compaction") {
      return this.saveCompaction(input.content, input.scope, scope_id);
    }

    // 普通模式：每写一个新文件
    const key = `note-${Date.now()}`;
    const filePath = buildPath({ root: this.root, scope: input.scope, scope_id, key });
    const fullPath = filePath.replace(/\\/g, "/");

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await Bun.write(filePath, input.content);

    const stat = await fs.stat(filePath);
    const fingerprint = `${stat.size}-${stat.mtimeMs}`;
    const now = Date.now();

    this.db
      .query(
        `INSERT INTO memory_fts (path, scope, scope_id, type, body, fingerprint, last_indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           body = excluded.body,
           fingerprint = excluded.fingerprint,
           last_indexed_at = excluded.last_indexed_at`,
      )
      .run(fullPath, input.scope, scope_id, type, input.content, fingerprint, now);

    return { path: fullPath, type, indexed_at: now };
  }

  /** ③ Compaction 单文件追加模式 */
  private async saveCompaction(
    content: string,
    scope: string,
    scope_id: string,
  ): Promise<{ path: string; type: string; indexed_at: number }> {
    const filePath = buildPath({ root: this.root, scope: scope as Scope, scope_id, key: "compactions" });
    const fullPath = filePath.replace(/\\/g, "/");

    await fs.mkdir(path.dirname(filePath), { recursive: true });

    // 追加写入（带时间戳标题）
    const entry = `\n## ${new Date().toISOString()}\n\n${content}\n`;
    await fs.appendFile(filePath, entry, "utf-8");

    // 重新读取全文用于索引
    const fullContent = await Bun.file(filePath).text();
    const stat = await fs.stat(filePath);
    const fingerprint = `${stat.size}-${stat.mtimeMs}`;

    this.db
      .query(
        `INSERT INTO memory_fts (path, scope, scope_id, type, body, fingerprint, last_indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           body = excluded.body,
           fingerprint = excluded.fingerprint,
           last_indexed_at = excluded.last_indexed_at`,
      )
      .run(fullPath, scope, scope_id, "compaction", fullContent, fingerprint, Date.now());

    return { path: fullPath, type: "compaction", indexed_at: Date.now() };
  }

  /** FTS5 全文搜索，BM25 排序 + 相对分数过滤 */
  search(input: SearchInput): SearchResult[] {
    const limit = input.limit ?? 10;

    const ftsQuery = buildFtsQuery(input.query);
    if (!ftsQuery) return [];

    const conditions: string[] = [];
    const params: string[] = [];

    if (input.scope) {
      conditions.push("memory_fts.scope = ?");
      params.push(input.scope);
    }
    if (input.scope_id) {
      conditions.push("memory_fts.scope_id = ?");
      params.push(input.scope_id);
    }
    if (input.type) {
      conditions.push("memory_fts.type = ?");
      params.push(input.type);
    }

    const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

    // 多 fetch 一些（3x，上限 50），给相对分数过滤留空间
    const fetchLimit = Math.min(limit * 3, 50);

    const sql = `
      SELECT memory_fts.path, memory_fts.scope, memory_fts.scope_id, memory_fts.type,
             snippet(memory_fts_idx, 0, '<<', '>>', '...', 32) AS snippet,
             bm25(memory_fts_idx) AS score
      FROM memory_fts_idx
      JOIN memory_fts ON memory_fts.id = memory_fts_idx.rowid
      WHERE memory_fts_idx MATCH ?
      ${whereClause}
      ORDER BY score
      LIMIT ?
    `;

    const rows = this.db.query(sql).all(ftsQuery, ...params, fetchLimit) as SearchResult[];

    // BM25 返回 lower=better，取反让 higher=better
    const mapped = rows.map((r) => ({
      ...r,
      score: -r.score,
    }));

    if (mapped.length === 0) return [];

    // 相对 floor 过滤：保留 ≥ 最高分 15% 的结果
    const topScore = mapped[0].score;
    const floorRatio = 0.15;
    const cutoff = topScore * floorRatio;
    return mapped.filter((r, i) => i === 0 || r.score >= cutoff).slice(0, limit);
  }

  /** 列出记忆条目 */
  list(input: ListInput): MemoryEntry[] {
    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;

    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (input.scope) {
      conditions.push("scope = ?");
      params.push(input.scope);
    }
    if (input.scope_id) {
      conditions.push("scope_id = ?");
      params.push(input.scope_id);
    }
    if (input.type) {
      conditions.push("type = ?");
      params.push(input.type);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT id, path, scope, scope_id, type, body, fingerprint, last_indexed_at
      FROM memory_fts
      ${whereClause}
      ORDER BY last_indexed_at DESC
      LIMIT ? OFFSET ?
    `;

    return this.db.query(sql).all(...params, limit, offset) as MemoryEntry[];
  }

  /** 删除指定记忆文件 */
  async delete(filePath: string): Promise<boolean> {
    const normalized = filePath.replace(/\\/g, "/");

    // 从数据库删除（触发器会自动处理 FTS 索引）
    const result = this.db
      .query("DELETE FROM memory_fts WHERE path = ?")
      .run(normalized);

    // 删除 .md 文件
    try {
      await fs.unlink(filePath);
    } catch {
      // 文件可能已不存在，忽略
    }

    return result.changes > 0;
  }

  /** 扫描记忆目录，增量同步磁盘文件到 FTS 索引 */
  async reconcile(): Promise<{ indexed: number; pruned: number }> {
    const diskFiles = new Set<string>(await this.walkMemoryDir(this.root));

    // 获取当前索引的所有路径
    const indexed = new Map<string, string>(
      (this.db
        .query("SELECT path, fingerprint FROM memory_fts")
        .all() as { path: string; fingerprint: string }[]).map((r) => [r.path, r.fingerprint]),
    );

    // 方向 B：清理索引中磁盘已不存在的条目
    let pruned = 0;
    for (const p of indexed.keys()) {
      if (!diskFiles.has(p)) {
        this.db.query("DELETE FROM memory_fts WHERE path = ?").run(p);
        pruned++;
      }
    }

    // 方向 A：索引新增或变更的文件
    let indexedCount = 0;
    for (const p of diskFiles) {
      const loc = parsePath(p);
      if (!loc) continue;

      const stat = await fs.stat(p).catch(() => null);
      if (!stat) continue;

      const fingerprint = `${stat.size}-${stat.mtimeMs}`;
      if (indexed.get(p) === fingerprint) continue; // 无变化

      const body = await Bun.file(p).text();
      const now = Date.now();

      this.db
        .query(
          `INSERT INTO memory_fts (path, scope, scope_id, type, body, fingerprint, last_indexed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             scope = excluded.scope,
             scope_id = excluded.scope_id,
             type = excluded.type,
             body = excluded.body,
             fingerprint = excluded.fingerprint,
             last_indexed_at = excluded.last_indexed_at`,
        )
        .run(p, loc.scope, loc.scope_id, loc.type, body, fingerprint, now);

      indexedCount++;
    }

    // 更新最后同步时间
    this.db
      .query("INSERT INTO memory_meta (key, value) VALUES ('last_reconciled_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(String(Date.now()));

    return { indexed: indexedCount, pruned };
  }

  /** 统计信息 */
  stats(): MemoryStats {
    const total = this.db.query("SELECT COUNT(*) as count FROM memory_fts").get() as { count: number };

    const scopeRows = this.db.query("SELECT scope, COUNT(*) as count FROM memory_fts GROUP BY scope").all() as {
      scope: string;
      count: number;
    }[];

    const scopes: Record<string, number> = {};
    for (const r of scopeRows) {
      scopes[r.scope] = r.count;
    }

    const lastReconciled = (
      this.db
        .query("SELECT value FROM memory_meta WHERE key = 'last_reconciled_at'")
        .get() as { value: string } | undefined
    )?.value;

    return {
      total_docs: total.count,
      total_size: 0, // 实时计算成本高，暂不实现
      last_reconciled: lastReconciled ? Number(lastReconciled) : 0,
      scopes,
    };
  }

  /** 保存 compaction 摘要（由轮询器调用） */
  async saveSummary(summary: string, sessionID: string): Promise<void> {
    await this.save({
      content: summary,
      scope: "sessions",
      scope_id: sessionID,
      type: "compaction",
    });
  }

  /** 递归遍历 .md 文件 */
  private async walkMemoryDir(dir: string): Promise<string[]> {
    const out: string[] = [];
    async function recurse(d: string) {
      const entries = await fs.readdir(d, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return [] as import("fs").Dirent[];
        throw e;
      });
      for (const entry of entries) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) await recurse(full);
        else if (entry.isFile() && full.endsWith(".md")) out.push(full.replace(/\\/g, "/"));
      }
    }
    await recurse(dir);
    return out;
  }

  close() {
    this.db.close();
  }
}
