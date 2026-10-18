#!/usr/bin/env node
/**
 * Language check — AGENTS.md §2, made mechanical.
 *
 * §2 says all human-facing content is English, with exactly two sanctioned exceptions
 * (`README.zh-CN.md` and fixture data in `tests/self-test.test.ts`). It also names runtime strings
 * among the things that must be English. The 0.6.1 change broke that rule in `src/` and `dist/`
 * and nothing noticed, because the rule lived only in prose.
 *
 * Scope: `src/` only. `dist/` is generated from `src/`, and `npm run verify:dist` fails if the
 * committed bundle differs from a fresh build — so a clean `src/` implies a clean `dist/`, while a
 * dirty `src/` cannot reach a release unnoticed. Scanning the bundle as well would only add false
 * positives: the CJK character classes in `src/cjk.ts` are compiled into regex literals, and they
 * are data the retrieval strategy needs, not prose.
 *
 * The boundary is drawn by *file*, not by judgement:
 *
 *   allowed  tests/**                 fixtures exercise Chinese retrieval
 *            src/cjk.ts              Chinese tokens, regexes, delimiters — data, no prose
 *
 * That source file is named explicitly rather than pattern-matched, so adding a new Chinese data
 * module is a visible edit to this list instead of an accident.
 *
 * Exit codes: 0 clean, 1 findings.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

/** CJK ideographs, CJK punctuation, and fullwidth forms. */
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

const ALLOWED_FILES = new Set(["src/cjk.ts"]);

const ALLOWED_PREFIXES = ["tests/"];

function allowed(rel) {
  if (ALLOWED_FILES.has(rel)) return true;
  return ALLOWED_PREFIXES.some((p) => rel.startsWith(p));
}

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

/** Show a few of the offending characters so the fix is locatable without dumping the line. */
function preview(line, limit = 12) {
  return (line.match(CJK) || []).slice(0, limit).join("");
}

function main() {
  const findings = [];
  let scanned = 0;

  for (const rel of trackedFiles()) {
    if (!rel.startsWith("src/")) continue;
    if (allowed(rel)) continue;
    if (!rel.endsWith(".ts")) continue;

    let text;
    try {
      text = fs.readFileSync(rel, "utf8");
    } catch {
      continue;
    }
    scanned++;

    for (const [idx, line] of text.split(/\r?\n/).entries()) {
      const found = line.match(CJK);
      if (!found) continue;
      findings.push({ file: rel, line: idx + 1, count: found.length, sample: preview(line) });
    }
  }

  if (findings.length) {
    for (const f of findings) {
      console.error(`${f.file}:${f.line}  ${f.count} CJK char(s)  ${f.sample}`);
    }
    const files = new Set(findings.map((f) => f.file));
    console.error(
      `\nlanguage-check: ${findings.length} line(s) in ${files.size} file(s) contain CJK outside the allowed set.`,
    );
    console.error("AGENTS.md §2: move prose to README.zh-CN.md or translate it; keep CJK data in src/cjk.ts.");
    process.exit(1);
  }

  console.log(`language-check: clean (${scanned} file(s) under src/).`);
}

main();
