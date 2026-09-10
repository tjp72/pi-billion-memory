// Self-test for pi-billion-memory.
//
// Runs against a temp directory and exercises the extension internals: ingestion,
// watermarks, FTS5 trigram vs LIKE fallback (including Chinese), AND semantics,
// truncation, project filtering, multi-tier hits, durable prune, close/reopen,
// and allow-list scanning over pi + opencode sources.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import factory, { internals } from "../src/internals.ts";

const failures = [];
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures.push(name);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-billion-memory-"));
const dbPath = path.join(tmp, "test.db");
const logPath = path.join(tmp, "test.log");
const sourcesPath = path.join(tmp, "sources.jsonl");
internals._setConfig({ dbPath, logPath, maxSummaryChars: 500, debug: true, sourcesPath });

const T1 = Date.now() - 2 * 24 * 60 * 60 * 1000;
const T2 = Date.now() - 1 * 24 * 60 * 60 * 1000;

// Fixture sessions. Directories mimic pi's encoded-cwd session dirs
// (e.g. "--home-dev-Proj--" style names under ~/.pi/agent/sessions/); the real
// project name is derived from the cwd passed at ingest time.
const sess1 = path.join(tmp, "--home-dev-ProjA--", "2024-01-01T00-00-00-000Z_aaa.jsonl");
const sess2 = path.join(tmp, "--home-dev-ProjB--", "2024-01-02T00-00-00-000Z_bbb.jsonl");
const sess3 = path.join(tmp, "--home-dev-ProjOld--", "2020-01-01T00-00-00-000Z_old.jsonl");
const cwd1 = "/home/dev/ProjA"; // project = basename(cwd) = "ProjA"
const cwd2 = "/home/dev/ProjB";
const cwd3 = "/home/dev/ProjOld";

function mkSidecar(blocks) {
  return {
    blocks,
    messageRefs: { byRaw: {}, byRef: {} },
    tokenSnapshot: { used: 0, capacity: 1000 },
    nudge: null,
    stats: { tokensCompressed: 0, compressionCount: blocks.length, absorbedTokens: 0 },
    absorbed: [],
    nextBlockId: `b${blocks.length + 1}`,
    nextRunId: "rX",
    liveRefOrigins: {},
  };
}

function writeSidecar(sessionFile, blocks) {
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile + ".acp.json", JSON.stringify(mkSidecar(blocks)));
}

// Block b1: long summary (> maxSummaryChars 500) — "headmarker9x" stays inside
// the kept prefix, "tailmarker2024" sits beyond the cut and must vanish.
const pad = "X".repeat(600);
const b1 = {
  blockId: "b1",
  runId: "r1",
  tier: 1,
  topic: "中文分词方案",
  summary: `headmarker9x 记忆插件 中文分词方案：FTS5 trigram 对中文与代码标识符原生建索引，不依赖分词器。${pad} 收尾 tailmarker2024`,
  compressedTokens: 12345,
  createdAt: T1,
  startRef: "m00002",
  endRef: "m00047",
  active: true,
};
const b2 = {
  blockId: "b2",
  runId: "r1",
  tier: 2,
  topic: "API 调研",
  summary: "API 调研：typebox 参数 schema 与 registerTool 注册路径；退化分支用原生 JSON Schema 兜底。",
  compressedTokens: 9876,
  createdAt: T1 + 1000,
  startRef: "m00003",
  endRef: "m00040",
};
const b3 = {
  blockId: "b3",
  runId: "r1",
  tier: 1,
  topic: "踩坑记录",
  summary: "踩坑：sessions 目录名是编码后的 cwd（如 --home-dev-ProjA--），不要自己解码，用官方 API 获取会话列表。",
  compressedTokens: 500,
  createdAt: T1 + 2000,
  startRef: "m00005",
  endRef: "m00031",
};
const c1 = [b1, b2, b3];

await internals.loadSqlite();
const db = internals.getDb();
writeSidecar(sess1, c1);
writeSidecar(sess2, []);

// --- ingestion & watermark ------------------------------------------------
check("default export is a factory function", typeof factory === "function");

const r1 = await db.ingestSidecarFile(sess1, cwd1);
check("first ingest stores all 3 blocks", r1.ok && r1.parsed && r1.total === 3 && r1.inserted === 3);

const r1b = await db.ingestSidecarFile(sess1, cwd1);
check("watermark skips unchanged sidecar", r1b.ok && !r1b.parsed && r1b.inserted === 0);

const r2 = await db.ingestSidecarFile(sess2, cwd2);
check("empty-blocks session ingests cleanly", r2.ok && r2.parsed && r2.total === 0 && r2.inserted === 0);

const rNo = await db.ingestSidecarFile(sess3, cwd3);
check("missing sidecar reports error, no crash", !rNo.ok && rNo.error === "no source file");

// --- search: FTS5 trigram vs LIKE fallback --------------------------------
const q1 = db.search("记忆插件");
check("fts: 4-char Chinese query hits (trigram)", q1.mode === "fts" && q1.rows.length >= 1);

const q2 = db.search("记忆");
check("like: 2-char Chinese query falls back to substring", q2.mode === "like" && q2.rows.length >= 1);

const q3 = db.search("typebox registerTool");
check(
  "fts: English multi-word AND hits the API block",
  q3.mode === "fts" && q3.rows.length === 1 && q3.rows[0].topic === "API 调研",
);

const q4 = db.search("zzqqxxwwvv");
check("no hit returns zero rows", q4.mode !== "empty" && q4.rows.length === 0);

const q5 = db.search("踩坑", { project: "ProjB" });
check("project filter excludes other projects", q5.rows.length === 0);

const q6 = db.search("踩坑", { project: "ProjA" });
check("project filter narrows to one project", q6.rows.length >= 1 && q6.rows.every((r) => r.project === "ProjA"));

const qLikeAnd = db.search("踩坑 中文");
check("like: short multi-word query is AND-matched", qLikeAnd.mode === "like" && qLikeAnd.rows.length === 0);

// --- truncation -------------------------------------------------------------
const qT = db.search("tailmarker2024");
check("truncated tail is not searchable", qT.rows.length === 0);

const qH = db.search("headmarker9x");
check("truncated head stays searchable", qH.rows.length >= 1);

// --- misc options -------------------------------------------------------------
const qE = db.search("   ");
check("blank query returns nothing", qE.mode === "empty" && qE.rows.length === 0);

const qL = db.search("记忆", { limit: 1 });
check("limit caps the row count", qL.rows.length === 1);

const st1 = db.stats();
check(
  "stats: 2 sources, 3 blocks, summed tokens",
  st1.sources === 2 && st1.blocks === 3 && st1.tokens === 12345 + 9876 + 500,
);

const meta = qH.rows[0];
check(
  "row metadata is complete",
  meta.project === "ProjA" &&
    meta.tier === 1 &&
    meta.topic === "中文分词方案" &&
    meta.refStart === "m00002" &&
    meta.refEnd === "m00047" &&
    meta.tokens === 12345 &&
    meta.createdAt === T1,
);

// --- force rescan & multi-tier ----------------------------------------------
const b4 = {
  blockId: "b4",
  runId: "r1",
  tier: 1,
  topic: "后续修复",
  summary: "后续修复：session 目录遍历 fallback 与编码目录名处理。",
  compressedTokens: 600,
  createdAt: T2,
  startRef: "m00041",
  endRef: "m00049",
};
c1.push(b4);
writeSidecar(sess1, c1);
const r3 = await db.ingestSidecarFile(sess1, cwd1, true);
check("force rescan picks up only the new block", r3.ok && r3.inserted === 1 && db.stats().blocks === 4);

