/**
 * Concept resolution — one name expands to the concrete terms a corpus actually uses, so a
 * mechanism whose name never made it into a summary is still findable. Terms are searched one by
 * one and the hits are merged, with blocks matching more distinct terms ranked first.
 *
 * The extension ships **no vocabulary**. A concept's terms are domain data the user supplies at
 * runtime through the `concepts` key of `pi-billion-memory.json`; personal, project, or
 * session-derived vocabulary is never repository content (AGENTS.md §1). This module holds only
 * the resolution logic and the caps that keep a configured entry bounded.
 */

export interface ConceptEntry {
  /** Stable machine id, e.g. "cache-integrity". */
  id: string;
  /** Display label shown by `mode: "concepts"`. */
  label: string;
  /** Alternative names accepted by `memory_search` (id and label are always accepted). */
  aliases: string[];
  /** Concrete terms searched one by one; the hits are merged. */
  terms: string[];
}

export const MAX_CONCEPT_TERMS = 24;
export const MAX_CONCEPT_TERM_CHARS = 64;
export const MAX_CONCEPT_LABEL_CHARS = 120;
export const MAX_CUSTOM_CONCEPTS = 50;

function norm(s: unknown): string {
  return typeof s === "string"
    ? s
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, " ")
    : "";
}

function cleanTerm(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim().slice(0, MAX_CONCEPT_TERM_CHARS);
  return t ? t : null;
}

function slug(s: string): string {
  const base = norm(s)
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CONCEPT_LABEL_CHARS);
  return base || "concept";
}

/** Copy one configured entry into the shape the tools consume. */
export function normalizeConceptEntry(raw: any): ConceptEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const label = typeof raw.label === "string" ? raw.label.trim().slice(0, MAX_CONCEPT_LABEL_CHARS) : "";
  const id = typeof raw.id === "string" && raw.id.trim() ? slug(raw.id) : slug(label);
  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases
        .map((a: unknown) => (typeof a === "string" ? a.trim().slice(0, MAX_CONCEPT_LABEL_CHARS) : ""))
        .filter(Boolean)
    : [];
  const terms = Array.isArray(raw.terms)
    ? [...new Set(raw.terms.map(cleanTerm).filter(Boolean) as string[])].slice(0, MAX_CONCEPT_TERMS)
    : [];
  if (!label || !terms.length) return null;
  return { id, label, aliases, terms };
}

function matchEntry(entry: ConceptEntry, key: string): boolean {
  const k = norm(key);
  if (!k) return false;
  return [entry.id, entry.label, ...entry.aliases].some((x) => norm(x) === k);
}

/**
 * The effective catalog: exactly the user's `concepts` config. A config key becomes the concept's
 * label and id; its value is the list of terms searched for it. Nothing is bundled.
 */
export function conceptCatalog(custom?: Record<string, unknown> | null): ConceptEntry[] {
  const list: ConceptEntry[] = [];
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) return list;
  let added = 0;
  for (const [key, value] of Object.entries(custom)) {
    if (!Array.isArray(value)) continue;
    const terms = value.map(cleanTerm).filter(Boolean) as string[];
    if (!terms.length) continue;
    const k = String(key || "")
      .trim()
      .slice(0, MAX_CONCEPT_LABEL_CHARS);
    if (!k) continue;
    const existing = list.find((c) => matchEntry(c, k));
    if (existing) {
      for (const t of terms) if (!existing.terms.includes(t)) existing.terms.push(t);
      if (existing.terms.length > MAX_CONCEPT_TERMS) existing.terms = existing.terms.slice(0, MAX_CONCEPT_TERMS);
      continue;
    }
    if (added >= MAX_CUSTOM_CONCEPTS) break;
    list.push({ id: slug(k), label: k, aliases: [], terms: [...new Set(terms)].slice(0, MAX_CONCEPT_TERMS) });
    added++;
  }
  return list;
}

/**
 * Resolve a concept by id, label, alias, or a unique substring/prefix. Exact id wins; exact
 * label/alias next; otherwise a unique substring match. Ambiguous names resolve to null so the
 * caller can list the catalog instead of silently picking one.
 */
export function findConcept(
  name: string,
  custom?: Record<string, unknown> | null,
): { entry: ConceptEntry; terms: string[] } | null {
  const n = norm(name);
  if (!n) return null;
  const list = conceptCatalog(custom);
  const exactId = list.find((c) => norm(c.id) === n);
  if (exactId) return { entry: exactId, terms: [...exactId.terms] };
  const exactName = list.find((c) => norm(c.label) === n || c.aliases.some((a) => norm(a) === n));
  if (exactName) return { entry: exactName, terms: [...exactName.terms] };
  const partial = list.filter(
    (c) => norm(c.label).includes(n) || norm(c.id).includes(n) || c.aliases.some((a) => norm(a).includes(n)),
  );
  if (partial.length !== 1) return null;
  return { entry: partial[0], terms: [...partial[0].terms] };
}

/** Max deprecated terms kept from the runtime config (guards a hostile or careless config). */
export const MAX_DEPRECATED_TERMS = 200;
/** Max deprecated-term hints rendered for one query. */
const MAX_HINT_TERMS = 5;

/** Normalize a vocabulary term for matching: lowercase, collapsed whitespace/hyphens/underscores. */
export function normTerm(s: unknown): string {
  return typeof s === "string"
    ? s
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, " ")
    : "";
}

