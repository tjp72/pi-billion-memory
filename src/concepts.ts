/**
 * Built-in concept vocabulary — the search aliases this extension ships.
 *
 * A concept maps one name to the concrete terms a corpus actually uses, so a mechanism whose name
 * never made it into a summary is still findable. Terms are searched one by one and the hits are
 * merged, with blocks matching more distinct terms ranked first.
 *
 * The built-in list is a *default*, not a fixed taxonomy: `pi-billion-memory.json` may extend an
 * entry (`"concepts": { "cache-integrity": ["term"] }`) or add a new one. Concepts are domain
 * vocabulary supplied by the user — the built-in set covers this project's own subject matter and
 * nothing else. It deliberately contains no identifier from any private project, machine, or
 * person; see AGENTS.md §1.
 *
 * Vocabulary data lives in `concepts.data.ts` so that `scripts/check-language.mjs` can treat it as
 * a data file rather than code, and so a vocabulary change is a reviewable diff of pure data.
 */

import { CONCEPT_DATA } from "./concepts.data.js";

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

const BUILTIN_CONCEPTS: ConceptEntry[] = CONCEPT_DATA;

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

/** Copy one built-in/custom entry into the shape the tools consume. */
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
 * The effective catalog: built-ins first, then the user's `concepts` config. A config key that
 * matches an existing id/label/alias extends that concept's terms; any other key adds a concept.
 */
export function conceptCatalog(custom?: Record<string, unknown> | null): ConceptEntry[] {
  const list: ConceptEntry[] = BUILTIN_CONCEPTS.map((c) => ({
    ...c,
    aliases: [...c.aliases],
    terms: [...c.terms],
  }));
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
