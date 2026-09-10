# AGENTS.md — working rules for pi-billion-memory

Independent long-term memory extension for the pi coding agent. It reads ACP compression
summaries from **allow-listed source files** into a shared SQLite store (`node:sqlite`, FTS5
trigram) and exposes them via the `memory_search` tool. These rules bind **all future work** —
optimizations, bug fixes, and feature additions. They exist to keep the repo publishable,
consistent, and testable. If a change conflicts with a rule, change the plan, not the rule.

## 1. Privacy — non-negotiable, checked on every commit

The repository is a clean, shareable artifact. It must never contain:

- names/codenames of the author's **other personal projects**,
- the author's **real username, initials, or email address**,
- **real machine paths** (home dirs, drive letters, session dirs) from any real installation,
- real hostnames, tokens, or personal identifiers of any kind.

Concretely:

- Never reference real projects, sessions, DBs, or paths in code, comments, README, tests, logs,
  or commit messages. Real-world examples go in neutral form: `/home/dev/ProjX`, `~/.pi/...`,
  `<home>/...`.
- Before every commit, scan the working tree for your **real** identifiers: username, email
  pattern, machine paths (`C:\Users`, drive letters, `/Users/`, `/home/<you>`, session dirs),
  and personal project codenames. Resolve **all** hits before staging. Keep the concrete keyword
  list private — never write your real identifiers into this file.
- Privacy fixes must also scrub **git history** (see §6), not just the working tree.
- The allow-list file (`~/.pi/pi-billion-memory.sources.jsonl`) is user-local data and is never
  committed; the repository only contains neutral documentation/examples of it.
- **Ingestion secret filter**: every block's `topic`/`summary` must pass through
  `redactSecrets()` before the `blocks` insert. The filter is best-effort and covers common
  credential assignments, provider token prefixes, JWTs, PEM private keys, auth headers,
  cookies, Chinese labels, and URLs (http/https/ftp/file/ssh/git/ws(s)/db schemes and bare
  `www.` hosts; URLs become `[REDACTED_URL]`). It must never be disabled, bypassed, or
  weakened; tests must prove both direct redaction and that an ingested secret is not
  searchable.

## 2. Language — English only, with two sanctioned exceptions

All human-facing content is English:

- README and any docs, code comments, JSDoc, section banners;
- **runtime strings**: tool `description`/parameter schemas, `formatResults` output, `/memory`
  notifications, error messages, and log lines;
- commit messages.

The two exceptions are:

- `README.zh-CN.md` — a Chinese translation for users. Keep it in sync with `README.md`.
- **Fixture data inside `tests/self-test.test.ts`** (Chinese topics, summaries, and query
  keywords used to verify Chinese retrieval) stays in Chinese. It exists to verify a core
  feature; never delete or translate that data away.

## 3. Test gate — nothing merges red

`npm test` runs `tests/self-test.test.ts` through Node's test runner with `tsx`: **all checks
must pass** before any commit. `npm run check` is the full gate: format check, typecheck, lint,
tests, and build.

Coverage that must be preserved and extended, never removed:

- ingestion, watermark skip (mtime+size), missing-file resilience;
- FTS5 trigram (>=3-char queries, incl. Chinese) and LIKE fallback (<=2 chars), mixed long+short
  queries, LIKE matching `summary OR topic`, **AND semantics across modes**, project filtering,
  blank query, limit; the pure-LIKE query plan must avoid `blocks_fts`/temp B-tree and use
  `idx_blocks_created`;
- truncation at `maxSummaryChars` (head searchable, tail not);
- force rescan idempotency, multi-tier parent/child coexistence, `Source: bN+bM` header;
- legacy rows and `prune()` behavior (removedBlocks / removedSources / VACUUM); **durable prune**:
  a tombstone is recorded, an unchanged pruned source is skipped, a later file change cannot
  resurrect pruned blocks, force rescan still skips tombstones, and the watermark ledger backfills
  from older `sources` rows;
- **lazy pi cwd resolution**: a new/changed source reads only the session header; an unchanged
  source reads nothing; a stored cwd is reused on incremental scans and refreshed on force;
- schema drift: a missing `blocks`/`blocksById` payload is rejected without advancing the
  watermark and a later valid payload is ingested;
- allow-list read errors are fail-closed (ENOENT -> defaults, other errors -> no sources);
- close/reopen and idempotent close;
- **allow-list scanning**: only roots/patterns in `sources.jsonl` are scanned; files outside are
  never ingested; pi sidecar and opencode-acp state adapters both work; opencode `dcp-message-id`
  tail is stripped; project resolution and `[pi]`/`[opencode]` source labels.
- **secret redaction**: direct `redactSecrets` checks (API key/password/provider token/JWT/
  PEM/Chinese labels, benign `max_tokens` text unchanged, URL replacement incl. credentials,
  bare `www.` hosts, database URLs, trailing punctuation, and incomplete `https://` text) and
  end-to-end ingestion where the stored summary/topic contains `[REDACTED]`/`[REDACTED_URL]`,
  the original secret/URL is not searchable, and surrounding benign text is still searchable;
