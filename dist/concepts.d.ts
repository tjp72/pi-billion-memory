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
export declare const MAX_CONCEPT_TERMS = 24;
export declare const MAX_CONCEPT_TERM_CHARS = 64;
export declare const MAX_CONCEPT_LABEL_CHARS = 120;
export declare const MAX_CUSTOM_CONCEPTS = 50;
/** Copy one built-in/custom entry into the shape the tools consume. */
export declare function normalizeConceptEntry(raw: any): ConceptEntry | null;
/**
 * The effective catalog: built-ins first, then the user's `concepts` config. A config key that
 * matches an existing id/label/alias extends that concept's terms; any other key adds a concept.
 */
export declare function conceptCatalog(custom?: Record<string, unknown> | null): ConceptEntry[];
/**
 * Resolve a concept by id, label, alias, or a unique substring/prefix. Exact id wins; exact
 * label/alias next; otherwise a unique substring match. Ambiguous names resolve to null so the
 * caller can list the catalog instead of silently picking one.
 */
export declare function findConcept(name: string, custom?: Record<string, unknown> | null): {
    entry: ConceptEntry;
    terms: string[];
} | null;