// tier-3 parent block whose summary aggregates the tier-1 children
// (multi-tier compression: parent + children coexist in the store).
const b5 = {
  blockId: "b5",
  runId: "r2",
  tier: 3,
  topic: "记忆插件总收束",
  summary:
    "Source: b1+b2+b3 (48K→280 tok, 170x). [记忆插件工程] 总收束：踩坑与 API 调研结论聚合，父块保留蒸馏后要点，细节在各 tier1 子块。",
  compressedTokens: 400,
  createdAt: T2 + 8000,
  startRef: "m00050",
  endRef: "m00081",
};
c1.push(b5);
writeSidecar(sess1, c1);
const r4 = await db.ingestSidecarFile(sess1, cwd1, true);
check("tier-3 parent ingests alongside children", r4.ok && r4.inserted === 1 && db.stats().blocks === 5);

const qP = db.search("踩坑", { project: "ProjA" });
check("parent and child both match the same query", qP.rows.length === 2);

const qB5 = db.search("总收束");
check(
  "tier-3 metadata and Source header survive",
  qB5.rows.length === 1 &&
    qB5.rows[0].tier === 3 &&
    qB5.rows[0].topic === "记忆插件总收束" &&
    qB5.rows[0].summary.startsWith("Source: b1+b2+b3"),
);

const qSrc = db.search("Source:");
check(
  "Source header is searchable",
  qSrc.rows.some((r) => r.blockId === "b5"),
);

// --- legacy data & prune ------------------------------------------------------
const bOld = {
  blockId: "bOld",
  runId: "r0",
  tier: 1,
  topic: "老项目",
  summary: "ancientmarker 远古会话内容：早期项目遗留，无多级压缩。",
  compressedTokens: 800,
  createdAt: Date.parse("2020-06-01T00:00:00Z"),
  startRef: "m00001",
  endRef: "m00002",
};
writeSidecar(sess3, [bOld]);
const r5 = await db.ingestSidecarFile(sess3, cwd3);
check("legacy block with old createdAt is ingested", r5.ok && r5.inserted === 1 && db.stats().blocks === 6);

const pr = db.prune(30);
check("prune removes the old block only", pr.removedBlocks === 1 && pr.remainingBlocks === 5);
check("prune also drops sources left without blocks (empty ProjB + legacy ProjOld)", pr.removedSources === 2);

const qA = db.search("ancientmarker");
check("pruned content is gone", qA.rows.length === 0);

const st2 = db.stats();
check("stats after prune: 1 source, 5 blocks", st2.sources === 1 && st2.blocks === 5);

// --- robustness ---------------------------------------------------------------
db.close();
const st3 = internals.getDb().stats();
check("close and reopen serves stats", st3.sources === 1 && st3.blocks === 5);

const qW = db.search("   记忆插件   ");
check("query is trimmed before matching", qW.rows.length >= 1);

const r6 = await db.ingestSidecarFile(sess1, cwd1, true);
check("second force rescan is idempotent", r6.ok && r6.inserted === 0);

// --- allow-list scan: pi sidecar + opencode-acp -------------------------------
const whiteRoot = path.join(tmp, "white-root");
const whiteDir = path.join(whiteRoot, "--home-dev-WhiteProj--");
const whiteSession = path.join(whiteDir, "2024-02-01T00-00-00-000Z_white.jsonl");
writeSidecar(whiteSession, [
  {
    blockId: "b1",
    runId: "wr1",
    tier: 1,
    topic: "White topic",
    summary: "whiteMarker allow-list pi sidecar outside the pi sessions root.",
    compressedTokens: 10,
    createdAt: T2,
    startRef: "m00001",
    endRef: "m00002",
  },
]);

const outsideRoot = path.join(tmp, "outside-root");
const outsideDir = path.join(outsideRoot, "--home-dev-Outside--");
const outsideSession = path.join(outsideDir, "2024-02-02T00-00-00-000Z_outside.jsonl");
writeSidecar(outsideSession, [
  {
    blockId: "b1",
    runId: "or1",
    tier: 1,
    topic: "Outside topic",
    summary: "outsideMarker must never enter the store because its root is not allow-listed.",
    compressedTokens: 5,
    createdAt: T2,
    startRef: "m00001",
    endRef: "m00002",
  },
]);

const ocRoot = path.join(tmp, "oc-root");
fs.mkdirSync(ocRoot, { recursive: true });
const ocFile = path.join(ocRoot, "ses_abc123.json");
fs.writeFileSync(
  ocFile,
  JSON.stringify({
    prune: {
      messages: {
        blocksById: {
          "1": {
            blockId: 1,
            runId: 7,
            tier: 1,
            topic: "Opencode topic",
            summary: "opencodeMarker allow-listed opencode-acp block.<dcp-message-id>b1</dcp-message-id>",
            compressedTokens: 321,
            createdAt: T2,
            startId: "m00100",
            endId: "m00130",
            active: true,
          },
        },
      },
    },
    stats: {},
  }),
);
const ocDbPath = path.join(ocRoot, "opencode.db");
const ocDb = new DatabaseSync(ocDbPath);
ocDb.exec("CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT, path TEXT, project_id TEXT)");
ocDb.prepare("INSERT INTO session VALUES (?, ?, ?, ?)").run("ses_abc123", "/home/dev/OpenProj", null, null);
ocDb.close();

fs.writeFileSync(
  sourcesPath,
  [
    JSON.stringify({
      id: "pi-white",
      adapter: "pi-sidecar",
      root: whiteRoot,
      pattern: "**/*.jsonl.acp.json",
      enabled: true,
    }),
    JSON.stringify({
      id: "oc",
      adapter: "opencode-acp",
      root: ocRoot,
      pattern: "ses_*.json",
      enabled: true,
      opencodeDb: ocDbPath,
    }),
    "",
  ].join("\n"),
);

const qOutBefore = db.search("outsideMarker");
check("outside-root file is absent before scan", qOutBefore.rows.length === 0);

const scanR = await internals.scanSources(false);
check("scanSources only scans allow-listed roots", scanR.files === 2 && scanR.scanned === 2 && scanR.sources === 2);

const st4 = db.stats();
check("allow-list scan adds pi + opencode sources", st4.sources === 3 && st4.blocks === 7);

const qWhite = db.search("whiteMarker");
check(
  "allow-listed pi sidecar is ingested",
  qWhite.rows.length === 1 && qWhite.rows[0].kind === "pi" && qWhite.rows[0].project === "--home-dev-WhiteProj--",
);

const qOc = db.search("opencodeMarker");
check(
  "opencode-acp state is ingested via adapter",
  qOc.rows.length === 1 &&
    qOc.rows[0].kind === "opencode" &&
    qOc.rows[0].project === "OpenProj" &&
    qOc.rows[0].blockId === "1" &&
    qOc.rows[0].refStart === "m00100" &&
    qOc.rows[0].refEnd === "m00130" &&
    qOc.rows[0].tier === 1,
);
check(
  "dcp-message-id tail is stripped from opencode summary",
  !qOc.rows[0].summary.includes("dcp-message-id") && qOc.rows[0].summary.includes("opencodeMarker"),
);
check("source label formatting includes kind", internals.formatResults(qOc).includes("[opencode]"));

const qOutside = db.search("outsideMarker");
check("files outside the allow-list are never ingested", qOutside.rows.length === 0);

