# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Distribution is git-only. The release workflow no longer publishes to npm: it checks that the
  tag matches `package.json`, re-checks the committed `dist/`, and creates the GitHub release from
  the matching `CHANGELOG.md` section. `pi install git:...` is the only documented install path,
  and the npm badge and npm install/uninstall sections were removed from both READMEs.

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
