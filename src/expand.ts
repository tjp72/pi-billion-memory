/**
 * Optional block expansion (`memory_expand`).
 *
 * A stored compression block knows which raw messages it absorbed (`blocks.msg_ids`, copied from
 * the sidecar's `effectiveMessageIds`). This module turns those ids back into the original
 * message text by reading the session `.jsonl` the block came from.
 *
 * Scope and guarantees:
 * - Read-only. Nothing is written back to the store; expanded text is returned to the caller only.
 * - Bounded. Every read and every response is capped by the caller's budgets (`maxReadBytes`,
 *   `maxChars`, `maxMessages`).
 * - On demand. Only messages already referenced by a stored block can be resolved; the reader is
 *   never used to walk a session file for discovery.
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
export type RenderedKind = "text" | "thinking" | "toolCall" | "toolResult" | "other";

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
 * (a `#call_` reference selects a tool call, not the surrounding prose).
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
  return null;
}

/**
 * Render a `type:"message"` line into role + items, optionally narrowed to one tool call.
 * Returns null when the line carries no usable content for the requested selector.
 * @internal
 */
export function renderMessage(line: unknown, callId: string | null): RenderedMessage | null {
  if (!line || typeof line !== "object") return null;
  const message = (line as Record<string, any>).message;
  if (!message || typeof message !== "object") return null;
  const role = typeof message.role === "string" && message.role ? message.role : "unknown";
  const content = message.content;
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

/** Result of reading a session file. */
export interface SessionRead {
  /** Raw message id -> parsed `type:"message"` line. */
  messages: Map<string, any>;
  /** Bytes actually read. */
  bytesRead: number;
  /** Total size of the file on disk. */
  totalBytes: number;
  /** True when the file was longer than the read cap (the trailing partial line is dropped). */
  truncated: boolean;
}

/**
 * Read a session `.jsonl` up to `maxReadBytes` and index its `type:"message"` lines by id.
 *
 * The read is intentionally byte-capped: expansion must not become a way to stream a whole
 * session file into memory. When the cap cuts the file mid-line the trailing fragment is dropped,
 * so a truncated read can only lose messages, never corrupt them.
 * @internal
 */
export async function readSessionMessages(
  sessionFile: string,
  maxReadBytes: number,
  readFile: (file: string) => Promise<Buffer> = (file) => readWholeFile(file),
): Promise<SessionRead> {
  const messages = new Map<string, any>();
  const buffer = await readFile(sessionFile);
  const totalBytes = buffer.length;
  const cap = Math.max(0, Math.floor(maxReadBytes));
  const truncated = totalBytes > cap;
  const slice = truncated ? buffer.subarray(0, cap) : buffer;
  const text = slice.toString("utf8");
  const parts = text.split("\n");
  if (truncated) parts.pop(); // drop the fragment the cap cut in half
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
    if (line.type !== "message") continue;
    if (typeof line.id !== "string" || !line.id) continue;
    messages.set(line.id, line);
  }
  return { messages, bytesRead: slice.length, totalBytes, truncated };
}

async function readWholeFile(file: string): Promise<Buffer> {
  const { promises: fsp } = await import("node:fs");
  return fsp.readFile(file);
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
}

export interface ExpandOptions {
  sessionFile: string;
  msgIds: string[];
  mode: "list" | "full";
  /** 1-based entry indices to render; null/empty means "all" in `full` mode. */
  select?: number[] | null;
  maxChars: number;
  maxMessages: number;
  maxReadBytes: number;
  /** Injected redaction filter applied to rendered text before it is returned. */
  redact?: (text: string) => { text: string; hits: number };
  /** Test seam for the file read. */
  readFile?: (file: string) => Promise<Buffer>;
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
  const select = Array.isArray(opts.select) ? opts.select.filter((n) => Number.isInteger(n) && n > 0) : null;
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
  };

  if (opts.mode === "list") return { ...base, text: null };

  const wanted = select && select.length > 0 ? new Set(select) : null;
  // Truncation must describe the request, not the block: returning a deliberate subset is not
  // truncation, so scope the "was everything returned?" check to the selected entries.
  let requestedCount = 0;
  for (const entry of entries) {
    if (wanted && !wanted.has(entry.index)) continue;
    if (entry.found) requestedCount++;
  }
  const maxChars = Math.max(0, Math.floor(opts.maxChars));
  const maxMessages = Math.max(1, Math.floor(opts.maxMessages));
  const chunks: string[] = [];
  let used = 0;
  let returned = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (wanted && !wanted.has(entry.index)) continue;
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
    const block = `${header}${body}`;
    const cost = block.length + (chunks.length ? 2 : 0);
    if (used + cost > maxChars && returned > 0) {
      skipped++;
      continue;
    }
    if (used + cost > maxChars && returned === 0) {
      // Always return at least one entry, trimmed, so a small budget still yields something useful.
      const room = Math.max(0, maxChars - header.length);
      chunks.push(`${header}${body.slice(0, room)}\n[entry truncated at ${maxChars} chars]`);
      used += header.length + room;
      returned++;
      base.truncated = true;
      continue;
    }
    chunks.push(block);
    used += cost;
    returned++;
  }

  if (returned === 0) {
    base.text = "";
    base.truncated = skipped > 0;
    base.skippedMessages = skipped;
    return base;
  }

  base.text = chunks.join("\n\n");
  base.returnedChars = used;
  base.skippedMessages = skipped;
  base.truncated = skipped > 0 || returned < requestedCount;
  return base;
}