// --- Durable prune: tombstones + watermark ledger ---------------------------------
const pruneDb = new internals.MemoryDb(path.join(tmp, "prune.db"));
const pruneSess = path.join(tmp, "--home-dev-Prune--", "prune.jsonl");
fs.mkdirSync(path.dirname(pruneSess), { recursive: true });
const pruneOld = {
  blockId: "bOld",
  runId: "r0",
  tier: 1,
  topic: "prune old",
  summary: "pruneAncientMarker old block",
  compressedTokens: 10,
  createdAt: Date.parse("2020-06-01T00:00:00Z"),
  startRef: "m00001",
  endRef: "m00002",
};
const pruneNew = {
  blockId: "bNew",
  runId: "r0",
  tier: 1,
  topic: "prune new",
  summary: "pruneNewMarker new block",
  compressedTokens: 11,
  createdAt: T2,
  startRef: "m00003",
  endRef: "m00004",
};
const writePruneSidecar = (blocks) => fs.writeFileSync(pruneSess + ".acp.json", JSON.stringify(mkSidecar(blocks)));
writePruneSidecar([pruneOld]);
const pr1 = await pruneDb.ingestSidecarFile(pruneSess, "/home/dev/PruneProj");
check("durable prune: old block ingested", pr1.ok && pr1.parsed && pr1.inserted === 1);
const pr2 = pruneDb.prune(30);
check("durable prune: old block removed", pr2.removedBlocks === 1 && pruneDb.stats().blocks === 0);
check("durable prune: tombstone recorded", pruneDb.stats().tombstones === 1);
const pr3 = await pruneDb.ingestSidecarFile(pruneSess, "/home/dev/PruneProj");
check("durable prune: unchanged source is skipped after prune", pr3.ok && !pr3.parsed && pruneDb.stats().blocks === 0);
writePruneSidecar([pruneOld, pruneNew]);
const pr4 = await pruneDb.ingestSidecarFile(pruneSess, "/home/dev/PruneProj");
check(
  "durable prune: later file change cannot resurrect pruned blocks",
  pr4.ok &&
    pr4.parsed &&
    pr4.inserted === 1 &&
    pruneDb.stats().blocks === 1 &&
    pruneDb.search("pruneAncientMarker").rows.length === 0 &&
    pruneDb.search("pruneNewMarker").rows.length === 1,
);
const pr5 = await pruneDb.ingestSidecarFile(pruneSess, "/home/dev/PruneProj", true);
check(
  "durable prune: force rescan still skips tombstones",
  pr5.ok && pr5.parsed && pr5.inserted === 0 && pruneDb.stats().blocks === 1,
);
pruneDb.close();

// --- Migration: backfill the watermark ledger from an older sources table -----------
const migPath = path.join(tmp, "migration.db");
const migRaw = new DatabaseSync(migPath);
migRaw.exec(`
  CREATE TABLE sources(
    source_file TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'pi', project TEXT NOT NULL, cwd TEXT,
    last_mtime_ms INTEGER DEFAULT 0, last_size INTEGER DEFAULT 0, first_seen_at INTEGER, updated_at INTEGER
  );
  INSERT INTO sources(source_file, kind, project, cwd, last_mtime_ms, last_size, first_seen_at, updated_at)
  VALUES ('/home/dev/ProjX/session.jsonl.acp.json', 'pi', 'ProjX', '/home/dev/ProjX', 123, 456, 1, 1);
`);
migRaw.close();
const migDb = new internals.MemoryDb(migPath);
migDb.open();
const migRow = migDb.db
  .prepare("SELECT last_mtime_ms, last_size FROM source_watermarks WHERE source_file = ?")
  .get("/home/dev/ProjX/session.jsonl.acp.json");
check(
  "migration backfills the watermark ledger from sources",
  migRow && migRow.last_mtime_ms === 123 && migRow.last_size === 456,
);
migDb.close();

// --- Schema drift: unknown payload shape must not advance the watermark ------------
const driftDb = new internals.MemoryDb(path.join(tmp, "drift.db"));
const driftSess = path.join(tmp, "--home-dev-Drift--", "drift.jsonl");
fs.mkdirSync(path.dirname(driftSess), { recursive: true });
fs.writeFileSync(driftSess + ".acp.json", JSON.stringify({ messageRefs: {}, stats: {} }));
const dr1 = await driftDb.ingestSidecarFile(driftSess, "/home/dev/DriftProj");
const dr2 = await driftDb.ingestSidecarFile(driftSess, "/home/dev/DriftProj");
check(
  "schema drift: missing blocks payload is rejected without advancing the watermark",
  !dr1.ok &&
    !dr1.parsed &&
    dr1.error === "unrecognized source format" &&
    !dr2.ok &&
    !dr2.parsed &&
    driftDb.stats().blocks === 0,
);
writeSidecar(driftSess, [
  {
    blockId: "b1",
    runId: "r1",
    tier: 1,
    topic: "drift recovered",
    summary: "driftRecoveredMarker",
    compressedTokens: 1,
    createdAt: T2,
    startRef: "m00001",
    endRef: "m00002",
  },
]);
const dr3 = await driftDb.ingestSidecarFile(driftSess, "/home/dev/DriftProj");
check(
  "schema drift: a later valid payload is ingested",
  dr3.ok && dr3.parsed && dr3.inserted === 1 && driftDb.stats().blocks === 1,
);
const ocDrift = path.join(tmp, "oc-drift.json");
fs.writeFileSync(ocDrift, JSON.stringify({ prune: {} }));
const od1 = await driftDb.ingestSourceFile(ocDrift, { kind: "opencode", project: "OcDrift" });
check("schema drift: opencode missing blocksById is rejected", !od1.ok && od1.error === "unrecognized source format");
driftDb.close();

// --- Short-query topic match, mixed mode, and the LIKE query plan -----------------
const topicSess = path.join(tmp, "--home-dev-Topic--", "topic.jsonl");
writeSidecar(topicSess, [
  {
    blockId: "b1",
    runId: "r1",
    tier: 1,
    topic: "短词only",
    summary: "long summary without the short term",
    compressedTokens: 1,
    createdAt: T2,
    startRef: "m00001",
    endRef: "m00002",
  },
]);
const rTopic = await db.ingestSidecarFile(topicSess, "/home/dev/TopicProj");
check("short-query topic fixture ingested", rTopic.ok && rTopic.inserted === 1);
const qTopic = db.search("短词");
check(
  "short query matches topic as well as summary",
  qTopic.mode === "like" && qTopic.rows.length === 1 && qTopic.rows[0].topic === "短词only",
);
const qMixed = db.search("记忆插件 中文");
check(
  "mixed query uses FTS + LIKE and hits",
  qMixed.mode === "mixed" && qMixed.rows.some((r) => r.topic === "中文分词方案"),
);
const qMixedMiss = db.search("短词 记忆插件");
check("mixed query keeps AND semantics across modes", qMixedMiss.mode === "mixed" && qMixedMiss.rows.length === 0);
const planLike = db
  .explainSearch("短词")
  .map((r) => r.detail)
  .join("\n");
check(
  "pure LIKE plan avoids blocks_fts and uses idx_blocks_created",
  !/blocks_fts/.test(planLike) && !/TEMP B-TREE/i.test(planLike) && /idx_blocks_created/.test(planLike),
);
const planMixed = db
  .explainSearch("记忆插件 中文")
  .map((r) => r.detail)
  .join("\n");
check("mixed plan uses the FTS index", /blocks_fts/.test(planMixed));

