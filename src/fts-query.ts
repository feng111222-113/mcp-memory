/**
 * 从用户自由输入构建 FTS5 MATCH 表达式。
 *
 * FTS5 的 MATCH 语法有自己的操作符和特殊字符
 * （"、(、)、*、:、^、-、.、{、}）。直接传入用户字符串
 * 会导致解析器崩溃。将每个 token 包裹为 phrase quote 并
 * OR-join 可以避免崩溃，OR-join 保证召回率。
 *
 * 选 OR 不选 AND：AND 要求每个 token 都命中，在小语料库上
 * 极易返回 0 结果。OR 让 BM25 按匹配多少和稀缺程度排序。
 *
 * 来源：MiMo Code packages/opencode/src/memory/fts-query.ts
 * 许可：MIT
 */

export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];

  if (tokens.length === 0) return null;

  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" OR ");
}
