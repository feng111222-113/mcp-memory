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
}

export interface ListInput {
  scope?: string;
  scope_id?: string;
  type?: string;
  limit?: number;
  offset?: number;
}