// --- Lazy pi cwd resolution: session header read only when (re)parsing ------------
const lazyRoot = path.join(tmp, "lazy-root");
const lazyDir = path.join(lazyRoot, "--home-dev-Lazy--");
const lazySession = path.join(lazyDir, "2024-03-01T00-00-00-000Z_lazy.jsonl");
fs.mkdirSync(lazyDir, { recursive: true });
const writeLazyHeader = (cwd) => {
  fs.writeFileSync(
    lazySession,
    JSON.stringify({ type: "session", version: 3, id: "lazy", timestamp: "2024-03-01T00:00:00Z", cwd }) +
      "\n" +
      "message body that the adapter must never read ".repeat(1000),
  );
};
writeLazyHeader("/home/dev/LazyA");
writeSidecar(lazySession, [
  {
    blockId: "b1",
    runId: "r1",
    tier: 1,
    topic: "lazy",
    summary: "lazyMarker first",
    compressedTokens: 1,
    createdAt: T2,
    startRef: "m00001",
    endRef: "m00002",
  },
]);
const lazySourcesPath = path.join(tmp, "lazy-sources.jsonl");
fs.writeFileSync(
  lazySourcesPath,
  JSON.stringify({ id: "lazy", adapter: "pi-sidecar", root: lazyRoot, pattern: "**/*.jsonl.acp.json", enabled: true }) +
    "\n",
);
internals._setConfig({ sourcesPath: lazySourcesPath });
internals._resetPiHeaderReadCount();
const l1 = await internals.scanSources(false);
const lazyRow1 = db.search("lazyMarker").rows[0];
check(
  "lazy cwd: new source resolves project from the session header",
  l1.scanned === 1 && lazyRow1 && lazyRow1.project === "LazyA" && internals._piHeaderReadCount() === 1,
);
internals._resetPiHeaderReadCount();
const l2 = await internals.scanSources(false);
check(
  "lazy cwd: unchanged source is skipped without reading the header",
  l2.scanned === 0 && internals._piHeaderReadCount() === 0 && db.search("lazyMarker").rows[0].project === "LazyA",
);
writeLazyHeader("/home/dev/LazyB");
internals._resetPiHeaderReadCount();
const l3 = await internals.scanSources(false);
check(
  "lazy cwd: header-only change is ignored on incremental scans",
  l3.scanned === 0 && internals._piHeaderReadCount() === 0 && db.search("lazyMarker").rows[0].project === "LazyA",
);
const l4 = await internals.scanSources(true);
check(
  "lazy cwd: force rescan refreshes the project from the header",
  l4.scanned === 1 && internals._piHeaderReadCount() === 1 && db.search("lazyMarker").rows[0].project === "LazyB",
);
const hdr = await internals.piSessionHeaderCwd(lazySession);
check("session header reader returns cwd and tolerates a huge message body", hdr === "/home/dev/LazyB");
const hdrMissing = await internals.piSessionHeaderCwd(path.join(tmp, "missing-session.jsonl"));
check("session header reader returns null for a missing file", hdrMissing === null);
const badHeader = path.join(tmp, "bad-header.jsonl");
fs.writeFileSync(badHeader, "not json\n");
const hdrBad = await internals.piSessionHeaderCwd(badHeader);
check("session header reader returns null for malformed JSON", hdrBad === null);

// --- Allow-list fail-closed -------------------------------------------------------
internals._setConfig({ sourcesPath: tmp }); // a directory -> read error, not ENOENT
const fcSources = await internals.loadSources();
check("allow-list read error is fail-closed (no sources)", Array.isArray(fcSources) && fcSources.length === 0);
internals._setConfig({ sourcesPath: path.join(tmp, "does-not-exist.jsonl") });
const defSources = await internals.loadSources();
check(
  "missing allow-list still falls back to built-in defaults",
  defSources.length === 2 && defSources.some((s) => s.id === "pi") && defSources.some((s) => s.id === "opencode"),
);
internals._setConfig({ sourcesPath: lazySourcesPath });

// --- robustness: close is idempotent ---------------------------------------------
db.close();
db.close();
check("double close is a no-op and getDb reopens", internals.getDb().stats().blocks > 0);

// --- secret redaction ------------------------------------------------------------
const fakeMarker = `Zq${"0".repeat(24)}`;
const fakeApiKey = ["sk", "FAKE", fakeMarker].join("-");
const fakeGithubToken = ["ghp", `FAKE${"0".repeat(24)}`].join("_");
const fakeJwtSegment = `eyJ${"0".repeat(16)}`;
const fakeJwt = [fakeJwtSegment, fakeJwtSegment, `FAKE${"0".repeat(20)}`].join(".");
const fakePem = ["-----BEGIN", "PRIVATE", "KEY-----", "FAKEPRIVATEKEYDATA", "-----END", "PRIVATE", "KEY-----"].join(
  " ",
);

const s1 = internals.redactSecrets(`api_key = "${fakeApiKey}" and benign marker`);
check(
  "redactSecrets redacts an API key assignment",
  s1.hits > 0 && !s1.text.includes(fakeApiKey) && s1.text.includes("[REDACTED]") && s1.text.includes("benign marker"),
);
const s2 = internals.redactSecrets("password: hunter2");
check(
  "redactSecrets redacts a password assignment",
  s2.hits > 0 && !s2.text.includes("hunter2") && s2.text.includes("[REDACTED]"),
);
const s3 = internals.redactSecrets(`token=${fakeGithubToken}`);
check("redactSecrets redacts a provider token", s3.hits > 0 && !s3.text.includes(fakeGithubToken));
const s4 = internals.redactSecrets(`Authorization: Bearer ${fakeJwt}`);
check("redactSecrets redacts a JWT / bearer header", s4.hits > 0 && !s4.text.includes(fakeJwt));
const s5 = internals.redactSecrets(fakePem);
check(
  "redactSecrets redacts a PEM private key",
  s5.hits > 0 && !s5.text.includes("FAKEPRIVATEKEYDATA") && s5.text.includes("[REDACTED_PRIVATE_KEY]"),
);
const benign = "token budget is 4096 tokens; max_tokens: 4096; passwordless auth is enabled";
const s6 = internals.redactSecrets(benign);
check("redactSecrets leaves benign token-budget text unchanged", s6.hits === 0 && s6.text === benign);
const s7 = internals.redactSecrets("密码：hunter2，令牌: abcdef123456");
check(
  "redactSecrets redacts Chinese credential labels",
  s7.hits > 0 && !s7.text.includes("hunter2") && !s7.text.includes("abcdef123456"),
);

const u1 = internals.redactSecrets("see https://example.com/path?q=1 for details");
check(
  "redactSecrets replaces a URL with a URL marker",
  u1.hits > 0 &&
    !u1.text.includes("https://example.com") &&
    u1.text.includes("[REDACTED_URL]") &&
    u1.text.includes("for details"),
);
const u2 = internals.redactSecrets("https://user:pass@example.com/private");
check(
  "redactSecrets removes URL credentials and the host",
  u2.hits > 0 &&
    !u2.text.includes("user:pass") &&
    !u2.text.includes("example.com") &&
    u2.text.includes("[REDACTED_URL]"),
);
const u3 = internals.redactSecrets("Visit www.example.com. Done");
check(
  "redactSecrets replaces a bare www host and keeps trailing punctuation",
  u3.hits > 0 && !u3.text.includes("www.example.com") && u3.text.includes("[REDACTED_URL]."),
);
const u4 = internals.redactSecrets("postgres://user:pass@db.internal/app");
check(
  "redactSecrets replaces database URLs",
  u4.hits > 0 && !u4.text.includes("db.internal") && u4.text.includes("[REDACTED_URL]"),
);
const u5 = internals.redactSecrets("HTTP is a protocol; https:// is not a complete URL");
check("redactSecrets leaves incomplete/benign protocol text unchanged", u5.hits === 0 && u5.text.includes("https://"));

