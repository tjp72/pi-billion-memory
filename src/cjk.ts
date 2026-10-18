/**
 * Chinese language data used by retrieval and redaction.
 *
 * Why this file exists: AGENTS.md §2 keeps human-facing content English, and it used to rely on a
 * human remembering that. The rule is only enforceable if "where CJK is allowed" is a *file*, not
 * a judgement call. `scripts/check-language.mjs` permits CJK here, and rejects it everywhere else
 * under `src/` and `dist/`.
 *
 * Everything in this module is data — token sets, character classes, and delimiters needed to
 * search and redact Chinese text. It contains no user- or model-facing sentence. Do not add prose,
 * examples, or labels here; put those in the English module that consumes them.
 */

/** Credential nouns that a Chinese secret assignment may use as its key. */
const CREDENTIAL_NOUNS = "(?:密码|口令|密钥|令牌|私钥|访问密钥|api密钥)";

/** Copulas and separators that may join a credential noun to its value. */
const CREDENTIAL_LINK = "(?:是|为|[:=：])";

/** Value terminator set: whitespace plus the punctuation that ends a Chinese clause. */
const VALUE_STOP = "，；";

/**
 * Chinese credential assignment (e.g. a label followed by a colon and a value). Group 1 is the
 * label, group 2 the value, so the replacement is `$1: [REDACTED]`.
 */
export const CHINESE_SECRET_RE = new RegExp(
  `(${CREDENTIAL_NOUNS})\\s*${CREDENTIAL_LINK}\\s*["']?([^\\s"'${VALUE_STOP},;]{4,})`,
  "gi",
);

/** Sentence terminators: ASCII and CJK full stops and question/exclamation marks, plus newlines. */
export const SENTENCE_DELIMITERS = /[。！？!?.;\n]+/;

/** Clause separators for requirement decomposition: CJK punctuation and the conjunction words. */
export const CLAUSE_SEPARATORS = /[,，;；。、]+|\s+(?:and|且|以及|并且)\s+/i;
