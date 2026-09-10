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

## Maintainer notes

Branch protection on `main` is: the four CI jobs are required status checks, force pushes
and branch deletions are disabled, and admins are **not** enforced. The owner can therefore
still push directly (that is how releases and fixes land), while a contributor without
admin rights can only land a change through a pull request where CI has run — a direct push
of a fresh commit fails because the required checks cannot be satisfied yet.

Two couplings to remember:

- The required checks are the CI job names (`Node <version> / <os>`). Renaming a matrix job
  in `.github/workflows/ci.yml` leaves the rule waiting for a check that never reports, and
  pull requests hang on `Expected — Waiting for status to be reported`. Update the rule in
  the same change.
- A tag creates a GitHub Release only when its name matches `package.json` (`vX.Y.Z`);
  older tags are skipped on purpose. Bump the version first, then tag.

Force pushes are blocked for everyone, including the owner. When history on `main`
genuinely has to be rewritten (an accidental commit that is already pushed), lift the rule
for the duration, rewrite, and put it back:

```bash
REPO=tjp72/pi-billion-memory

# 1. Lift force-push protection (everything else stays as configured).
gh api -X PUT "repos/$REPO/branches/main/protection" --input - <<'JSON'
{
  "required_status_checks": {
    "strict": false,
    "contexts": [
      "Node 22.19 / ubuntu-latest",
      "Node 22.19 / windows-latest",
      "Node 24 / ubuntu-latest",
      "Node 24 / windows-latest"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_deletions": false,
  "allow_force_pushes": true
}
JSON

# 2. Rewrite the branch.
git push --force-with-lease origin main

# 3. Put the rule back: same payload with "allow_force_pushes": false.
gh api "repos/$REPO/branches/main/protection" \
  --jq '{force_push: .allow_force_pushes.enabled, checks: .required_status_checks.contexts}'
```

## Reporting bugs

Use the issue templates and include the version, Node version, pi version, and
a minimal reproduction with neutral paths. Do not paste real session content.
