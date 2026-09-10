/**
 * Optional block expansion (`memory_expand`).
 *
 * A stored compression block knows which raw messages it absorbed (`blocks.msg_ids`, copied from
 * the sidecar's `effectiveMessageIds`). This module turns those ids back into the original
 * message text by reading the session `.jsonl` the block came from.
 *
 * Scope and guarantees:
 * - Read-only. Nothing is written back to the store; expanded text is returned to the caller only.
 * - Bounded. Every read and every response is capped by the caller's budgets: the session file is
 *   opened and read in `maxReadBytes` steps (never slurped whole), and the rendered text — entry
 *   headers and truncation markers included — never exceeds `maxChars`.
 * - Two-step. `full` mode renders only an explicit, non-empty `select`, so a whole block cannot be
 *   dumped by omitting it; `list` mode returns a manifest with no conversation text at all.
 * - On demand. The reader resolves only ids already referenced by a stored block and is never used
 *   to discover blocks; it does parse the session file up to the byte cap, because a JSONL file
 *   cannot be read randomly.
 * - Redaction is injected by the caller so this module stays dependency-free (and so the same
 *   filter that guards storage also guards output).
 */
/** A sidecar id split into its base message id and an optional tool-call selector. */
export interface SplitMessageId {
    /** Message id as it appears on the `.jsonl` line (e.g. `4d17483d`). */
    base: string;
    /** `call_...` selector when the reference points at one tool call inside the message. */
    callId: string | null;
}
/** Kind of a rendered content item. */
export type RenderedKind = "text" | "thinking" | "toolCall" | "other";
/** One rendered piece of a message. */
export interface RenderedItem {
    /** Tool-call id when the item is a tool call. */
    callId: string | null;
    kind: RenderedKind;
    text: string;
}
/** A message reduced to displayable role + items. */
export interface RenderedMessage {
    role: string;
    items: RenderedItem[];
}
/** Bytes read from a file plus its size on disk. */
export interface ReadResult {
    buffer: Buffer;
    totalBytes: number;
}
/** Result of reading a session file. */
export interface SessionRead {
    /** Raw message id -> parsed entry (`type:"message"` or `type:"custom_message"`). */
    messages: Map<string, any>;
    /** Bytes actually read. */
    bytesRead: number;
    /** Total size of the file on disk. */
    totalBytes: number;
    /** True when the file was longer than the read cap (the trailing partial line is dropped). */
    truncated: boolean;
    /** True when the session file no longer exists (deleted, rotated, or renamed since ingestion). */
    missing: boolean;
}
/** One entry in the expansion manifest. */
export interface ExpandEntry {
    /** 1-based position, used as the `select` handle. */
    index: number;
    /** Reference exactly as stored in `msg_ids` (may include `#call_...`). */
    ref: string;
    /** Base message id. */
    messageId: string;
    /** Tool-call selector, when present. */
    callId: string | null;
    /** Message role, when the message was resolved. */
    role: string | null;
    /** Rendered size in characters (0 when unresolved). */
    chars: number;
    /** False when the referenced message is absent (session file trimmed, rotated, or pruned). */
    found: boolean;
}
/** Outcome of an expansion request. */
export interface ExpandResult {
    entries: ExpandEntry[];
    /** Rendered text, or null in `list` mode. */
    text: string | null;
    /** True when budgets cut the response short. */
    truncated: boolean;
    /** Total characters available across all resolved entries (upper bound before budgets). */
    availableChars: number;
    /** Characters actually returned. */
    returnedChars: number;
    /** Messages dropped because of `maxMessages`. */
    skippedMessages: number;
    /** True when the session file read hit `maxReadBytes`. */
    readTruncated: boolean;
    /** Bytes read from the session file. */
    bytesRead: number;
    /** Total size of the session file. */
    totalBytes: number;
    /** True when the session file was gone, so every reference resolves to missing. */
    sessionMissing: boolean;
}
export interface ExpandOptions {
    sessionFile: string;
    msgIds: string[];
    mode: "list" | "full";
    /**
     * 1-based entry indices to render. Required and non-empty in `full` mode: there is no "render
     * everything" path, so a caller has to pick a selection from a `list` result first.
     */
    select?: number[] | null;
    maxChars: number;
    maxMessages: number;
    maxReadBytes: number;
    /** Injected redaction filter applied to rendered text before it is returned. */
    redact?: (text: string) => {
        text: string;
        hits: number;
    };
    /** Test seam for the file read. */
    readFile?: (file: string, maxBytes: number) => Promise<ReadResult>;
}
