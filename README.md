# pi-billion-memory

[![npm version](https://img.shields.io/npm/v/pi-billion-memory.svg)](https://www.npmjs.com/package/pi-billion-memory)
[![CI](https://github.com/tjp72/pi-billion-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/tjp72/pi-billion-memory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Long-term memory extension for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent):
**allow-listed ACP compression blocks → SQLite FTS5 → `memory_search`**.

ACP plugins compress long conversations into summaries. This extension collects
those compression summaries from **allow-listed source locations** into one
searchable store and registers a `memory_search` tool the model can call at any
time. The compatibility target is compression blocks / compression sidecars;
the recommended upstream for pi is
[billion-context-pi](#relationship-to-billion-context-pi).

## Relationship to billion-context-pi

This project is **independent and community-maintained**. It is **not
affiliated with, endorsed by, or a fork of**
[billion-context-pi](https://github.com/ranxianglei/billion-context-pi).

- billion-context-pi is the **recommended optional upstream for pi**. It
  produces the `<session>.jsonl.acp.json` compression sidecars that this
  extension indexes. Install it separately if you want pi-side compression
  memory:
  ```bash
  pi install npm:billion-context-pi
  ```
- This extension reads those sidecars **read-only**. It does not import,
  bundle, call, or modify billion-context-pi, and it has no code dependency on
  it.
- billion-context-pi is optional. Without it, pi sessions have no sidecars to
  index; the extension can still index opencode-acp state files if configured.
- This extension **does not hook pi's `context` event**. It only registers the
  `memory_search` tool and the `/memory` command, so it is safe to run
  alongside billion-context-pi. It does not participate in context-compression
  ordering or clobber compressed output.
- The sidecar format is an implementation detail of billion-context-pi and may
  change. This extension is tested against the sidecar format produced by
  billion-context-pi `0.1.52`; a format change may require an adapter update.
- billion-context-pi is MIT-licensed. Its name and logo belong to its authors.
  This project's MIT license covers only this project's code.

## Features

- **Allow-list first**: scanning is restricted to the roots/patterns in the
  allow-list file. There is no global discovery across every session or
  message file, so scanning stays bounded even with many sessions.
- **Compression blocks only**: the pi adapter reads
  `<session>.jsonl.acp.json`; the opencode adapter reads `ses_*.json` state
  files. Raw conversation messages are never parsed.
- **Incremental and durable**: per-source `mtime + size` watermarks live in a
  durable ledger; `UNIQUE(source_file, block_id)` + `INSERT OR IGNORE` dedupes
  blocks. `prune()` writes tombstones so a later rescan cannot resurrect
  pruned blocks.
- **Chinese-friendly search**: FTS5 `trigram` for queries of 3+ characters;
  AND-ed `LIKE` against `summary OR topic` for shorter queries; a mixed mode
  combines both. No LLM translation or keyword generation.
- **Lazy project resolution**: the pi session header is read only when a source
  file actually needs (re)ingestion, and only its first line is read. An
  unchanged store costs no header reads.
- **No context hook**: the extension never participates in pi's `context`
  event; it only indexes and searches compression summaries.

## Requirements

- **Node.js >= 22.19.0** (built-in `node:sqlite`; Node 24 is recommended and
  tested). `node:sqlite` is still marked experimental in Node, so Node may
  print an `ExperimentalWarning` at startup; this is expected and safe to
  ignore for this extension.
- **pi coding agent >= 0.85.1** (tested with 0.85.1; the extension uses only
  public extension APIs).
- At least one enabled compression source:
  - [billion-context-pi](https://github.com/ranxianglei/billion-context-pi)
    for pi sidecars (**recommended**), or
  - [opencode-acp](https://www.npmjs.com/package/opencode-acp) state files.
- No third-party runtime dependencies. The extension uses Node built-ins and the
  pi host API (`@earendil-works/pi-coding-agent`, a peer dependency). Optional
  billion-context-pi sidecars are read from disk.

## Install

### npm (recommended once published)

```bash
pi install npm:pi-billion-memory
```

### GitHub (private or public repository)

```bash
# SSH (recommended for a private repository)
pi install git:git@github.com:tjp72/pi-billion-memory.git@v0.4.0

# HTTPS (public repository; credentials are handled by git)
pi install git:https://github.com/tjp72/pi-billion-memory.git@v0.4.0
```

> `pi install git:...` clones the repository and runs `npm install --omit=dev`.
> It does not build the project, so the built `dist/` directory is committed to
> the repository. Do not delete `dist/` before tagging a release.

### Local development

```bash
npm install --legacy-peer-deps
npm run build
pi install /absolute/path/to/pi-billion-memory
```

### Verify

```bash
pi list
```

Then in a pi session:

- `/memory` — show store stats (sources / blocks / compressed tokens).
- `/memory sources` — print the active allow-list.
- `/memory rescan` — force a full allow-list rescan.
- `/memory prune <days>` — durably delete blocks older than N days.
- Ask the model something like "what did I work on before?" so it can call
  `memory_search`.

### Uninstall

```bash
pi remove npm:pi-billion-memory
# or
pi remove git:git@github.com:tjp72/pi-billion-memory.git
```

The local store is not removed automatically. To delete it as well:

```bash
rm -f ~/.pi/pi-billion-memory.db ~/.pi/pi-billion-memory.db-wal ~/.pi/pi-billion-memory.db-shm
rm -f ~/.pi/pi-billion-memory.log ~/.pi/pi-billion-memory.sources.jsonl ~/.pi/pi-billion-memory.json
```

Never delete pi session files (`.jsonl`, `.jsonl.acp.json`), the opencode
database, or `~/.pi/agent/settings.json` to remove this extension.

## How it works

```
pi sidecars (.jsonl.acp.json) ─┐
                                ├─ allow-list ─► scanSources() ─► ~/.pi/pi-billion-memory.db
opencode-acp ses_*.json ────────┘                                (SQLite + FTS5 trigram)
                                                                        │
                                                                        ▼
                                                         memory_search tool (on demand)
```

1. `session_start` runs a background allow-list scan (configurable with
   `scanOnStartup`).
2. `agent_settled` and `session_shutdown` incrementally scan the current pi
   session.
3. Every `memory_search` performs a light allow-list scan first, then queries
   the SQLite store.
4. For an allow-listed pi sidecar, the session file's first line is read only
   when the sidecar needs (re)ingestion, to resolve the project name from
   `cwd`. Message lines are never read.
5. For opencode sources, `opencode.db` is opened read-only (or `query_only`)
   only to map session IDs to working directories. Conversation content is
   never read.

## Data and privacy

- **No network**: the extension makes no network requests and has no telemetry.
- **No raw messages**: only compression blocks/sidecars are ingested. The pi
  session file is read only for its first-line header (`cwd`, `id`,
  `timestamp`, `type`, `version`) when project resolution is needed.
- **Secret and URL filter**: before a block is stored, its `topic` and
  `summary` are scanned for common credentials (passwords, API keys, tokens,
  private keys, JWTs, auth headers, cookies, and Chinese credential labels) and
  for URLs. Credential values are replaced with `[REDACTED]`, URLs with
  `[REDACTED_URL]`; a hit count is logged without the value. This is a
  best-effort safety net, not a guarantee. The filter applies to newly
  ingested/updated blocks; existing rows are not rewritten (delete
  `~/.pi/pi-billion-memory.db*` and rescan to rebuild).
- **No context hook**: the extension never hooks pi's `context` event.
- **No session writes**: the extension never writes to session files.
- **Local store**: the SQLite database, log, config, and allow-list live under
  `~/.pi/` by default. They stay on your machine.

## Configuration

`~/.pi/pi-billion-memory.json` is optional. Defaults:

```json
{
  "dbPath": "~/.pi/pi-billion-memory.db",
  "sourcesPath": "~/.pi/pi-billion-memory.sources.jsonl",
  "logPath": "~/.pi/pi-billion-memory.log",
  "maxSummaryChars": 20000,
  "debug": false,
  "excludeDirs": [],
  "scanOnStartup": true
}
```

- `dbPath`: SQLite store path.
- `sourcesPath`: JSONL allow-list path.
- `logPath`: log file path (auto-truncated at 1 MB).
- `maxSummaryChars`: summaries longer than this are truncated on ingestion.
  Changing it does not rewrite existing rows; delete the `*.db*` files and
  restart pi to rebuild from source.
- `debug`: verbose logging.
- `excludeDirs`: directory names to skip inside pi-sidecar source roots.
- `scanOnStartup`: run a background allow-list scan at session start. If
  disabled, the current session is still force-scanned once and other sources
  are picked up by later scans.

## Allow-list sources

`~/.pi/pi-billion-memory.sources.jsonl` is optional. When it is missing, the
extension uses these two built-in defaults:

```jsonl
{"id":"pi","adapter":"pi-sidecar","root":"~/.pi/agent/sessions","pattern":"**/*.jsonl.acp.json","enabled":true}
{"id":"opencode","adapter":"opencode-acp","root":"~/.local/share/opencode/storage/plugin/acp","pattern":"ses_*.json","enabled":true,"opencodeDb":"~/.local/share/opencode/opencode.db"}
```

- Each non-empty, non-comment line is one JSON object.
- `enabled: false` disables a source without deleting its line.
- `root` supports `~` for the current user's home directory.
- `pattern` supports a recursive `**/*.jsonl.acp.json` form or a flat
  `ses_*.json` form.
- `opencodeDb` is optional but recommended for opencode sources: it lets the
  adapter resolve each state file to its real working directory (project name)
  via a read-only lookup.

Example: scan only a pi sessions subtree plus one extra sidecar root:

```jsonl
{"id":"pi-work","adapter":"pi-sidecar","root":"~/.pi/agent/sessions","pattern":"**/*.jsonl.acp.json","enabled":true}
{"id":"pi-archive","adapter":"pi-sidecar","root":"~/archive/compressions","pattern":"**/*.jsonl.acp.json","enabled":true}
```

Run `/memory sources` to confirm, then `/memory rescan`.

## Search behavior

- `memory_search` accepts `query`, optional `project`, optional `limit`
  (default 6, max 20), and returns matching blocks with `source`, `project`,
  `topic`, `tier`, `createdAt`, `compressedTokens`, and a preview.
- Queries of **3+ characters** use the FTS5 `trigram` index, which matches
  Chinese substrings, mixed Chinese/English text, and code identifiers.
- Queries of **1–2 characters** use AND-ed `LIKE` matches against both
  `summary` and `topic`.
- **Mixed queries** (long + short tokens) use FTS for the long tokens and
  `LIKE` for the short ones, preserving AND semantics across modes.
- Pure-`LIKE` queries do not join the FTS table; they use
  `idx_blocks_created` for ordering.
- The schema is plain JSON; the extension does not require `typebox` or any
  other runtime dependency.

## Scale and prune

Summaries are distilled knowledge whose value only the model can judge, so
there is no automatic expiry. Prune manually:

```text
/memory prune 365   # delete blocks compressed more than 365 days ago
/memory prune 0     # delete every timestamped block
/memory rescan      # add new blocks; pruned blocks stay deleted
```

Prune is durable: every deleted block is tombstoned, and the watermark ledger
keeps pruned-but-unchanged sources skipped, so a rescan cannot resurrect them.
A pruned block can only return if the upstream source emits it with a new
`blockId` (or the tombstone row is removed manually).

Rough sizing: about 1 KB of body text per block; the database file runs about
5–7× the body size (SQLite + FTS index). 720 blocks is roughly 0.7 MB of body
text / 4.9 MB of database; 10k blocks is roughly 15–20 MB. No intervention is
needed until hundreds of thousands of blocks.

## Development

```bash
npm install --legacy-peer-deps
npm run build        # tsup + tsc -> dist/
npm run typecheck    # tsc --noEmit
npm run lint         # oxlint
npm test             # node --import tsx --test tests/*.test.ts
npm run check        # format check + typecheck + lint + test + build
npm run e2e          # load dist/ and verify the pi registrations
npm run verify:dist  # build and fail if committed dist/ is stale
```

Repository layout:

- `src/` — TypeScript source modules; the pi extension entry is
  `src/index.ts`.
- `dist/` — committed build output. Required by `pi install git:...`, because
  pi's git installer runs `npm install --omit=dev` and does not run a build.
- `tests/` — self-tests run with Node's test runner and `tsx`.
- `scripts/` — development helpers.
- `.github/workflows/` — CI and release automation.

See `CONTRIBUTING.md` and `AGENTS.md` for the rules that apply to changes.

## Known limitations

- Memory entries are ACP compression summaries, not original messages.
  Semantic (embedding) search is not implemented; trigram is literal substring
  matching.
- If a block is rewritten upstream, the already-ingested row is not updated
  (`INSERT OR IGNORE`); `/memory rescan` only adds new blocks.
- Upstream compression formats are internal implementations that can change.
  The adapters are defensive (malformed/mid-write files are skipped and
  retried), but a format change may require an adapter update.
- Multi-tier blocks are intentionally not deduplicated: a tier-2/3 parent and
  its tier-1 children can both match. Parent summaries start with a
  `Source: bN+bM …` header that identifies what they aggregate.

## License

MIT. See [LICENSE](LICENSE).
