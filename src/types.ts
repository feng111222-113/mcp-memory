export type Scope = "global" | "projects" | "sessions";

export type MemoryType =
  | "free"
  | "memory"
  | "checkpoint"
  | "compaction"
  | "notes"
  | "progress";

export interface MemoryLocator {
  scope: Scope;
  scope_id: string;
  type: MemoryType;
  key: string;
}

export interface SearchResult {
  path: string;
  snippet: string;
  score: number;
  scope: string;
  scope_id: string;
  type: string;
  body?: string;
}

export interface UpdateInput {
  path: string;
  content: string;
  scope?: Scope;
  scope_id?: string;
  type?: MemoryType;
}

export interface BatchDeleteInput {
  scope: string;
  scope_id?: string;
  type?: string;
}

export interface MemoryEntry {
  path: string;
  scope: string;
  scope_id: string;
  type: string;
  body: string;
  fingerprint: string;
  last_indexed_at: number;
}

export interface MemoryStats {
  total_docs: number;
  total_size: number;
  last_reconciled: number;
  scopes: Record<string, number>;
}

export interface SaveInput {
  content: string;
  scope: Scope;
  scope_id?: string;
  type?: MemoryType;
}

export interface SearchInput {
  query: string;
  scope?: string;
  scope_id?: string;
  type?: string;
  limit?: number;
  search_mode?: "fts" | "hybrid";
}

export interface ListInput {
  scope?: string;
  scope_id?: string;
  type?: string;
  limit?: number;
  offset?: number;
}

/** 结构化 checkpoint 的 11 个字段（MiMo Code checkpoint 设计） */
export interface CheckpointData {
  intent?: string;
  next_action?: string;
  constraints?: string;
  task_tree?: string;
  working_on?: string;
  files?: string[];
  cross_task_findings?: string;
  errors_fixes?: string;
  runtime_state?: string;
  design_decisions?: string;
  notes?: string;
}

/** promote 操作：将记忆从低作用域提升到高作用域 */
export interface PromoteInput {
  path: string;
  target_scope: "projects" | "global";
  target_scope_id?: string;
  type?: string;
}
