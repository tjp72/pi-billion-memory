/**
 * Built-in concept vocabulary — data only, no logic.
 *
 * Split from `concepts.ts` so that `scripts/check-language.mjs` can allow Chinese here as *data*
 * (search terms that must match a Chinese corpus) while still rejecting Chinese prose in code.
 * See AGENTS.md §2.
 *
 * Rules for this file:
 * - `id`, `label`, `aliases` are English. The label is what `mode: "concepts"` prints.
 * - `terms` may be Chinese where the term itself is Chinese: those strings are search payload, not
 *   human-facing text, and the Chinese retrieval strategy depends on them.
 * - No identifier of any real project, machine, person, or private repository may appear here.
 *   Terms must be generic engineering vocabulary. Personal aliases belong in the user's own
 *   `pi-billion-memory.json` under `concepts`, which is never committed.
 */
export interface ConceptDatum {
    id: string;
    label: string;
    aliases: string[];
    terms: string[];
}
export declare const CONCEPT_DATA: ConceptDatum[];
