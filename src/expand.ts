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

/** Separator between a message id and a tool-call selector in `effectiveMessageIds`. */
const CALL_SEPARATOR = "#";

/** Prefix of synthetic summary references some upstream versions emit in their place of message ids. */
const SYNTHETIC_REF_PREFIX = "acp_summary_";

/**
 * Split a sidecar reference such as `4d17483d#call_00_abc` into base id and call id.
 * References without a selector return `callId: null`.
 * @internal
 */
export function splitMessageId(raw: unknown): SplitMessageId {
  const s = typeof raw === "string" ? raw : String(raw ?? "");
  const at = s.indexOf(CALL_SEPARATOR);
  if (at <= 0) return { base: s, callId: null };
  const callId = s.slice(at + CALL_SEPARATOR.length);
  return { base: s.slice(0, at), callId: callId || null };
}

/**
 * True when a reference looks like an upstream-synthesized id (`acp_summary_*`) rather than an id
 * that can exist as a session entry. Such a reference can never be resolved, so callers should say
 * "synthetic" instead of reporting it as missing.
 * @internal
 */
export function isSyntheticRef(id: unknown): boolean {
  return typeof id === "string" && id.startsWith(SYNTHETIC_REF_PREFIX);
}

/**
 * Parse a `blocks.msg_ids` column (JSON array of strings) into a deduplicated id list,
 * preserving order. Malformed input yields an empty list.
 * @internal
 */
