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
export declare const MAX_CONCEPT_TERMS = 24;
export declare const MAX_CONCEPT_TERM_CHARS = 64;
export declare const MAX_CONCEPT_LABEL_CHARS = 120;
export declare const MAX_CUSTOM_CONCEPTS = 50;
/** Copy one configured entry into the shape the tools consume. */
export declare function normalizeConceptEntry(raw: any): ConceptEntry | null;
/**
 * The effective catalog: exactly the user's `concepts` config. A config key becomes the concept's
 * label and id; its value is the list of terms searched for it. Nothing is bundled.
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
