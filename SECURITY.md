# Security and privacy

## Data flow

`pi-billion-memory` is a local, read-mostly extension:

- It reads only the allow-listed compression files described in the README
  (pi `.jsonl.acp.json` sidecars and opencode-acp `ses_*.json` state files).
- For an allow-listed pi sidecar, it may read the session file's **first line
  only** (`cwd`, `id`, `timestamp`, `type`, `version`) to resolve the project
  name. Message lines are never read.
- It may open `opencode.db` read-only (or `query_only`) only to map session IDs
  to working directories. Conversation content is never read.
- It writes a local SQLite database, an optional log file, and the allow-list
  file under the user's home directory. It does not write to session files.

## No network, no telemetry

The extension makes no network requests, has no telemetry, and sends no data to
any service. The `memory_search` tool is a local database lookup.

## Secret redaction

Before a compression block is written to the SQLite store, its `topic` and
`summary` are scanned for common credential shapes: key/value assignments,
provider token prefixes, JWTs, PEM private keys, `Authorization` headers,
cookies, and Chinese credential labels. Credential values are replaced with
`[REDACTED]`. URLs (http/https/ftp/file/ssh/git/ws(s)/db schemes and bare
`www.` hosts) are replaced with `[REDACTED_URL]`; a hit count is logged without
the value.

This is a best-effort safety net, not a guarantee. Compression summaries should
not contain secrets in the first place; if you find a bypass, report it privately
as described below. The filter applies to newly ingested/updated blocks; existing
rows are not rewritten (delete `~/.pi/pi-billion-memory.db*` and rescan to rebuild).

## Reporting a vulnerability

Please do not open a public issue for security or privacy problems. Use the
repository's **Security** tab to open a private security advisory, or contact
the maintainer through the GitHub profile linked from the repository.

Include:

- the affected version or commit;
- a minimal reproduction (neutral paths and fixture data only);
- the impact you believe is possible.

Do not include real session content, personal paths, tokens, or other users'
data in the report.
