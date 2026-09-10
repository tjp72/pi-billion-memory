import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// pi-billion-memory - MIT License


// src/expand.ts
var CALL_SEPARATOR = "#";
var SYNTHETIC_REF_PREFIX = "acp_summary_";
function splitMessageId(raw) {
  const s = typeof raw === "string" ? raw : String(raw ?? "");
  const at = s.indexOf(CALL_SEPARATOR);
  if (at <= 0) return { base: s, callId: null };
  const callId = s.slice(at + CALL_SEPARATOR.length);
  return { base: s.slice(0, at), callId: callId || null };
}
function isSyntheticRef(id) {
  return typeof id === "string" && id.startsWith(SYNTHETIC_REF_PREFIX);
}
function parseMsgIds(json) {
  if (typeof json !== "string" || !json.trim()) return [];
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
function stringifyArgs(args) {
  if (args == null) return "";
  try {
    const s = JSON.stringify(args);
    return s === void 0 ? String(args) : s;
  } catch {
    return "[unserializable arguments]";
  }
}
function renderContentItem(item, callId) {
  if (!item || typeof item !== "object") return null;
  const it = item;
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
function renderMessage(line, callId) {
  if (!line || typeof line !== "object") return null;
  const entry = line;
  const custom = entry.type === "custom_message";
  const message = custom ? null : entry.message;
  if (!custom && (!message || typeof message !== "object")) return null;
  if (custom && callId) return null;
  const role = custom ? "user" : typeof message.role === "string" && message.role ? message.role : "unknown";
  const content = custom ? entry.content : message.content;
  const items = [];
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
async function readCapped(file, maxBytes) {
  const { promises: fsp } = await import('fs');
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
    const { size: after } = await handle.stat();
    return { buffer: buffer.subarray(0, filled), totalBytes: after };
  } finally {
    try {
      await handle.close();
    } catch {
    }
  }
}
async function readSessionMessages(sessionFile, maxReadBytes, readFile = readCapped) {
  const messages = /* @__PURE__ */ new Map();
  const cap = Math.max(0, Math.floor(maxReadBytes));
  let read;
  try {
    read = await readFile(sessionFile, cap);
  } catch (e) {
    if (e && ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EISDIR"].includes(e.code)) {
      return { messages, bytesRead: 0, totalBytes: 0, truncated: false, missing: true };
    }
    throw e;
  }
  const truncated = read.buffer.length < read.totalBytes;
  const text = read.buffer.toString("utf8");
  const parts = text.split("\n");
  if (truncated && !text.endsWith("\n")) parts.pop();
  for (const part of parts) {
    const raw = part.trim();
    if (!raw) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!line || typeof line !== "object") continue;
    if (line.type !== "message" && line.type !== "custom_message") continue;
    if (typeof line.id !== "string" || !line.id) continue;
    messages.set(line.id, line);
  }
  return { messages, bytesRead: read.buffer.length, totalBytes: read.totalBytes, truncated, missing: false };
}
function renderEntry(rendered) {
  const parts = [];
  for (const item of rendered.items) {
    const label = item.kind === "thinking" ? "thinking" : item.kind === "toolCall" ? `tool call${item.callId ? ` ${item.callId}` : ""}` : item.kind;
    parts.push(item.kind === "text" ? item.text : `-- ${label} --
${item.text}`);
  }
  return parts.join("\n");
}
async function expandBlock(opts) {
  const select = Array.isArray(opts.select) ? opts.select.filter((n) => Number.isInteger(n) && n > 0) : [];
  if (opts.mode === "full" && select.length === 0) {
    throw new Error('mode "full" requires a non-empty select (run mode "list" first and pick indices)');
  }
  const read = await readSessionMessages(opts.sessionFile, opts.maxReadBytes, opts.readFile);
  const entries = [];
  const renderedByIndex = /* @__PURE__ */ new Map();
  let availableChars = 0;
  let index = 0;
  for (const ref of opts.msgIds) {
    index++;
    const { base: base2, callId } = splitMessageId(ref);
    const line = read.messages.get(base2);
    const rendered = line ? renderMessage(line, callId) : null;
    const body = rendered ? renderEntry(rendered) : "";
    if (rendered) {
      renderedByIndex.set(index, rendered);
      availableChars += body.length;
    }
    entries.push({
      index,
      ref,
      messageId: base2,
      callId,
      role: rendered ? rendered.role : null,
      chars: body.length,
      found: Boolean(rendered)
    });
  }
  const base = {
    entries,
    text: null,
    truncated: false,
    availableChars,
    returnedChars: 0,
    skippedMessages: 0,
    readTruncated: read.truncated,
    bytesRead: read.bytesRead,
    totalBytes: read.totalBytes,
    sessionMissing: read.missing
  };
  if (opts.mode === "list") return { ...base, text: null };
  const wanted = new Set(select);
  let requestedCount = 0;
  for (const entry of entries) {
    if (wanted.has(entry.index) && entry.found) requestedCount++;
  }
  const maxChars = Math.max(0, Math.floor(opts.maxChars));
  const maxMessages = Math.max(1, Math.floor(opts.maxMessages));
  const chunks = [];
  let used = 0;
  let returned = 0;
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
    const header = `### [${entry.index}] ${entry.role ?? "unknown"}${entry.callId ? ` \xB7 ${entry.callId}` : ""} \xB7 ${body.length} chars
`;
    const sep2 = chunks.length ? 2 : 0;
    const room = maxChars - used - sep2;
    if (room <= 0) {
      skipped++;
      continue;
    }
    if (header.length + body.length <= room) {
      chunks.push(`${header}${body}`);
      used += sep2 + header.length + body.length;
      returned++;
      continue;
    }
    const marker = `
[entry truncated at ${maxChars} chars]`;
    const bodyRoom = room - header.length - marker.length;
    if (bodyRoom > 0) {
      chunks.push(`${header}${body.slice(0, bodyRoom)}${marker}`);
      used += sep2 + header.length + bodyRoom + marker.length;
    } else {
      chunks.push(body.slice(0, room));
      used += sep2 + room;
    }
    returned++;
    capTrimmed = true;
  }
  base.text = chunks.join("\n\n");
  base.returnedChars = base.text.length;
  base.skippedMessages = skipped;
  base.truncated = capTrimmed || skipped > 0 || returned < requestedCount;
  return base;
}

