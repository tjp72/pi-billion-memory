import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// pi-billion-memory - MIT License

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
  logPath: path.join(PI_DIR, "pi-billion-memory.log")
};
var MAX_TOPIC_CHARS = 200;
var PREVIEW_CHARS = 600;
var DEFAULT_RESULT_LIMIT = 6;
var MAX_RESULT_LIMIT = 20;
var LOG_MAX_BYTES = 1e6;
var TRIGRAM_MIN_LEN = 3;
var PI_MAP_TTL_MS = 10 * 60 * 1e3;
var SESSION_HEADER_MAX_BYTES = 1e6;
function sanitizeCfg(over) {
  const out = {};
  if (!over || typeof over !== "object") return out;
  if (typeof over.dbPath === "string" && over.dbPath) out.dbPath = over.dbPath;
  if (typeof over.maxSummaryChars === "number" && Number.isFinite(over.maxSummaryChars) && over.maxSummaryChars > 0) {
    out.maxSummaryChars = Math.floor(over.maxSummaryChars);
  }
  if (typeof over.debug === "boolean") out.debug = over.debug;
  if (Array.isArray(over.excludeDirs)) out.excludeDirs = over.excludeDirs.filter((x) => typeof x === "string");
  if (typeof over.scanOnStartup === "boolean") out.scanOnStartup = over.scanOnStartup;
  if (typeof over.sourcesPath === "string" && over.sourcesPath) out.sourcesPath = over.sourcesPath;
  if (typeof over.logPath === "string" && over.logPath) out.logPath = over.logPath;
  return out;
}
var cfg = { ...DEFAULT_CFG };
try {
  if (fs.existsSync(CFG_PATH)) {
    cfg = { ...DEFAULT_CFG, ...sanitizeCfg(JSON.parse(fs.readFileSync(CFG_PATH, "utf8"))) };
  }
} catch (e) {
  logLine(`config load failed: ${e.message}`);
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
    logLine(`node:sqlite unavailable (need node>=22.19): ${e.message}`);
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
function sanitizeSource(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" ? raw.id : null;
  const adapter = typeof raw.adapter === "string" ? raw.adapter : null;
  const root = typeof raw.root === "string" ? expandHome(raw.root) : null;
  const pattern = typeof raw.pattern === "string" ? raw.pattern : null;
  if (!id || !adapter || !root || !pattern) return null;
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
    logLine(`sources read failed (fail-closed, no sources): ${e.message}`);
    return [];
  }
  const list = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    try {
      const s = sanitizeSource(JSON.parse(line));
      if (s) list.push(s);
    } catch (e) {
      logLine(`sources line ignored: ${e.message}`);
    }
  }
  return list;
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function fileMatches(pattern, name) {
  const re = new RegExp("^" + pattern.split("*").map(escapeRegExp).join(".*") + "$");
  return re.test(name);
}
async function walkFiles(dir, filePattern) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...await walkFiles(full, filePattern));
    } else if (ent.isFile() && fileMatches(filePattern, ent.name)) {
      out.push(full);
    }
  }
  return out;
}
async function listSourceFiles(source) {
  const root = source.root;
  try {
    await fs.promises.access(root);
  } catch {
    return [];
  }
  const parts = source.pattern.split(/[\\/]/).filter(Boolean);
  const filePattern = parts[parts.length - 1] || source.pattern;
  const recursive = parts.length > 1 || parts[0] === "**";
  if (!recursive) {
    const names = await fs.promises.readdir(root);
    return names.filter((n) => fileMatches(filePattern, n)).map((n) => path.join(root, n));
  }
  return walkFiles(root, filePattern);
}
function cleanOpencodeSummary(summary) {
  return String(summary).replace(/\s*<dcp-message-id>.*?<\/dcp-message-id>\s*$/s, "").trim();
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
  /**
   * @param {string} dbPath
   */
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }
  open() {
    if (this.db) return;
    if (!DatabaseSyncCtor) throw new Error("node:sqlite unavailable");
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSyncCtor(this.dbPath);
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
    this.db.exec(`
      INSERT OR IGNORE INTO source_watermarks(source_file, last_mtime_ms, last_size, updated_at)
      SELECT source_file, last_mtime_ms, last_size, updated_at
      FROM sources
      WHERE last_mtime_ms IS NOT NULL AND last_size IS NOT NULL;
    `);
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
    const now = Date.now();
    let inserted = 0;
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
           (source_file, kind, block_id, run_id, tier, topic, summary, ref_start, ref_end, compressed_tokens, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM block_tombstones WHERE source_file = ? AND block_id = ?)`
      );
      for (const b of blocks) {
        if (!b || typeof b.summary !== "string") continue;
        const redactedSummary = redactSecrets(b.summary);
        const redactedTopic = typeof b.topic === "string" && b.topic ? redactSecrets(b.topic) : { text: null, hits: 0 };
        redactedHits += redactedSummary.hits + redactedTopic.hits;
        const summary = redactedSummary.text.length > cfg.maxSummaryChars ? redactedSummary.text.slice(0, cfg.maxSummaryChars) : redactedSummary.text;
        if (!summary.trim()) continue;
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
          sourceFile,
          b.blockId
        );
        if (r.changes > 0) inserted++;
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
    return { ok: true, parsed: true, total: blocks.length, inserted, redacted: redactedHits, mtimeMs, size };
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
      logLine(`search error: ${e.message} | sql=${built.sql}`);
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
    this.db.prepare(
      `INSERT OR IGNORE INTO block_tombstones(source_file, block_id, pruned_at)
         SELECT source_file, block_id, ? FROM blocks
         WHERE created_at IS NOT NULL AND created_at < ?`
    ).run(now, cutoff);
    this.db.prepare("DELETE FROM blocks WHERE created_at IS NOT NULL AND created_at < ?").run(cutoff);
    const rs = this.db.prepare(
      "DELETE FROM sources WHERE NOT EXISTS (SELECT 1 FROM blocks b WHERE b.source_file = sources.source_file)"
    ).run();
    this.db.exec("VACUUM");
    const remain = this.db.prepare("SELECT count(*) AS c FROM blocks").get().c;
    return {
      removedBlocks: before - remain,
      removedSources: rs.changes,
      removedSessions: rs.changes,
      remainingBlocks: remain
    };
  }
};
var db = null;
var sessionGeneration = 0;
var backgroundScan = null;
var piMapCache = null;
var piMapInFlight = null;
function getDb() {
  if (!db) db = new MemoryDb(cfg.dbPath);
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
    logLine(`opencode session map failed: ${e.message}`);
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
    enabledSources++;
    let files = await listSourceFiles(source);
    if (source.adapter === "pi-sidecar" && cfg.excludeDirs.length) {
      files = files.filter((f) => {
        const rel = path.relative(source.root, f);
        return !rel.split(path.sep).some((seg) => cfg.excludeDirs.includes(seg));
      });
    }
    fileCount += files.length;
    let opencodeMap = null;
    if (source.adapter === "opencode-acp" && files.length) {
      opencodeMap = await loadOpencodeSessionMap(source, files);
    }
    for (const file of files) {
      let meta;
      if (source.adapter === "pi-sidecar") {
        meta = { kind: "pi", cwd: null, project: null };
      } else if (source.adapter === "opencode-acp") {
        const info = opencodeMap?.get(file);
        meta = { kind: "opencode", cwd: info?.cwd ?? null, project: info?.project ?? null };
      } else {
        logLine(`unknown source adapter '${source.adapter}' for ${source.id}; skipped`);
        failed++;
        continue;
      }
      const r = await d.ingestSourceFile(file, meta, force, source.adapter === "pi-sidecar" ? resolvePiCwd : null);
      if (r.parsed) scanned++;
      if (!r.ok && r.error && r.error !== "no source file") {
        failed++;
        if (cfg.debug) log(`scan failed ${file}: ${r.error}`);
      }
      inserted += r.inserted;
      redacted += r.redacted || 0;
      total += r.total;
    }
  }
  return { scanned, inserted, redacted, total, failed, files: fileCount, sources: enabledSources };
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
    const generation = ++sessionGeneration;
    logLine(`session_start file=${sessionFile || "(ephemeral)"} cwd=${ctx.cwd ?? ""}`);
    if (!cfg.scanOnStartup) {
      scanCurrentSession(sessionFile, true, ctx.cwd).catch((e) => logLine(`session_start scan error: ${e.message}`));
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
      logLine(`db ready: ${st.dbPath} sources=${st.sources} blocks=${st.blocks}`);
    }).catch((e) => logLine(`session_start scan error: ${e.stack || e.message}`));
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
    sessionGeneration++;
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
          details: { mode: res.mode, hits: res.rows.length, dbPath: cfg.dbPath }
        };
      } catch (e) {
        logLine(`memory_search error: ${e.stack || e.message}`);
        return {
          content: [
            {
              type: "text",
              text: `memory_search failed: ${e.message} (see ${cfg.logPath || DEFAULT_CFG.logPath})`
            }
          ],
          details: { mode: "error", hits: 0, dbPath: cfg.dbPath }
        };
      }
    }
  });
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
        logLine(`/memory error: ${e.stack || e.message}`);
      }
    }
  });
  return {};
}

export { factory as default };