- **block expansion (opt-in)**: `msg_ids` pointers stored at ingestion from pi
  `effectiveMessageIds` / opencode `messageIds` (including `#call_...` selectors, duplicates,
  dangling refs, and malformed pointer payloads); `list` mode returns a manifest with no
  conversation text; `full` mode renders only an explicit `select`, and a narrow selection is
  **not** reported as truncation; `maxChars`/`maxMessages` caps and the injected redactor are
  honored; missing session files and byte-capped reads degrade instead of throwing; pointer
  backfill refreshes existing rows without re-inserting them; the 0.4.x -> 0.5.0 migration adds
  `msg_ids` and resets the watermark ledger exactly once;

Fixture conventions: sessions live under encoded-dir names like `--home-dev-ProjA--` with a
matching neutral cwd (`/home/dev/ProjA` -> project `ProjA`). Keep it that way — no real paths.

Additional gates:

- `npm run e2e` loads the built `dist/index.js`, asserts the default export is a function,
  checks that the factory registers the three session events, `memory_search`, and `/memory` —
  and that it does **not** register `memory_expand` under the default config — then re-imports the
  bundle with `expandEnabled: true` to prove the expansion tool appears only when opted in, and
  opens the SQLite store through `node:sqlite` in an isolated temporary home.
- `npm run verify:dist` rebuilds and fails if the committed `dist/` differs from a fresh build.
  `dist/` is committed because pi's git installer runs `npm install --omit=dev` and never runs a
  build (see §4).

## 4. Architecture constraints

The design is deliberately minimal; preserve these properties:

- **No third-party runtime dependencies beyond the pi host API**: only built-in `node:sqlite`
  (Node >= 22.19.0) and the peer-provided `@earendil-works/pi-coding-agent` API. No new npm
  packages for the extension itself. Development-only tools (e.g. `typescript`, `tsx`, `tsup`,
  `oxlint`, `prettier`, `@types/node` in `devDependencies`) are fine — they never ship in the
  runtime path.
- **Module layout**: `src/index.ts` is the pi entry (default export only); `src/extension.ts`
  contains the factory and wiring; `src/expand.ts` holds the opt-in block-expansion reader and is
  the **only** module allowed to read session message lines; `src/internals.ts` is a test-only
  re-export module that is excluded from `tsconfig.build.json` and is never bundled. The pi entry
  must stay free of test hooks. `tests/` holds self-tests, `scripts/e2e/` holds the dist smoke test.
- **Build output is committed**: `npm run build` bundles `src/index.ts` to `dist/index.js` with
  tsup and emits declarations with `tsc -p tsconfig.build.json`. `dist/` is committed so
  `pi install git:...` works without a build step. Never rely on `prepare`/`postinstall` for
  runtime code.
- **Never hook `context` events** — that is ACP's domain. Ingest on `session_start` (background,
  non-blocking, `scanOnStartup` configurable), `agent_settled`, `session_shutdown`, and before
  every `memory_search` (light allow-list scan).
- **Allow-list scanning only**: scan roots/patterns come from
  `~/.pi/pi-billion-memory.sources.jsonl` (or the built-in pi + opencode defaults when the file
  is absent). Never globally discover every session/message file. Raw conversation content is
  never parsed: for an allow-listed pi source the extension may read the session file's **first
  line only** (header metadata: `cwd,id,timestamp,type,version`) to resolve the working
  directory; message lines are never read during ingestion. Raw message databases are never
  parsed; `opencode.db` is opened read-only/`query_only` only to map session IDs to working
  directories. The single exception is opt-in expansion: when `expandEnabled` is true and
  `memory_expand` is called, `src/expand.ts` may read the specific message lines a stored block
  references — never a scan, never a cache, never a write.
- **Secret redaction before storage**: `redactSecrets()` runs on every normalized block's
  `topic` and `summary` inside `ingestSourceFile()` before the `blocks` insert; it is not
  optional. Log a hit count (never the secret) and continue ingesting the redacted block.
