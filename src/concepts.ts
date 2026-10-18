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
