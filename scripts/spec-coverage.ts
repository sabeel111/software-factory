// Cross-checks spec test IDs (T<phase>.<n>) against test titles (specs/01-foundations.md R0.9).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CoverageReport {
  specIds: string[];
  missing: string[];
  pending: string[];
  covered: string[];
}

const ID = /\bT\d+\.\d+\b/g;

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules") continue;
    if (statSync(p).isDirectory()) out.push(...walk(p, ext));
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

export function specIds(specText: string): string[] {
  // Only IDs that head a table row ("| T0.1 |") are definitions; other mentions are references.
  const ids = new Set<string>();
  for (const m of specText.matchAll(/^\|\s*(T\d+\.\d+)\s*\|/gm)) ids.add(m[1]!);
  return [...ids];
}

export function coverage(specTexts: string[], testTexts: string[]): CoverageReport {
  const all = [...new Set(specTexts.flatMap(specIds))].sort(byId);
  const present = new Set<string>();
  const pending = new Set<string>();
  const title = /\b(it|test)(\.skip|\.todo|\.skipIf\([^)]*\)|\.runIf\([^)]*\))?\(\s*["'`]([^"'`]*)/g;
  for (const text of testTexts) {
    // A whole suite behind describe.skipIf/runIf is environment-gated (e2e, docker).
    const gatedSuite = /\bdescribe\.(skipIf|runIf|skip)\(/.test(text);
    for (const m of text.matchAll(title)) {
      const modifier = (m[2] ?? "") || (gatedSuite ? ".skipIf" : "");
      for (const id of m[3]!.match(ID) ?? []) {
        present.add(id);
        // skipIf/runIf tests are environment-gated (e2e, docker): report them as pending.
        if (modifier) pending.add(id);
      }
    }
  }
  return {
    specIds: all,
    missing: all.filter((id) => !present.has(id)),
    pending: all.filter((id) => pending.has(id)),
    covered: all.filter((id) => present.has(id) && !pending.has(id)),
  };
}

function byId(a: string, b: string): number {
  const [pa, na] = a.slice(1).split(".").map(Number);
  const [pb, nb] = b.slice(1).split(".").map(Number);
  return pa! - pb! || na! - nb!;
}

export function run(specDir = "specs", testDir = "test"): number {
  const specs = walk(specDir, ".md").map((f) => readFileSync(f, "utf8"));
  const tests = walk(testDir, ".ts").map((f) => readFileSync(f, "utf8"));
  const r = coverage(specs, tests);
  console.log(
    `Spec test IDs: ${r.specIds.length}  covered: ${r.covered.length}  pending: ${r.pending.length}  missing: ${r.missing.length}`,
  );
  if (r.pending.length) console.log(`Pending (conditionally skipped): ${r.pending.join(", ")}`);
  if (r.missing.length) {
    console.error(`Missing tests for: ${r.missing.join(", ")}`);
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run(process.argv[2], process.argv[3]));
}