- **Adapters ingest only compression files**: the pi adapter reads `<session>.jsonl.acp.json`
  (plus the session header's first line for cwd when needed); the opencode adapter reads
  `ses_*.json` state files. The opencode DB is opened read-only (or `query_only` on older
  node:sqlite builds) and only to resolve session IDs to working directories — never to read
  conversation content.
- **Idempotent ingestion**: per-source watermark on source-file mtime+size, stored in the durable
  `source_watermarks` ledger and advanced only on successful parse (an unrecognized payload shape
  does not advance it); `UNIQUE(source_file, block_id)` + `INSERT OR IGNORE` for dedup; summaries
  truncated to `maxSummaryChars`. `prune()` writes a `block_tombstones` row per deleted block, and
  ingestion skips tombstoned `(source_file, block_id)` pairs.
- **Expansion is opt-in, two-step, and read-only**: `memory_expand` is registered only when
  `expandEnabled` is true (default false). `list` mode returns a manifest with no conversation
  text; `full` mode renders only an explicit selection, bounded by `expandMaxChars`,
  `expandMaxMessages`, and `expandMaxReadBytes`. Expanded text passes through `redactSecrets()`,
  and nothing is written to the store. `blocks.msg_ids` is populated from the sidecar at
  ingestion — ingestion itself must never read message lines. The 0.5.0 migration adds the column
  and resets the watermark ledger **once** to backfill pointers; `INSERT OR IGNORE` must keep
  protecting stored summaries (only `msg_ids` may be refreshed in place, which keeps the
  external-content FTS table valid) and tombstones must keep blocking resurrection.
- **Chinese strategy is fixed**: FTS5 trigram for >=3 chars, AND-ed `LIKE` for shorter queries
  (matching `summary OR topic`), and a mixed mode that combines FTS for long tokens with `LIKE`
  for short ones. Pure-LIKE queries must not join `blocks_fts` (so `idx_blocks_created` can
  satisfy the ordering); never route queries through an LLM for translation or keyword
  generation.
- **No silent data loss**: `prune()` (manual, via `/memory prune <days>`) is the only deletion
  mechanism; no automatic expiry. Prune is durable via tombstones, and the watermark ledger keeps
  pruned-but-unchanged sources skipped, so a rescan cannot resurrect them. Ingestion-parameter
  changes do not rewrite old rows — the documented remedy (delete `*.db*`, rescan) is the
  intended behavior.
- **Multi-tier duplication is by design**: parent (tier 2/3) and child blocks both match; do not
  dedupe results.
- **Plain JSON schema**: `memory_search` parameters are a plain JSON schema validated by a small
  runtime guard. Do not add `typebox` or another runtime schema dependency.
- Config: `~/.pi/pi-billion-memory.json` merged over `DEFAULT_CFG`; allow-list
  `~/.pi/pi-billion-memory.sources.jsonl`; log `~/.pi/pi-billion-memory.log` (1 MB cap). All under
  `os.homedir()/.pi` unless overridden by user config — never hardcode paths. `expandEnabled`
  (default `false`), `expandMaxChars`, `expandMaxMessages`, and `expandMaxReadBytes` bound the
  optional expansion tool.

## 5. Scope and known boundaries

- The store contains ACP **summaries**, not original messages. `memory_expand` can recover
  originals for pi sources when explicitly enabled, but only for blocks that recorded pointers and
  only for the messages a block names; it must never grow into a general session reader or become
  a search path. Semantic (embedding) search is a
  recognized future enhancement — if added, it must **augment** the trigram/LIKE path (keep it as
  the offline fallback) and come with self-test coverage; it must not add runtime dependencies
  beyond what the extension already requires, nor change search result semantics silently.
- The extension aggregates compression blocks from **allow-listed ACP-compatible sources** only:
  currently pi billion-context-pi sidecars and opencode-acp state files. billion-context-pi is an
  optional, recommended upstream, **not** a dependency; the README must state that this project
  is independent and not affiliated with it. Do not auto-discover or share state with other
  agents/formats.
- Upstream compression formats are internal implementations that can change. Adapters must be
  defensive: detect/ignore malformed or mid-write files (parse failure leaves the watermark
  untouched), never crash the scan, and remain easy to update when a source format changes.
- `memory_search` must stay a cheap, reliable lookup — no network calls, no external services.

## 6. Git hygiene

- Commit messages in English, imperative, with a short body when non-trivial.
- Working tree clean before wrapping up; `.gitignore` keeps `*.bak`, `*.db*`, `*.log`,
  `*.sources.jsonl`, `*.tgz`, `*.tsbuildinfo`, `node_modules`, and planning files out — never
  `git add -f` them. `dist/` is intentionally tracked.
- Configure a neutral identity before committing: `user.name` should be the public GitHub handle
  and `user.email` should be a GitHub noreply address. Never commit a real email address.
- If history ever needs scrubbing: orphan-branch rebuild is the approved procedure, **then**
  `git reflog expire --expire=now --all && git gc --prune=now`, and verify with
  `git fsck --no-reflogs` (no dangling output) and `git log --all` (only intended commits).
- Publishing stays private until the maintainer removes `"private": true`. Tags use `vX.Y.Z`.
  The release workflow publishes to npm with `--access public`; provenance is enabled only after
  the GitHub repository is public.

## 7. Finish checklist (every task)

1. `npm run format:check` -> clean.
2. `npm run typecheck` -> clean.
3. `npm run lint` -> clean.
4. `npm test` -> all checks pass.
5. `npm run build` -> succeeds; `npm run verify:dist` -> committed `dist/` matches a fresh build.
6. `npm run e2e` -> dist loads and registers the expected pi surface.
7. `npm pack --dry-run` -> only `dist/`, `README.md`, `README.zh-CN.md`, `LICENSE`,
   `CHANGELOG.md`, and `package.json` are shipped (no `src/`, `tests/`, `AGENTS.md`, or
   `scripts/`).
8. Working-tree privacy scan (see §1) -> no real identifiers; Chinese only in
   `README.zh-CN.md` and test fixtures.
9. `git status` clean after commit; `git log --oneline` shows only intended, English, factual
   history.
