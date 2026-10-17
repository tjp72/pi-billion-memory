import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
export default function factory(pi: ExtensionAPI): Promise<{}>;
