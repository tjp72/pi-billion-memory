import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
/**
 * Strip local absolute paths from text that goes back to the model. A tool error must not hand over
 * the layout of the machine (log, database, and session paths). Full details stay in the log.
 */
export declare function withoutPaths(text: string): string;
export default function factory(pi: ExtensionAPI): Promise<{}>;