function termPresent(key: string, hay: string): boolean {
  if (!key) return false;
  if (/[\u4e00-\u9fff]/.test(key)) return hay.includes(key);
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}(?=$|[^a-z0-9])`).test(hay);
}

/**
 * Hints for deprecated vocabulary terms occurring in `text`. The table is runtime user data
 * (`deprecated` in pi-billion-memory.json: `{ "old term": "replacement", "retired term": "" }`),
 * never repository content; the extension only reads it.
 * @internal
 */
export function deprecatedHints(deprecated?: Record<string, unknown> | null, text?: string | null): string {
  if (!deprecated || typeof deprecated !== "object" || Array.isArray(deprecated)) return "";
  const hay = normTerm(text);
  if (!hay) return "";
  const hits: string[] = [];
  for (const [rawKey, rawVal] of Object.entries(deprecated)) {
    if (hits.length >= MAX_HINT_TERMS) break;
    const key = normTerm(rawKey);
    if (!key || key.length < 2 || !termPresent(key, hay)) continue;
    const replacement = normTerm(rawVal);
    const label = String(rawKey).trim().slice(0, MAX_CONCEPT_TERM_CHARS);
    hits.push(
      replacement
        ? `Deprecated term '${label}': use '${String(rawVal).trim()}' instead.`
        : `Deprecated term '${label}': no replacement recorded.`,
    );
  }
  if (!hits.length) return "";
  return ["Vocabulary hints (runtime config, not repository content):", ...hits.map((h) => `- ${h}`)].join("\n");
}

// ---------------------------------------------------------------------------
// Concept table file (generated at runtime for one scope; never repository content)
// ---------------------------------------------------------------------------

/** Caps for a concept table produced by the elevation workflow. */
export const MAX_TABLE_CONCEPTS = 200;
export const MAX_TABLE_KEYWORDS = 10;
export const MAX_TABLE_FILTERED = 200;
/** A table file larger than this is ignored (the extension never loads unbounded JSON). */
export const MAX_TABLE_BYTES = 1024 * 1024;

export interface ConceptTable {
  concepts: Record<string, string[]>;
  deprecated: Record<string, string>;
  filtered: string[];
  evidence: Record<string, number>;
  scope: Record<string, unknown> | null;
  watermark: Record<string, unknown> | null;
}

function scalarRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= 20) break;
    const key = String(k).trim().slice(0, 60);
    if (!key) continue;
    if (typeof v === "string") out[key] = v.slice(0, 200);
    else if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
    else if (typeof v === "boolean") out[key] = v;
    else continue;
    n++;
  }
  return n ? out : null;
}

/**
 * Parse one concept table (`concepts`, `deprecated`, `filtered`, `evidence`, `scope`,
 * `watermark`). Bounded and shape-checked: unknown keys are ignored, and nothing is coerced
 * into a search term that the file did not contain.
 * @internal
 */
export function parseConceptTable(raw: unknown): ConceptTable {
  const empty: ConceptTable = {
    concepts: {},
    deprecated: {},
    filtered: [],
    evidence: {},
    scope: null,
    watermark: null,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const src = raw as Record<string, unknown>;

  const concepts: Record<string, string[]> = {};
  if (src.concepts && typeof src.concepts === "object" && !Array.isArray(src.concepts)) {
    for (const [rawLabel, rawTerms] of Object.entries(src.concepts as Record<string, unknown>)) {
      if (Object.keys(concepts).length >= MAX_TABLE_CONCEPTS) break;
      const label = String(rawLabel).trim().slice(0, MAX_CONCEPT_LABEL_CHARS);
      if (!label) continue;
      const terms: string[] = [];
      const seen = new Set<string>();
      for (const rawTerm of Array.isArray(rawTerms) ? rawTerms : []) {
        const term = cleanTerm(rawTerm);
        if (!term) continue;
        const key = term.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        terms.push(term);
        if (terms.length >= MAX_TABLE_KEYWORDS) break;
      }
      if (terms.length) concepts[label] = terms;
    }
  }

  const deprecated: Record<string, string> = {};
  if (src.deprecated && typeof src.deprecated === "object" && !Array.isArray(src.deprecated)) {
    for (const [rawKey, rawValue] of Object.entries(src.deprecated as Record<string, unknown>)) {
      if (Object.keys(deprecated).length >= MAX_DEPRECATED_TERMS) break;
      const key = String(rawKey).trim().slice(0, MAX_CONCEPT_TERM_CHARS);
      if (!key) continue;
      if (rawValue !== null && rawValue !== undefined && typeof rawValue !== "string") continue;
      deprecated[key] = typeof rawValue === "string" ? rawValue.trim().slice(0, MAX_CONCEPT_TERM_CHARS) : "";
    }
  }

  const filtered: string[] = [];
  if (Array.isArray(src.filtered)) {
    const seen = new Set<string>();
    for (const rawWord of src.filtered) {
      const word = cleanTerm(rawWord);
      if (!word || seen.has(word.toLowerCase())) continue;
      seen.add(word.toLowerCase());
      filtered.push(word);
      if (filtered.length >= MAX_TABLE_FILTERED) break;
    }
  }

  const evidence: Record<string, number> = {};
  if (src.evidence && typeof src.evidence === "object" && !Array.isArray(src.evidence)) {
    for (const [rawKey, rawValue] of Object.entries(src.evidence as Record<string, unknown>)) {
      if (Object.keys(evidence).length >= 500) break;
      const key = String(rawKey).trim().slice(0, MAX_CONCEPT_TERM_CHARS);
      if (!key || typeof rawValue !== "number" || !Number.isFinite(rawValue) || rawValue < 0) continue;
      evidence[key] = Math.floor(rawValue);
    }
  }

  return {
    concepts,
    deprecated,
    filtered,
    evidence,
    scope: scalarRecord(src.scope),
    watermark: scalarRecord(src.watermark),
  };
}
