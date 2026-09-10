# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.2] - 2026-09-10

### Fixed

- A background scan can no longer reopen the store after `session_shutdown`, including a shutdown
  that lands while the allow-list is being read: the scan captures the session generation before
  its first `await`, and `MemoryDb.open()` refuses a latched store (`getDb()` already did).
- Allow-list patterns are matched against paths relative to the source root, so a directory prefix
  (`sub/*.json`, `2026/**/*.jsonl.acp.json`) narrows the scan instead of silently widening it into
  a recursive scan of the whole root.
- Symlinks are ignored consistently. The non-recursive listing now uses `withFileTypes` like the
  recursive walk, so a link inside the root can no longer pull in a file from outside the
  allow-list.
- An unreadable or missing allow-list directory is counted as a failed source and logged (with the
  path redacted) instead of silently looking like an empty source. The 0.5.1 note promised this;
  it now holds. The scan budget now bounds visited entries (`200,000`) and matches (`20,000`)
  separately, so non-matching session files cannot starve the real sidecars.
- `readCapped` re-stats the handle after reading, so `truncated` means "bytes exist past the
  buffer": a session file that shrank while it was read no longer reports a stale truncation and
  loses its last complete line. A file that exists but cannot be opened (EACCES/EPERM/EISDIR)
  degrades to missing instead of failing the tool.
- `mode: "full"` counts indices the manifest never offered (or that hold no text) as skipped, so a
  selection that resolves to nothing reports `truncated` instead of a clean empty result.
- `withoutPaths` covers `C:/`, UNC roots, `file:///` and paths containing spaces
  ("C:\Program Files\...", "/home/alice/My Docs/..."). The tool details no longer carry the full
  database path, and log lines that quote raw errors/stacks pass through it as well, so the 0.5.1
  "logs have no absolute paths" note now holds for them too.
- `collectMsgIds` skips a first field whose entries are all unusable instead of letting it shadow a
  valid second field.
- A `session_shutdown` that is still finishing (grace period or final scan) when a new
  `session_start` lands no longer closes and latches the new session's store; it detects that it was
  superseded and leaves the store open.
- `configureForTests` resets the cached connection, session generation, background scan and latch,
  so tests no longer depend on every test file owning its own process.
- `package.json` drops the leftover `publishConfig` and `prepublishOnly` (the package is `private`
  and distributed through git tags), and the README update examples use the same `.git` URL as the
  install section.

## [0.5.1] - 2026-09-10

### Changed

- Distribution is git-only. The release workflow no longer publishes to npm: it checks that the
  tag matches `package.json`, re-checks the committed `dist/`, and creates the GitHub release from
  the matching `CHANGELOG.md` section. `pi install git:...` is the only documented install path,
  and the npm badge and npm install/uninstall sections were removed from both READMEs.
- The store file is created `0600` where the OS supports it (ignored on Windows).
- Errors returned to the model by `memory_search`/`memory_expand` no longer contain absolute local
  paths; the full trace stays in the extension log.
- CI limits the workflow token to `contents: read`, the release workflow extracts release notes
  with a literal version match instead of a regular expression, and the declared
  `billion-context-pi` peer range is `>=0.1.65` to match the documented tested version.
- The install docs are written for the public repository: HTTPS first (no credentials required),
  SSH as the alternative, plus an "Update" section and a release badge.
- Both workflows pin `actions/checkout` and `actions/setup-node` to commit SHAs. The repository
  also gained issue forms (bug report with version/Node/pi fields), a pull-request template,
  Dependabot configuration, and a Code of Conduct.

### Added

- README "Scope: single user, single machine" section: no accounts, server, sync, or per-user
  permissions; one store per OS user; SQLite WAL locking is single-host only, so the database file
  must never be shared; ephemeral homes rebuild the index; redaction is best-effort over a
  plaintext, permission-unhardened store; sync sidecars, not the database, across machines.

### Fixed

- `memory_expand` hardening after an external review of 0.5.0:
  - `mode: "full"` now **requires** a non-empty `select` instead of rendering the whole block,
    which contradicted the documented two-step contract.
  - `expandMaxReadBytes` is a real read cap again: the session file is opened and read in bounded
    chunks instead of being slurped whole and sliced afterwards.
  - A per-entry trim is reported as `truncated` again (a later assignment always cleared the
    flag), and the rendered text is guaranteed to stay within `maxChars`.
  - A missing/renamed session file degrades to `missing` references instead of throwing, matching
    the documented behavior.
  - `custom_message` entries (extension-injected context such as ACP compaction notices) are
    expandable again; unknown content-item types render an explicit `[unsupported ...]`
    placeholder instead of being dropped from the entry.
  - Re-ingesting a sidecar clears stored pointers the sidecar no longer lists, so expansion can no
    longer return messages that are no longer part of the block.
  - The 0.5.0 pointer migration now clears a freshly seeded watermark row, so an orphaned source
    row still gets its pointers backfilled.
  - `~` in `dbPath`/`sourcesPath`/`logPath` expands to the home directory instead of creating a
    literal `~` directory.
  - The ambiguous-block message reports the real number of matches instead of the page size.
  - Manifests no longer print an absolute session path, and generated `acp_summary_*` references
    are labelled `synthetic` rather than counted as recoverable text.