const secretSource = path.join(tmp, "--home-dev-SecretProj--", "2024-01-03T00-00-00-000Z_secret.jsonl");
writeSidecar(secretSource, [
  {
    blockId: "b1",
    runId: "s1",
    tier: 1,
    topic: `secret topic ${fakeApiKey}`,
    summary: `benignMarker secret summary password=${fakeApiKey} see https://example.com/secretPath`,
    compressedTokens: 1,
    createdAt: T2,
    startRef: "m00001",
    endRef: "m00002",
  },
]);
const sdb = internals.getDb();
const sir = await sdb.ingestSourceFile(
  secretSource + ".acp.json",
  { kind: "pi", cwd: "/home/dev/SecretProj", project: "SecretProj" },
  true,
);
const srow = sdb.db
  .prepare("SELECT topic, summary FROM blocks WHERE source_file = ? AND block_id = ?")
  .get(secretSource + ".acp.json", "b1");
check(
  "ingestion redacts secrets before storing",
  sir.ok &&
    sir.redacted > 0 &&
    srow &&
    !String(srow.summary).includes(fakeApiKey) &&
    !String(srow.topic).includes(fakeApiKey) &&
    String(srow.summary).includes("[REDACTED]"),
);
check(
  "ingestion replaces URLs before storing",
  srow &&
    !String(srow.summary).includes("secretPath") &&
    !String(srow.summary).includes("example.com") &&
    String(srow.summary).includes("[REDACTED_URL]"),
);
check("redacted secret is not searchable", sdb.search(fakeMarker).rows.length === 0);
check("redacted URL path is not searchable", sdb.search("secretPath").rows.length === 0);
check("benign text around the redacted secret remains searchable", sdb.search("benignMarker").rows.length > 0);

// --- Optional block expansion: msg_ids pointers + memory_expand internals ---------
check(
  "splitMessageId splits a base id from its tool-call selector",
  JSON.stringify(internals.splitMessageId("4d17483d#call_00_abc")) ===
    JSON.stringify({ base: "4d17483d", callId: "call_00_abc" }) &&
    JSON.stringify(internals.splitMessageId("4d17483d")) === JSON.stringify({ base: "4d17483d", callId: null }) &&
    JSON.stringify(internals.splitMessageId("4d17483d#")) === JSON.stringify({ base: "4d17483d", callId: null }) &&
    JSON.stringify(internals.splitMessageId("#call_00_abc")) ===
      JSON.stringify({ base: "#call_00_abc", callId: null }) &&
    JSON.stringify(internals.splitMessageId(42)) === JSON.stringify({ base: "42", callId: null }),
);
check(
  "parseMsgIds tolerates malformed pointer payloads",
  JSON.stringify(internals.parseMsgIds('["a","b","a","  "]')) === JSON.stringify(["a", "b"]) &&
    JSON.stringify(internals.parseMsgIds('["a",7,null]')) === JSON.stringify(["a"]) &&
    JSON.stringify(internals.parseMsgIds(null)) === "[]" &&
    JSON.stringify(internals.parseMsgIds("")) === "[]" &&
    JSON.stringify(internals.parseMsgIds("not json")) === "[]" &&
    JSON.stringify(internals.parseMsgIds('{"a":1}')) === "[]",
);

const exRoot = path.join(tmp, "expand-root");
const exSession = path.join(exRoot, "--home-dev-ExpandProj--", "2024-03-03T00-00-00-000Z_expand.jsonl");
const exSidecar = `${exSession}.acp.json`;
fs.mkdirSync(path.dirname(exSession), { recursive: true });
// A realistic session file: one user message, one assistant message carrying two tool
// calls, one string-content message, plus non-message lines that must be ignored.
const exLines = [
  { type: "session", id: "sess-expand" },
  {
    type: "message",
    id: "aaa11111",
    message: { role: "user", content: [{ type: "text", text: "expandAlphaMarker the original user wording" }] },
  },
  {
    type: "message",
    id: "bbb22222",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "expandBetaMarker assistant prose" },
        { type: "toolCall", id: "call_00_one", name: "read", arguments: { path: "src/a.ts" } },
        { type: "toolCall", id: "call_01_two", name: "grep", arguments: { pattern: "expandGammaMarker" } },
      ],
    },
  },
  {
    type: "message",
    id: "ccc33333",
    message: { role: "user", content: "expandStringMarker plain string content" },
  },
  { type: "model_change", id: "not-a-message" },
];
fs.writeFileSync(exSession, `${exLines.map((l) => JSON.stringify(l)).join("\n")}\n`);

// b1 records pointers via effectiveMessageIds (incl. a #call_ selector and a duplicate),
// b2 exercises the messageIds fallback key, and one pointer is intentionally dangling.
writeSidecar(exSession, [
  {
    blockId: "b1",
    runId: "r1",
    tier: 1,
    topic: "Expand pointers",
    summary: "expandDeltaMarker block carrying raw message pointers",
    compressedTokens: 4242,
    createdAt: T2,
    startRef: "m00001",
    endRef: "m00009",
    effectiveMessageIds: ["aaa11111", "bbb22222", "bbb22222#call_01_two", "ccc33333", "deadbeef", "aaa11111"],
  },
  {
    blockId: "b2",
    runId: "r1",
    tier: 1,
    topic: "Fallback pointers",
    summary: "expandEpsilonMarker block using the messageIds fallback key",
    compressedTokens: 99,
    createdAt: T2 + 1,
    startRef: "m00010",
    endRef: "m00011",
    messageIds: ["aaa11111"],
  },
]);

const exDb = new internals.MemoryDb(path.join(exRoot, "expand.db"));
const exIngest = await exDb.ingestSidecarFile(exSession, "/home/dev/ExpandProj");
check(
  "ingest stores pointers and never reads the session text",
  exIngest.ok && exIngest.parsed && exIngest.inserted === 2 && exIngest.refreshed === 0 && exIngest.redacted === 0,
);
const exRow = exDb.findBlocks("b1");
check(
  "findBlocks returns the stored pointer list with its metadata",
  exRow.length === 1 &&
    internals.parseMsgIds(exRow[0].msgIds).length === 5 &&
    exRow[0].project === "ExpandProj" &&
    exRow[0].tokens === 4242 &&
    exRow[0].sourceFile === exSidecar,
);
check("findBlocks reports an unknown block id as empty", exDb.findBlocks("b404").length === 0);
check(
  "findBlocks narrows candidates by source substring",
  exDb.findBlocks("b1", "no-such-source").length === 0 && exDb.findBlocks("b1", "ExpandProj").length === 1,
);
check("ingest falls back to the messageIds key", internals.parseMsgIds(exDb.findBlocks("b2")[0].msgIds).length === 1);
check(
  "countBlocks counts every duplicate row, not just the page findBlocks returns",
  exDb.countBlocks("b1") === 1 &&
    exDb.countBlocks("b1", "ExpandProj") === 1 &&
    exDb.countBlocks("b1", "no-such-source") === 0 &&
    exDb.countBlocks("b404") === 0,
);
check(
  "an explicitly empty effectiveMessageIds does not hide the messageIds fallback",
  JSON.stringify(internals.collectMsgIds({ effectiveMessageIds: [], messageIds: ["aaa11111"] })) === '["aaa11111"]' &&
    internals.collectMsgIds({ effectiveMessageIds: [], messageIds: [] }) === null &&
    internals.collectMsgIds({}) === null,
);

