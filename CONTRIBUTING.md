# Contributing

## Before you start

- Read `AGENTS.md` for the project rules that apply to all contributions.
- Use English for code, comments, docs, commit messages, and runtime strings.
  The only exception is neutral Chinese fixture data in the self-test, which
  exists to verify Chinese retrieval.
- Never include real names, email addresses, machine paths, hostnames, tokens,
  session content, or personal project codenames in code, tests, docs, logs, or
  commit messages.

## Development

```bash
npm install --legacy-peer-deps
npm run build      # tsup + tsc -> dist/
npm run typecheck  # tsc --noEmit
npm run lint       # oxlint
npm test           # node --import tsx --test tests/*.test.ts
npm run check      # format check + typecheck + lint + test + build
```

The extension must keep **no third-party runtime dependencies beyond the pi host
API** (`@earendil-works/pi-coding-agent`). Development-only tools belong in
`devDependencies` and must not be imported by `src/`.

## Architecture rules

- Never hook pi's `context` event.
- Scan only allow-listed sources; never discover sessions globally.
- Never parse raw conversation messages. The only exception is the first line
  of an allow-listed pi session file for `cwd` metadata.
- Keep `prune()` durable: tombstones are required, and rescan must not
  resurrect pruned blocks.
- Keep the Chinese search strategy (FTS5 trigram for >=3 characters, AND-ed
  `LIKE` for shorter queries, mixed mode for combined queries).
- Keep `memory_search` schema plain JSON; do not add a typebox runtime
  dependency.

## Pull requests

1. `npm run check` must be green.
2. Add or update tests for behavior changes.
3. Keep `dist/` in sync with `src/` (`npm run build`; CI runs `verify:dist`).
4. Any new ingestion path must call `redactSecrets()` on `topic`/`summary` before storing.
5. Keep commit messages English, imperative, and factual.
6. Do not force-push a shared branch; open a pull request instead.

## Reporting bugs

Use the issue templates and include the version, Node version, pi version, and
a minimal reproduction with neutral paths. Do not paste real session content.
