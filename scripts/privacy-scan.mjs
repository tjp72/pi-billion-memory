#!/usr/bin/env node
/**
 * Privacy scan — AGENTS.md §1, made mechanical.
 *
 * Why this exists: §1 told the author to scan for personal identifiers before every commit, with
 * no automation behind it. A codename shipped inside a public release as a result. A rule that
 * depends on remembering is not a rule.
 *
 * Two layers run here:
 *
 * 1. Structural rules — always on, no configuration. Home paths, real email addresses, private-key
 *    blocks, and token prefixes are identifiable by shape.
 * 2. Term rules — a keyword list supplied out of band via `PBM_PRIVACY_TERMS` (newline- or
 *    comma-separated) or a `.privacy-terms` file in the repo root (gitignored). The concrete
 *    codenames must never be written into this repository: §1 says to keep the keyword list
 *    private, and this file is public.
 *
 * Precision matters more than coverage here. A scanner that cries wolf gets switched off, and a
 * switched-off scanner catches nothing — which is exactly how the leak got out. So:
 *
 * - ASCII terms match on word boundaries (a three-letter term must not fire inside a longer word
 *   such as "streaming"); CJK terms match as substrings, because Chinese has no word delimiters at
 *   this level.
 * - Placeholder identities are neutral by definition: `alice`, `dev`, `you`, `ProjA`, and friends
 *   are what §1 *asks* examples to use. Flagging them would flag compliance.
 * - `package-lock.json` is skipped: every hit in it is a transitive dependency's own metadata,
 *   which this project neither writes nor can fix.
 *
 * Escaped text is decoded before matching. `dist/index.js` is a bundle, so a term may appear as
 * `\uXXXX` escapes there; matching only the literal spelling would miss the artifact that ships.
 *
 * Findings print as `file:line  rule` with the match masked. CI logs of a public repository are
 * public, so echoing the matched text would re-publish the leak the scan exists to stop.
 *
 * Exit codes: 0 clean, 1 findings.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MASK = "[redacted]";

/**
 * Documentation placeholders and fixture identities. AGENTS.md §1 explicitly instructs examples
 * to use neutral forms; these are those forms. `alice`/`bob` are the RFC-style stand-ins already
 * used by the test suite, and `x` is a single-character fixture path.
 */
const NEUTRAL_USERS = new Set([
  "alice",
  "bob",
  "carol",
  "dave",
  "dev",
  "user",
  "users",
  "you",
  "your",
  "name",
  "username",
  "example",
  "someone",
  "runner",
  "node",
  "root",
  "x",
  "proja",
  "projb",
  "projx",
  "myuser",
  "test",
]);

/** Domains that are not a real identity: GitHub noreply, example, documentation ranges. */
const NEUTRAL_DOMAINS = new Set([
  "users.noreply.github.com",
  "noreply.github.com",
  "example.com",
  "example.org",
  "example.net",
  "test.local",
  "localhost",
]);

/**
 * Whether a path segment names a real account rather than a placeholder. `...` and `<you>` are
 * documentation ellipses (§1's own examples use them), so they are not identities.
 */
function isRealUser(segment) {
  const s = segment.toLowerCase();
  if (!s || s === "..." || NEUTRAL_USERS.has(s)) return false;
  return true;
}

const STRUCTURAL_RULES = [
  {
    name: "windows-home-path",
    // Capture only a plausible account segment; `C:\Users\` in prose must not match.
    re: /[A-Za-z]:[\\/]+Users[\\/]+([A-Za-z0-9._-]+)/g,
    check: (m) => isRealUser(m[1]),
  },
  {
    name: "macos-home-path",
    re: /\/Users\/([A-Za-z0-9._-]+)/g,
    check: (m) => isRealUser(m[1]),
  },
  {
    name: "linux-home-path",
    re: /\/home\/([A-Za-z0-9._-]+)/g,
    check: (m) => isRealUser(m[1]),
  },
  {
    name: "email-address",
    // The lookbehind rejects URL credentials: in `postgres://user:pass@host` the `pass@host` part
    // matches an address shape but is a password, not an identity.
    re: /(?<![:/])\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
    // `git@github.com:` is an SSH URL in an install command, not an address.
    check: (m) => m[1].toLowerCase() !== "git" && !NEUTRAL_DOMAINS.has(m[2].toLowerCase()),
  },
  {
    name: "private-key-block",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    check: () => true,
  },
  {
    name: "token-prefix",
    re: /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,})/g,
    check: () => true,
  },
];

