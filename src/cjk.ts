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
export const CJK_STOPWORDS: readonly string[] = [
  "的",
  "了",
  "在",
  "和",
  "是",
  "与",
  "及",
  "或",
  "对",
  "被",
  "把",
  "就",
  "都",
  "而",
  "也",
  "还",
  "之",
  "其",
  "等",
  "我",
  "你",
  "他",
  "她",
  "它",
  "们",
  "这",
  "那",
  "有",
  "无",
  "为",
  "以",
  "于",
  "从",
  "到",
  "会",
  "要",
  "不",
  "没",
  "很",
  "更",
  "最",
  "并",
  "且",
  "但",
  "若",
  "则",
  "即",
  "可",
  "能",
  "需",
  "应",
  "该",
  "上",
  "下",
  "中",
  "内",
  "外",
  "前",
  "后",
  "时",
  "个",
  "些",
  "种",
];

/** Credential nouns that a Chinese secret assignment may use as its key. */
const CREDENTIAL_NOUNS = "(?:密码|口令|密钥|令牌|私钥|访问密钥|api密钥)";

/** Copulas and separators that may join a credential noun to its value. */
const CREDENTIAL_LINK = "(?:是|为|[:=：])";

/** Value terminator set: whitespace plus the punctuation that ends a Chinese clause. */
const VALUE_STOP = "，；";

/**
 * `密码：xxx` / `令牌是 xxx` — a Chinese credential assignment. Group 1 is the label, group 2 the
 * value, so the replacement is `$1: [REDACTED]`.
 */
export const CHINESE_SECRET_RE = new RegExp(
  `(${CREDENTIAL_NOUNS})\\s*${CREDENTIAL_LINK}\\s*["']?([^\\s"'${VALUE_STOP},;]{4,})`,
  "gi",
);

/** Sentence terminators: ASCII and CJK full stops and question/exclamation marks, plus newlines. */
export const SENTENCE_DELIMITERS = /[。！？!?.;\n]+/;

/** Clause separators for requirement decomposition: CJK punctuation and the conjunction words. */
export const CLAUSE_SEPARATORS = /[,，;；。、]+|\s+(?:and|且|以及|并且)\s+/i;
