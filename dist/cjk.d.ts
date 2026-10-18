/**
 * Chinese language data used by retrieval and redaction.
 *
 * Why this file exists: AGENTS.md §2 keeps human-facing content English, and it used to rely on a
 * human remembering that. The rule is only enforceable if "where CJK is allowed" is a *file*, not
 * a judgement call. `scripts/check-language.mjs` permits CJK here and in `concepts.data.ts`, and
 * rejects it everywhere else under `src/` and `dist/`.
 *
 * Everything in this module is data — token sets, character classes, and delimiters needed to
 * search and redact Chinese text. It contains no user- or model-facing sentence. Do not add prose,
 * examples, or labels here; put those in the English module that consumes them.
 */
/**
 * Function words dropped from related-evidence tokens. Only function words belong here: content
 * words (even short ones) are kept, because removing them damages the evidence sentence. Tokens
 * that are merely ubiquitous for one query are demoted by the data-driven DF gate instead.
 */
export declare const CJK_STOPWORDS: readonly string[];
/**
 * `密码：xxx` / `令牌是 xxx` — a Chinese credential assignment. Group 1 is the label, group 2 the
 * value, so the replacement is `$1: [REDACTED]`.
 */
export declare const CHINESE_SECRET_RE: RegExp;
/** Sentence terminators: ASCII and CJK full stops and question/exclamation marks, plus newlines. */
export declare const SENTENCE_DELIMITERS: RegExp;
/** Clause separators for requirement decomposition: CJK punctuation and the conjunction words. */
export declare const CLAUSE_SEPARATORS: RegExp;