// src/extension.ts
var HOME = os.homedir();
var PI_DIR = path.join(HOME, ".pi");
var CFG_PATH = path.join(PI_DIR, "pi-billion-memory.json");
var DEFAULT_CFG = {
  /** SQLite store location (default ~/.pi/pi-billion-memory.db) */
  dbPath: path.join(PI_DIR, "pi-billion-memory.db"),
  /** Max summary chars stored per block; longer ones are truncated to keep the store small */
  maxSummaryChars: 2e4,
  /** Debug logging */
  debug: false,
  /** Directory names to skip inside pi-sidecar source roots (e.g. encoded private project dirs) */
  excludeDirs: [],
  /** Background full allow-list scan on session start; disable for faster startups */
  scanOnStartup: true,
  /** JSONL allow-list of compression source roots (one JSON object per line) */
  sourcesPath: path.join(PI_DIR, "pi-billion-memory.sources.jsonl"),
  /** Log file (overridable so tests never write to the real ~/.pi log) */
  logPath: path.join(PI_DIR, "pi-billion-memory.log"),
  /**
   * Register the `memory_expand` tool, which resolves a stored block back to the original
   * session messages it absorbed. Off by default: expansion re-reads raw conversation lines,
   * which the ingestion path deliberately never touches, so it must be enabled on purpose.
   */
  expandEnabled: false,
  /** Hard cap on characters returned by one `memory_expand` call. */
  expandMaxChars: 4e4,
  /** Hard cap on messages rendered by one `memory_expand` call. */
  expandMaxMessages: 200,
  /** Hard cap on bytes read from a session file by one `memory_expand` call. */
  expandMaxReadBytes: 32 * 1024 * 1024
};
var MAX_TOPIC_CHARS = 200;
var PREVIEW_CHARS = 600;
var MAX_MSG_IDS = 4e3;
var EXPAND_MANIFEST_MAX = 300;
var DEFAULT_RESULT_LIMIT = 6;
var MAX_RESULT_LIMIT = 20;
var LOG_MAX_BYTES = 1e6;
var TRIGRAM_MIN_LEN = 3;
var PI_MAP_TTL_MS = 10 * 60 * 1e3;
var SESSION_HEADER_MAX_BYTES = 1e6;
function sanitizeCfg(over) {
  const out = {};
  if (!over || typeof over !== "object") return out;
  if (typeof over.dbPath === "string" && over.dbPath) out.dbPath = expandHome(over.dbPath);
  if (typeof over.maxSummaryChars === "number" && Number.isFinite(over.maxSummaryChars) && over.maxSummaryChars > 0) {
    out.maxSummaryChars = Math.floor(over.maxSummaryChars);
  }
  if (typeof over.debug === "boolean") out.debug = over.debug;
  if (Array.isArray(over.excludeDirs)) out.excludeDirs = over.excludeDirs.filter((x) => typeof x === "string");
  if (typeof over.scanOnStartup === "boolean") out.scanOnStartup = over.scanOnStartup;
  if (typeof over.sourcesPath === "string" && over.sourcesPath) out.sourcesPath = expandHome(over.sourcesPath);
  if (typeof over.logPath === "string" && over.logPath) out.logPath = expandHome(over.logPath);
  if (typeof over.expandEnabled === "boolean") out.expandEnabled = over.expandEnabled;
  if (Number.isInteger(over.expandMaxChars) && over.expandMaxChars > 0) out.expandMaxChars = over.expandMaxChars;
  if (Number.isInteger(over.expandMaxMessages) && over.expandMaxMessages > 0)
    out.expandMaxMessages = over.expandMaxMessages;
  if (Number.isInteger(over.expandMaxReadBytes) && over.expandMaxReadBytes > 0)
    out.expandMaxReadBytes = over.expandMaxReadBytes;
  return out;
}
var cfg = { ...DEFAULT_CFG };
try {
  if (fs.existsSync(CFG_PATH)) {
    cfg = { ...DEFAULT_CFG, ...sanitizeCfg(JSON.parse(fs.readFileSync(CFG_PATH, "utf8"))) };
  }
} catch (e) {
  logLine(`config load failed: ${withoutPaths(e.message)}`);
}
function syncLogPath() {
  if (typeof cfg.logPath !== "string" || !cfg.logPath) cfg.logPath = DEFAULT_CFG.logPath;
}
syncLogPath();
function logLine(msg) {
  const line = `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`;
  try {
    const logPath = cfg.logPath || DEFAULT_CFG.logPath;
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > LOG_MAX_BYTES) {
      fs.truncateSync(logPath, 0);
    }
    fs.appendFileSync(logPath, line);
  } catch {
  }
}
function log(msg) {
  if (cfg.debug) logLine(msg);
}
var SECRET_KEY_NAMES = [
  "password",
  "passwd",
  "passphrase",
  "pass",
  "pwd",
  "secret",
  "api[\\s_-]*(?:key|secret|token)",
  "apikey",
  "access[\\s_-]*key(?:[\\s_-]*id)?",
  "secret[\\s_-]*(?:access[\\s_-]*)?key",
  "client[\\s_-]*secret",
  "app[\\s_-]*secret",
  "consumer[\\s_-]*secret",
  "private[\\s_-]*key",
  "account[\\s_-]*key",
  "storage[\\s_-]*key",
  "subscription[\\s_-]*key",
  "function[\\s_-]*key",
  "connection[\\s_-]*string",
  "auth[\\s_-]*token",
  "access[\\s_-]*token",
  "refresh[\\s_-]*token",
  "id[\\s_-]*token",
  "session[\\s_-]*(?:id|token|key|secret)",
  "csrf[\\s_-]*token",
  "oauth[\\s_-]*token",
  "bearer[\\s_-]*token",
  "seed[\\s_-]*phrase",
  "mnemonic",
  "otp",
  "totp",
  "token"
].join("|");
var SECRET_KEY_PREFIX = `(?<![A-Za-z0-9])((?:${SECRET_KEY_NAMES}))(?![A-Za-z0-9_-])`;
var QUOTED_SECRET_RE = new RegExp(`${SECRET_KEY_PREFIX}(["']?)(\\s*[:=]\\s*)(["'])([^"']{4,})\\4`, "gi");
var UNQUOTED_SECRET_RE = new RegExp(`${SECRET_KEY_PREFIX}(["']?)(\\s*[:=]\\s*)([^\\s"',;]{6,})`, "gi");
var CHINESE_SECRET_RE = /((?:密码|口令|密钥|令牌|私钥|访问密钥|api密钥))\s*(?:是|为|[:=：])\s*["']?([^\s"'，；,;]{4,})/gi;
var URL_RE = /\b(?:(?:https?|ftp|file|ssh|git|wss?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/|www\.)[^\s<>"'`]*[A-Za-z0-9/#=?_~%&+-]/gi;
var SECRET_PATTERNS = [
  { re: QUOTED_SECRET_RE, to: "$1$2$3$4[REDACTED]$4" },
  { re: UNQUOTED_SECRET_RE, to: "$1$2$3[REDACTED]" },
  { re: URL_RE, to: "[REDACTED_URL]" },
  {
    re: /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]{20,})\b/g,
    to: "[REDACTED]"
  },
  {
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    to: "[REDACTED_JWT]"
  },
  {
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/g,
    to: "[REDACTED_PRIVATE_KEY]"
  },
  {
    re: /\b(Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    to: "$1: [REDACTED]"
  },
  {
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    to: "Bearer [REDACTED]"
  },
  {
    re: /\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,
    to: "Cookie: [REDACTED]"
  },
  { re: CHINESE_SECRET_RE, to: "$1: [REDACTED]" }
];
function redactSecrets(text) {
  let out = typeof text === "string" ? text : "";
  let hits = 0;
  for (const { re, to } of SECRET_PATTERNS) {
    const found = out.match(re);
    if (found && found.length > 0) {
      hits += found.length;
      out = out.replace(re, to);
    }
  }
  return { text: out, hits };
}
var DatabaseSyncCtor = null;
async function loadSqlite() {
  if (DatabaseSyncCtor) return DatabaseSyncCtor;
  try {
    const sqliteModule = "node:sqlite";
    const m = await import(sqliteModule);
    DatabaseSyncCtor = m.DatabaseSync;
  } catch (e) {
    logLine(`node:sqlite unavailable (need node>=22.19): ${withoutPaths(e.message)}`);
  }
  return DatabaseSyncCtor;
}
function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  if (p.startsWith("~\\")) return path.join(HOME, p.slice(2));
  return p;
}
function defaultSources() {
  const piRoot = path.join(PI_DIR, "agent", "sessions");
  const ocRoot = path.join(HOME, ".local", "share", "opencode", "storage", "plugin", "acp");
  const ocDb = path.join(HOME, ".local", "share", "opencode", "opencode.db");
  return [
    {
      id: "pi",
      adapter: "pi-sidecar",
      root: piRoot,
      pattern: "**/*.jsonl.acp.json",
      enabled: true
    },
    {
      id: "opencode",
      adapter: "opencode-acp",
      root: ocRoot,
      pattern: "ses_*.json",
      enabled: true,
      opencodeDb: ocDb
    }
  ];
}
function blockFilter(blockId, source) {
  const params = [String(blockId)];
  let where = "b.block_id = ?";
  if (source) {
    where += " AND (b.source_file LIKE ? ESCAPE '\\' OR s.project LIKE ? ESCAPE '\\')";
    const like = `%${String(source).replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    params.push(like, like);
  }
  return { where, params };
}
function withoutPaths(text) {
  return String(text).replace(/file:\/\/\/[^\s'"]+/g, "file://<path>").replace(/(?<![\w:/\\])(?:[A-Za-z]:[\\/]|\\\\|\/\/)[^\s'"]+(?: [^\s'"]*[\\/][^\s'"]*)*/g, "<path>").replace(/(?<![\w.:/\\])~?\/(?:[^\s'":,)]*\/)*[^\s'":,)]+(?: [^\s'":,)]*\/[^\s'":,)]*)*/g, "<path>");
}
var SOURCE_ADAPTERS = /* @__PURE__ */ new Set(["pi-sidecar", "opencode-acp"]);
function sanitizeSource(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id : null;
  const adapter = typeof raw.adapter === "string" ? raw.adapter : null;
  const root = typeof raw.root === "string" ? expandHome(raw.root) : null;
  const pattern = typeof raw.pattern === "string" ? raw.pattern : null;
  if (!id || !adapter || !root || !pattern) return null;
  if (!SOURCE_ADAPTERS.has(adapter)) return null;
  const out = {
    id,
    adapter,
    root,
    pattern,
    enabled: raw.enabled !== false
  };
  if (typeof raw.opencodeDb === "string" && raw.opencodeDb) out.opencodeDb = expandHome(raw.opencodeDb);
  return out;
}
async function loadSources() {
  const sourcesPath = cfg.sourcesPath || DEFAULT_CFG.sourcesPath;
  let text;
  try {
    text = await fs.promises.readFile(sourcesPath, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return defaultSources();
    logLine(`sources read failed (fail-closed, no sources): ${withoutPaths(e.message)}`);
    return [];
  }
  const list = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    try {
      const parsed = JSON.parse(line);
      const s = sanitizeSource(parsed);
      if (s) list.push(s);
      else logLine(`sources line ignored: bad id/adapter/root/pattern or unknown adapter '${parsed?.adapter}'`);
    } catch (e) {
      logLine(`sources line ignored: ${withoutPaths(e.message)}`);
    }
  }
  return list;
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function globToRegExp(pattern) {
  const segs = String(pattern).split(/[\\/]/).filter(Boolean);
  let re = "^";
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (seg === "**") {
      re += last ? ".*" : "(?:[^/]+/)*";
      continue;
    }
    re += seg.split("*").map(escapeRegExp).join("[^/]*");
    if (!last) re += "/";
  }
  return new RegExp(`${re}$`);
}
var MAX_SCAN_ENTRIES = 2e5;
var MAX_SCAN_FILES = 2e4;
async function walkGlob(dir, re, budget, errors, prefix = "") {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    errors.push(e);
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (budget.visitedLeft <= 0) {
      budget.hitVisited = true;
      break;
    }
    budget.visitedLeft--;
    if (ent.isDirectory()) {
      out.push(...await walkGlob(path.join(dir, ent.name), re, budget, errors, `${prefix}${ent.name}/`));
    } else if (ent.isFile()) {
      if (!re.test(`${prefix}${ent.name}`)) continue;
      if (budget.matchedLeft <= 0) {
        budget.hitMatched = true;
        break;
      }
      budget.matchedLeft--;
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}
async function listSourceFiles(source) {
  const errors = [];
  const segs = String(source.pattern).split(/[\\/]/).filter(Boolean);
  const filePattern = segs.pop() || source.pattern;
  let start = source.root;
  while (segs.length && !segs[0].includes("*")) {
    start = path.join(start, segs.shift());
  }
  if (segs.length === 0) {
    const re2 = globToRegExp(filePattern);
    try {
      const entries = await fs.promises.readdir(start, { withFileTypes: true });
      const matched = entries.filter((ent) => ent.isFile() && re2.test(ent.name)).map((ent) => path.join(start, ent.name));
      if (matched.length > MAX_SCAN_FILES) {
        logLine(
          `scan: source '${source.id}' has ${matched.length} matching files; only the first ${MAX_SCAN_FILES} are considered`
        );
        matched.length = MAX_SCAN_FILES;
      }
      return { files: matched, errors };
    } catch (e) {
      errors.push(e);
      return { files: [], errors };
    }
  }
  const re = globToRegExp([...segs, filePattern].join("/"));
  const budget = { visitedLeft: MAX_SCAN_ENTRIES, matchedLeft: MAX_SCAN_FILES, hitVisited: false, hitMatched: false };
  const files = await walkGlob(start, re, budget, errors);
  if (budget.hitVisited || budget.hitMatched) {
    logLine(
      `scan: source '${source.id}' hit the ${budget.hitMatched ? `${MAX_SCAN_FILES}-match` : `${MAX_SCAN_ENTRIES}-entry`} cap; the rest was skipped (check that the allow-list root points at a session directory, not at a whole home directory)`
    );
  }
  return { files, errors };
}
function cleanOpencodeSummary(summary) {
  return String(summary).replace(/\s*<dcp-message-id>.*?<\/dcp-message-id>\s*$/s, "").trim();
}
function collectMsgIds(block) {
  const raw = [block?.effectiveMessageIds, block?.messageIds].find(
    (v) => Array.isArray(v) && v.some((item) => typeof item === "string" && item.trim() !== "")
  );
  if (!raw) return null;
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_MSG_IDS) break;
  }
  return out.length ? out : null;
}
function normalizePiBlocks(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.blocks)) return null;
  const out = [];
  for (const b of data.blocks) {
    if (!b || typeof b.blockId !== "string" && typeof b.blockId !== "number" || typeof b.summary !== "string")
      continue;
    out.push({
      blockId: String(b.blockId),
      runId: typeof b.runId === "string" ? b.runId : typeof b.runId === "number" ? String(b.runId) : null,
      tier: Number.isInteger(b.tier) ? b.tier : null,
      topic: typeof b.topic === "string" && b.topic ? b.topic.slice(0, MAX_TOPIC_CHARS) : null,
      summary: b.summary,
      msgIds: collectMsgIds(b),
      refStart: typeof b.startRef === "string" ? b.startRef : null,
      refEnd: typeof b.endRef === "string" ? b.endRef : null,
      compressedTokens: Number.isInteger(b.compressedTokens) ? b.compressedTokens : null,
      createdAt: Number.isInteger(b.createdAt) ? b.createdAt : null
    });
  }
  return out;
}
function normalizeOpencodeBlocks(data) {
  const byId = data?.prune?.messages?.blocksById;
  if (!byId || typeof byId !== "object") return null;
  const out = [];
  for (const [key, b] of Object.entries(byId)) {
    if (!b || typeof b.summary !== "string") continue;
    const rawId = b.blockId ?? key;
    out.push({
      blockId: String(rawId),
      runId: b.runId != null ? String(b.runId) : null,
      tier: Number.isInteger(b.tier) ? b.tier : null,
      topic: (typeof b.topic === "string" && b.topic ? b.topic : typeof b.batchTopic === "string" ? b.batchTopic : "").slice(
        0,
        MAX_TOPIC_CHARS
      ) || null,
      summary: cleanOpencodeSummary(b.summary),
      msgIds: collectMsgIds(b),
      refStart: typeof b.startId === "string" ? b.startId : null,
      refEnd: typeof b.endId === "string" ? b.endId : null,
      compressedTokens: Number.isInteger(b.compressedTokens) ? b.compressedTokens : null,
      createdAt: Number.isInteger(b.createdAt) ? b.createdAt : null
    });
  }
  return out;
}
var MemoryDb = class {
  dbPath;
  db = null;
  /** True between close() and the next open(): an in-flight ingest must fail, not touch a null handle. */
  closed = false;
  /**
   * @param {string} dbPath
   */
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }
  open() {
    if (this.db) return;
    if (dbClosed) throw new Error("memory store is closed for this session");
    if (!DatabaseSyncCtor) throw new Error("node:sqlite unavailable");
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSyncCtor(this.dbPath);
    this.closed = false;
    try {
      if (process.platform !== "win32") fs.chmodSync(this.dbPath, 384);
    } catch {
    }
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA busy_timeout=5000;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    const hasSources = this.db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='sources'").get().c > 0;
    if (!hasSources) {
      this.db.exec("DROP TABLE IF EXISTS blocks_fts;");
      this.db.exec("DROP TABLE IF EXISTS blocks;");
      this.db.exec("DROP TABLE IF EXISTS sessions;");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources(
        source_file    TEXT PRIMARY KEY,      -- actual file that was parsed (sidecar or ACP state file)
        kind           TEXT NOT NULL DEFAULT 'pi',  -- 'pi' | 'opencode'
        project        TEXT NOT NULL,         -- working dir folder name (basename(cwd))
        cwd            TEXT,
        last_mtime_ms  INTEGER DEFAULT 0,     -- source file mtime of last successful scan
        last_size      INTEGER DEFAULT 0,
        first_seen_at  INTEGER,
        updated_at     INTEGER
      );
      CREATE TABLE IF NOT EXISTS blocks(
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        source_file       TEXT NOT NULL,
        kind              TEXT NOT NULL DEFAULT 'pi',
        block_id          TEXT NOT NULL,      -- "b1", "1", monotonic per source
        run_id            TEXT,
        tier              INTEGER,
        topic             TEXT,
        summary           TEXT NOT NULL,
        ref_start         TEXT,
        ref_end           TEXT,
        compressed_tokens INTEGER,
        created_at        INTEGER,            -- block.createdAt / block.createdAt (ms)
        msg_ids           TEXT,               -- JSON array of raw message ids (NULL = not expandable)
        UNIQUE(source_file, block_id)
      );
      CREATE INDEX IF NOT EXISTS idx_blocks_source ON blocks(source_file);
      CREATE INDEX IF NOT EXISTS idx_blocks_created ON blocks(created_at);
      -- Durable ingestion watermarks: survive prune() deleting block-less sources rows.
      CREATE TABLE IF NOT EXISTS source_watermarks(
        source_file   TEXT PRIMARY KEY,
        last_mtime_ms INTEGER NOT NULL DEFAULT 0,
        last_size     INTEGER NOT NULL DEFAULT 0,
        updated_at    INTEGER
      );
      -- Durable prune tombstones: a later source-file change must not resurrect pruned blocks.
      CREATE TABLE IF NOT EXISTS block_tombstones(
        source_file TEXT NOT NULL,
        block_id    TEXT NOT NULL,
        pruned_at   INTEGER NOT NULL,
        PRIMARY KEY(source_file, block_id)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
        summary, topic,
        content='blocks', content_rowid='id',
        tokenize='trigram'
      );
    `);
    const blockCols = this.db.prepare("PRAGMA table_info(blocks)").all();
    const addedMsgIds = !blockCols.some((c) => c.name === "msg_ids");
    if (addedMsgIds) this.db.exec("ALTER TABLE blocks ADD COLUMN msg_ids TEXT;");
    this.db.exec(`
      INSERT OR IGNORE INTO source_watermarks(source_file, last_mtime_ms, last_size, updated_at)
      SELECT source_file, last_mtime_ms, last_size, updated_at
      FROM sources
      WHERE last_mtime_ms IS NOT NULL AND last_size IS NOT NULL;
    `);
    if (addedMsgIds) {
      this.db.exec("UPDATE source_watermarks SET last_mtime_ms = 0, last_size = 0;");
      logLine("migrated blocks.msg_ids; watermark ledger reset once for pointer backfill");
    }
    const trig = this.db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='trigger' AND name IN ('blocks_ai','blocks_ad')").get();
    if (!trig || trig.c < 2) {
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS blocks_ai AFTER INSERT ON blocks BEGIN
          INSERT INTO blocks_fts(rowid, summary, topic)
          VALUES (new.id, new.summary, coalesce(new.topic, ''));
        END;
        CREATE TRIGGER IF NOT EXISTS blocks_ad AFTER DELETE ON blocks BEGIN
          INSERT INTO blocks_fts(blocks_fts, rowid, summary, topic)
          VALUES ('delete', old.id, old.summary, coalesce(old.topic, ''));
        END;
      `);
      this.db.exec("INSERT INTO blocks_fts(blocks_fts) VALUES('rebuild');");
    }
  }
  close() {
    this.closed = true;
    if (this.db) {
      try {
        this.db.close();
      } catch (e) {
        log(`db close: ${e.message}`);
      }
      this.db = null;
    }
  }
  /**
   * Pi convenience wrapper: ingest one session sidecar.
   * Kept for incremental current-session scans and direct tests. When cwd is unknown, the
   * session header (first line) is read lazily to resolve it; message lines are never read.
   * @param {string} sessionFile absolute path of the session .jsonl
   * @param {string|null} cwd real working dir (may be null when unknown)
   * @param {boolean} force ignore the mtime/size watermark and rescan
   */
  async ingestSidecarFile(sessionFile, cwd = null, force = false) {
    const sidecar = sessionFile + ".acp.json";
    return this.ingestSourceFile(
      sidecar,
      {
        kind: "pi",
        cwd: cwd || null,
        project: cwd ? path.basename(cwd) : null
      },
      force,
      async (sf) => piSessionHeaderCwd(sf)
    );
  }
  /**
   * Parse and ingest one allow-listed compression source file.
   * The source_watermarks ledger advances (mtime/size) only after a successful parse; failed
   * parses and unrecognized payload shapes are retried on the next scan.
   * @param {string} sourceFile absolute path of the parsed compression file
   * @param {{kind?:string, cwd?:string|null, project?:string|null}} meta
   * @param {boolean} force ignore the mtime/size watermark and rescan
   * @param {((sessionFile:string)=>Promise<string|null>)|null} resolveCwd lazy cwd resolver
   */
  async ingestSourceFile(sourceFile, meta = {}, force = false, resolveCwd = null) {
    this.open();
    try {
      await fs.promises.access(sourceFile);
    } catch {
      return { ok: false, parsed: false, total: 0, inserted: 0, mtimeMs: 0, size: 0, error: "no source file" };
    }
    let st;
    try {
      st = await fs.promises.stat(sourceFile);
    } catch (e) {
      return { ok: false, parsed: false, total: 0, inserted: 0, mtimeMs: 0, size: 0, error: e.message };
    }
    const mtimeMs = st.mtimeMs;
    const size = st.size;
    const kind = meta?.kind === "opencode" ? "opencode" : "pi";
    let cwd = typeof meta?.cwd === "string" && meta.cwd ? meta.cwd : null;
    let project = typeof meta?.project === "string" && meta.project ? meta.project : null;
    if (!force) {
      const prev = this.db.prepare("SELECT last_mtime_ms, last_size FROM source_watermarks WHERE source_file = ?").get(sourceFile);
      if (prev && prev.last_mtime_ms === mtimeMs && prev.last_size === size) {
        return { ok: true, parsed: false, total: 0, inserted: 0, mtimeMs, size };
      }
    }
    if (kind === "pi" && !cwd) {
      if (!force) {
        const stored = this.db.prepare("SELECT cwd FROM sources WHERE source_file = ?").get(sourceFile);
        if (stored && typeof stored.cwd === "string" && stored.cwd) cwd = stored.cwd;
      }
      if (!cwd && typeof resolveCwd === "function") {
        const sessionFile = sourceFile.endsWith(".acp.json") ? sourceFile.slice(0, -".acp.json".length) : sourceFile;
        try {
          const resolved = await resolveCwd(sessionFile);
          if (typeof resolved === "string" && resolved) cwd = resolved;
        } catch (e) {
          log(`cwd resolve failed ${path.basename(sessionFile)}: ${e.message}`);
        }
      }
    }
    if (!project) {
      if (cwd) project = path.basename(cwd);
      else if (kind === "pi") project = path.basename(path.dirname(sourceFile));
      else project = "unknown";
    }
    let data;
    try {
      data = JSON.parse(await fs.promises.readFile(sourceFile, "utf8"));
    } catch (e) {
      return { ok: false, parsed: false, total: 0, inserted: 0, mtimeMs, size, error: `parse: ${e.message}` };
    }
    const blocks = kind === "pi" ? normalizePiBlocks(data) : normalizeOpencodeBlocks(data);
    if (blocks === null) {
      return {
        ok: false,
        parsed: false,
        total: 0,
        inserted: 0,
        mtimeMs,
        size,
        error: "unrecognized source format"
      };
    }
    if (this.closed) {
      return { ok: false, parsed: true, total: 0, inserted: 0, mtimeMs, size, error: "store closed" };
    }
    const now = Date.now();
    let inserted = 0;
    let refreshed = 0;
    let redactedHits = 0;
    this.db.exec("BEGIN");
    try {
      this.db.prepare(
        `INSERT INTO sources(source_file, kind, project, cwd, last_mtime_ms, last_size, first_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_file) DO UPDATE SET
             kind = excluded.kind,
             project = excluded.project,
             cwd = excluded.cwd,
             last_mtime_ms = excluded.last_mtime_ms,
             last_size = excluded.last_size,
             updated_at = excluded.updated_at`
      ).run(sourceFile, kind, project, cwd, mtimeMs, size, now, now);
      this.db.prepare(
        `INSERT INTO source_watermarks(source_file, last_mtime_ms, last_size, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(source_file) DO UPDATE SET
             last_mtime_ms = excluded.last_mtime_ms,
             last_size = excluded.last_size,
             updated_at = excluded.updated_at`
      ).run(sourceFile, mtimeMs, size, now);
      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO blocks
           (source_file, kind, block_id, run_id, tier, topic, summary, ref_start, ref_end, compressed_tokens, created_at, msg_ids)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM block_tombstones WHERE source_file = ? AND block_id = ?)`
      );
      const updMsgIds = this.db.prepare(
        `UPDATE blocks SET msg_ids = ?
          WHERE source_file = ? AND block_id = ? AND (msg_ids IS NOT ?)`
      );
      for (const b of blocks) {
        if (!b || typeof b.summary !== "string") continue;
        const redactedSummary = redactSecrets(b.summary);
        const redactedTopic = typeof b.topic === "string" && b.topic ? redactSecrets(b.topic) : { text: null, hits: 0 };
        redactedHits += redactedSummary.hits + redactedTopic.hits;
        const summary = redactedSummary.text.length > cfg.maxSummaryChars ? redactedSummary.text.slice(0, cfg.maxSummaryChars) : redactedSummary.text;
        if (!summary.trim()) continue;
        const msgIdsJson = Array.isArray(b.msgIds) && b.msgIds.length ? JSON.stringify(b.msgIds) : null;
        const r = ins.run(
          sourceFile,
          kind,
          b.blockId,
          b.runId,
          b.tier,
          redactedTopic.text,
          summary,
          b.refStart,
          b.refEnd,
          b.compressedTokens,
          b.createdAt,
          msgIdsJson,
          sourceFile,
          b.blockId
        );
        if (r.changes > 0) inserted++;
        else if (updMsgIds.run(msgIdsJson, sourceFile, b.blockId, msgIdsJson).changes > 0) refreshed++;
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
      }
      return { ok: false, parsed: true, total: blocks.length, inserted: 0, mtimeMs, size, error: e.message };
    }
    if (redactedHits > 0) {
      logLine(`redacted ${redactedHits} potential secret(s) before storing ${path.basename(sourceFile)}`);
    }
    log(`ingest ${path.basename(sourceFile)} kind=${kind} project=${project} blocks=${blocks.length} new=${inserted}`);
    return { ok: true, parsed: true, total: blocks.length, inserted, refreshed, redacted: redactedHits, mtimeMs, size };
  }
  /**
   * Look up stored blocks for `memory_expand`.
   * @param {string} blockId block id as shown by memory_search (e.g. "b1")
   * @param {string|null} source optional substring match on the source file name or project
   * @param {number} limit max candidate rows returned for disambiguation
   * @returns {Array<object>} camelCase rows, newest first
   */
  findBlocks(blockId, source = null, limit = 10) {
    this.open();
    const { where, params } = blockFilter(blockId, source);
    params.push(Math.max(1, Math.min(50, limit)));
    return this.db.prepare(
      `SELECT b.id, b.source_file AS sourceFile, b.kind AS kind,
                b.block_id AS blockId, b.tier, b.topic, b.summary,
                b.ref_start AS refStart, b.ref_end AS refEnd,
                b.compressed_tokens AS tokens, b.created_at AS createdAt,
                b.msg_ids AS msgIds, s.project, s.cwd
           FROM blocks b LEFT JOIN sources s ON s.source_file = b.source_file
          WHERE ${where}
          ORDER BY b.created_at DESC, b.id DESC
          LIMIT ?`
    ).all(...params);
  }
  /**
   * Count stored rows for a block id with the same filter as {@link findBlocks} (ignoring `limit`),
   * so a caller can report the real number of duplicates instead of the page size.
   * @param {string} blockId block id as shown by memory_search (e.g. "b1")
   * @param {string|null} source optional substring match on the source file name or project
   * @returns {number} number of matching rows
   */
  countBlocks(blockId, source = null) {
    this.open();
    const { where, params } = blockFilter(blockId, source);
    return this.db.prepare(
      `SELECT count(*) AS c
           FROM blocks b LEFT JOIN sources s ON s.source_file = b.source_file
          WHERE ${where}`
    ).get(...params).c;
  }
  /**
   * Build the search SQL shared by search()/explainSearch().
   * - all tokens >= 3 chars: FTS5 trigram (bm25 ordering);
   * - mixed: FTS for long tokens + AND-ed LIKE for short tokens;
   * - all short: LIKE on summary OR topic, deliberately without the blocks_fts join so SQLite
   *   can use idx_blocks_created (no FTS scan + temp B-tree sort).
   * @returns {{mode:string, sql:string|null, params:Array<any>, limit:number}}
   */
  _buildSearch(query, opts = {}) {
    const limit = Math.max(
      1,
      Math.min(MAX_RESULT_LIMIT, Number.isInteger(opts.limit) ? opts.limit : DEFAULT_RESULT_LIMIT)
    );
    const project = opts.project || null;
    const tokens = String(query || "").trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return { mode: "empty", sql: null, params: [], limit };
    const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => "\\" + m);
    const ftsTokens = tokens.filter((t) => t.length >= TRIGRAM_MIN_LEN);
    const likeTokens = tokens.filter((t) => t.length < TRIGRAM_MIN_LEN);
    const useFts = ftsTokens.length > 0;
    const params = [];
    const clauses = [];
    if (useFts) {
      clauses.push("blocks_fts MATCH ?");
      params.push(ftsTokens.map((t) => '"' + t.replace(/"/g, '""') + '"').join(" "));
    }
    for (const t of likeTokens) {
      clauses.push("(b.summary LIKE ? ESCAPE '\\' OR b.topic LIKE ? ESCAPE '\\')");
      const like = "%" + escapeLike(t) + "%";
      params.push(like, like);
    }
    let where = clauses.length ? clauses.join(" AND ") : "1=1";
    if (project) {
      where += " AND s.project = ?";
      params.push(project);
    }
    params.push(limit);
    const mode = useFts ? likeTokens.length ? "mixed" : "fts" : "like";
    const from = useFts ? "FROM blocks_fts JOIN blocks b ON b.id = blocks_fts.rowid JOIN sources s ON s.source_file = b.source_file" : "FROM blocks b JOIN sources s ON s.source_file = b.source_file";
    const rank = useFts ? "bm25(blocks_fts)" : "NULL";
    const order = useFts ? "ORDER BY bm25(blocks_fts), b.created_at DESC, b.id DESC" : "ORDER BY b.created_at DESC";
    const sql = `
      SELECT b.id, b.source_file AS sourceFile, b.kind AS kind,
             b.block_id AS blockId, b.tier, b.topic,
             b.ref_start AS refStart, b.ref_end AS refEnd,
             b.compressed_tokens AS tokens, b.created_at AS createdAt,
             b.summary, s.project, s.cwd,
             ${rank} AS rank
      ${from}
      WHERE ${where}
      ${order}
      LIMIT ?
    `;
    return { mode, sql, params, limit };
  }
  /**
   * @param {string} query
   * @param {{project?:string|null, limit?:number}} opts
   * @returns {{mode:string, rows:Array<object>}}
   */
  search(query, opts = {}) {
    this.open();
    const built = this._buildSearch(query, opts);
    if (built.mode === "empty") return { mode: "empty", rows: [] };
    let rows = [];
    try {
      rows = this.db.prepare(built.sql).all(...built.params);
    } catch (e) {
      logLine(`search error: ${withoutPaths(e.message)} | sql=${built.sql}`);
      rows = [];
    }
    return { mode: built.mode, rows };
  }
  /** EXPLAIN QUERY PLAN for the same SQL as search(); used by tests to lock the LIKE plan. */
  explainSearch(query, opts = {}) {
    this.open();
    const built = this._buildSearch(query, opts);
    if (built.mode === "empty") return [];
    return this.db.prepare(`EXPLAIN QUERY PLAN ${built.sql}`).all(...built.params);
  }
  stats() {
    this.open();
    const s = this.db.prepare(
      `SELECT (SELECT count(*) FROM sources) AS sources,
                (SELECT count(*) FROM blocks) AS blocks,
                (SELECT count(DISTINCT source_file) FROM blocks) AS sources_with_blocks,
                (SELECT coalesce(sum(compressed_tokens),0) FROM blocks) AS tokens,
                (SELECT count(*) FROM block_tombstones) AS tombstones`
    ).get();
    return {
      sources: s.sources,
      // Compatibility aliases kept for older status consumers.
      sessions: s.sources,
      sources_with_blocks: s.sources_with_blocks,
      sessions_with_blocks: s.sources_with_blocks,
      blocks: s.blocks,
      tokens: s.tokens,
      tombstones: s.tombstones,
      dbPath: this.dbPath
    };
  }
  /**
   * Scale governance: delete blocks whose created_at is older than keepDays days (fts rows go
   * through the delete trigger), drop source rows left without blocks, then VACUUM.
   * Blocks without created_at (legacy data) are kept. Low-frequency manual op (/memory prune <days>),
   * the caller confirms.
   * @param {number} keepDays retention in days; 0 = delete every timestamped block
   * @returns {{removedBlocks:number, removedSources:number, removedSessions:number, remainingBlocks:number}}
   */
  prune(keepDays) {
    this.open();
    const cutoff = Date.now() - keepDays * 864e5;
    const now = Date.now();
    const before = this.db.prepare("SELECT count(*) AS c FROM blocks").get().c;
    this.db.exec("BEGIN IMMEDIATE");
    let removedSources = 0;
    try {
      this.db.prepare(
        `INSERT OR IGNORE INTO block_tombstones(source_file, block_id, pruned_at)
           SELECT source_file, block_id, ? FROM blocks
           WHERE created_at IS NOT NULL AND created_at < ?`
      ).run(now, cutoff);
      this.db.prepare("DELETE FROM blocks WHERE created_at IS NOT NULL AND created_at < ?").run(cutoff);
      const rs = this.db.prepare(
        "DELETE FROM sources WHERE NOT EXISTS (SELECT 1 FROM blocks b WHERE b.source_file = sources.source_file)"
      ).run();
      removedSources = rs.changes;
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
      }
      throw e;
    }
    try {
      this.db.exec("VACUUM");
    } catch (e) {
      logLine(`prune: VACUUM skipped (${withoutPaths(e.message)}); rows pruned, file size unchanged`);
    }
    const remain = this.db.prepare("SELECT count(*) AS c FROM blocks").get().c;
    return {
      removedBlocks: before - remain,
      removedSources,
      removedSessions: removedSources,
      remainingBlocks: remain
    };
  }
};
var db = null;
var sessionGeneration = 0;
var dbClosed = false;
var backgroundScan = null;
var piMapCache = null;
var piMapInFlight = null;
function getDb() {
  if (!db) db = new MemoryDb(cfg.dbPath);
  if (dbClosed) throw new Error("memory store is closed for this session");
  db.open();
  return db;
}
async function piSessionCwdMap() {
  const map = /* @__PURE__ */ new Map();
  try {
    const mod = await import('@earendil-works/pi-coding-agent');
    const infos = await mod.SessionManager.listAll();
    for (const i of infos) {
      const file = i.path;
      if (typeof file === "string" && file.endsWith(".jsonl") && !file.endsWith(".acp.json")) {
        map.set(file, typeof i.cwd === "string" ? i.cwd : null);
      }
    }
  } catch {
  }
  return map;
}
async function piSessionHeaderCwd(sessionFile) {
  let fh = null;
  try {
    fh = await fs.promises.open(sessionFile, "r");
    const chunks = [];
    let total = 0;
    while (total < SESSION_HEADER_MAX_BYTES) {
      const want = Math.min(64 * 1024, SESSION_HEADER_MAX_BYTES - total);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, total);
      if (!bytesRead) break;
      const nl = buf.subarray(0, bytesRead).indexOf(10);
      if (nl >= 0) {
        chunks.push(buf.subarray(0, nl));
        break;
      }
      chunks.push(buf.subarray(0, bytesRead));
      total += bytesRead;
    }
    const line = Buffer.concat(chunks).toString("utf8").trim();
    if (!line) return null;
    const parsed = JSON.parse(line);
    return parsed && typeof parsed.cwd === "string" && parsed.cwd ? parsed.cwd : null;
  } catch {
    return null;
  } finally {
    if (fh) {
      try {
        await fh.close();
      } catch {
      }
    }
  }
}
async function getPiSessionCwdMap(force = false) {
  const now = Date.now();
  if (!force && piMapCache && now - piMapCache.at < PI_MAP_TTL_MS) return piMapCache.map;
  if (piMapInFlight) return piMapInFlight;
  piMapInFlight = piSessionCwdMap().then((map) => {
    piMapCache = { at: Date.now(), map };
    return map;
  }).finally(() => {
    piMapInFlight = null;
  });
  return piMapInFlight;
}
async function loadOpencodeSessionMap(source, files) {
  const map = /* @__PURE__ */ new Map();
  const dbPath = source.opencodeDb;
  if (!dbPath || !files.length) return map;
  try {
    await fs.promises.access(dbPath);
  } catch {
    return map;
  }
  let odb = null;
  try {
    await loadSqlite();
    if (!DatabaseSyncCtor) return map;
    try {
      odb = new DatabaseSyncCtor(dbPath, { readOnly: true });
    } catch (readErr) {
      logLine(`read-only open failed (${readErr.message}); retry with query_only`);
      odb = new DatabaseSyncCtor(dbPath);
      odb.exec("PRAGMA query_only=ON;");
    }
    try {
      odb.exec("PRAGMA busy_timeout=5000;");
    } catch {
    }
    const stmt = odb.prepare("SELECT id, directory, path, project_id FROM session WHERE id = ?");
    for (const file of files) {
      const base = path.basename(file);
      if (!base.startsWith("ses_") || !base.endsWith(".json")) continue;
      const sessionId = base.slice(0, -5);
      const row = stmt.get(sessionId);
      if (!row) continue;
      const cwd = row.directory || row.path || null;
      const project = row.directory ? path.basename(row.directory) : row.path ? path.basename(row.path) : typeof row.project_id === "string" ? row.project_id : null;
      if (cwd || project) map.set(file, { cwd: cwd || null, project: project || null });
    }
  } catch (e) {
    logLine(`opencode session map failed: ${withoutPaths(e.message)}`);
  } finally {
    if (odb) {
      try {
        odb.close();
      } catch {
      }
    }
  }
  return map;
}
async function scanSources(force = false) {
  const generation = sessionGeneration;
  await loadSqlite();
  const d = getDb();
  const sources = await loadSources();
  const needPiCwd = sources.some((s) => s.enabled && s.adapter === "pi-sidecar");
  const resolvePiCwd = needPiCwd ? async (sessionFile) => {
    const headerCwd = await piSessionHeaderCwd(sessionFile);
    if (headerCwd) return headerCwd;
    const map = await getPiSessionCwdMap(force);
    return map.get(sessionFile) ?? null;
  } : null;
  let scanned = 0;
  let inserted = 0;
  let redacted = 0;
  let total = 0;
  let failed = 0;
  let fileCount = 0;
  let enabledSources = 0;
  for (const source of sources) {
    if (!source.enabled) continue;
    if (generation !== sessionGeneration) {
      logLine("scan: stopped early, the session was closed while scanning");
      break;
    }
    enabledSources++;
    const tally = { files: 0, scanned: 0, inserted: 0, redacted: 0, total: 0, failed: 0 };
    try {
      await scanOneSource(source, d, force, resolvePiCwd, generation, tally);
    } catch (e) {
      tally.failed++;
      logLine(`source '${source.id}' (${source.adapter}) failed: ${withoutPaths(e.stack || e.message)}`);
    }
    fileCount += tally.files;
    scanned += tally.scanned;
    inserted += tally.inserted;
    redacted += tally.redacted;
    total += tally.total;
    failed += tally.failed;
  }
  return { scanned, inserted, redacted, total, failed, files: fileCount, sources: enabledSources };
}
async function scanOneSource(source, d, force, resolvePiCwd, generation, tally) {
  const listing = await listSourceFiles(source);
  let files = listing.files;
  if (listing.errors.length) {
    tally.failed += listing.errors.length;
    const first = listing.errors[0];
    logLine(
      `scan: source '${source.id}' could not read ${listing.errors.length} director${listing.errors.length === 1 ? "y" : "ies"}: ${withoutPaths(first?.message || String(first))}`
    );
  }
  if (source.adapter === "pi-sidecar" && cfg.excludeDirs.length) {
    files = files.filter((f) => {
      const rel = path.relative(source.root, f);
      return !rel.split(path.sep).some((seg) => cfg.excludeDirs.includes(seg));
    });
  }
  tally.files += files.length;
  let opencodeMap = null;
  if (source.adapter === "opencode-acp" && files.length) {
    opencodeMap = await loadOpencodeSessionMap(source, files);
  }
  for (const file of files) {
    if (generation !== sessionGeneration) return;
    let meta;
    if (source.adapter === "pi-sidecar") {
      meta = { kind: "pi", cwd: null, project: null };
    } else if (source.adapter === "opencode-acp") {
      const info = opencodeMap?.get(file);
      meta = { kind: "opencode", cwd: info?.cwd ?? null, project: info?.project ?? null };
    } else {
      logLine(`unknown source adapter '${source.adapter}' for ${source.id}; skipped`);
      tally.failed++;
      continue;
    }
    const r = await d.ingestSourceFile(file, meta, force, source.adapter === "pi-sidecar" ? resolvePiCwd : null);
    if (r.parsed) tally.scanned++;
    if (!r.ok && r.error && r.error !== "no source file") {
      tally.failed++;
      if (cfg.debug) log(`scan failed ${file}: ${r.error}`);
    }
    tally.inserted += r.inserted;
    tally.redacted += r.redacted || 0;
    tally.total += r.total;
  }
}
async function scanCurrentSession(sessionFile, force = false, cwd = null) {
  if (!sessionFile) return null;
  const d = getDb();
  return d.ingestSidecarFile(sessionFile, cwd || null, force);
}
function fmtTs(ms) {
  if (!Number.isInteger(ms)) return "";
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
  } catch {
    return "";
  }
}
function fmtTokens(n) {
  if (!Number.isInteger(n)) return "";
  return n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}
