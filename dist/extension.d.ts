import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ConceptTable } from "./concepts.js";
/** `preview: true` renders only for windows at most this large, so one response stays bounded. */
export declare const TIMELINE_PREVIEW_MAX_ROWS = 80;
/** Keyword-table workflow budget (docs/ELEVATION.md §3.1): 200 rows per window, hard stop above 2,000. */
export declare const ELEVATION_WINDOW_ROWS = 200;
export declare const ELEVATION_WINDOW_LIMIT = 10;
export declare const ELEVATION_ROWS_BRAKE: number;
export declare const MAX_STOPWORDS = 500;
/**
 * Load the concept table named by `conceptsFile` (read-only user data, mtime+size cached).
 * Returns null when no file is configured; a broken file degrades to an empty table plus a note.
 */
export declare function loadConceptTable(): {
    path: string;
    mtimeMs: number;
    size: number;
    table: ConceptTable;
    error: string | null;
};
/** Merge inline `concepts`/`deprecated` with the concepts file (inline wins on conflicts). */
export declare function effectiveVocabulary(): {
    concepts: {
        [x: string]: string[];
    };
    deprecated: {
        [x: string]: string;
    };
    table: ConceptTable;
    error: string;
    source: string;
};
/**
 * Strip local absolute paths from text that goes back to the model. A tool error must not hand over
 * the layout of the machine (log, database, and session paths). Full details stay in the log.
 */
export declare function withoutPaths(text: string): string;
/**
 * Collapse exact-duplicate memories copied across source files (fork/copy artifacts) into one row
 * that lists the alternate sources. Blocks from the same source are never merged, so multi-tier
 * parent/child pairs survive. `rows` must already be in display order; the first row of a group is
 * kept and the rest only contribute their source labels.
 */
export declare function mergeDuplicateRows(rows: any): any[];
/** First sentence of a summary for the timeline preview (bounded and redacted). */
export declare function timelinePreview(summary: any): string;
/**
 * Render the keyword-table work package for `/memory elevation` (rows, window count, budget brake,
 * vocabulary watermark). Numbers only — the command pulls no block text into the session.
 * @param {{scope:string, rows:number, windows:number, brake:boolean, capped:boolean,
 *   watermark:{{lastCreatedAt:*, lastBlockSeq:*} | null, stale:number|null,
 *   conceptsFile:string|null}} plan
 */
export declare function formatElevationPlan(plan: any): string;
/**
 * Parse a timeline bound: epoch milliseconds or an ISO 8601 string. A date-only value means the
 * local start (from) or end (to) of that day, matching the local time the timeline prints. Invalid
 * values throw an actionable error instead of being silently ignored.
 */
export declare function parseTimeParam(v: unknown, param: "from" | "to"): number | null;
export default function factory(pi: ExtensionAPI): Promise<{}>;
