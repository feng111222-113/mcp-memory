/**
 * Embedder — 本地向量嵌入，通过 Ollama API 生成 embedding。
 *
 * 使用 nomic-embed-text 模型（768 维），支持 CJK。
 * Ollama 不可用时静默降级，不阻塞主流程。
 *
 * 环境变量:
 *   OLLAMA_URL  - Ollama 服务地址（默认 http://127.0.0.1:11434）
 */

const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";
const EMBED_MODEL = "nomic-embed-text";
const EMBED_DIMENSION = 768;
const EMBED_TIMEOUT = 10_000;

export class Embedder {
  private apiUrl: string;
  private model: string;
  readonly dimension: number;
  private _available: boolean | null = null;

  constructor(apiUrl?: string) {
    this.apiUrl = (apiUrl || OLLAMA_DEFAULT_URL).replace(/\/+$/, "");
    this.model = EMBED_MODEL;
    this.dimension = EMBED_DIMENSION;
  }

  /** 检测 Ollama 是否可达且模型已加载 */
  async isAvailable(options?: { force?: boolean }): Promise<boolean> {
    if (!options?.force && this._available !== null) return this._available;
    try {
      const res = await fetch(`${this.apiUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) { this._available = false; return false; }
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      this._available =
        data.models?.some((m) => m.name.startsWith(this.model)) ?? false;
      return this._available;
    } catch {
      this._available = false;
      return false;
    }
  }

  /** 生成文本的 embedding 向量 */
  async embed(text: string): Promise<Float32Array | null> {
    try {
      // nomic-embed-text 上限 8192 token，截取前 ~24000 字符
      const truncated = text.length > 24000 ? text.slice(0, 24000) : text;

      const res = await fetch(`${this.apiUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: [truncated] }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT),
      });
      if (!res.ok) return null;

      const data = (await res.json()) as { embeddings: number[][] };
      if (!data.embeddings?.[0]) return null;
      return new Float32Array(data.embeddings[0]);
    } catch {
      return null;
    }
  }

  /** 余弦相似度 */
  cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /** 重置可用缓存，下次 isAvailable 重新检测 */
  resetCache(): void {
    this._available = null;
  }

  /** 强制刷新可用状态 */
  async refresh(): Promise<boolean> {
    this._available = null;
    return this.isAvailable({ force: true });
  }
}