function sourceLabel(row) {
  const kind = row.kind === "opencode" ? "opencode" : "pi";
  let base = path.basename(row.sourceFile || "");
  if (kind === "pi" && base.endsWith(".acp.json")) base = base.slice(0, -".acp.json".length);
  return `[${kind}] ${base}`;
}
function formatResults(res) {
  const rows = res.rows;
  if (rows.length === 0) {
    return "No memory matches. Try: 1) shorter / more common keywords; 2) drop the project filter; 3) if a compression happened moments ago, retry later (ingestion follows scan timing). The store only contains ACP block summaries from allow-listed sources (pi billion-context-pi sidecars and opencode-acp state files).";
  }
  const modeLabel = res.mode === "like" ? " (short-query LIKE mode)" : res.mode === "mixed" ? " (mixed trigram + LIKE mode)" : " (trigram relevance sort)";
  const head = `Memory hits: ${rows.length}${modeLabel}:
`;
  const parts = rows.map((r, i) => {
    const project = r.project || "?";
    const tm = fmtTs(r.createdAt);
    const refs = r.refStart ? ` [${r.refStart}${r.refEnd && r.refEnd !== r.refStart ? "\u2013" + r.refEnd : ""}]` : "";
    const topic = r.topic ? `Topic: ${r.topic}
` : "";
    let summary = r.summary || "";
    if (summary.length > PREVIEW_CHARS) summary = summary.slice(0, PREVIEW_CHARS) + "\u2026";
    summary = summary.replace(/\n{3,}/g, "\n\n").trim();
    return `[${i + 1}] project ${project} \xB7 ${tm || "time unknown"} \xB7 ${r.blockId || ""} \xB7 tier${r.tier ?? "?"} \xB7 ${fmtTokens(r.tokens) || "?"} tokens compressed${refs}
Source: ${sourceLabel(r)}
${topic}${summary}`;
  });
  return head + parts.join("\n\n---\n\n");
}
function formatExpansion(row, sessionFile, res, mode) {
  const lines = [
    `Block ${row.blockId}${row.tier != null ? ` (tier ${row.tier})` : ""} \xB7 project ${row.project || "unknown"}${row.createdAt ? ` \xB7 ${fmtTs(row.createdAt)}` : ""} \xB7 ${res.entries.length} message ref(s) \xB7 ${fmtTokens(row.tokens) || "?"} tok compressed`,
    `Source: ${sourceLabel(row)}`,
    // Basename only: the absolute path carries the OS user name and the encoded project directory,
    // and expansion never needs it (the `source` filter takes the session file name or project).
    `Session: ${path.basename(sessionFile)}`
  ];
  const kb = (n) => `${Math.round(n / 1024)} KB`;
  lines.push(
    res.sessionMissing ? "Read: session file is gone (deleted, rotated, or renamed since ingestion)" : res.readTruncated ? `Read: ${kb(res.bytesRead)} of ${kb(res.totalBytes)} (read cap hit; later messages may be missing)` : `Read: ${kb(res.totalBytes)} (complete)`
  );
  const synthetic = res.entries.filter((e) => !e.found && isSyntheticRef(e.messageId)).length;
  const missing = res.entries.filter((e) => !e.found).length - synthetic;
  if (missing > 0) lines.push(`Missing: ${missing} referenced message(s) not present in the session file`);
  if (synthetic > 0) {
    lines.push(`Synthetic: ${synthetic} reference(s) point at generated ids the session file never holds`);
  }
  lines.push("");
  if (mode === "list") {
    const shown = res.entries.slice(0, EXPAND_MANIFEST_MAX);
    for (const e of shown) {
      const role = (e.found ? e.role || "?" : isSyntheticRef(e.messageId) ? "synthetic" : "missing").padEnd(11);
      const size = e.found ? `${String(e.chars).padStart(6)} chars` : "          ";
      lines.push(`${String(e.index).padStart(4)}  ${role} ${size}  ${e.ref}`);
    }
    if (res.entries.length > shown.length) lines.push(`       ... and ${res.entries.length - shown.length} more`);
    lines.push("");
    lines.push(
      `Text: ${res.availableChars} chars available. Read a selection with memory_expand({ block: "${row.blockId}", mode: "full", select: [1, 2, 3] }).`
    );
  } else {
    lines.push(res.text || "(no text selected)");
    if (res.truncated) {
      lines.push("");
      lines.push(
        `[truncated: ${res.returnedChars} of ${res.availableChars} chars returned; ${res.skippedMessages} message(s) skipped \u2014 narrow 'select' or raise expandMaxChars]`
      );
    }
  }
  return lines.join("\n");
}
var MEMORY_SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search keywords / phrase, Chinese or English; space-separated words are AND-matched, e.g. 'sqlite fts5'"
    },
    project: {
      type: "string",
      description: "Restrict to one project: folder name of the working directory (e.g. my-project); omit to search all projects"
    },
    limit: {
      type: "number",
      description: "Max number of results, default 6, max 20"
    }
  },
  required: ["query"]
};
var MEMORY_EXPAND_PARAMETERS = {
  type: "object",
  properties: {
    block: {
      type: "string",
      description: "Block id taken from a memory_search result, e.g. 'b1'"
    },
    source: {
      type: "string",
      description: "Optional disambiguator when the same block id exists in several sessions: a substring of the memory_search 'Source:' label (session file name or project)"
    },
    mode: {
      type: "string",
      enum: ["list", "full"],
      description: "'list' (default) returns a manifest of the absorbed messages with no conversation text; 'full' renders exactly the indices given in 'select'"
    },
    select: {
      type: "array",
      items: { type: "number" },
      description: "1-based message indices taken from a 'list' result; required (and non-empty) for mode 'full', which never renders a whole block at once"
    },
    limit: { type: "number", description: "Max messages to render, default from expandMaxMessages" },
    chars: { type: "number", description: "Max characters to return, default from expandMaxChars" }
  },
  required: ["block"]
};
function readMemoryExpandParams(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const block = typeof value.block === "string" ? value.block.trim() : "";
  const source = typeof value.source === "string" && value.source.trim() ? value.source.trim() : null;
  const mode = value.mode === "full" ? "full" : "list";
  const select = Array.isArray(value.select) ? value.select.filter((n) => typeof n === "number" && Number.isInteger(n) && n > 0) : null;
  const limit = typeof value.limit === "number" && Number.isInteger(value.limit) && value.limit > 0 ? value.limit : null;
  const chars = typeof value.chars === "number" && Number.isInteger(value.chars) && value.chars > 0 ? value.chars : null;
  return { block, source, mode, select, limit, chars };
}
function readMemorySearchParams(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const query = typeof value.query === "string" ? value.query : "";
  const project = typeof value.project === "string" && value.project.trim().length > 0 ? value.project.trim() : null;
  const limit = typeof value.limit === "number" && Number.isInteger(value.limit) ? value.limit : DEFAULT_RESULT_LIMIT;
  return { query, project, limit };
}
async function factory(pi) {
  await loadSqlite();
  const paramsSchema = MEMORY_SEARCH_PARAMETERS;
  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? null;
    dbClosed = false;
    const generation = ++sessionGeneration;
    logLine(
      cfg.debug ? `session_start file=${sessionFile || "(ephemeral)"} cwd=${ctx.cwd ?? ""}` : (
        // Logs are what users paste into issues: without debug, keep names, not full paths.
        `session_start file=${sessionFile ? path.basename(sessionFile) : "(ephemeral)"} cwd=${ctx.cwd ? path.basename(ctx.cwd) : ""}`
      )
    );
    if (!cfg.scanOnStartup) {
      scanCurrentSession(sessionFile, true, ctx.cwd).catch(
        (e) => logLine(`session_start scan error: ${withoutPaths(e.message)}`)
      );
      return;
    }
    const run = scanSources().then(async (r) => {
      if (generation !== sessionGeneration) return;
      logLine(
        `initial scan: sources=${r.sources} files=${r.files} sidecarScanned=${r.scanned} newBlocks=${r.inserted} redacted=${r.redacted} totalBlocks=${r.total} failed=${r.failed}`
      );
      await scanCurrentSession(sessionFile, true, ctx.cwd);
      if (generation !== sessionGeneration) return;
      const st = getDb().stats();
      logLine(`db ready: ${path.basename(st.dbPath)} sources=${st.sources} blocks=${st.blocks}`);
    }).catch((e) => logLine(`session_start scan error: ${withoutPaths(e.stack || e.message)}`));
    backgroundScan = run;
    void run.finally(() => {
      if (backgroundScan === run) backgroundScan = null;
    });
  });
  pi.on("agent_settled", async (_event, ctx) => {
    try {
      const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? null;
      await scanCurrentSession(sessionFile, false, ctx.cwd);
    } catch (e) {
      log(`agent_settled: ${e.message}`);
    }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const shutdownGeneration = ++sessionGeneration;
    const inflight = backgroundScan;
    if (inflight) {
      let timer = null;
      await Promise.race([
        inflight.catch(() => void 0),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 2e3);
        })
      ]);
      if (timer) clearTimeout(timer);
    }
    try {
      const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? null;
      await scanCurrentSession(sessionFile, false, ctx.cwd);
    } catch (e) {
      log(`session_shutdown: ${e.message}`);
    }
    if (shutdownGeneration !== sessionGeneration) {
      log(`session_shutdown: superseded by a new session; store left open`);
      return;
    }
    dbClosed = true;
    if (db) {
      db.close();
      db = null;
    }
  });
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search pi's long-term memory store: block summaries produced by ACP compression from allow-listed sources (pi billion-context-pi sidecars and opencode-acp state files) across all allowed projects. Use when the user asks about past work, conclusions, decisions, technical pitfalls, code locations, project context, or content compressed earlier in this session. Query with Chinese or English keywords / phrases; results are relevance-ranked and annotated with source kind, project, file, block and time.",
    promptSnippet: "Search pi's accumulated memory of past sessions (ACP compression summaries across allowed sources)",
    promptGuidelines: [
      "Use memory_search when the user asks about past work, conclusions, decisions, or context from earlier sessions or from earlier in this session after compression.",
      "For Chinese queries shorter than 3 characters, memory_search falls back to substring matching automatically \u2014 still pass the query as-is."
    ],
    parameters: paramsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        await scanSources();
        const { query, project, limit } = readMemorySearchParams(params);
        const res = getDb().search(query, { project, limit });
        const text = formatResults(res);
        return {
          content: [{ type: "text", text }],
          details: { mode: res.mode, hits: res.rows.length, dbPath: path.basename(cfg.dbPath) }
        };
      } catch (e) {
        logLine(`memory_search error: ${withoutPaths(e.stack || e.message)}`);
        return {
          content: [
            {
              type: "text",
              text: `memory_search failed: ${withoutPaths(e.message) || "unknown error"} (the extension log has the full trace)`
            }
          ],
          details: { mode: "error", hits: 0, dbPath: path.basename(cfg.dbPath) }
        };
      }
    }
  });
  if (cfg.expandEnabled) {
    pi.registerTool({
      name: "memory_expand",
      label: "Memory Expand",
      description: "Recover the original session messages absorbed by one stored compression block \u2014 the inverse of memory_search. Only registered when expandEnabled is true in ~/.pi/pi-billion-memory.json. Default mode 'list' returns just a manifest (ref, role, size); call again with mode 'full' and an explicit 'select' to read text. Expansion is deliberately two-step and bounded, because it spends the context that compression saved. Returned text passes through the same secret redaction as ingestion, and nothing is written to the store.",
      promptSnippet: "Expand one memory block back to its original messages (opt-in; list before full)",
      promptGuidelines: [
        "Use mode 'list' first: it is cheap and shows which messages a block absorbed, with role and size.",
        "Request mode 'full' with a narrow 'select' only when the exact original wording matters.",
        "memory_expand reads raw conversation lines from the session file; it only resolves references already recorded in a stored block."
      ],
      parameters: MEMORY_EXPAND_PARAMETERS,
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        try {
          const p = readMemoryExpandParams(params);
          if (!p.block) {
            return {
              content: [{ type: "text", text: `memory_expand: 'block' is required (e.g. block: "b1").` }],
              details: { mode: "error", hits: 0 }
            };
          }
          const db2 = getDb();
          const rows = db2.findBlocks(p.block, p.source);
          const total = rows.length ? db2.countBlocks(p.block, p.source) : 0;
          if (rows.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `memory_expand: no stored block '${p.block}'${p.source ? ` matching source '${p.source}'` : ""}. Run memory_search first and pass the block id from a result.`
                }
              ],
              details: { mode: "missing", hits: 0 }
            };
          }
          if (rows.length > 1) {
            const list = rows.map(
              (r) => `- ${r.blockId} \xB7 project ${r.project || "?"} \xB7 ${fmtTs(r.createdAt) || "time unknown"} \xB7 ${path.basename(r.sourceFile)}`
            ).join("\n");
            return {
              content: [
                {
                  type: "text",
                  text: `memory_expand: ${total} block(s) share the id '${p.block}' (showing the newest ${rows.length}). Add 'source' to pick one:
${list}`
                }
              ],
              details: { mode: "ambiguous", hits: total }
            };
          }
          const row = rows[0];
          if (!String(row.sourceFile).endsWith(".acp.json")) {
            return {
              content: [
                {
                  type: "text",
                  text: `memory_expand: block ${row.blockId} comes from ${sourceLabel(row)}, not a pi ACP sidecar. Expansion is currently supported only for pi sidecars.`
                }
              ],
              details: { mode: "unsupported", hits: 1 }
            };
          }
          const msgIds = parseMsgIds(row.msgIds);
          if (msgIds.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `memory_expand: block ${row.blockId} has no recorded message references, so it cannot be expanded. This happens for rows ingested before 0.5.0. Run /memory rescan to backfill the pointers from the sidecar.`
                }
              ],
              details: { mode: "no-refs", hits: 1 }
            };
          }
          const sessionFile = row.sourceFile.slice(0, -".acp.json".length);
          const res = await expandBlock({
            sessionFile,
            msgIds,
            mode: p.mode,
            select: p.select,
            maxChars: Math.min(cfg.expandMaxChars, p.chars ?? cfg.expandMaxChars),
            maxMessages: Math.min(cfg.expandMaxMessages, p.limit ?? cfg.expandMaxMessages),
            maxReadBytes: cfg.expandMaxReadBytes,
            redact: redactSecrets
          });
          log(
            `expand ${row.blockId} mode=${p.mode} refs=${msgIds.length} found=${res.entries.filter((e) => e.found).length} returned=${res.returnedChars}`
          );
          return {
            content: [{ type: "text", text: formatExpansion(row, sessionFile, res, p.mode) }],
            details: {
              mode: p.mode,
              block: row.blockId,
              refs: msgIds.length,
              found: res.entries.filter((e) => e.found).length,
              chars: res.returnedChars,
              truncated: res.truncated
            }
          };
        } catch (e) {
          logLine(`memory_expand error: ${withoutPaths(e.stack || e.message)}`);
          return {
            content: [
              {
                type: "text",
                text: `memory_expand failed: ${withoutPaths(e.message) || "unknown error"} (the extension log has the full trace)`
              }
            ],
            details: { mode: "error", hits: 0 }
          };
        }
      }
    });
  }
  pi.registerCommand("memory", {
    description: "pi-billion-memory: /memory (status), rescan (force rescan), sources (show allow-list), prune <days> (delete blocks older than N days)",
    handler: async (args, ctx) => {
      try {
        const want = String(args || "").trim();
        if (want === "rescan") {
          const r = await scanSources(true);
          const msg2 = `Force rescan done: sources=${r.sources} files=${r.files} parsed=${r.scanned} newBlocks=${r.inserted} redacted=${r.redacted} failed=${r.failed}`;
          ctx.ui?.notify?.(msg2, "info");
          return;
        }
        if (want === "sources") {
          const sources = await loadSources();
          const lines = sources.filter((s) => s.enabled).map((s) => `- [${s.id}] adapter=${s.adapter} root=${s.root} pattern=${s.pattern}`);
          const msg2 = lines.length ? `Allow-listed sources (${lines.length}):
${lines.join("\n")}

Edit ${cfg.sourcesPath || DEFAULT_CFG.sourcesPath} and run /memory rescan.` : `No allow-listed sources enabled. Edit ${cfg.sourcesPath || DEFAULT_CFG.sourcesPath} and run /memory rescan.`;
          ctx.ui?.notify?.(msg2, "info");
          return;
        }
        const pm = /^prune\s+(\d+)$/.exec(want);
        if (pm) {
          const keepDays = Number(pm[1]);
          if (!Number.isInteger(keepDays) || keepDays < 0 || keepDays > 36500) {
            ctx.ui?.notify?.("Usage: /memory prune <days> (0-36500; 0 = delete all timestamped blocks)", "info");
            return;
          }
          const p = getDb().prune(keepDays);
          const msg2 = `Prune done: removed ${p.removedBlocks} block(s) / ${p.removedSources} empty source(s), ${p.remainingBlocks} remain (kept ${keepDays} day(s))`;
          ctx.ui?.notify?.(msg2, "info");
          return;
        }
        const st = getDb().stats();
        const msg = `Memory store: ${st.sources} sources / ${st.sources_with_blocks} with compressed blocks / ${st.blocks} blocks / ${fmtTokens(st.tokens)} tok compressed total
DB: ${st.dbPath}
Log: ${cfg.logPath || DEFAULT_CFG.logPath}`;
        ctx.ui?.notify?.(msg, "info");
      } catch (e) {
        logLine(`/memory error: ${withoutPaths(e.stack || e.message)}`);
      }
    }
  });
  return {};
}

export { factory as default };