const exIds = internals.parseMsgIds(exRow[0].msgIds);
const exBudget = { maxChars: 40000, maxMessages: 200, maxReadBytes: 32 * 1024 * 1024 };

const exList = await internals.expandBlock({
  sessionFile: exSession,
  msgIds: exIds,
  mode: "list",
  select: null,
  ...exBudget,
  redact: null,
});
check(
  "list mode reports a manifest and returns no conversation text",
  exList.text === null &&
    exList.entries.length === 5 &&
    exList.entries[0].role === "user" &&
    exList.entries[1].role === "assistant" &&
    exList.entries[2].callId === "call_01_two" &&
    exList.entries[4].found === false &&
    exList.entries[4].chars === 0 &&
    exList.entries.filter((e) => e.found).length === 4 &&
    !exList.truncated &&
    exList.availableChars > 0,
);
const exFull = await internals.expandBlock({
  sessionFile: exSession,
  msgIds: exIds,
  mode: "full",
  select: [1],
  ...exBudget,
  redact: null,
});
check(
  "full mode renders only the selected reference",
  exFull.text.includes("expandAlphaMarker") &&
    !exFull.text.includes("expandBetaMarker") &&
    exFull.returnedChars > 0 &&
    !exFull.truncated,
);
check(
  "a narrow explicit selection is not reported as truncation",
  !exFull.truncated && exFull.skippedMessages === 0 && exFull.availableChars > exFull.returnedChars,
);
const exCall = await internals.expandBlock({
  sessionFile: exSession,
  msgIds: exIds,
  mode: "full",
  select: [3],
  ...exBudget,
  redact: null,
});
check(
  "a #call_ reference renders only that tool call, not the surrounding prose",
  exCall.text.includes("grep(") &&
    exCall.text.includes("expandGammaMarker") &&
    !exCall.text.includes("expandBetaMarker") &&
    !exCall.text.includes("src/a.ts"),
);
const exString = await internals.expandBlock({
  sessionFile: exSession,
  msgIds: exIds,
  mode: "full",
  select: [4],
  ...exBudget,
  redact: null,
});
check("plain string content is rendered", exString.text.includes("expandStringMarker"));
const exTrim = await internals.expandBlock({
  sessionFile: exSession,
  msgIds: exIds,
  mode: "full",
  select: [4],
  ...exBudget,
  maxChars: 60,
  redact: null,
});
check(
  "a trimmed entry is flagged as truncation and stays inside the char cap",
  exTrim.truncated &&
    exTrim.text.length <= 60 &&
    exTrim.returnedChars === exTrim.text.length &&
    exTrim.text.includes("[entry truncated at 60 chars]"),
);
const exTrunc = await internals.expandBlock({
  sessionFile: exSession,
  msgIds: exIds,
  mode: "full",
  select: [1],
  ...exBudget,
  maxChars: 1,
  redact: null,
});
check(
  "a tiny char budget never exceeds the cap and still flags truncation",
  exTrunc.truncated &&
    exTrunc.text.length <= 1 &&
    exTrunc.returnedChars === exTrunc.text.length &&
    exTrunc.skippedMessages === 0,
);
let exNoSelect = "";
try {
  await internals.expandBlock({
    sessionFile: exSession,
    msgIds: exIds,
    mode: "full",
    select: null,
    ...exBudget,
    redact: null,
  });
} catch (e) {
  exNoSelect = e.message;
}
check(
  "full mode refuses to render a whole block without an explicit selection",
  exNoSelect.includes("non-empty select"),
);
const exFew = await internals.expandBlock({
  sessionFile: exSession,
  msgIds: exIds,
  mode: "full",
  select: [1, 2, 3, 4],
  ...exBudget,
  maxMessages: 1,
  redact: null,
});
check(
  "maxMessages caps how many messages are rendered",
  exFew.text.includes("expandAlphaMarker") &&
    !exFew.text.includes("expandBetaMarker") &&
    exFew.skippedMessages === 3 &&
    exFew.truncated,
);
const exRedact = await internals.expandBlock({
  sessionFile: exSession,
  msgIds: exIds,
  mode: "full",
  select: [1],
  ...exBudget,
  redact: (s) => ({ text: s.replace(/expandAlphaMarker/g, "[REDACTED]"), hits: 1 }),
});
check(
  "the injected redactor is applied to expanded text",
  exRedact.text.includes("[REDACTED]") && !exRedact.text.includes("expandAlphaMarker"),
);

const exCapRead = await internals.readSessionMessages(exSession, 40);
check(
  "a byte-capped read reports truncation without corrupting messages",
  exCapRead.truncated && exCapRead.bytesRead === 40 && exCapRead.totalBytes > 40,
);
const exFullRead = await internals.readSessionMessages(exSession, 10 * 1024 * 1024);
check(
  "an uncapped read indexes message entries and skips other line types",
  !exFullRead.truncated && exFullRead.messages.size === 3 && !exFullRead.messages.has("not-a-message"),
);
check(
  "renderMessage returns null for a line without a message body",
  internals.renderMessage({ type: "message", id: "x" }, null) === null && internals.renderMessage(null, null) === null,
);
const exCapped = await internals.readCapped(exSession, 40);
check(
  "the physical read stops at the cap and still reports the real file size",
  exCapped.buffer.length === 40 && exCapped.totalBytes > 40,
);
let exSeamCap = -1;
const exSeamRead = await internals.readSessionMessages(exSession, 40, async (_file, maxBytes) => {
  exSeamCap = maxBytes;
  return internals.readCapped(exSession, maxBytes);
});
check(
  "the read seam is handed the byte cap, so no caller can slurp a whole session file",
  exSeamCap === 40 && exSeamRead.truncated && exSeamRead.bytesRead === 40 && exSeamRead.totalBytes > 40,
);
const exMissingRead = await internals.readSessionMessages(path.join(exRoot, "nope.jsonl"), 1000);
check(
  "a deleted session file degrades to missing refs instead of throwing",
  exMissingRead.missing === true && exMissingRead.messages.size === 0 && exMissingRead.totalBytes === 0,
);
const exMissingExpand = await internals.expandBlock({
  sessionFile: path.join(exRoot, "nope.jsonl"),
  msgIds: exIds,
  mode: "list",
  select: null,
  ...exBudget,
  redact: null,
});
check(
  "expansion over a deleted session reports every reference as missing",
  exMissingExpand.sessionMissing === true &&
    exMissingExpand.entries.every((e) => !e.found) &&
    exMissingExpand.text === null,
);
const exUnknown = await internals.renderMessage(
  { type: "message", id: "unknown1", message: { role: "assistant", content: [{ type: "brandNewThing", payload: 7 }] } },
  null,
);
check(
  "an unknown content type renders as an `other` placeholder, not as a missing reference",
  Boolean(exUnknown) &&
    exUnknown.items.length === 1 &&
    exUnknown.items[0].kind === "other" &&
    exUnknown.items[0].text.includes("brandNewThing"),
);
const exCustomLine = { type: "custom_message", id: "cm1", customType: "test-extension", content: "expandCustomMarker" };
const exCustomRendered = internals.renderMessage(exCustomLine, null);
check(
  "custom_message entries (extension-injected context) are expandable as user text",
  Boolean(exCustomRendered) &&
    exCustomRendered.role === "user" &&
    exCustomRendered.items.length === 1 &&
    exCustomRendered.items[0].text === "expandCustomMarker",
);
check(
  "a #call_ selector can never match a custom_message",
  internals.renderMessage(exCustomLine, "call_00_one") === null,
);
const exCustomFile = path.join(exRoot, "custom.jsonl");
fs.writeFileSync(exCustomFile, `${JSON.stringify(exCustomLine)}\n`);
const exCustomRead = await internals.readSessionMessages(exCustomFile, 1_000_000);
check(
  "readSessionMessages indexes custom_message lines alongside messages",
  exCustomRead.messages.size === 1 && exCustomRead.messages.has("cm1") && !exCustomRead.truncated,
);
const exCustomExpand = await internals.expandBlock({
  sessionFile: exCustomFile,
  msgIds: ["cm1", "acp_summary_7"],
  mode: "full",
  select: [1],
  ...exBudget,
  redact: null,
});
check(
  "a custom_message reference expands to its injected text, and synthetic refs are recognizable",
  exCustomExpand.text.includes("expandCustomMarker") &&
    !exCustomExpand.truncated &&
    internals.isSyntheticRef("acp_summary_7") &&
    !internals.isSyntheticRef("aaa11111"),
);

