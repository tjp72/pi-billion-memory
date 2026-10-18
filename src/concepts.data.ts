/**
 * Built-in concept vocabulary — data only, no logic.
 *
 * Split from `concepts.ts` so that `scripts/check-language.mjs` can allow Chinese here as *data*
 * (search terms that must match a Chinese corpus) while still rejecting Chinese prose in code.
 * See AGENTS.md §2.
 *
 * Rules for this file:
 * - `id`, `label`, `aliases` are English. The label is what `mode: "concepts"` prints.
 * - `terms` may be Chinese where the term itself is Chinese: those strings are search payload, not
 *   human-facing text, and the Chinese retrieval strategy depends on them.
 * - No identifier of any real project, machine, person, or private repository may appear here.
 *   Terms must be generic engineering vocabulary. Personal aliases belong in the user's own
 *   `pi-billion-memory.json` under `concepts`, which is never committed.
 */

export interface ConceptDatum {
  id: string;
  label: string;
  aliases: string[];
  terms: string[];
}

export const CONCEPT_DATA: ConceptDatum[] = [
  {
    id: "compression-kernel",
    label: "compression kernel",
    aliases: ["compression", "compaction", "summarizer"],
    terms: ["压缩", "compress", "compaction", "summary", "摘要", "fold", "spill", "tier", "蒸馏", "块边界", "ref-tag"],
  },
  {
    id: "cache-integrity",
    label: "prompt cache",
    aliases: ["cache", "prefix cache", "cache hit"],
    terms: ["缓存", "cache", "前缀", "prefix", "命中率", "schema", "system_hash", "失配"],
  },
  {
    id: "injection-pointer",
    label: "injection pointer",
    aliases: ["injection", "context injection", "pointer"],
    terms: ["注入", "inject", "指针", "pointer", "白名单", "whitelist", "interjection"],
  },
  {
    id: "guard-chain",
    label: "write guard",
    aliases: ["guard", "permission gate", "guard chain"],
    terms: ["守卫", "guard", "权限矩阵", "确认", "confirm", "拦截", "sandbox"],
  },
  {
    id: "forensics",
    label: "incident forensics",
    aliases: ["forensics", "incident", "postmortem"],
    terms: ["取证", "forensic", "400", "崩溃", "crash", "根因", "日志", "wire"],
  },
  {
    id: "ab-bench",
    label: "A/B bench",
    aliases: ["A/B", "bench", "ablation"],
    terms: ["A/B", "台架", "arm", "臂", "台账", "ledger", "dry run", "对照"],
  },
  {
    id: "memory-layer",
    label: "memory layer",
    aliases: ["memory", "memory search", "retrieval"],
    terms: ["记忆", "memory", "sidecar", "FTS5", "SQLite", "入库", "ingest", "timeline"],
  },
  {
    id: "governance",
    label: "governance",
    aliases: ["process", "working agreement", "review process"],
    terms: ["治理", "governance", "AGENTS.md", "DoD", "worktree", "review", "plan"],
  },
  {
    id: "release-engineering",
    label: "release engineering",
    aliases: ["release", "shipping", "versioning"],
    terms: ["发布", "release", "tag", "CI", "publish", "dist", "校验"],
  },
  {
    id: "cross-repo",
    label: "cross-repo migration",
    aliases: ["cross-repo", "cross repo", "repo migration"],
    terms: ["跨仓", "跨仓迁移", "cross-repo", "repo migration", "monorepo"],
  },
];