/** Files whose hits are never this project's to fix. */
const SKIP_FILES = new Set(["package-lock.json", "npm-shrinkwrap.json"]);

const SKIP_DIRS = ["node_modules/", ".git/"];

function skipFile(rel) {
  if (SKIP_FILES.has(rel)) return true;
  return SKIP_DIRS.some((d) => rel.startsWith(d));
}

function isAscii(s) {
  return /^[\x20-\x7e]+$/.test(s);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a matcher per term. ASCII terms are bounded so a short codename cannot match inside an
 * unrelated word; CJK terms are substrings because boundaries are not meaningful for them.
 */
function buildMatchers(terms) {
  return terms.map((term) => ({
    term,
    re: isAscii(term) ? new RegExp(`(?<![A-Za-z0-9])${escapeRe(term)}(?![A-Za-z0-9])`, "i") : null,
    lowered: term.toLowerCase(),
  }));
}

function lineHits(line, matchers) {
  let hit = false;
  for (const m of matchers) {
    if (m.re) {
      if (m.re.test(line)) hit = true;
    } else if (line.toLowerCase().includes(m.lowered)) {
      hit = true;
    }
    if (hit) return true;
  }
  return false;
}

/** Decode `\uXXXX` escapes so a term hidden as escapes is still found. */
function decodeEscapes(text) {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function loadTerms() {
  let raw = process.env.PBM_PRIVACY_TERMS || "";
  if (!raw.trim()) {
    const file = path.join(process.cwd(), ".privacy-terms");
    if (fs.existsSync(file)) raw = fs.readFileSync(file, "utf8");
  }
  return [
    ...new Set(
      raw
        .split(/[\n,]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2 && !t.startsWith("#")),
    ),
  ];
}

/**
 * Files to scan: tracked *and* untracked-but-not-ignored.
 *
 * Scanning only `git ls-files` would miss the one case that matters most — a brand-new file, which
 * is exactly how a codename reached a release. `--others --exclude-standard` picks up new files
 * while still honoring `.gitignore`, so local runtime data is not read.
 */
function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  });
  return [...new Set(out.split("\0").filter(Boolean))];
}

function main() {
  const terms = loadTerms();
  if (!terms.length) {
    console.log("privacy-scan: no term list (PBM_PRIVACY_TERMS / .privacy-terms); structural rules only.");
  }
  const matchers = buildMatchers(terms);

  const findings = [];
  let scanned = 0;

  for (const rel of trackedFiles()) {
    if (skipFile(rel)) continue;
    let text;
    try {
      text = fs.readFileSync(rel, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    scanned++;

    const lines = text.split(/\r?\n/);
    const decodedLines = matchers.length ? decodeEscapes(text).split(/\r?\n/) : null;

    for (const [idx, line] of lines.entries()) {
      for (const rule of STRUCTURAL_RULES) {
        rule.re.lastIndex = 0;
        let m;
        while ((m = rule.re.exec(line))) {
          if (rule.check(m)) findings.push({ file: rel, line: idx + 1, rule: rule.name });
        }
      }
      if (matchers.length && lineHits(line, matchers)) {
        findings.push({ file: rel, line: idx + 1, rule: "term" });
      }
    }

    // A term written as `\uXXXX` escapes does not match the literal scan above.
    if (decodedLines) {
      for (const [idx, line] of decodedLines.entries()) {
        if (line === lines[idx]) continue;
        if (lineHits(line, matchers)) findings.push({ file: rel, line: idx + 1, rule: "term-escaped" });
      }
    }
  }

  // Collapse duplicates (a line can trip several rules) without hiding which rule fired.
  const seen = new Set();
  const unique = findings.filter((f) => {
    const key = `${f.file}:${f.line}:${f.rule}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length) {
    for (const f of unique) console.error(`${f.file}:${f.line}  ${f.rule}  ${MASK}`);
    const files = new Set(unique.map((f) => f.file));
    console.error(`\nprivacy-scan: ${unique.length} finding(s) in ${files.size} file(s) (${scanned} scanned).`);
    console.error("Resolve every hit before committing (AGENTS.md §1).");
    process.exit(1);
  }

  console.log(`privacy-scan: clean (${scanned} file(s), ${terms.length} term(s)).`);
}

main();
