## Summary

<!-- What changes, and why. Link the issue when there is one. -->

## Checklist

<!-- Mirrors the pull request rules in CONTRIBUTING.md. -->

- [ ] `npm run check` is green (format, typecheck, lint, self-test, build)
- [ ] Tests added or updated for behavior changes
- [ ] `dist/` rebuilt and in sync with `src/` (`npm run build`; CI runs `verify:dist`)
- [ ] New ingestion paths call `redactSecrets()` on `topic`/`summary` before storing
- [ ] Commit messages are English, imperative, and factual
- [ ] No secrets, real paths, session content, or personal data in the diff