- Scan and store lifecycle hardening after a follow-up review:
  - A background scan can no longer reopen the closed store after `session_shutdown`: the scan
    aborts per file when the session generation moved on, and `getDb()` refuses to open a latched
    store instead of recreating it.
  - One failing allow-list source (unreadable root, corrupt opencode DB, adapter bug) no longer
    aborts every remaining source; failures are counted and logged per source.
  - An allow-list entry with an unknown `adapter` is rejected and logged when the list is read,
    instead of falling through to the permissive scan-time path.
  - `/memory prune` writes its tombstones and deletes in one transaction, so a crash cannot leave
    the two halves inconsistent, and a failing `VACUUM` is logged instead of failing the prune.
  - An ingest that finishes reading a file after `session_shutdown` returns `store closed` instead
    of touching a null handle and then failing again in `ROLLBACK`.
  - A scan whose allow-list root holds more than 20,000 entries stops at the cap and logs it,
    instead of walking an accidentally over-broad tree to the end.
  - Log lines no longer contain absolute session or working-directory paths unless `debug` is on
    (the store path is logged as a file name) — logs are what users paste into public issues.
  - `SECURITY.md` no longer points "above" at a section that sits below it.

## [0.5.0] - 2026-09-10

### Added

- Opt-in block expansion: a `memory_expand` tool (registered only when
  `expandEnabled` is true) resolves a stored block back to the original session
  messages it absorbed. It is two-step by design — `mode: "list"` returns a
  manifest of ref/role/size with no conversation text, and `mode: "full"` renders
  only an explicit `select`. Rendering is bounded by `expandMaxChars`,
  `expandMaxMessages`, and `expandMaxReadBytes`, passes through the same secret
  and URL filter as ingestion, and is never written back to the store. Only pi
  sources are expandable; a `#call_...` reference renders just that tool call.
- `blocks.msg_ids` records the message pointers behind each block, populated
  from the sidecar at ingestion (pi `effectiveMessageIds`, opencode
  `messageIds`). Pointers are not FTS-indexed and never affect search ranking.

### Changed

- Upgrading from 0.4.x resets the watermark ledger once, so the next scan
  re-reads existing sidecars and backfills pointers onto already-ingested blocks
  without duplicating them. `INSERT OR IGNORE` still protects the stored summary
  text; only `msg_ids` is refreshed in place.

## [0.4.0] - 2026-09-09

### Added

- Best-effort pre-ingestion secret redaction: passwords, API keys, tokens,
  private keys, JWTs, auth headers, cookies, and Chinese credential labels are
  replaced with `[REDACTED]`; URLs (http/https/ftp/file/ssh/git/ws(s)/db
  schemes and bare `www.` hosts) are replaced with `[REDACTED_URL]`, keeping
  trailing punctuation. The hit count is logged without the value. Applies to
  newly ingested/updated blocks; existing rows are not rewritten. The scan log
  and `/memory rescan` output include the redacted count.
- npm/GitHub packaging: `pi` manifest, `dist/` build, `files` allow-list,
  `peerDependencies`, MIT license, CI, release workflow, and bilingual README.
- `README.zh-CN.md` with a clear compatibility/independence notice for
  billion-context-pi.

### Changed

- Refactored the single-file extension into a `src/` layout: `src/index.ts` is the pi
  entry point, `src/extension.ts` holds the implementation, and `src/internals.ts` is a
  test-only re-export module that is excluded from the published bundle.
- Replaced the ambient `types.d.ts` shim with the real
  `@earendil-works/pi-coding-agent` development dependency.
- Raised the Node requirement to `>=22.19.0` to match pi and to make the
  `node:sqlite` baseline explicit.
- Tests now run with `node --import tsx --test tests/*.test.ts`.

### Removed

- Test-only hooks and internal development notes from the published entry point
  and user-facing docs.

### Fixed

- The bundled `dist/index.js` now preserves the `node:sqlite` specifier.
  Previously the bundler rewrote it to a bare `sqlite` import, which is not a
  Node built-in and failed at runtime.
- `npm run e2e` now opens the SQLite store in an isolated temporary home, so
  this class of bundling regression is covered.

### Notes

- Runtime behavior is unchanged from 0.3.0: durable prune via tombstones,
  lazy session-header cwd resolution, and mixed FTS5/LIKE search.
- No runtime dependencies were added. `memory_search` keeps a plain JSON schema.
