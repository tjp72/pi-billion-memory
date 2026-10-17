/**
 * pi-billion-memory — long-term memory extension for the pi coding agent
 *
 * Data flow: read allow-listed ACP compression files (+ the pi session header for cwd metadata
 * only) → SQLite shared store (FTS5 trigram) → memory_search tool
 *
 * Supported source kinds:
 *   - pi:      billion-context-pi sidecars  <session>.jsonl.acp.json
 *              under ~/.pi/agent/sessions/** (default source "pi")
 *   - opencode: opencode-acp state files    ses_*.json (filename = <session.id>.json)
 *              under <home>/.local/share/opencode/storage/plugin/acp (default source "opencode")
 *   - bili:     billion-context session files <host>_<hash>.json (envelope {version,payload} with
 *              blocks under payload.state.blocks; versions 1-3) or proxy session files
 *              (WorkBuddy/codebuddy) under <home>/.local/share/billion-context/sessions/** (no default)
 *
 * The allow-list lives in ~/.pi/pi-billion-memory.sources.jsonl (one JSON object per line).
 * Each line points at a root directory + file pattern and selects the adapter that knows how
 * to read that format. Scanning is always restricted to these allow-listed locations — there is
 * no global discovery across every session or message file. For a pi source the only raw-file
 * read is the session file's first line (header metadata: cwd/id/timestamp/version), used to
 * resolve the project name; message lines are never read.
 *
 * Chinese strategy: the FTS5 trigram tokenizer (indexes every run of 3 characters) matches Chinese
 * substrings, mixed Chinese/English text and code identifiers out of the box; tokens of <= 2
 * characters use AND-ed LIKE clauses against summary and topic, and a mixed query combines FTS for
 * long tokens with LIKE for short ones. No LLM translation or keyword generation is used (it would
 * not be offline-friendly and adds cost for little gain).
 *
 * Event strategy: never hooks context events (that is ACP's domain);
 * session_start → background allow-list scan (async fs I/O, does not block session start;
 *   disable via scanOnStartup);
 * agent_settled → incremental scan of the current pi session; session_shutdown → final scan and
 *   DB close; memory_search runs a light allow-list scan first so results always include the
 *   latest compressions. cwd resolution is lazy (header read only when a source is (re)parsed).
 *
 * Durability: ingestion watermarks live in source_watermarks (survives prune); prune() records a
 * block_tombstones row per deleted block so a later source-file change cannot resurrect it.
 * Secrets: every ingested block's topic/summary passes through redactSecrets() first; matched
 * credential values are replaced with [REDACTED] and URLs with [REDACTED_URL]; the hit count is
 * logged without the value.
 *
 * Install: `pi install git:https://github.com/tjp72/pi-billion-memory.git@<tag>`
 *   (git distribution only; there is no npm package).
 * Build: `npm run build` (tsup + tsc) emits `dist/index.js`.
 * Config: ~/.pi/pi-billion-memory.json (optional; see loadConfig defaults below).
 * Allow-list: ~/.pi/pi-billion-memory.sources.jsonl (optional; defaults to pi + opencode).
 * Log: ~/.pi/pi-billion-memory.log.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expandBlock, expandStoredBlock, isSyntheticRef, parseMsgIds } from "./expand.js";

// ---------------------------------------------------------------------------
// Constants / config / logging
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const PI_DIR = path.join(HOME, ".pi");
const CFG_PATH = path.join(PI_DIR, "pi-billion-memory.json");

const DEFAULT_CFG = {
  /** SQLite store location (default ~/.pi/pi-billion-memory.db) */
  dbPath: path.join(PI_DIR, "pi-billion-memory.db"),
  /** Max summary chars stored per block; longer ones are truncated to keep the store small */
  maxSummaryChars: 20000,
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
  expandMaxChars: 40000,
  /** Hard cap on messages rendered by one `memory_expand` call. */
  expandMaxMessages: 200,
  /** Hard cap on bytes read from a session file by one `memory_expand` call. */
  expandMaxReadBytes: 32 * 1024 * 1024,
};

const MAX_TOPIC_CHARS = 200;
const PREVIEW_CHARS = 600;
/** Max message references stored per block (guards against an unbounded sidecar array). */
const MAX_MSG_IDS = 4000;
/** Max lineage (direct block id) references stored per block. */
const MAX_DIRECT_BLOCKS = 1000;
/** Max manifest lines rendered by a `list` expansion. */
const EXPAND_MANIFEST_MAX = 300;
const DEFAULT_RESULT_LIMIT = 6;
const MAX_RESULT_LIMIT = 20;
/** Timeline result cap (higher than blocks mode because a timeline is read in order). */
const MAX_TIMELINE_LIMIT = 50;
/** Candidate rows fetched before ordering a timeline or scoring related blocks. */
const TIMELINE_CANDIDATE_LIMIT = 500;
const RELATED_CANDIDATE_LIMIT = 200;
/** A gap larger than this between consecutive timed entries is rendered as a gap marker. */
const TIMELINE_GAP_MS = 6 * 60 * 60 * 1000;
/** Shared column list for the timeline/related candidate queries (blocks search keeps its own). */
const BLOCK_ROW_COLUMNS =
  "b.id, b.source_file AS sourceFile, b.kind AS kind, b.block_id AS blockId, b.run_id AS runId, b.tier, b.topic, " +
  "b.ref_start AS refStart, b.ref_end AS refEnd, b.compressed_tokens AS tokens, b.created_at AS createdAt, " +
  "b.summary, b.active AS active, b.direct_block_ids AS directBlockIds, b.duration_ms AS durationMs, " +
  "b.generation AS generation, b.survived_count AS survivedCount, b.compress_call_id AS compressCallId, " +
  "s.project, s.cwd";
const LOG_MAX_BYTES = 1_000_000;
const TRIGRAM_MIN_LEN = 3;
/** TTL for the cached official SessionManager cwd map (fallback only; the header read is primary) */
const PI_MAP_TTL_MS = 10 * 60 * 1000;
/** Hard cap for the session header read; the first line is normally a few KB */
const SESSION_HEADER_MAX_BYTES = 1_000_000;
/**
 * billion-context-pi writes `schemaVersion` on every sidecar save; a missing value means the
 * pre-contract v1 (#368). An unknown NEWER version means block fields may have changed, so the
 * file is skipped (never rewritten, watermark not advanced) and reported once.
 */
const SUPPORTED_SIDECAR_SCHEMA_VERSION = 1;
/** billion-context session-envelope versions this extension understands. */
const SUPPORTED_BC_ENVELOPE_VERSIONS = new Set([1, 2, 3]);
/** Keys of unsupported-format notices already logged, so repeated scans stay quiet. */
const unsupportedFormatNotices = new Set<string>();

/** Log an unsupported-format notice once per key; the file itself is never rewritten. */
function noteUnsupportedFormat(key: string, message: string) {
  if (unsupportedFormatNotices.has(key)) return;
  unsupportedFormatNotices.add(key);
  logLine(message);
}

/**
 * Auxiliary files share the compression directories but hold no blocks: billion-context's
 * content-addressed original store (`<hash>.content-store.json`), the kernel store's fallback slot
 * (`*.fb.json`), and SQLite sidecars. They are skipped without reading so an allow-list glob that
 * matches every JSON file cannot turn them into repeating failed sources.
 */
function isAuxiliarySourceFile(file: string): boolean {
  const base = path.basename(String(file)).toLowerCase();
  return (
    base.endsWith(".content-store.json") ||
    base.endsWith(".fb.json") ||
    base.endsWith(".db") ||
    base.endsWith(".db-wal") ||
    base.endsWith(".db-shm")
  );
}

/** null when the pi sidecar uses a supported schema version, else the unsupported version. */
function unsupportedSidecarSchema(data: any) {
  if (!data || typeof data !== "object") return null;
  const raw = data.schemaVersion;
  if (raw === undefined || raw === null) return null; // pre-contract files are v1
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return raw;
  return raw > SUPPORTED_SIDECAR_SCHEMA_VERSION ? raw : null;
}

/** null when the billion-context envelope uses a supported version, else the unsupported version. */
function unsupportedBcEnvelope(data: any) {
  if (!data || typeof data !== "object") return null;
  const payload = data.payload;
  if (!payload || typeof payload !== "object") return null; // legacy flat shape, not this envelope
  const raw = data.version;
  if (raw === undefined || raw === null) return null; // pre-envelope record: read as v1
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return raw;
  return SUPPORTED_BC_ENVELOPE_VERSIONS.has(raw) ? null : raw;
}

/** @internal Test seam: the same sanitizer the config loader uses. */
export function sanitizeCfg(over) {
  const out: Record<string, any> = {};
  if (!over || typeof over !== "object") return out;
  // Config paths accept `~`/`~/`: a config copied from the README must never create a literal "~"
  // directory next to the working directory (expandHome is applied to source roots for the same
  // reason below).
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

let cfg = { ...DEFAULT_CFG };
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
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    const logPath = cfg.logPath || DEFAULT_CFG.logPath;
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > LOG_MAX_BYTES) {
      fs.truncateSync(logPath, 0); // 1 MB cap
    }
    fs.appendFileSync(logPath, line);
  } catch {
    /* logging must never break the extension */
  }
}

function log(msg) {
  if (cfg.debug) logLine(msg);
}

// ---------------------------------------------------------------------------
// Secret redaction (best-effort, runs before any block is stored)
// ---------------------------------------------------------------------------

/**
 * Credential-like key names. The list is deliberately conservative: it covers
 * common password/token/API-key/private-key assignments, including JSON/YAML
 * quoted keys and Chinese labels, without redacting unrelated numbers.
 */
const SECRET_KEY_NAMES = [
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
  "token",
].join("|");

const SECRET_KEY_PREFIX = `(?<![A-Za-z0-9])((?:${SECRET_KEY_NAMES}))(?![A-Za-z0-9_-])`;