// Pointers must backfill onto rows that predate the column, and must not churn afterwards.
exDb.db.exec("UPDATE blocks SET msg_ids = NULL");
fs.utimesSync(exSidecar, new Date(T2), new Date(T2));
const exRefresh = await exDb.ingestSidecarFile(exSession, "/home/dev/ExpandProj");
check(
  "re-ingest backfills pointers onto existing rows",
  exRefresh.ok && exRefresh.parsed && exRefresh.inserted === 0 && exRefresh.refreshed === 2,
);
fs.utimesSync(exSidecar, new Date(T2 + 1), new Date(T2 + 1));
const exNoop = await exDb.ingestSidecarFile(exSession, "/home/dev/ExpandProj");
check(
  "re-ingest leaves intact pointers untouched",
  exNoop.ok && exNoop.parsed && exNoop.inserted === 0 && exNoop.refreshed === 0,
);
// A sidecar that re-emits a block id without references must clear the stored pointers, otherwise
// expansion keeps returning messages the block no longer covers.
const exSidecarRaw = fs.readFileSync(exSidecar, "utf8");
const exSidecarData = JSON.parse(exSidecarRaw);
exSidecarData.blocks = exSidecarData.blocks.map((b) => (b.blockId === "b1" ? { ...b, effectiveMessageIds: [] } : b));
fs.writeFileSync(exSidecar, JSON.stringify(exSidecarData));
fs.utimesSync(exSidecar, new Date(T2 + 2), new Date(T2 + 2));
const exDrop = await exDb.ingestSidecarFile(exSession, "/home/dev/ExpandProj");
check(
  "a sidecar that drops references clears the stored pointers",
  exDrop.ok &&
    exDrop.parsed &&
    exDrop.refreshed === 1 &&
    internals.parseMsgIds(exDb.findBlocks("b1")[0].msgIds).length === 0,
);
fs.writeFileSync(exSidecar, exSidecarRaw);
fs.utimesSync(exSidecar, new Date(T2 + 1), new Date(T2 + 1));
check("pointers stay searchable but are not FTS-indexed", exDb.search("expandDeltaMarker").rows.length === 1);
exDb.close();

// --- Migration (0.4.x -> 0.5.0): add msg_ids and reset the ledger once ----------------
const ptrPath = path.join(tmp, "pointers.db");
const ptrRaw = new DatabaseSync(ptrPath);
ptrRaw.exec(`
  CREATE TABLE sources(
    source_file TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'pi', project TEXT NOT NULL, cwd TEXT,
    last_mtime_ms INTEGER DEFAULT 0, last_size INTEGER DEFAULT 0, first_seen_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE blocks(
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_file TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'pi',
    block_id TEXT NOT NULL, run_id TEXT, tier INTEGER, topic TEXT, summary TEXT NOT NULL,
    ref_start TEXT, ref_end TEXT, compressed_tokens INTEGER, created_at INTEGER,
    UNIQUE(source_file, block_id)
  );
  CREATE TABLE source_watermarks(
    source_file TEXT PRIMARY KEY, last_mtime_ms INTEGER NOT NULL DEFAULT 0,
    last_size INTEGER NOT NULL DEFAULT 0, updated_at INTEGER
  );
  INSERT INTO sources(source_file, kind, project, cwd, last_mtime_ms, last_size, first_seen_at, updated_at)
  VALUES ('${exSidecar}', 'pi', 'ExpandProj', '/home/dev/ExpandProj', 777, 888, 1, 1);
  INSERT INTO source_watermarks(source_file, last_mtime_ms, last_size, updated_at)
  VALUES ('${exSidecar}', 777, 888, 1);
  INSERT INTO blocks(source_file, kind, block_id, run_id, tier, topic, summary, compressed_tokens, created_at)
  VALUES ('${exSidecar}', 'pi', 'b1', 'r1', 1, 'legacy', 'legacyPointerMarker', 42, ${T1});
`);
ptrRaw.close();
const ptrDb = new internals.MemoryDb(ptrPath);
ptrDb.open();
check(
  "a pre-0.5.0 store gains the msg_ids column on open",
  ptrDb.db
    .prepare("PRAGMA table_info(blocks)")
    .all()
    .some((c) => c.name === "msg_ids"),
);
const ptrWm = ptrDb.db.prepare("SELECT last_mtime_ms, last_size FROM source_watermarks").all();
check(
  "the pointer migration resets the watermark ledger so rows backfill once",
  ptrWm.length === 1 && ptrWm[0].last_mtime_ms === 0 && ptrWm[0].last_size === 0,
);
const ptrIngest = await ptrDb.ingestSidecarFile(exSession, "/home/dev/ExpandProj");
check(
  "post-migration ingest backfills pointers into the legacy row",
  ptrIngest.ok &&
    ptrIngest.parsed &&
    ptrIngest.inserted === 1 &&
    ptrIngest.refreshed === 1 &&
    internals.parseMsgIds(ptrDb.findBlocks("b1", "ExpandProj")[0].msgIds).length === 5,
);
const ptrAgain = await ptrDb.ingestSidecarFile(exSession, "/home/dev/ExpandProj");
check("the pointer migration runs at most once", ptrAgain.ok && !ptrAgain.parsed);
ptrDb.close();

