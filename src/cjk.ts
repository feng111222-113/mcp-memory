/**
 * CJK 搜索支持：在汉字/假名/谚文之间插入空格，使 FTS5 unicode61 能逐字索引。
 *
 * Bun 的 SQLite FTS5 使用 unicode61 tokenizer，它将连续的 CJK 字符
 * 视为一个 token（不分词）。通过在每个 CJK 字符后加空格，
 * 每个字符成为独立 FTS5 token，实现逐字可搜。
 *
 * 范围：CJK 统一表意文字(U+4E00–U+9FFF)、平假名(U+3040–U+309F)、
 *       片假名(U+30A0–U+30FF)、谚文(U+AC00–U+D7AF)
 */

const CJK_RE = /([\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af])/g;
const CJK_SPACE_RE = /([\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]) /g;

/** 在每个 CJK 字符后加空格，使 FTS5 能逐字索引。
 *  同时会隔开 CJK 与紧跟的 ASCII（如 "もOK" → "も OK"），
 *  避免 CJK+ASCII 混合成一个 token。 */
export function addCjkSpacing(text: string): string {
  return text.replace(CJK_RE, "$1 ");
}

/** 移除 CJK 字符后面的空格（addCjkSpacing 的逆操作） */
export function removeCjkSpacing(text: string): string {
  return text.replace(CJK_SPACE_RE, "$1");
}