/** key: "value" / "key": "value" — quoted values may contain spaces. */
const QUOTED_SECRET_RE = new RegExp(`${SECRET_KEY_PREFIX}(["']?)(\\s*[:=]\\s*)(["'])([^"']{4,})\\4`, "gi");
/** key: value / "key": value — unquoted values stop at whitespace or punctuation. */
const UNQUOTED_SECRET_RE = new RegExp(`${SECRET_KEY_PREFIX}(["']?)(\\s*[:=]\\s*)([^\\s"',;]{6,})`, "gi");
/** Chinese credential labels, e.g. 密码：... / 令牌是... */
const CHINESE_SECRET_RE =
  /((?:密码|口令|密钥|令牌|私钥|访问密钥|api密钥))\s*(?:是|为|[:=：])\s*["']?([^\s"'，；,;]{4,})/gi;
/** http(s)/ftp/file/ssh/git/ws(s)/db URLs and bare www.* hosts. */
const URL_RE =
  /\b(?:(?:https?|ftp|file|ssh|git|wss?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/|www\.)[^\s<>"'`]*[A-Za-z0-9/#=?_~%&+-]/gi;

/**
 * Ordered patterns. The first two cover key/value assignments, then URLs, well-known token
 * prefixes, JWTs, private keys, auth headers, cookies, and Chinese labels.
 */
const SECRET_PATTERNS: Array<{ re: RegExp; to: string }> = [
  { re: QUOTED_SECRET_RE, to: "$1$2$3$4[REDACTED]$4" },
  { re: UNQUOTED_SECRET_RE, to: "$1$2$3[REDACTED]" },
  { re: URL_RE, to: "[REDACTED_URL]" },
  {
    re: /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|ya29\.[0-9A-Za-z_-]{20,})\b/g,
    to: "[REDACTED]",
  },
  {
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    to: "[REDACTED_JWT]",
  },
  {
    re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY(?: BLOCK)?-----/g,
    to: "[REDACTED_PRIVATE_KEY]",
  },
  {
    re: /\b(Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    to: "$1: [REDACTED]",
  },
  {
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    to: "Bearer [REDACTED]",
  },
  {
    re: /\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,
    to: "Cookie: [REDACTED]",
  },
  { re: CHINESE_SECRET_RE, to: "$1: [REDACTED]" },
];

/**
 * Replace common credential values and URLs in `text` with a placeholder.
 * Best-effort only: it cannot catch every secret, and it may occasionally
 * redact benign text. A non-zero `hits` count is logged by the caller.
 * @internal
 * @param {unknown} text
 * @returns {{text:string,hits:number}}
 */
export function redactSecrets(text: unknown): { text: string; hits: number } {
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

// ---------------------------------------------------------------------------
// SQLite store (node:sqlite, synchronous API; node >= 22.19)
// ---------------------------------------------------------------------------

let DatabaseSyncCtor = null;
/** @internal */
export async function loadSqlite() {
  if (DatabaseSyncCtor) return DatabaseSyncCtor;
  try {
    // Assign to a variable so bundlers do not rewrite the specifier to "sqlite".
    const sqliteModule = "node:sqlite";
    const m = await import(sqliteModule);
    DatabaseSyncCtor = m.DatabaseSync;
  } catch (e) {
    logLine(`node:sqlite unavailable (need node>=22.19): ${withoutPaths(e.message)}`);
  }
  return DatabaseSyncCtor;
}

// ---------------------------------------------------------------------------
// Allow-list helpers
// ---------------------------------------------------------------------------

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
      enabled: true,
    },
    {
      id: "opencode",
      adapter: "opencode-acp",
      root: ocRoot,
      pattern: "ses_*.json",
      enabled: true,
      opencodeDb: ocDb,
    },
  ];
}

/**
 * Shared WHERE clause for block lookups: exact block id plus an optional substring match on the
 * source file name or the project. Returns the clause and its positional parameters so count and
 * page queries can never drift apart.
 */
function blockFilter(blockId, source) {
  const params: any[] = [String(blockId)];
  let where = "b.block_id = ?";
  if (source) {
    where += " AND (b.source_file LIKE ? ESCAPE '\\' OR s.project LIKE ? ESCAPE '\\')";
    const like = `%${String(source).replace(/[\\%_]/g, (m) => "\\" + m)}%`;
    params.push(like, like);
  }
  return { where, params };
}

/**
 * Strip local absolute paths from text that goes back to the model. A tool error must not hand over
 * the layout of the machine (log, database, and session paths). Full details stay in the log.
 */
export function withoutPaths(text: string): string {
  return (
    String(text)
      // Stack traces: `file:///home/...` would survive the POSIX lookbehind below.
      .replace(/file:\/\/\/[^\s'"]+/g, "file://<path>")
      // Drive or UNC roots, either separator. A space only continues the path when the next chunk
      // still contains a separator, so "C:\Program Files\app\a.log" is covered without letting a
      // message like "C:\x failed: ..." swallow the rest of the sentence.
      .replace(/(?<![\w:/\\])(?:[A-Za-z]:[\\/]|\\\\|\/\/)[^\s'"]+(?: [^\s'"]*[\\/][^\s'"]*)*/g, "<path>")
      // POSIX paths, same space rule ("/home/alice/My Docs/notes.txt").
      .replace(/(?<![\w.:/\\])~?\/(?:[^\s'":,)]*\/)*[^\s'":,)]+(?: [^\s'":,)]*\/[^\s'":,)]*)*/g, "<path>")
  );
}

/** Adapter ids the scanner understands; anything else is rejected where the allow-list is read. */
const SOURCE_ADAPTERS = new Set(["pi-sidecar", "opencode-acp", "bili-session"]);

/** @internal Test seam: the same validation the allow-list loader applies. */
export function sanitizeSource(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id : null;
  const adapter = typeof raw.adapter === "string" ? raw.adapter : null;
  const root = typeof raw.root === "string" ? expandHome(raw.root) : null;
  const pattern = typeof raw.pattern === "string" ? raw.pattern : null;
  if (!id || !adapter || !root || !pattern) return null;
  // An unknown adapter used to fall through to the permissive branch at scan time; reject it here
  // so a typo in the allow-list is visible instead of a silently dead source.
  if (!SOURCE_ADAPTERS.has(adapter)) return null;
  const out: any = {
    id,
    adapter,
    root,
    pattern,
    enabled: raw.enabled !== false,
  };
  if (typeof raw.opencodeDb === "string" && raw.opencodeDb) out.opencodeDb = expandHome(raw.opencodeDb);
  // Optional hints so a source can skip the lazy session-header read entirely: `project` sets the
  // label, `cwd` (expanded like every configured path) also gives project = basename(cwd).
  if (typeof raw.project === "string" && raw.project.trim()) out.project = raw.project.trim();
  if (typeof raw.cwd === "string" && raw.cwd) out.cwd = expandHome(raw.cwd);
  return out;
}

/** @internal */
export async function loadSources() {
  const sourcesPath = cfg.sourcesPath || DEFAULT_CFG.sourcesPath;
  let text;
  try {
    text = await fs.promises.readFile(sourcesPath, "utf8");
  } catch (e) {
    // Missing allow-list → built-in defaults. Any other read error (permissions, a directory,
    // I/O error) is fail-closed: scan nothing rather than silently re-enabling default roots.
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

/**
 * Path-aware glob for allow-list patterns: `*` stays inside one path segment, `**` spans zero or
 * more segments. Patterns are matched against the path relative to the allow-list root, so a
 * directory prefix ("sub/*.json") can only narrow the scan, never widen it.
 */
function globToRegExp(pattern) {
  const segs = String(pattern).split(/[\\/]/).filter(Boolean);
  let re = "^";
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (seg === "**") {
      // `**` also swallows the separators around it: "**/x" matches "x" and "a/b/x".
      re += last ? ".*" : "(?:[^/]+/)*";
      continue;
    }
    re += seg.split("*").map(escapeRegExp).join("[^/]*");
    if (!last) re += "/";
  }
  return new RegExp(`${re}$`);
}

// An allow-list root that accidentally points at ~ (or /) must not stall the scan: bound both the
// entries visited and the matches kept, then log the cap. Visited entries get the larger budget so
// a directory full of non-matching session files cannot starve the real sidecars.
const MAX_SCAN_ENTRIES = 200000;
const MAX_SCAN_FILES = 20000;

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
      out.push(...(await walkGlob(path.join(dir, ent.name), re, budget, errors, `${prefix}${ent.name}/`)));
    } else if (ent.isFile()) {
      // Dirent types exclude symlinks on purpose: the allow-list must only read real files.
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

/**
 * List the files an allow-list entry selects.
 *
 * The pattern is matched against paths relative to `source.root`, so `sub/*.json` stays inside
 * `sub/` instead of widening into a recursive root scan. Symlinks are never followed (the
 * allow-list describes real files), and directories that cannot be read are reported instead of
 * silently looking like an empty source.
 * @internal
 */
export async function listSourceFiles(source) {
  const errors = [];
  const segs = String(source.pattern).split(/[\\/]/).filter(Boolean);
  const filePattern = segs.pop() || source.pattern;
  // A literal directory prefix is a starting point, not a file name: "sub/*.json" must scan
  // `<root>/sub`, not `<root>` recursively.
  let start = source.root;
  while (segs.length && !segs[0].includes("*")) {
    start = path.join(start, segs.shift());
  }
  if (segs.length === 0) {
    const re = globToRegExp(filePattern);
    try {
      const entries = await fs.promises.readdir(start, { withFileTypes: true });
      const matched = entries
        .filter((ent) => ent.isFile() && re.test(ent.name))
        .map((ent) => path.join(start, ent.name));
      if (matched.length > MAX_SCAN_FILES) {
        logLine(
          `scan: source '${source.id}' has ${matched.length} matching files; only the first ${MAX_SCAN_FILES} are considered`,
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
      `scan: source '${source.id}' hit the ${
        budget.hitMatched ? `${MAX_SCAN_FILES}-match` : `${MAX_SCAN_ENTRIES}-entry`
      } cap; the rest was skipped (check that the allow-list root points at a session directory, not at a whole home directory)`,
    );
  }
  return { files, errors };
}

// ---------------------------------------------------------------------------
// Block normalization (source adapters)
// ---------------------------------------------------------------------------

function cleanOpencodeSummary(summary) {
  return String(summary)
    .replace(/\s*<dcp-message-id>.*?<\/dcp-message-id>\s*$/s, "")
    .trim();
}

/**
 * Collect the raw message ids a block absorbed.
 *
 * pi sidecars expose `effectiveMessageIds`, whose entries may be `"<messageId>#<callId>"` when the
 * block covered one tool call inside an assistant message. opencode-acp state files use
 * `messageIds`. An unrecognized shape yields null, so the block is stored as "not expandable"
 * instead of failing ingestion.
 */
/** @internal Test seam: exposed so the first-non-empty-list rule stays covered. */
export function collectMsgIds(block: any): string[] | null {
  // `??` alone would let an explicitly empty first field hide a populated second one, so take the
  // first list that actually has entries.
  const raw = [block?.effectiveMessageIds, block?.messageIds].find(
    (v) => Array.isArray(v) && v.some((item) => typeof item === "string" && item.trim() !== ""),
  );
  if (!raw) return null;
  const out: string[] = [];
  const seen = new Set<string>();
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

/**
 * Lifecycle/lineage fields shared by all three adapters. Numbers accept the string form the
 * billion-context proxy writes; anything unrecognized becomes null ("unknown"), never a guess.
 */
function blockMetaFields(b: any) {
  const direct = Array.isArray(b?.directBlockIds)
    ? b.directBlockIds.filter((x: unknown) => typeof x === "string" && x !== "").slice(0, MAX_DIRECT_BLOCKS)
    : [];
  return {
    active: typeof b?.active === "boolean" ? (b.active ? 1 : 0) : null,
    directBlockIds: direct.length ? JSON.stringify(direct) : null,
    durationMs: toInt(b?.durationMs),
    generation: typeof b?.generation === "string" && b.generation ? b.generation : null,
    survivedCount: toInt(b?.survivedCount),
    compressCallId: typeof b?.compressCallId === "string" && b.compressCallId ? b.compressCallId : null,
  };
}

function normalizePiBlocks(data: any) {
  // null = unrecognized payload shape: the caller must not advance the watermark (retry later)
  if (!data || typeof data !== "object" || !Array.isArray(data.blocks)) return null;
  const out: any[] = [];
  for (const b of data.blocks) {
    if (!b || (typeof b.blockId !== "string" && typeof b.blockId !== "number") || typeof b.summary !== "string")
      continue;
    out.push({
      blockId: String(b.blockId),
      runId: typeof b.runId === "string" ? b.runId : typeof b.runId === "number" ? String(b.runId) : null,
      tier: Number.isInteger(b.tier) ? b.tier : null,
      topic: typeof b.topic === "string" && b.topic ? b.topic.slice(0, MAX_TOPIC_CHARS) : null,
      summary: b.summary,
      ...blockMetaFields(b),
      msgIds: collectMsgIds(b),
      refStart: typeof b.startRef === "string" ? b.startRef : null,
      refEnd: typeof b.endRef === "string" ? b.endRef : null,
      compressedTokens: Number.isInteger(b.compressedTokens) ? b.compressedTokens : null,
      createdAt: Number.isInteger(b.createdAt) ? b.createdAt : null,
    });
  }
  return out;
}

function normalizeOpencodeBlocks(data: any) {
  const byId = (data as any)?.prune?.messages?.blocksById as Record<string, any> | undefined;
  // null = unrecognized payload shape: the caller must not advance the watermark (retry later)
  if (!byId || typeof byId !== "object") return null;
  const out: any[] = [];
  for (const [key, b] of Object.entries(byId)) {
    if (!b || typeof b.summary !== "string") continue;
    const rawId = b.blockId ?? key;
    out.push({
      blockId: String(rawId),
      runId: b.runId != null ? String(b.runId) : null,
      tier: Number.isInteger(b.tier) ? b.tier : null,
      topic:
        (typeof b.topic === "string" && b.topic ? b.topic : typeof b.batchTopic === "string" ? b.batchTopic : "").slice(
          0,
          MAX_TOPIC_CHARS,
        ) || null,
      summary: cleanOpencodeSummary(b.summary),
      ...blockMetaFields(b),
      msgIds: collectMsgIds(b),
      refStart: typeof b.startId === "string" ? b.startId : null,
      refEnd: typeof b.endId === "string" ? b.endId : null,
      compressedTokens: Number.isInteger(b.compressedTokens) ? b.compressedTokens : null,
      createdAt: Number.isInteger(b.createdAt) ? b.createdAt : null,
    });
  }
  return out;
}

/**
 * bili (billion-context proxy) session files store block scalars as strings, unlike the pi and
 * opencode sidecars which store them as JSON numbers. Convert a scalar to an integer, or null when
 * it is absent, empty, or not a number.
 */
function toInt(v: any) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) ? n : null;
}

/**
 * bili session files are named `<host>_<hash>.json` (one file per proxied upstream). The proxy does
 * not record a working directory, so the upstream host is the best available "project" name.
 */
function biliHost(sourceFile) {
  const base = path.basename(sourceFile, ".json");
  const idx = base.lastIndexOf("_");
  return idx > 0 ? base.slice(0, idx) : base || "unknown";
}

/**
 * Project label for a billion-context session: the envelope's upstream origin (v2+ `meta.*`, or
 * the v1 flat field) when present, otherwise the `<host>` segment of the file name. The value is a
 * host label such as `zhipu`/`anthropic`, never a local filesystem path.
 */
function biliProject(data: any, sourceFile: string) {
  const payload = data?.payload ?? {};
  const meta = payload?.meta ?? {};
  const origin = meta.upstreamOrigin ?? payload.upstreamOrigin ?? data?.upstreamOrigin;
  if (typeof origin === "string" && origin.trim()) return origin.trim();
  const protocol = meta.protocol ?? payload.protocol ?? data?.protocol;
  if (typeof protocol === "string" && protocol.trim()) return protocol.trim();
  return biliHost(sourceFile);
}

/**
 * bili (billion-context proxy, e.g. WorkBuddy/codebuddy) sessions: the file is
 * `{ version, savedAt, id, payload }` and the compression blocks live under
 * `payload.state.blocks`. Blocks record `startRef`/`endRef`, but the raw message ids (`h_...`) are
 * kept separately from the blocks and the session is one JSON document rather than line-delimited
 * messages — so bili blocks are stored as not expandable (msgIds = null), like opencode state files.
 */
function normalizeBiliBlocks(data: any) {
  const blocks = (data as any)?.payload?.state?.blocks;
  // null = unrecognized payload shape: the caller must not advance the watermark (retry later)
  if (!Array.isArray(blocks)) return null;
  const out: any[] = [];
  for (const b of blocks) {
    if (!b || (typeof b.blockId !== "string" && typeof b.blockId !== "number") || typeof b.summary !== "string")
      continue;
    out.push({
      blockId: String(b.blockId),
      runId: typeof b.runId === "string" ? b.runId : typeof b.runId === "number" ? String(b.runId) : null,
      tier: toInt(b.tier),
      topic: typeof b.topic === "string" && b.topic ? b.topic.slice(0, MAX_TOPIC_CHARS) : null,
      summary: b.summary,
      ...blockMetaFields(b),
      msgIds: null,
      refStart: typeof b.startRef === "string" ? b.startRef : null,
      refEnd: typeof b.endRef === "string" ? b.endRef : null,
      compressedTokens: toInt(b.compressedTokens),
      createdAt: toInt(b.createdAt),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// SQLite store
// ---------------------------------------------------------------------------

/** @internal */
export class MemoryDb {
  dbPath: string;
  db: any = null;
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
    // Refuse to reopen a store the session already closed: `ingestSourceFile` calls `open()` on
    // entry, so without this latch an in-flight scan could resurrect the DB after shutdown.
    if (dbClosed) throw new Error("memory store is closed for this session");
    if (!DatabaseSyncCtor) throw new Error("node:sqlite unavailable");
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSyncCtor(this.dbPath);
    this.closed = false;
    // The store holds conversation summaries: keep it readable by the user only. Best effort, so a
    // filesystem that cannot express modes (Windows) simply keeps its defaults.
    try {
      if (process.platform !== "win32") fs.chmodSync(this.dbPath, 0o600);
    } catch {
      // Ignore: permissions are hardening, not a functional requirement.
    }
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA busy_timeout=5000;");
    this.db.exec("PRAGMA synchronous=NORMAL;");

    const hasSources =
      this.db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='sources'").get().c > 0;
    if (!hasSources) {
      // Upgrade from the v1 schema (sessions/blocks) is a rebuild: drop legacy tables first so the
      // FTS external-content table is not bound to an old blocks table. Sidecars are re-scanned.
      this.db.exec("DROP TABLE IF EXISTS blocks_fts;");
      this.db.exec("DROP TABLE IF EXISTS blocks;");
      this.db.exec("DROP TABLE IF EXISTS sessions;");
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources(
        source_file    TEXT PRIMARY KEY,      -- actual file that was parsed (sidecar or ACP state file)
        kind           TEXT NOT NULL DEFAULT 'pi',  -- 'pi' | 'opencode' | 'bili'
        project        TEXT NOT NULL,         -- working dir folder name (basename(cwd))
        cwd            TEXT,
        last_mtime_ms  INTEGER DEFAULT 0,     -- source file mtime of last successful scan
        last_size      INTEGER DEFAULT 0,
        first_seen_at  INTEGER,
        updated_at     INTEGER,
        format_version INTEGER,               -- upstream format version (schemaVersion / envelope version)
        producer       TEXT                   -- upstream producer string when present
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
        active            INTEGER,            -- 1/0 from the source; NULL = unknown
        direct_block_ids  TEXT,               -- JSON array of lineage block ids (NULL = unknown)
        duration_ms       INTEGER,            -- block duration when the source records it
        generation        TEXT,               -- 'young' | 'old' (NULL = unknown)
        survived_count    INTEGER,
        compress_call_id  TEXT,
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
    // Idempotent migration (0.4.x -> 0.5.0): blocks.msg_ids powers the optional memory_expand tool.
    // Rows created before the column existed keep NULL, so reset the watermark ledger once to force
    // a re-parse of every source and backfill the pointers. Tombstones still block resurrection.
    const blockCols = this.db.prepare("PRAGMA table_info(blocks)").all();
    const addedMsgIds = !blockCols.some((c) => c.name === "msg_ids");
    if (addedMsgIds) this.db.exec("ALTER TABLE blocks ADD COLUMN msg_ids TEXT;");
    // Additive migration (0.6.0): upstream lifecycle/lineage metadata. Existing rows stay NULL
    // ("unknown") until the source changes or a force rescan refreshes them; no watermark reset is
    // needed because the timeline treats a missing value as unknown rather than a guess.
    for (const [name, type] of [
      ["active", "INTEGER"],
      ["direct_block_ids", "TEXT"],
      ["duration_ms", "INTEGER"],
      ["generation", "TEXT"],
      ["survived_count", "INTEGER"],
      ["compress_call_id", "TEXT"],
    ] as const) {
      if (!blockCols.some((c) => c.name === name)) this.db.exec(`ALTER TABLE blocks ADD COLUMN ${name} ${type};`);
    }
    const sourceCols = this.db.prepare("PRAGMA table_info(sources)").all();
    for (const [name, type] of [
      ["format_version", "INTEGER"],
      ["producer", "TEXT"],
    ] as const) {
      if (!sourceCols.some((c) => c.name === name)) this.db.exec(`ALTER TABLE sources ADD COLUMN ${name} ${type};`);
    }
    // Idempotent migration: seed the watermark ledger from existing sources rows.
    this.db.exec(`
      INSERT OR IGNORE INTO source_watermarks(source_file, last_mtime_ms, last_size, updated_at)
      SELECT source_file, last_mtime_ms, last_size, updated_at
      FROM sources
      WHERE last_mtime_ms IS NOT NULL AND last_size IS NOT NULL;
    `);
    // Reset the ledger once, after the seed: seeding first would re-stamp the watermarks that the
    // reset is about to clear, and the pointer backfill re-read would never happen.
    if (addedMsgIds) {
      this.db.exec("UPDATE source_watermarks SET last_mtime_ms = 0, last_size = 0;");
      logLine("migrated blocks.msg_ids; watermark ledger reset once for pointer backfill");
    }
    const trig = this.db
      .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='trigger' AND name IN ('blocks_ai','blocks_ad')")
      .get();
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
        project: cwd ? path.basename(cwd) : null,
      },
      force,
      async (sf) => piSessionHeaderCwd(sf),
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
  async ingestSourceFile(sourceFile, meta: any = {}, force = false, resolveCwd = null) {
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
    if (isAuxiliarySourceFile(sourceFile)) {
      // Content stores and SQLite sidecars live next to session files but hold no blocks.
      return { ok: true, parsed: false, skipped: true, total: 0, inserted: 0, mtimeMs, size };
    }
    const kind = meta?.kind === "opencode" ? "opencode" : meta?.kind === "bili" ? "bili" : "pi";
    let cwd = typeof meta?.cwd === "string" && meta.cwd ? meta.cwd : null;
    let project = typeof meta?.project === "string" && meta.project ? meta.project : null;
    if (!force) {
      // The ledger, not the sources row, owns the watermark: prune() may drop sources rows
      // without losing the "already ingested" state.
      const prev = this.db
        .prepare("SELECT last_mtime_ms, last_size FROM source_watermarks WHERE source_file = ?")
        .get(sourceFile);
      if (prev && prev.last_mtime_ms === mtimeMs && prev.last_size === size) {
        return { ok: true, parsed: false, total: 0, inserted: 0, mtimeMs, size };
      }
    }
    if (kind === "pi" && !cwd) {
      // Reuse a previously resolved cwd on incremental scans; force rescans refresh metadata.
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
      else if (kind === "bili") project = biliHost(sourceFile);
      else project = "unknown";
    }
    let data;
    try {
      data = JSON.parse(await fs.promises.readFile(sourceFile, "utf8"));
    } catch (e) {
      // Possibly mid-write by another process: leave watermark untouched, retry next scan
      return { ok: false, parsed: false, total: 0, inserted: 0, mtimeMs, size, error: `parse: ${e.message}` };
    }
    const unsupported =
      kind === "pi" ? unsupportedSidecarSchema(data) : kind === "bili" ? unsupportedBcEnvelope(data) : null;
    if (unsupported !== null) {
      noteUnsupportedFormat(
        `${kind}:${sourceFile}:${String(unsupported)}`,
        `unsupported ${kind} format version ${String(unsupported)}; skipped ${path.basename(sourceFile)}`,
      );
      return { ok: true, parsed: false, skipped: true, total: 0, inserted: 0, mtimeMs, size };
    }
    // Format version + producer are recorded for diagnostics; a bili project prefers the envelope's
    // own origin over the file-name host segment.
    const formatVersion =
      kind === "pi"
        ? typeof data?.schemaVersion === "number" && Number.isInteger(data.schemaVersion)
          ? data.schemaVersion
          : 1
        : kind === "bili"
          ? typeof data?.version === "number" && Number.isInteger(data.version)
            ? data.version
            : 1
          : null;
    const producer = typeof data?.producer === "string" && data.producer ? data.producer : null;
    if (kind === "bili") project = biliProject(data, sourceFile);
    const blocks =
      kind === "pi"
        ? normalizePiBlocks(data)
        : kind === "bili"
          ? normalizeBiliBlocks(data)
          : normalizeOpencodeBlocks(data);
    if (blocks === null) {
      // Unrecognized payload shape (upstream format drift): do not advance the watermark, retry.
      return {
        ok: false,
        parsed: false,
        total: 0,
        inserted: 0,
        mtimeMs,
        size,
        error: "unrecognized source format",
      };
    }
    if (this.closed) {
      // The session ended while this file was being read: the connection is gone, and a closed
      // store must not be reopened behind the user's back. Report a plain failure instead of a
      // TypeError from a null handle (plus a second one from the ROLLBACK).
      return { ok: false, parsed: true, total: 0, inserted: 0, mtimeMs, size, error: "store closed" };
    }
    const now = Date.now();
    let inserted = 0;
    let refreshed = 0;
    let redactedHits = 0;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO sources(source_file, kind, project, cwd, last_mtime_ms, last_size, first_seen_at, updated_at, format_version, producer)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_file) DO UPDATE SET
             kind = excluded.kind,
             project = excluded.project,
             cwd = excluded.cwd,
             last_mtime_ms = excluded.last_mtime_ms,
             last_size = excluded.last_size,
             updated_at = excluded.updated_at,
             format_version = excluded.format_version,
             producer = excluded.producer`,
        )
        .run(sourceFile, kind, project, cwd, mtimeMs, size, now, now, formatVersion, producer);
      this.db
        .prepare(
          `INSERT INTO source_watermarks(source_file, last_mtime_ms, last_size, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(source_file) DO UPDATE SET
             last_mtime_ms = excluded.last_mtime_ms,
             last_size = excluded.last_size,
             updated_at = excluded.updated_at`,
        )
        .run(sourceFile, mtimeMs, size, now);
      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO blocks
           (source_file, kind, block_id, run_id, tier, topic, summary, ref_start, ref_end, compressed_tokens, created_at, msg_ids, active, direct_block_ids, duration_ms, generation, survived_count, compress_call_id)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM block_tombstones WHERE source_file = ? AND block_id = ?)`,
      );
      // INSERT OR IGNORE leaves existing rows alone, so refresh the pointer column separately —
      // including back to NULL, because a sidecar that re-emits a block_id without references must
      // not leave stale pointers behind (they would expand to messages the block no longer covers).
      // Only msg_ids changes, which keeps the FTS external-content table valid. `IS NOT` is
      // SQLite's null-safe comparison, so an unchanged value still reports 0 change.
      const updMsgIds = this.db.prepare(
        `UPDATE blocks SET msg_ids = ?
          WHERE source_file = ? AND block_id = ? AND (msg_ids IS NOT ?)`,
      );
      // Lifecycle/lineage metadata is refreshable on force rescan. It feeds timeline/related
      // ordering only, never FTS, so an unconditional in-place update is safe.
      const updMeta = this.db.prepare(
        `UPDATE blocks SET
           active = ?, direct_block_ids = ?, duration_ms = ?, generation = ?, survived_count = ?, compress_call_id = ?
         WHERE source_file = ? AND block_id = ?`,
      );
      for (const b of blocks) {
        if (!b || typeof b.summary !== "string") continue;
        const redactedSummary = redactSecrets(b.summary);
        const redactedTopic = typeof b.topic === "string" && b.topic ? redactSecrets(b.topic) : { text: null, hits: 0 };
        redactedHits += redactedSummary.hits + redactedTopic.hits;
        const summary =
          redactedSummary.text.length > cfg.maxSummaryChars
            ? redactedSummary.text.slice(0, cfg.maxSummaryChars)
            : redactedSummary.text;
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
          b.active ?? null,
          b.directBlockIds ?? null,
          b.durationMs ?? null,
          b.generation ?? null,
          b.survivedCount ?? null,
          b.compressCallId ?? null,
          sourceFile,
          b.blockId,
        );
        if (r.changes > 0) inserted++;
        else {
          if (updMsgIds.run(msgIdsJson, sourceFile, b.blockId, msgIdsJson).changes > 0) refreshed++;
          updMeta.run(
            b.active ?? null,
            b.directBlockIds ?? null,
            b.durationMs ?? null,
            b.generation ?? null,
            b.survivedCount ?? null,
            b.compressCallId ?? null,
            sourceFile,
            b.blockId,
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* noop */
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
    return this.db
      .prepare(
        `SELECT b.id, b.source_file AS sourceFile, b.kind AS kind,
                b.block_id AS blockId, b.run_id AS runId, b.tier, b.topic, b.summary,
                b.ref_start AS refStart, b.ref_end AS refEnd,
                b.compressed_tokens AS tokens, b.created_at AS createdAt,
                b.msg_ids AS msgIds, b.active AS active, b.direct_block_ids AS directBlockIds,
                b.duration_ms AS durationMs, b.generation AS generation,
                b.survived_count AS survivedCount, b.compress_call_id AS compressCallId,
                s.project, s.cwd
           FROM blocks b LEFT JOIN sources s ON s.source_file = b.source_file
          WHERE ${where}
          ORDER BY b.created_at DESC, b.id DESC
          LIMIT ?`,
      )
      .all(...params);
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
    return this.db
      .prepare(
        `SELECT count(*) AS c
           FROM blocks b LEFT JOIN sources s ON s.source_file = b.source_file
          WHERE ${where}`,
      )
      .get(...params).c;
  }

  /**
   * Token-matching WHERE/FROM shared by the blocks search and the timeline/related candidate
   * queries. Returns null for an empty query (callers decide what "no filter" means).
   */
  _buildFilter(query, project = null) {
    const tokens = String(query || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length === 0) return null;
    const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => "\\" + m);
    const ftsTokens = tokens.filter((t) => t.length >= TRIGRAM_MIN_LEN);
    const likeTokens = tokens.filter((t) => t.length < TRIGRAM_MIN_LEN);
    const useFts = ftsTokens.length > 0;
    const params: any[] = [];
    const clauses: string[] = [];
    if (useFts) {
      // FTS5 trigram: per-token phrase AND
      clauses.push("blocks_fts MATCH ?");
      params.push(ftsTokens.map((t) => '"' + t.replace(/"/g, '""') + '"').join(" "));
    }
    for (const t of likeTokens) {
      // Short tokens (<= 2 chars, common in Chinese) are not trigram-indexable; match both
      // summary and topic, AND-ed with the other tokens.
      clauses.push("(b.summary LIKE ? ESCAPE '\\' OR b.topic LIKE ? ESCAPE '\\')");
      const like = "%" + escapeLike(t) + "%";
      params.push(like, like);
    }
    let where = clauses.length ? clauses.join(" AND ") : "1=1";
    if (project) {
      where += " AND s.project = ?";
      params.push(project);
    }
    const mode = useFts ? (likeTokens.length ? "mixed" : "fts") : "like";
    const from = useFts
      ? "FROM blocks_fts JOIN blocks b ON b.id = blocks_fts.rowid JOIN sources s ON s.source_file = b.source_file"
      : "FROM blocks b JOIN sources s ON s.source_file = b.source_file";
    return { mode, where, params, from, useFts };
  }

  /**
   * Build the search SQL shared by search()/explainSearch().
   * - all tokens >= 3 chars: FTS5 trigram (bm25 ordering);
   * - mixed: FTS for long tokens + AND-ed LIKE for short tokens;
   * - all short: LIKE on summary OR topic, deliberately without the blocks_fts join so SQLite
   *   can use idx_blocks_created (no FTS scan + temp B-tree sort).
   * @returns {{mode:string, sql:string|null, params:Array<any>, limit:number}}
   */
  _buildSearch(query, opts: any = {}) {
    const limit = Math.max(
      1,
      Math.min(MAX_RESULT_LIMIT, Number.isInteger(opts.limit) ? opts.limit : DEFAULT_RESULT_LIMIT),
    );
    const built = this._buildFilter(query, opts.project || null);
    if (!built) return { mode: "empty", sql: null, params: [], limit };
    const params = [...built.params, limit];
    const rank = built.useFts ? "bm25(blocks_fts)" : "NULL";
    // Pure LIKE keeps ORDER BY created_at only so idx_blocks_created satisfies the ordering.
    const order = built.useFts
      ? "ORDER BY bm25(blocks_fts), b.created_at DESC, b.id DESC"
      : "ORDER BY b.created_at DESC";
    const sql = `
      SELECT b.id, b.source_file AS sourceFile, b.kind AS kind,
             b.block_id AS blockId, b.run_id AS runId, b.tier, b.topic,
             b.ref_start AS refStart, b.ref_end AS refEnd,
             b.compressed_tokens AS tokens, b.created_at AS createdAt,
             b.summary, b.active AS active, b.direct_block_ids AS directBlockIds,
             b.duration_ms AS durationMs, b.generation AS generation,
             b.survived_count AS survivedCount, b.compress_call_id AS compressCallId,
             s.project, s.cwd,
             ${rank} AS rank
      ${built.from}
      WHERE ${built.where}
      ${order}
      LIMIT ?
    `;
    return { mode: built.mode, sql, params, limit };
  }

  /**
   * @param {string} query
   * @param {{project?:string|null, limit?:number}} opts
   * @returns {{mode:string, rows:Array<object>}}
   */
  search(query, opts: any = {}) {
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
  explainSearch(query, opts: any = {}) {
    this.open();
    const built = this._buildSearch(query, opts);
    if (built.mode === "empty") return [];
    return this.db.prepare(`EXPLAIN QUERY PLAN ${built.sql}`).all(...built.params);
  }

  /**
   * Timeline view: the same token filter as search(), ordered by the timeline key (exact time when
   * present, otherwise a source-local estimate from the numeric block id) instead of relevance.
   * `exact` marks rows that carry a real `created_at`; an estimated time is used for ordering only
   * and never displayed. Rows with neither time nor order are counted in `unknown` and only
   * returned when `verbose` is set.
   */
  timeline(query, opts: any = {}) {
    this.open();
    const limit = Math.max(
      1,
      Math.min(MAX_TIMELINE_LIMIT, Number.isInteger(opts.limit) ? opts.limit : DEFAULT_RESULT_LIMIT),
    );
    const verbose = opts.verbose === true;
    const built = this._buildFilter(query, opts.project || null);
    const from = built ? built.from : "FROM blocks b JOIN sources s ON s.source_file = b.source_file";
    let where = built ? built.where : "1=1";
    const params = built ? [...built.params] : [];
    if (!built && opts.project) {
      where += " AND s.project = ?";
      params.push(opts.project);
    }
    params.push(TIMELINE_CANDIDATE_LIMIT);
    const sql = `
      SELECT ${BLOCK_ROW_COLUMNS}, NULL AS rank
      ${from}
      WHERE ${where}
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT ?
    `;
    let rows = [];
    try {
      rows = this.db.prepare(sql).all(...params);
    } catch (e) {
      logLine(`timeline error: ${withoutPaths(e.message)}`);
      rows = [];
    }
    let anchor = null;
    if (opts.block) {
      const found = this.findBlocks(String(opts.block), opts.source || null, 1);
      if (!found.length) return { mode: "timeline", rows: [], unknown: 0, total: 0, note: "anchor not found" };
      anchor = found[0];
    }
    const anchorsBySource = new Map();
    for (const r of rows) {
      if (!Number.isInteger(r.createdAt)) continue;
      const list = anchorsBySource.get(r.sourceFile) || [];
      list.push({ seq: blockSeqNum(r.blockId), createdAt: r.createdAt });
      anchorsBySource.set(r.sourceFile, list);
    }
    const windowMs = Number.isInteger(opts.windowMinutes) ? opts.windowMinutes * 60000 : null;
    let lo = Number.isInteger(opts.from) ? opts.from : null;
    let hi = Number.isInteger(opts.to) ? opts.to : null;
    const sameSourceOnly = anchor && windowMs !== null ? anchor.sourceFile : null;
    if (anchor && windowMs !== null && Number.isInteger(anchor.createdAt)) {
      lo = anchor.createdAt - windowMs;
      hi = anchor.createdAt + windowMs;
    }
    const entries = [];
    let unknown = 0;
    for (const r of rows) {
      if (sameSourceOnly && r.sourceFile !== sameSourceOnly) continue;
      const key = timelineKey(r, anchorsBySource);
      if (key.rank === 0 && key.time !== null && (lo !== null || hi !== null)) {
        if ((lo !== null && key.time < lo) || (hi !== null && key.time > hi)) continue;
      }
      if (key.rank === 2) {
        unknown++;
        if (!verbose) continue;
      }
      entries.push({
        ...r,
        timelineTime: key.time,
        estimated: key.estimated,
        exact: Number.isInteger(r.createdAt),
        orderRank: key.rank,
      });
    }
    entries.sort((a, b) => {
      if (a.orderRank !== b.orderRank) return a.orderRank - b.orderRank;
      const at = a.timelineTime ?? 0;
      const bt = b.timelineTime ?? 0;
      if (at !== bt) return at - bt;
      const as = blockSeqNum(a.blockId) ?? 0;
      const bs = blockSeqNum(b.blockId) ?? 0;
      if (as !== bs) return as - bs;
      return (a.id ?? 0) - (b.id ?? 0);
    });
    return { mode: "timeline", rows: entries.slice(0, limit), unknown, total: rows.length, verbose };
  }

  /**
   * Related-line view: score other blocks against a seed block by structural evidence first
   * (compression lineage, same run, source neighbor) and lexical overlap second. Deterministic,
   * offline, and bounded by RELATED_CANDIDATE_LIMIT; each row carries its `reasons`.
   */
  related(query, opts: any = {}) {
    this.open();
    const limit = Math.max(
      1,
      Math.min(MAX_RESULT_LIMIT, Number.isInteger(opts.limit) ? opts.limit : DEFAULT_RESULT_LIMIT),
    );
    let seed = null;
    if (opts.block) {
      const found = this.findBlocks(String(opts.block), opts.source || null, 1);
      seed = found[0] || null;
    } else if (query) {
      const s = this.search(query, { project: opts.project || null, limit: 1 });
      seed = s.rows[0] || null;
    }
    if (!seed) return { mode: "related", rows: [], note: "seed not found" };
    const candidates = new Map();
    const baseSql =
      `SELECT ${BLOCK_ROW_COLUMNS} FROM blocks b JOIN sources s ON s.source_file = b.source_file ` +
      `WHERE b.id != ? AND ${
        seed.project ? "s.project = ?" : "b.source_file = ?"
      } ORDER BY b.created_at DESC, b.id DESC LIMIT ?`;
    try {
      const baseParams = seed.project
        ? [seed.id, seed.project, RELATED_CANDIDATE_LIMIT]
        : [seed.id, seed.sourceFile, RELATED_CANDIDATE_LIMIT];
      for (const r of this.db.prepare(baseSql).all(...baseParams)) candidates.set(r.id, r);
    } catch (e) {
      logLine(`related candidates error: ${withoutPaths(e.message)}`);
    }
    const seedTokens = significantTokens(`${seed.topic || ""} ${seed.summary || ""}`);
    const filter = seedTokens.length ? this._buildFilter(seedTokens.slice(0, 6).join(" "), opts.project || null) : null;
    if (filter) {
      const sql = `SELECT ${BLOCK_ROW_COLUMNS} ${filter.from} WHERE b.id != ? AND ${filter.where} ORDER BY b.created_at DESC LIMIT ?`;
      try {
        for (const r of this.db.prepare(sql).all(seed.id, ...filter.params, RELATED_CANDIDATE_LIMIT))
          candidates.set(r.id, r);
      } catch (e) {
        logLine(`related token error: ${withoutPaths(e.message)}`);
      }
    }
    const scored = [...candidates.values()]
      .map((r) => {
        const { score, reasons } = relatedScore(seed, r);
        return { ...r, score, reasons };
      })
      .sort((a, b) => b.score - a.score || (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.id - b.id);
    return {
      mode: "related",
      rows: scored.slice(0, limit),
      seed: { blockId: seed.blockId, project: seed.project, sourceFile: seed.sourceFile },
    };
  }

  stats() {
    this.open();
    const s = this.db
      .prepare(
        `SELECT (SELECT count(*) FROM sources) AS sources,
                (SELECT count(*) FROM blocks) AS blocks,
                (SELECT count(DISTINCT source_file) FROM blocks) AS sources_with_blocks,
                (SELECT coalesce(sum(compressed_tokens),0) FROM blocks) AS tokens,
                (SELECT count(*) FROM block_tombstones) AS tombstones`,
      )
      .get();
    return {
      sources: s.sources,
      // Compatibility aliases kept for older status consumers.
      sessions: s.sources,
      sources_with_blocks: s.sources_with_blocks,
      sessions_with_blocks: s.sources_with_blocks,
      blocks: s.blocks,
      tokens: s.tokens,
      tombstones: s.tombstones,
      dbPath: this.dbPath,
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
    const cutoff = Date.now() - keepDays * 86400000;
    const now = Date.now();
    const before = this.db.prepare("SELECT count(*) AS c FROM blocks").get().c;
    // Tombstones and deletes are one unit: a crash between them would make the delete look like it
    // never happened, so a later source-file change could resurrect pruned blocks.
    this.db.exec("BEGIN IMMEDIATE");
    let removedSources = 0;
    try {
      // Record durable tombstones first: a later source-file change must not resurrect pruned blocks.
      this.db
        .prepare(
          `INSERT OR IGNORE INTO block_tombstones(source_file, block_id, pruned_at)
           SELECT source_file, block_id, ? FROM blocks
           WHERE created_at IS NOT NULL AND created_at < ?`,
        )
        .run(now, cutoff);
      this.db.prepare("DELETE FROM blocks WHERE created_at IS NOT NULL AND created_at < ?").run(cutoff);
      const rs = this.db
        .prepare(
          "DELETE FROM sources WHERE NOT EXISTS (SELECT 1 FROM blocks b WHERE b.source_file = sources.source_file)",
        )
        .run();
      removedSources = rs.changes;
      this.db.exec("COMMIT");
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The failing statement is the one worth reporting.
      }
      throw e;
    }
    // VACUUM cannot run inside a transaction, and a busy database is no reason to fail the prune:
    // the rows are already gone, only the file size stays behind.
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
      remainingBlocks: remain,
    };
  }
}

// ---------------------------------------------------------------------------
// Scan orchestration
// ---------------------------------------------------------------------------

/** DB held by the running extension instance (reused for the session, closed at shutdown) */
let db = null;
/** Session generation guard: a stale background scan must not touch the DB after shutdown. */
let sessionGeneration = 0;
/** Set once the store is closed at session end: no continuation may reopen the file-backed DB. */
let dbClosed = false;
let backgroundScan = null;
/** Cached official SessionManager map (fallback only; the header read is the primary path). */
let piMapCache = null;
let piMapInFlight = null;
/** Test/observability counter: how many times a session header was read. */
let piHeaderReadCount = 0;

/** @internal */
export function getDb() {
  if (!db) db = new MemoryDb(cfg.dbPath);
  if (dbClosed) throw new Error("memory store is closed for this session");
  db.open();
  return db;
}

/** Official pi SessionManager list → { jsonlPath: cwd }; empty when the API is unavailable. */
/** @internal */
export async function piSessionCwdMap() {
  const map = new Map();
  try {
    const mod = await import("@earendil-works/pi-coding-agent");
    const infos = await mod.SessionManager.listAll();
    for (const i of infos) {
      const file = i.path;
      if (typeof file === "string" && file.endsWith(".jsonl") && !file.endsWith(".acp.json")) {
        map.set(file, typeof i.cwd === "string" ? i.cwd : null);
      }
    }
  } catch {
    // Not running inside pi or package unavailable: project falls back to the encoded directory name.
  }
  return map;
}

/**
 * Read only the first line (session header) and return its cwd. The header is pi metadata
 * (`cwd,id,timestamp,type,version`); message lines are never read.
 * Returns null when the file is missing/unreadable or the first line is not valid JSON.
 */
/** @internal */
export async function piSessionHeaderCwd(sessionFile) {
  piHeaderReadCount++;
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
      const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
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
        /* noop */
      }
    }
  }
}

/** Cached official-API fallback for sessions whose header cannot be read. */
async function getPiSessionCwdMap(force = false) {
  const now = Date.now();
  if (!force && piMapCache && now - piMapCache.at < PI_MAP_TTL_MS) return piMapCache.map;
  if (piMapInFlight) return piMapInFlight;
  piMapInFlight = piSessionCwdMap()
    .then((map) => {
      piMapCache = { at: Date.now(), map };
      return map;
    })
    .finally(() => {
      piMapInFlight = null;
    });
  return piMapInFlight;
}

/** Resolve opencode-acp state files to project/cwd via a read-only query on opencode.db. */
/** @internal */
export async function loadOpencodeSessionMap(source, files) {
  const map = new Map();
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
      // Older node:sqlite builds may not accept the readOnly option; fall back to a
      // query-only connection so opencode.db is never modified.
      logLine(`read-only open failed (${readErr.message}); retry with query_only`);
      odb = new DatabaseSyncCtor(dbPath);
      odb.exec("PRAGMA query_only=ON;");
    }
    try {
      odb.exec("PRAGMA busy_timeout=5000;");
    } catch {
      /* best effort */
    }
    const stmt = odb.prepare("SELECT id, directory, path, project_id FROM session WHERE id = ?");
    for (const file of files) {
      const base = path.basename(file);
      if (!base.startsWith("ses_") || !base.endsWith(".json")) continue;
      const sessionId = base.slice(0, -5); // state file name is <sessionId>.json; session.id includes the "ses_" prefix
      const row = stmt.get(sessionId);
      if (!row) continue;
      const cwd = row.directory || row.path || null;
      const project = row.directory
        ? path.basename(row.directory)
        : row.path
          ? path.basename(row.path)
          : typeof row.project_id === "string"
            ? row.project_id
            : null;
      if (cwd || project) map.set(file, { cwd: cwd || null, project: project || null });
    }
  } catch (e) {
    logLine(`opencode session map failed: ${withoutPaths(e.message)}`);
  } finally {
    if (odb) {
      try {
        odb.close();
      } catch {
        /* noop */
      }
    }
  }
  return map;
}

/**
 * Light full scan over the allow-list: ingest every compression file whose mtime/size changed.
 * Idempotent; watermarks live in the source_watermarks ledger. No global session discovery.
 */
/** @internal */
export async function scanSources(force = false) {
  // Captured before the first await: a shutdown that lands while the allow-list is being read must
  // invalidate this scan, not hand it the post-shutdown generation (which would let the scan write
  // into a store the session already closed).
  const generation = sessionGeneration;
  await loadSqlite();
  const d = getDb();
  const sources = await loadSources();
  const needPiCwd = sources.some((s) => s.enabled && s.adapter === "pi-sidecar");
  // Lazy cwd resolution: called by ingestSourceFile only after the watermark check says the
  // source must be (re)parsed. Header read first; official SessionManager map is the fallback.
  const resolvePiCwd = needPiCwd
    ? async (sessionFile: string) => {
        const headerCwd = await piSessionHeaderCwd(sessionFile);
        if (headerCwd) return headerCwd;
        const map = await getPiSessionCwdMap(force);
        return map.get(sessionFile) ?? null;
      }
    : null;
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
    // Partial counts survive a throwing source: the tally is filled in as the scan progresses.
    const tally = { files: 0, scanned: 0, inserted: 0, redacted: 0, total: 0, failed: 0 };
    try {
      await scanOneSource(source, d, force, resolvePiCwd, generation, tally);
    } catch (e) {
      // One broken source (unreadable root, corrupt opencode DB, adapter bug) must not hide every
      // source behind it.
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

/**
 * Scan one allow-list source, accumulating into `tally`.
 *
 * Split out of {@link scanSources} so a single failure degrades to a `failed` count. The generation
 * guard stops the walk when the session ends mid-scan: the store is closed at shutdown, so any
 * further ingest would reopen it and keep writing after the user left.
 */
async function scanOneSource(source, d, force, resolvePiCwd, generation, tally) {
  const listing = await listSourceFiles(source);
  let files = listing.files;
  // Auxiliary store files (content-store, fallback slots, SQLite) are not compression sources.
  files = files.filter((f) => !isAuxiliarySourceFile(f));
  if (listing.errors.length) {
    // An unreadable or missing root must be visible: treating it as "0 files" hid permission
    // errors and stale allow-list paths from both the log and the failure tally.
    tally.failed += listing.errors.length;
    const first = listing.errors[0];
    logLine(
      `scan: source '${source.id}' could not read ${listing.errors.length} director${
        listing.errors.length === 1 ? "y" : "ies"
      }: ${withoutPaths(first?.message || String(first))}`,
    );
  }
  if (source.adapter === "pi-sidecar" && cfg.excludeDirs.length) {
    // Keep the legacy per-directory exclusion working when a pi root contains many session dirs.
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
    if (generation !== sessionGeneration) return; // session ended: stop before the next DB touch
    let meta;
    if (source.adapter === "pi-sidecar") {
      // cwd is resolved lazily inside ingestSourceFile (explicit → stored → header → API map).
      // An allow-list `project`/`cwd` hint short-circuits that and avoids the header read.
      meta = { kind: "pi", cwd: source.cwd ?? null, project: source.project ?? null };
    } else if (source.adapter === "opencode-acp") {
      const info = opencodeMap?.get(file);
      meta = { kind: "opencode", cwd: info?.cwd ?? null, project: info?.project ?? null };
    } else if (source.adapter === "bili-session") {
      // bili sessions carry no working directory; project is derived from the file's host segment.
      meta = { kind: "bili", cwd: null, project: null };
    } else {
      logLine(`unknown source adapter '${source.adapter}' for ${source.id}; skipped`);
      tally.failed++;
      continue;
    }
    const r = await d.ingestSourceFile(file, meta, force, source.adapter === "pi-sidecar" ? resolvePiCwd : null);
    if (r.parsed) tally.scanned++;
    if (!r.ok && !r.skipped && r.error && r.error !== "no source file") {
      tally.failed++;
      if (cfg.debug) log(`scan failed ${file}: ${r.error}`);
    }
    tally.inserted += r.inserted;
    tally.redacted += r.redacted || 0;
    tally.total += r.total;
  }
}

/** Kept as an alias for callers/tests that used the pre-allow-list name. */
/** @internal */
export function scanAll(force = false) {
  return scanSources(force);
}

/** Scan only the current pi session's sidecar (called on settle / shutdown — cheap) */
/** @internal */
export async function scanCurrentSession(sessionFile, force = false, cwd = null) {
  if (!sessionFile) return null;
  const d = getDb();
  return d.ingestSidecarFile(sessionFile, cwd || null, force);
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

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
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function sourceLabel(row) {
  const kind = row.kind === "opencode" || row.kind === "bili" ? row.kind : "pi";
  let base = path.basename(row.sourceFile || "");
  if (kind === "pi" && base.endsWith(".acp.json")) base = base.slice(0, -".acp.json".length);
  return `[${kind}] ${base}`;
}

/** Numeric suffix of a block id ("b12" -> 12, "12" -> 12), or null when there is none. */
function blockSeqNum(blockId) {
  const m = /\d+/.exec(String(blockId ?? ""));
  return m ? parseInt(m[0], 10) : null;
}

/** Parse the stored lineage JSON without ever throwing on a malformed value. */
function parseDirectBlockIds(raw) {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Significant tokens of a summary/topic for related-line matching (>=3 chars, deduped). */
function significantTokens(text) {
  const out = new Set();
  const s = String(text || "");
  for (const m of s.matchAll(/[A-Za-z0-9_]{3,}/g)) out.add(m[0].toLowerCase());
  // CJK runs stay whole; they are already distinct enough at 2+ chars.
  for (const m of s.matchAll(/[\u4e00-\u9fff]{2,}/g)) out.add(m[0]);
  return [...out];
}

/**
 * Timeline ordering key. An exact `created_at` wins; a block without one is anchored to the timed
 * rows of the same source by its numeric block id (interpolated between the nearest anchors, or
 * offset from the single nearest one). `rank` 0 = placeable, 1 = source-local order only (the
 * source has no timed row), 2 = neither. Estimated times are for ordering only, never displayed.
 */
function timelineKey(row, anchorsBySource) {
  if (Number.isInteger(row.createdAt)) return { time: row.createdAt, rank: 0, estimated: false };
  const seq = blockSeqNum(row.blockId);
  const anchors = (anchorsBySource.get(row.sourceFile) || []).filter((a) => a.seq !== null);
  if (seq === null || anchors.length === 0) return { time: null, rank: seq === null ? 2 : 1, estimated: true };
  let prev = null;
  let next = null;
  for (const a of anchors) {
    if (a.seq <= seq && (!prev || a.seq > prev.seq)) prev = a;
    if (a.seq >= seq && (!next || a.seq < next.seq)) next = a;
  }
  if (prev && next && next.seq !== prev.seq) {
    return {
      time: prev.createdAt + ((seq - prev.seq) / (next.seq - prev.seq)) * (next.createdAt - prev.createdAt),
      rank: 0,
      estimated: true,
    };
  }
  const a = prev || next;
  if (a) return { time: a.createdAt + (prev ? seq - a.seq : a.seq - seq), rank: 0, estimated: true };
  return { time: null, rank: 1, estimated: true };
}

/** Deterministic evidence-based score for the related-line view. */
function relatedScore(seed, row) {
  const reasons = [];
  let score = 0;
  const seedDirect = parseDirectBlockIds(seed.directBlockIds);
  const rowDirect = parseDirectBlockIds(row.directBlockIds);
  if (seedDirect.includes(String(row.blockId)) || rowDirect.includes(String(seed.blockId))) {
    score += 5;
    reasons.push("lineage");
  }
  if (seed.runId && row.runId && seed.runId === row.runId) {
    score += 2;
    reasons.push("same-run");
  }
  if (seed.sourceFile === row.sourceFile) {
    const a = blockSeqNum(seed.blockId);
    const b = blockSeqNum(row.blockId);
    if (a !== null && b !== null && Math.abs(a - b) <= 1) {
      score += 1.5;
      reasons.push("neighbor");
    }
  }
  const seedTokens = new Set(significantTokens(`${seed.topic || ""} ${seed.summary || ""}`));
  const shared = [];
  for (const t of significantTokens(`${row.topic || ""} ${row.summary || ""}`)) {
    if (seedTokens.has(t)) shared.push(t);
  }
  if (shared.length) {
    score += shared.reduce((n, t) => n + (t.length >= 4 ? 1.5 : 1), 0);
    reasons.push(`shared-token:${shared.slice(0, 3).join(",")}`);
  }
  if (
    seed.project &&
    row.project === seed.project &&
    Number.isInteger(seed.createdAt) &&
    Number.isInteger(row.createdAt)
  ) {
    const days = Math.abs(seed.createdAt - row.createdAt) / 86400000;
    score += 2 * Math.exp(-days / 7);
    reasons.push("project-window");
  }
  return { score, reasons };
}

/** @internal */
export function formatResults(res) {
  const rows = res.rows;
  if (rows.length === 0) {
    return (
      "No memory matches. Try: 1) shorter / more common keywords; 2) drop the project filter; " +
      "3) if a compression happened moments ago, retry later (ingestion follows scan timing). " +
      "The store only contains ACP block summaries from allow-listed sources " +
      "(pi billion-context-pi sidecars, opencode-acp state files, and billion-context sessions)."
    );
  }
  const modeLabel =
    res.mode === "like"
      ? " (short-query LIKE mode)"
      : res.mode === "mixed"
        ? " (mixed trigram + LIKE mode)"
        : " (trigram relevance sort)";
  const head = `Memory hits: ${rows.length}${modeLabel}:\n`;
  const parts = rows.map((r, i) => {
    const project = r.project || "?";
    const tm = fmtTs(r.createdAt);
    const refs = r.refStart ? ` [${r.refStart}${r.refEnd && r.refEnd !== r.refStart ? "–" + r.refEnd : ""}]` : "";
    const topic = r.topic ? `Topic: ${r.topic}\n` : "";
    let summary = r.summary || "";
    if (summary.length > PREVIEW_CHARS) summary = summary.slice(0, PREVIEW_CHARS) + "…";
    summary = summary.replace(/\n{3,}/g, "\n\n").trim();
    return (
      `[${i + 1}] project ${project} · ${tm || "time unknown"} · ${r.blockId || ""}` +
      ` · tier${r.tier ?? "?"} · ${fmtTokens(r.tokens) || "?"} tokens compressed${refs}\n` +
      `Source: ${sourceLabel(r)}\n` +
      `${topic}${summary}`
    );
  });
  return head + parts.join("\n\n---\n\n");
}

/**
 * Render a timeline. Entries without an exact timestamp show `time missing`; their position comes
 * from the source-local order estimate. Rows that could be neither timed nor ordered are reported
 * as a trailing count (and only listed when `verbose` was requested).
 * @internal
 */
export function formatTimeline(res) {
  const rows = res.rows || [];
  if (res.note) return `No timeline: ${res.note}.`;
  if (!rows.length) {
    return (
      "No timeline entries. Try: 1) a broader query; 2) another project; 3) a wider time window " +
      "(from/to or windowMinutes). Entries need either a recorded timestamp or an orderable block id."
    );
  }
  let prevTime = null;
  const parts = rows.map((r, i) => {
    const hasTime = r.exact === true && Number.isInteger(r.timelineTime);
    const time = hasTime ? fmtTs(r.timelineTime) : "time missing";
    let gap = "";
    if (hasTime && prevTime !== null && r.timelineTime - prevTime > TIMELINE_GAP_MS) gap = "· · · gap · · ·\n";
    if (hasTime) prevTime = r.timelineTime;
    const est = !hasTime && r.orderRank === 0 ? " (order estimated)" : "";
    const active = r.active === 0 ? " · inactive" : "";
    const topic = r.topic ? `Topic: ${r.topic}\n` : "";
    let summary = r.summary || "";
    if (summary.length > PREVIEW_CHARS) summary = summary.slice(0, PREVIEW_CHARS) + "…";
    summary = summary.replace(/\n{3,}/g, "\n\n").trim();
    return (
      `${gap}[${i + 1}] ${time}${est} · project ${r.project || "?"} · ${r.blockId || ""}` +
      ` · tier${r.tier ?? "?"}${active}\n` +
      `Source: ${sourceLabel(r)}\n${topic}${summary}`
    );
  });
  const scope = res.total && res.total > rows.length ? `${rows.length} of ${res.total}` : `${rows.length}`;
  let out = `Memory timeline: ${scope} entr${rows.length === 1 ? "y" : "ies"}:\n` + parts.join("\n\n---\n\n");
  if (res.unknown > 0) {
    out +=
      `\n\nUnable to place: ${res.unknown} block(s) have neither a usable timestamp nor an order.` +
      (res.verbose ? "" : " Re-run with verbose:true to list them.");
  }
  return out;
}

/** Render related-line results with their reason labels. @internal */
export function formatRelated(res) {
  const rows = res.rows || [];
  if (res.note) return `No related blocks: ${res.note}.`;
  if (!rows.length) return "No related blocks found for that seed.";
  const seed = res.seed ? ` (seed ${res.seed.blockId}${res.seed.project ? ` in ${res.seed.project}` : ""})` : "";
  const parts = rows.map((r, i) => {
    const time = fmtTs(r.createdAt) || "time missing";
    const topic = r.topic ? `Topic: ${r.topic}\n` : "";
    let summary = r.summary || "";
    if (summary.length > PREVIEW_CHARS) summary = summary.slice(0, PREVIEW_CHARS) + "…";
    summary = summary.replace(/\n{3,}/g, "\n\n").trim();
    return (
      `[${i + 1}] score ${(r.score ?? 0).toFixed(2)} · ${time} · project ${r.project || "?"} · ${r.blockId || ""}` +
      ` · tier${r.tier ?? "?"}\nWhy: ${(r.reasons || []).join(", ") || "related"}\n` +
      `Source: ${sourceLabel(r)}\n${topic}${summary}`
    );
  });
  return `Related blocks${seed}: ${rows.length}:\n` + parts.join("\n\n---\n\n");
}
function formatExpansion(row, sessionFile, res, mode) {
  const lines = [
    `Block ${row.blockId}${row.tier != null ? ` (tier ${row.tier})` : ""} · project ${row.project || "unknown"}` +
      `${row.createdAt ? ` · ${fmtTs(row.createdAt)}` : ""} · ${res.entries.length} message ref(s)` +
      ` · ${fmtTokens(row.tokens) || "?"} tok compressed`,
    `Source: ${sourceLabel(row)}`,
    // Basename only: the absolute path carries the OS user name and the encoded project directory,
    // and expansion never needs it (the `source` filter takes the session file name or project).
    `Session: ${path.basename(sessionFile)}`,
  ];
  const kb = (n) => `${Math.round(n / 1024)} KB`;
  lines.push(
    res.sessionMissing
      ? "Read: session file is gone (deleted, rotated, or renamed since ingestion)"
      : res.readTruncated
        ? `Read: ${kb(res.bytesRead)} of ${kb(res.totalBytes)} (read cap hit; later messages may be missing)`
        : `Read: ${kb(res.totalBytes)} (complete)`,
  );
  // Upstream versions can synthesize their own ids for summary entries ("acp_summary_*"); no such
  // line exists in a session file, so label those instead of calling them missing.
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
      `Text: ${res.availableChars} chars available. Read a selection with ` +
        `memory_expand({ block: "${row.blockId}", mode: "full", select: [1, 2, 3] }).`,
    );
  } else {
    lines.push(res.text || "(no text selected)");
    if (res.truncated) {
      lines.push("");
      lines.push(
        `[truncated: ${res.returnedChars} of ${res.availableChars} chars returned; ` +
          `${res.skippedMessages} message(s) skipped — narrow 'select' or raise expandMaxChars]`,
      );
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool parameter schema (plain JSON Schema; no typebox runtime dependency)
// ---------------------------------------------------------------------------

const MEMORY_SEARCH_PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Search keywords / phrase, Chinese or English; space-separated words are AND-matched, e.g. 'sqlite fts5'",
    },
    project: {
      type: "string",
      description:
        "Restrict to one project: folder name of the working directory (e.g. my-project); omit to search all projects",
    },
    limit: {
      type: "number",
      description: "Max number of results, default 6, max 20 (timeline: max 50)",
    },
    mode: {
      type: "string",
      enum: ["blocks", "timeline", "related"],
      description:
        "'blocks' (default) relevance search; 'timeline' orders matches by time/order instead of relevance; 'related' finds blocks related to an anchor or query hit",
    },
    block: {
      type: "string",
      description: "Anchor block id for mode 'timeline' or 'related', e.g. 'b2' (from a previous result)",
    },
    source: {
      type: "string",
      description: "Disambiguate an anchor block id that exists in several sources (substring of the Source label)",
    },
    from: { type: "number", description: "Timeline window start as epoch milliseconds" },
    to: { type: "number", description: "Timeline window end as epoch milliseconds" },
    windowMinutes: {
      type: "number",
      description: "Timeline window around the anchor block, in minutes (requires 'block')",
    },
    reasons: { type: "boolean", description: "Include relation reason labels for mode 'related' (always on for now)" },
    verbose: {
      type: "boolean",
      description: "Timeline: also list blocks that have neither a timestamp nor an order",
    },
  },
} as const;

interface MemorySearchParams {
  query: string;
  project: string | null;
  limit: number;
  mode: "blocks" | "timeline" | "related";
  block: string | null;
  source: string | null;
  from: number | null;
  to: number | null;
  windowMinutes: number | null;
  reasons: boolean;
  verbose: boolean;
}

const MEMORY_EXPAND_PARAMETERS = {
  type: "object",
  properties: {
    block: {
      type: "string",
      description: "Block id taken from a memory_search result, e.g. 'b1'",
    },
    source: {
      type: "string",
      description:
        "Optional disambiguator when the same block id exists in several sessions: a substring of the memory_search 'Source:' label (session file name or project)",
    },
    mode: {
      type: "string",
      enum: ["list", "full"],
      description:
        "'list' (default) returns a manifest of the absorbed messages with no conversation text; 'full' renders exactly the indices given in 'select'",
    },
    select: {
      type: "array",
      items: { type: "number" },
      description:
        "1-based message indices taken from a 'list' result; required (and non-empty) for mode 'full', which never renders a whole block at once",
    },
    limit: { type: "number", description: "Max messages to render, default from expandMaxMessages" },
    chars: { type: "number", description: "Max characters to return, default from expandMaxChars" },
  },
  required: ["block"],
} as const;

interface MemoryExpandParams {
  block: string;
  source: string | null;
  mode: "list" | "full";
  select: number[] | null;
  limit: number | null;
  chars: number | null;
}

function readMemoryExpandParams(raw: unknown): MemoryExpandParams {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const block = typeof value.block === "string" ? value.block.trim() : "";
  const source = typeof value.source === "string" && value.source.trim() ? value.source.trim() : null;
  const mode = value.mode === "full" ? "full" : "list";
  const select = Array.isArray(value.select)
    ? value.select.filter((n) => typeof n === "number" && Number.isInteger(n) && n > 0)
    : null;
  const limit =
    typeof value.limit === "number" && Number.isInteger(value.limit) && value.limit > 0 ? value.limit : null;
  const chars =
    typeof value.chars === "number" && Number.isInteger(value.chars) && value.chars > 0 ? value.chars : null;
  return { block, source, mode, select, limit, chars };
}

function readMemorySearchParams(raw: unknown): MemorySearchParams {
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const query = typeof value.query === "string" ? value.query : "";
  const project = typeof value.project === "string" && value.project.trim().length > 0 ? value.project.trim() : null;
  const limit = typeof value.limit === "number" && Number.isInteger(value.limit) ? value.limit : DEFAULT_RESULT_LIMIT;
  const mode = value.mode === "timeline" ? "timeline" : value.mode === "related" ? "related" : "blocks";
  const block = typeof value.block === "string" && value.block.trim() ? value.block.trim() : null;
  const source = typeof value.source === "string" && value.source.trim() ? value.source.trim() : null;
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);
  return {
    query,
    project,
    limit,
    mode,
    block,
    source,
    from: int(value.from),
    to: int(value.to),
    windowMinutes: int(value.windowMinutes),
    reasons: value.reasons !== false,
    verbose: value.verbose === true,
  };
}

// ---------------------------------------------------------------------------
// Extension body
// ---------------------------------------------------------------------------

export default async function factory(pi: ExtensionAPI) {
  await loadSqlite();
  const paramsSchema = MEMORY_SEARCH_PARAMETERS;

  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager?.getSessionFile?.() ?? null;
    dbClosed = false; // a new session may reuse this extension instance after a shutdown
    const generation = ++sessionGeneration;
    logLine(
      cfg.debug
        ? `session_start file=${sessionFile || "(ephemeral)"} cwd=${ctx.cwd ?? ""}`
        : // Logs are what users paste into issues: without debug, keep names, not full paths.
          `session_start file=${sessionFile ? path.basename(sessionFile) : "(ephemeral)"} ` +
            `cwd=${ctx.cwd ? path.basename(ctx.cwd) : ""}`,
    );
    if (!cfg.scanOnStartup) {
      // Startup full scan disabled: force-scan only the current session so it is visible immediately;
      // agent_settled and the pre-search scan keep everything else fresh.
      scanCurrentSession(sessionFile, true, ctx.cwd).catch((e) =>
        logLine(`session_start scan error: ${withoutPaths(e.message)}`),
      );
      return;
    }
    // Background allow-list scan: async fs I/O never blocks the event loop, session_start returns
    // immediately (startup no longer waits); a final scanSources before each memory_search keeps
    // results consistent with the latest compressions.
    const run = scanSources()
      .then(async (r) => {
        if (generation !== sessionGeneration) return; // session was shut down/replaced meanwhile
        logLine(
          `initial scan: sources=${r.sources} files=${r.files} sidecarScanned=${r.scanned} newBlocks=${r.inserted} redacted=${r.redacted} ` +
            `totalBlocks=${r.total} failed=${r.failed}`,
        );
        await scanCurrentSession(sessionFile, true, ctx.cwd); // force-scan the current session so it is visible right away
        if (generation !== sessionGeneration) return;
        const st = getDb().stats();
        logLine(`db ready: ${path.basename(st.dbPath)} sources=${st.sources} blocks=${st.blocks}`);
      })
      .catch((e) => logLine(`session_start scan error: ${withoutPaths(e.stack || e.message)}`));
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
    // Remember which session this shutdown belongs to: if a new session_start lands while the grace
    // period (or the final scan) is still running, closing the store here would close and latch the
    // *new* session's store. The check below is synchronous with the latch, so no window remains.
    const shutdownGeneration = ++sessionGeneration; // invalidate in-flight background scan continuations
    const inflight = backgroundScan;
    if (inflight) {
      // Short grace period so we do not close the DB in the middle of a background transaction.
      let timer = null;
      await Promise.race([
        inflight.catch(() => undefined),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
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
      // A new session started while this shutdown was finishing: it owns the store now, leave it open.
      log(`session_shutdown: superseded by a new session; store left open`);
      return;
    }
    // Latch before closing: a continuation that resumes between the close and the latch could
    // otherwise reopen the store through MemoryDb.open().
    dbClosed = true;
    if (db) {
      db.close();
      db = null;
    }
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search pi's long-term memory store: block summaries produced by ACP compression from " +
      "allow-listed sources (pi billion-context-pi sidecars, opencode-acp state files, and billion-context sessions) across all " +
      "allowed projects. Modes: 'blocks' (default) relevance search; 'timeline' orders the same matches by " +
      "time and order (missing times stay blank, unplaceable blocks are reported separately); 'related' " +
      "finds blocks related to an anchor block or query hit (compression lineage, same run, neighbors, shared terms). " +
      "Use when the user asks about past work, conclusions, decisions, technical " +
      "pitfalls, code locations, project context, or content compressed earlier in this session. " +
      "Query with Chinese or English keywords / phrases; results are relevance-ranked and annotated " +
      "with source kind, project, file, block and time.",
    promptSnippet: "Search pi's accumulated memory of past sessions (ACP compression summaries across allowed sources)",
    promptGuidelines: [
      "Use memory_search when the user asks about past work, conclusions, decisions, or context from earlier sessions or from earlier in this session after compression.",
      "For Chinese queries shorter than 3 characters, memory_search falls back to substring matching automatically — still pass the query as-is.",
      "For a chronological view of a topic use mode 'timeline' (optionally with a 'block' anchor and windowMinutes); for 'what is related to this block' use mode 'related' with 'block'.",
    ],
    parameters: paramsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        // Light allow-list scan (mtime watermark) before every search so latest compressions are included
        await scanSources();
        const p = readMemorySearchParams(params);
        const db = getDb();
        if (p.mode === "timeline") {
          const res = db.timeline(p.query, {
            project: p.project,
            limit: p.limit,
            block: p.block,
            source: p.source,
            from: p.from,
            to: p.to,
            windowMinutes: p.windowMinutes,
            verbose: p.verbose,
          });
          return {
            content: [{ type: "text", text: formatTimeline(res) }],
            details: {
              mode: "timeline",
              hits: res.rows.length,
              unknown: res.unknown,
              dbPath: path.basename(cfg.dbPath),
            },
          };
        }
        if (p.mode === "related") {
          const res = db.related(p.query, {
            project: p.project,
            limit: p.limit,
            block: p.block,
            source: p.source,
          });
          return {
            content: [{ type: "text", text: formatRelated(res) }],
            details: { mode: "related", hits: res.rows.length, dbPath: path.basename(cfg.dbPath) },
          };
        }
        const res = db.search(p.query, { project: p.project, limit: p.limit });
        const text = formatResults(res);
        return {
          content: [{ type: "text", text }],
          details: { mode: res.mode, hits: res.rows.length, dbPath: path.basename(cfg.dbPath) },
        };
      } catch (e) {
        logLine(`memory_search error: ${withoutPaths(e.stack || e.message)}`);
        return {
          content: [
            {
              type: "text",
              text: `memory_search failed: ${withoutPaths(e.message) || "unknown error"} (the extension log has the full trace)`,
            },
          ],
          details: { mode: "error", hits: 0, dbPath: path.basename(cfg.dbPath) },
        };
      }
    },
  });

  if (cfg.expandEnabled) {
    pi.registerTool({
      name: "memory_expand",
      label: "Memory Expand",
      description:
        "Recover the original session messages absorbed by one stored compression block — the " +
        "inverse of memory_search. Only registered when expandEnabled is true in " +
        "~/.pi/pi-billion-memory.json. Default mode 'list' returns just a manifest (ref, role, size); " +
        "call again with mode 'full' and an explicit 'select' to read text. Expansion is deliberately " +
        "two-step and bounded, because it spends the context that compression saved. Returned text " +
        "passes through the same secret redaction as ingestion, and nothing is written to the store.",
      promptSnippet: "Expand one memory block back to its original messages (opt-in; list before full)",
      promptGuidelines: [
        "Use mode 'list' first: it is cheap and shows which messages a block absorbed, with role and size.",
        "Request mode 'full' with a narrow 'select' only when the exact original wording matters.",
        "memory_expand reads raw conversation lines from the session file; it only resolves references already recorded in a stored block.",
      ],
      parameters: MEMORY_EXPAND_PARAMETERS,
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        try {
          const p = readMemoryExpandParams(params);
          if (!p.block) {
            return {
              content: [{ type: "text", text: "memory_expand: 'block' is required (e.g. block: \"b1\")." }],
              details: { mode: "error", hits: 0 },
            };
          }
          const db = getDb();
          const rows = db.findBlocks(p.block, p.source);
          // Rows are paged (findBlocks defaults to 10); count separately so the report is honest.
          const total = rows.length ? db.countBlocks(p.block, p.source) : 0;
          if (rows.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `memory_expand: no stored block '${p.block}'` +
                    `${p.source ? ` matching source '${p.source}'` : ""}. ` +
                    "Run memory_search first and pass the block id from a result.",
                },
              ],
              details: { mode: "missing", hits: 0 },
            };
          }
          if (rows.length > 1) {
            const list = rows
              .map(
                (r) =>
                  `- ${r.blockId} · project ${r.project || "?"} · ${fmtTs(r.createdAt) || "time unknown"}` +
                  ` · ${path.basename(r.sourceFile)}`,
              )
              .join("\n");
            return {
              content: [
                {
                  type: "text",
                  text: `memory_expand: ${total} block(s) share the id '${p.block}' (showing the newest ${rows.length}). Add 'source' to pick one:\n${list}`,
                },
              ],
              details: { mode: "ambiguous", hits: total },
            };
          }
          const row = rows[0];
          if (row.kind === "bili") {
            // billion-context keeps each block's originals in its own envelope, so expansion never
            // touches the host session log for these sources.
            const res = await expandStoredBlock({
              file: row.sourceFile,
              blockId: row.blockId,
              mode: p.mode,
              select: p.select,
              maxChars: Math.min(cfg.expandMaxChars, p.chars ?? cfg.expandMaxChars),
              maxMessages: Math.min(cfg.expandMaxMessages, p.limit ?? cfg.expandMaxMessages),
              maxReadBytes: cfg.expandMaxReadBytes,
              redact: redactSecrets,
            });
            log(
              `expand ${row.blockId} stored mode=${p.mode} entries=${res.entries.length} returned=${res.returnedChars}`,
            );
            return {
              content: [{ type: "text", text: formatExpansion(row, row.sourceFile, res, p.mode) }],
              details: {
                mode: p.mode,
                block: row.blockId,
                entries: res.entries.length,
                found: res.entries.filter((e) => e.found).length,
                chars: res.returnedChars,
                truncated: res.truncated,
                source: "block-contents",
              },
            };
          }
          if (!String(row.sourceFile).endsWith(".acp.json")) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `memory_expand: block ${row.blockId} comes from ${sourceLabel(row)}, not a pi ACP sidecar. ` +
                    "Expansion is currently supported only for pi sidecars.",
                },
              ],
              details: { mode: "unsupported", hits: 1 },
            };
          }
          const msgIds = parseMsgIds(row.msgIds);
          if (msgIds.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `memory_expand: block ${row.blockId} has no recorded message references, so it cannot be expanded. ` +
                    "This happens for rows ingested before 0.5.0. Run /memory rescan to backfill the pointers from the sidecar.",
                },
              ],
              details: { mode: "no-refs", hits: 1 },
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
            redact: redactSecrets,
          });
          log(
            `expand ${row.blockId} mode=${p.mode} refs=${msgIds.length} found=${res.entries.filter((e) => e.found).length} returned=${res.returnedChars}`,
          );
          return {
            content: [{ type: "text", text: formatExpansion(row, sessionFile, res, p.mode) }],
            details: {
              mode: p.mode,
              block: row.blockId,
              refs: msgIds.length,
              found: res.entries.filter((e) => e.found).length,
              chars: res.returnedChars,
              truncated: res.truncated,
            },
          };
        } catch (e) {
          logLine(`memory_expand error: ${withoutPaths(e.stack || e.message)}`);
          return {
            content: [
              {
                type: "text",
                text: `memory_expand failed: ${withoutPaths(e.message) || "unknown error"} (the extension log has the full trace)`,
              },
            ],
            details: { mode: "error", hits: 0 },
          };
        }
      },
    });
  }

  pi.registerCommand("memory", {
    description:
      "pi-billion-memory: /memory (status), rescan (force rescan), sources (show allow-list), prune <days> (delete blocks older than N days)",
    handler: async (args, ctx) => {
      try {
        const want = String(args || "").trim();
        if (want === "rescan") {
          const r = await scanSources(true);
          const msg = `Force rescan done: sources=${r.sources} files=${r.files} parsed=${r.scanned} newBlocks=${r.inserted} redacted=${r.redacted} failed=${r.failed}`;
          ctx.ui?.notify?.(msg, "info");
          return;
        }
        if (want === "sources") {
          const sources = await loadSources();
          const lines = sources
            .filter((s) => s.enabled)
            .map((s) => `- [${s.id}] adapter=${s.adapter} root=${s.root} pattern=${s.pattern}`);
          const msg = lines.length
            ? `Allow-listed sources (${lines.length}):\n${lines.join("\n")}\n\nEdit ${cfg.sourcesPath || DEFAULT_CFG.sourcesPath} and run /memory rescan.`
            : `No allow-listed sources enabled. Edit ${cfg.sourcesPath || DEFAULT_CFG.sourcesPath} and run /memory rescan.`;
          ctx.ui?.notify?.(msg, "info");
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
          const msg = `Prune done: removed ${p.removedBlocks} block(s) / ${p.removedSources} empty source(s), ${p.remainingBlocks} remain (kept ${keepDays} day(s))`;
          ctx.ui?.notify?.(msg, "info");
          return;
        }
        const st = getDb().stats();
        const msg =
          `Memory store: ${st.sources} sources / ${st.sources_with_blocks} with compressed blocks / ` +
          `${st.blocks} blocks / ${fmtTokens(st.tokens)} tok compressed total\nDB: ${st.dbPath}\n` +
          `Log: ${cfg.logPath || DEFAULT_CFG.logPath}`;
        ctx.ui?.notify?.(msg, "info");
      } catch (e) {
        logLine(`/memory error: ${withoutPaths(e.stack || e.message)}`);
      }
    },
  });

  return {};
}

// ---------------------------------------------------------------------------
// Test helpers. The pi entry point (src/index.ts) does not import these.
// ---------------------------------------------------------------------------

/** @internal */
export function configureForTests(over: Record<string, unknown>): void {
  cfg = { ...cfg, ...sanitizeCfg(over) };
  syncLogPath();
  piMapCache = null;
  piMapInFlight = null;
  // Reset the connection state too, so one test cannot inherit the previous test's store (until
  // now that isolation came from every test file owning its own process).
  if (db) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    db = null;
  }
  backgroundScan = null;
  dbClosed = false;
  sessionGeneration++;
}

/** @internal */
export function resetPiHeaderReadCount(): void {
  piHeaderReadCount = 0;
}

/** @internal */
export function getPiHeaderReadCount(): number {
  return piHeaderReadCount;
}
