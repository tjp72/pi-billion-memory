# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