export function parseMsgIds(json: unknown): string[] {
  if (typeof json !== "string" || !json.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
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

function stringifyArgs(args: unknown): string {
  if (args == null) return "";
  try {
    const s = JSON.stringify(args);
    return s === undefined ? String(args) : s;
  } catch {
    return "[unserializable arguments]";
  }
}

/**
 * Render one raw content item.
 * `callId` filters to a single tool call; text/thinking items are skipped when a filter is set
 * (a `#call_` reference selects a tool call, not the surrounding prose). An item type this module
 * does not know renders as a short `other` placeholder instead of being dropped silently.
 * @internal
 */
export function renderContentItem(item: unknown, callId: string | null): RenderedItem | null {
  if (!item || typeof item !== "object") return null;
  const it = item as Record<string, any>;
  const type = it.type;
  if (type === "text") {
    if (callId) return null;
    return { callId: null, kind: "text", text: typeof it.text === "string" ? it.text : String(it.text ?? "") };
  }
  if (type === "thinking") {
    if (callId) return null;
    const text = typeof it.thinking === "string" ? it.thinking : String(it.thinking ?? "");
    return { callId: null, kind: "thinking", text };
  }
  if (type === "toolCall") {
    const id = typeof it.id === "string" && it.id ? it.id : null;
    if (callId && id !== callId) return null;
    const name = typeof it.name === "string" && it.name ? it.name : "tool";
    return { callId: id, kind: "toolCall", text: `${name}(${stringifyArgs(it.arguments)})` };
  }
  if (callId) return null;
  const label = typeof type === "string" && type ? type : "unknown";
  return { callId: null, kind: "other", text: `[unsupported content item: ${label}]` };
}

/**
 * Render a session entry into role + items, optionally narrowed to one tool call.
 *
 * Handles `type:"message"` lines and extension-injected `type:"custom_message"` entries. The
 * latter do participate in LLM context upstream (`convertToLlm` maps role `custom` to `user`), so
 * they are expandable too; they carry no tool calls, so a `#call_` selector can never match one.
 * Returns null when nothing usable matches the requested selector.
 * @internal
 */
export function renderMessage(line: unknown, callId: string | null): RenderedMessage | null {
  if (!line || typeof line !== "object") return null;
  const entry = line as Record<string, any>;
  const custom = entry.type === "custom_message";
  const message = custom ? null : entry.message;
  if (!custom && (!message || typeof message !== "object")) return null;
  if (custom && callId) return null;
  const role = custom ? "user" : typeof message.role === "string" && message.role ? message.role : "unknown";
  const content = custom ? entry.content : message.content;
  const items: RenderedItem[] = [];
  if (Array.isArray(content)) {
    for (const item of content) {
      const rendered = renderContentItem(item, callId);
      if (rendered) items.push(rendered);
    }
  } else if (typeof content === "string") {
    if (!callId) items.push({ callId: null, kind: "text", text: content });
  }
  if (items.length === 0) return null;
  return { role, items };
}

/** Bytes read from a file plus its size after the read. */
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
  /** File size after the read; larger than `bytesRead` means bytes were left behind. */
  totalBytes: number;
  /** True when bytes existed past the returned buffer (the trailing partial line is dropped). */
  truncated: boolean;
  /** True when the session file is gone or unreadable (deleted, rotated, renamed, or not permitted). */
  missing: boolean;
}

/**
 * Open `file` and read at most `maxBytes` of it.
 *
 * The cap is physical: bytes are pulled from an open handle in bounded steps, so a multi-megabyte
 * session file never has to fit in memory just to resolve a few references. The size comes from the
 * same handle is re-statted after the transfer, which tells the caller whether anything was left
 * past the returned buffer.
 * @internal
 */
export async function readCapped(file: string, maxBytes: number): Promise<ReadResult> {
  const { promises: fsp } = await import("node:fs");
  const cap = Math.max(0, Math.floor(maxBytes));
  const handle = await fsp.open(file, "r");
  try {
    const { size } = await handle.stat();
    const want = Math.min(cap, size);
    const buffer = Buffer.allocUnsafe(want);
    let filled = 0;
    while (filled < want) {
      const { bytesRead } = await handle.read(buffer, filled, want - filled, filled);
      if (bytesRead <= 0) break;
      filled += bytesRead;
    }
    // Re-stat instead of reporting the size from before the transfer: a session file can grow or
    // shrink while it is read, and the caller's "is there data past this buffer?" must not use a
    // stale value (a shrink used to look truncated and cost a complete line).
    const { size: after } = await handle.stat();
    return { buffer: buffer.subarray(0, filled), totalBytes: after };
  } finally {
    try {
      await handle.close();
    } catch {
      // Never let a close failure mask the real read error.
    }
  }
}

/**
 * Read a session `.jsonl` up to `maxReadBytes` and index its message entries by id.
 *
 * The read is physically byte-capped (see {@link readCapped}): expansion must not become a way to
 * stream a whole session file into memory. When the cap cuts the file mid-line the trailing
 * fragment is dropped, so a truncated read can only lose messages, never corrupt them. A session
 * file that has been deleted, rotated, renamed, or cannot be opened is not an error: every
 * reference in it is reported as missing instead of failing the call.
 * @internal
 */
export async function readSessionMessages(
  sessionFile: string,
  maxReadBytes: number,
  readFile: (file: string, maxBytes: number) => Promise<ReadResult> = readCapped,
): Promise<SessionRead> {
  const messages = new Map<string, any>();
  const cap = Math.max(0, Math.floor(maxReadBytes));
  let read: ReadResult;
  try {
    read = await readFile(sessionFile, cap);
  } catch (e) {
    // Gone or not readable: both degrade to "nothing recoverable here", never to a failed call.
    if (e && ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EISDIR"].includes(e.code)) {
      return { messages, bytesRead: 0, totalBytes: 0, truncated: false, missing: true };
    }
    throw e;
  }
  // "Truncated" means bytes exist past the buffer, whatever the reason: the cap, or a file that grew
  // while it was read. Comparing against the stale cap alone reported a shrink as truncation.
  const truncated = read.buffer.length < read.totalBytes;
  const text = read.buffer.toString("utf8");
  const parts = text.split("\n");
  if (truncated && !text.endsWith("\n")) parts.pop(); // drop the fragment the cut left mid-line
  for (const part of parts) {
    const raw = part.trim();
    if (!raw) continue;
    let line: any;
    try {
      line = JSON.parse(raw);
    } catch {
      continue; // tolerate a partially written or non-JSON line
    }
    if (!line || typeof line !== "object") continue;
    // Extension-injected `custom_message` entries participate in LLM context, so they count too.
    if (line.type !== "message" && line.type !== "custom_message") continue;
    if (typeof line.id !== "string" || !line.id) continue;
    messages.set(line.id, line);
  }
  return { messages, bytesRead: read.buffer.length, totalBytes: read.totalBytes, truncated, missing: false };
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
  redact?: (text: string) => { text: string; hits: number };
  /** Test seam for the file read. */
  readFile?: (file: string, maxBytes: number) => Promise<ReadResult>;
}

function renderEntry(rendered: RenderedMessage): string {
  const parts: string[] = [];
  for (const item of rendered.items) {
    const label =
      item.kind === "thinking"
        ? "thinking"
        : item.kind === "toolCall"
          ? `tool call${item.callId ? ` ${item.callId}` : ""}`
          : item.kind;
    parts.push(item.kind === "text" ? item.text : `-- ${label} --\n${item.text}`);
  }
  return parts.join("\n");
}

/**
 * Resolve a block's message references back to original text.
 *
 * `list` mode is the safe default: it reports what is available (ref, role, size, presence) without
 * returning any conversation text, so a caller must make an explicit second call to read a
 * selection. `full` mode renders the selection, stopping as soon as `maxChars`/`maxMessages` are
 * reached.
 * @internal
 */
export async function expandBlock(opts: ExpandOptions): Promise<ExpandResult> {
  const select = Array.isArray(opts.select) ? opts.select.filter((n) => Number.isInteger(n) && n > 0) : [];
  if (opts.mode === "full" && select.length === 0) {
    throw new Error('mode "full" requires a non-empty select (run mode "list" first and pick indices)');
  }
  const read = await readSessionMessages(opts.sessionFile, opts.maxReadBytes, opts.readFile);
  const entries: ExpandEntry[] = [];
  const renderedByIndex = new Map<number, RenderedMessage>();

  let availableChars = 0;
  let index = 0;
  for (const ref of opts.msgIds) {
    index++;
    const { base, callId } = splitMessageId(ref);
    const line = read.messages.get(base);
    const rendered = line ? renderMessage(line, callId) : null;
    const body = rendered ? renderEntry(rendered) : "";
    if (rendered) {
      renderedByIndex.set(index, rendered);
      availableChars += body.length;
    }
    entries.push({
      index,
      ref,
      messageId: base,
      callId,
      role: rendered ? rendered.role : null,
      chars: body.length,
      found: Boolean(rendered),
    });
  }

  const base: ExpandResult = {
    entries,
    text: null,
    truncated: false,
    availableChars,
    returnedChars: 0,
    skippedMessages: 0,
    readTruncated: read.truncated,
    bytesRead: read.bytesRead,
    totalBytes: read.totalBytes,
    sessionMissing: read.missing,
  };

  if (opts.mode === "list") return { ...base, text: null };

  // `full` only ever renders an explicit selection (enforced above), so `wanted` is never null.
  const wanted = new Set(select);
  // Truncation must describe the request, not the block: returning a deliberate subset is not
  // truncation, so scope the "was everything returned?" check to the selected entries.
  let requestedCount = 0;
  for (const entry of entries) {
    if (wanted.has(entry.index) && entry.found) requestedCount++;
  }
  const maxChars = Math.max(0, Math.floor(opts.maxChars));
  const maxMessages = Math.max(1, Math.floor(opts.maxMessages));
  const chunks: string[] = [];
  let used = 0;
  let returned = 0;
  // Indices the caller asked for that the block cannot render (out of range, no text, synthetic)
  // are skipped too: a selection that resolves to nothing must not look like a clean empty result.
  let skipped = Math.max(0, wanted.size - requestedCount);
  let capTrimmed = false;

  for (const entry of entries) {
    if (!wanted.has(entry.index)) continue;
    if (!entry.found) continue;
    if (returned >= maxMessages) {
      skipped++;
      continue;
    }
    const rendered = renderedByIndex.get(entry.index);
    if (!rendered) continue;
    let body = renderEntry(rendered);
    if (opts.redact) body = opts.redact(body).text;
    const header = `### [${entry.index}] ${entry.role ?? "unknown"}${entry.callId ? ` · ${entry.callId}` : ""} · ${body.length} chars\n`;
    const sep = chunks.length ? 2 : 0;
    const room = maxChars - used - sep;
    if (room <= 0) {
      skipped++;
      continue;
    }
    if (header.length + body.length <= room) {
      chunks.push(`${header}${body}`);
      used += sep + header.length + body.length;
      returned++;
      continue;
    }
    // The entry does not fit whole: trim it into the remaining room. The header and the marker are
    // part of that budget, so `text.length` never exceeds `maxChars`. Later entries then fall
    // through as skipped, because the budget is spent.
    const marker = `\n[entry truncated at ${maxChars} chars]`;
    const bodyRoom = room - header.length - marker.length;
    if (bodyRoom > 0) {
      chunks.push(`${header}${body.slice(0, bodyRoom)}${marker}`);
      used += sep + header.length + bodyRoom + marker.length;
    } else {
      // Not even a header plus marker fit; fall back to the bare opening of the body.
      chunks.push(body.slice(0, room));
      used += sep + room;
    }
    returned++;
    capTrimmed = true;
  }

  base.text = chunks.join("\n\n");
  base.returnedChars = base.text.length;
  base.skippedMessages = skipped;
  // Truncated means "something the caller asked for is not in the text": a budget cap or dropped
  // entries. A trimmed entry must not clear an earlier cap flag, so this is only ever set.
  base.truncated = capTrimmed || skipped > 0 || returned < requestedCount;
  return base;
}