// A legacy store whose `sources` row has no watermark row yet: seeding the ledger before the
// pointer reset must not re-stamp the watermarks that reset is about to clear.
const orphanPath = path.join(tmp, "pointers-orphan.db");
const orphanRaw = new DatabaseSync(orphanPath);
orphanRaw.exec(`
  CREATE TABLE sources(
    source_file TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'pi', project TEXT NOT NULL, cwd TEXT,
    last_mtime_ms INTEGER DEFAULT 0, last_size INTEGER DEFAULT 0, first_seen_at INTEGER, updated_at INTEGER
  );
  CREATE TABLE blocks(
    id INTEGER PRIMARY KEY AUTOINCREMENT, source_file TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'pi',
    block_id TEXT NOT NULL, run_id TEXT, tier INTEGER, topic TEXT, summary TEXT NOT NULL,
    ref_start TEXT, ref_end TEXT, compressed_tokens INTEGER, created_at INTEGER,
    UNIQUE(source_file, block_id)
  );
  CREATE TABLE source_watermarks(
    source_file TEXT PRIMARY KEY, last_mtime_ms INTEGER NOT NULL DEFAULT 0,
    last_size INTEGER NOT NULL DEFAULT 0, updated_at INTEGER
  );
  INSERT INTO sources(source_file, kind, project, cwd, last_mtime_ms, last_size, first_seen_at, updated_at)
  VALUES ('${exSidecar}', 'pi', 'ExpandProj', '/home/dev/ExpandProj', 777, 888, 1, 1);
`);
orphanRaw.close();
const orphanDb = new internals.MemoryDb(orphanPath);
orphanDb.open();
const orphanWm = orphanDb.db.prepare("SELECT last_mtime_ms, last_size FROM source_watermarks").all();
check(
  "the pointer migration clears a freshly seeded watermark row",
  orphanWm.length === 1 && orphanWm[0].last_mtime_ms === 0 && orphanWm[0].last_size === 0,
);
const orphanIngest = await orphanDb.ingestSidecarFile(exSession, "/home/dev/ExpandProj");
check(
  "an orphaned source re-reads and backfills its pointers after migration",
  orphanIngest.ok &&
    orphanIngest.parsed &&
    internals.parseMsgIds(orphanDb.findBlocks("b1", "ExpandProj")[0].msgIds).length === 5,
);
orphanDb.close();

// Config paths accept `~`: a config copied from the README must not create a literal "~" directory.
const exHome = process.env.HOME || "";
const exCfgPaths = internals.sanitizeCfg({ dbPath: "~/a.db", sourcesPath: "~", logPath: "~/c.log" });
check(
  "~ in configured paths expands to the home directory instead of a literal '~' directory",
  exCfgPaths.dbPath === path.join(exHome, "a.db") &&
    exCfgPaths.sourcesPath === exHome &&
    exCfgPaths.logPath === path.join(exHome, "c.log") &&
    internals.sanitizeCfg({ dbPath: "relative/x.db" }).dbPath === "relative/x.db",
);
check(
  "an allow-list entry with an unknown adapter is rejected instead of silently scanned",
  internals.sanitizeSource({ id: "s1", adapter: "sessions", root: "/tmp", pattern: "*.jsonl" }) === null &&
    internals.sanitizeSource({ id: "s1", adapter: "pi-sidecar", root: "/tmp", pattern: "*.jsonl" })?.adapter ===
      "pi-sidecar",
);

// --- allow-list pattern scope, symlinks, listing errors ----------------------------------------
const globRoot = path.join(tmp, "glob-root");
fs.mkdirSync(path.join(globRoot, "sub"), { recursive: true });
fs.mkdirSync(path.join(globRoot, "other"), { recursive: true });
fs.writeFileSync(path.join(globRoot, "top.json"), "{}");
fs.writeFileSync(path.join(globRoot, "sub", "inside.json"), "{}");
fs.writeFileSync(path.join(globRoot, "other", "outside.json"), "{}");
const globSub = await internals.listSourceFiles({
  id: "g1",
  adapter: "pi-sidecar",
  root: globRoot,
  pattern: "sub/*.json",
});
check(
  "a directory prefix in an allow-list pattern narrows the scan instead of widening it",
  globSub.files.length === 1 &&
    globSub.files[0] === path.join(globRoot, "sub", "inside.json") &&
    globSub.errors.length === 0,
);
const globDeep = await internals.listSourceFiles({
  id: "g2",
  adapter: "pi-sidecar",
  root: globRoot,
  pattern: "**/*.json",
});
check(
  "** spans directories while * stays inside one segment",
  globDeep.files.length === 3 && globDeep.files.includes(path.join(globRoot, "sub", "inside.json")),
);
const globMissing = await internals.listSourceFiles({
  id: "g3",
  adapter: "pi-sidecar",
  root: path.join(tmp, "no-such-root"),
  pattern: "*.json",
});
check(
  "an unreadable or missing allow-list root is reported instead of looking like an empty source",
  globMissing.files.length === 0 && globMissing.errors.length === 1,
);
let symlinkCreated = false;
try {
  fs.symlinkSync(path.join(globRoot, "other", "outside.json"), path.join(globRoot, "sub", "linked.json"));
  symlinkCreated = true;
} catch {
  // Windows without developer mode cannot create symlinks; the check is skipped there.
}
if (symlinkCreated) {
  const globLink = await internals.listSourceFiles({
    id: "g4",
    adapter: "pi-sidecar",
    root: globRoot,
    pattern: "sub/*.json",
  });
  check(
    "a symlink inside the root does not pull in a file from outside the allow-list",
    globLink.files.length === 1 && globLink.files[0] === path.join(globRoot, "sub", "inside.json"),
  );
}
check(
  "withoutPaths covers drive, UNC, spaced and POSIX absolute paths",
  internals.withoutPaths("C:\\Users\\alice\\secret\\a.jsonl") === "<path>" &&
    internals.withoutPaths("C:/Users/alice/secret/a.jsonl") === "<path>" &&
    internals.withoutPaths("\\\\server\\share\\private\\a.jsonl") === "<path>" &&
    internals.withoutPaths("C:\\Program Files\\app\\a.log") === "<path>" &&
    internals.withoutPaths("/home/alice/My Docs/notes.txt") === "<path>",
);
check(
  "withoutPaths leaves URLs and plain messages alone",
  internals.withoutPaths("see https://example.com/a/b for details") === "see https://example.com/a/b for details" &&
    internals.withoutPaths("permission denied") === "permission denied",
);
check(
  "a first list of unusable entries does not shadow a valid second field",
  JSON.stringify(internals.collectMsgIds({ effectiveMessageIds: [null, "  "], messageIds: ["aaa11111"] })) ===
    '["aaa11111"]',
);
const exBadSelect = await internals.expandBlock({
  sessionFile: exSession,
  msgIds: exIds,
  mode: "full",
  select: [999],
  ...exBudget,
  redact: null,
});
check(
  "a selection that resolves to nothing reports truncation instead of a clean empty result",
  exBadSelect.text === "" && exBadSelect.truncated === true && exBadSelect.skippedMessages === 1,
);
const exGrowBuf = Buffer.from('{"type":"message","id":"m9"}\n');
const exGrow = await internals.readSessionMessages(exSession, 10 * 1024 * 1024, async () => ({
  buffer: exGrowBuf,
  totalBytes: exGrowBuf.length + 100,
}));
check(
  "a file that grows during the read is truncated without dropping the complete line",
  exGrow.truncated === true && exGrow.messages.has("m9"),
);
const exShrinkBuf = Buffer.from('{"type":"message","id":"m9"}');
const exShrink = await internals.readSessionMessages(exSession, 10, async () => ({
  buffer: exShrinkBuf,
  totalBytes: exShrinkBuf.length,
}));
check(
  "a file that shrank during the read is no longer reported as truncated",
  exShrink.truncated === false && exShrink.messages.has("m9"),
);
const exDenied = await internals.readSessionMessages(exSession, 100, async () => {
  const err = new Error("denied");
  (err as any).code = "EACCES";
  throw err;
});
check(
  "an unreadable session file degrades to missing instead of failing the tool call",
  exDenied.missing === true && exDenied.messages.size === 0,
);

// --- cleanup --------------------------------------------------------------------
db.close();
fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) {
  console.error(`\n${failures.length} check(s) FAILED:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
