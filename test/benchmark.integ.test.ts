import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import {
  commitAll,
  git,
  loadIssues,
  prepareBenchRepo,
  type BenchIssue,
  type PreparedBench,
} from "../src/bench/benchmark.js";
import { scoreCandidate } from "../src/bench/score.js";

const exec = promisify(execFile);

let bench: PreparedBench;
let issues: BenchIssue[];

beforeAll(async () => {
  bench = await prepareBenchRepo(await mkdtemp(join(tmpdir(), "bench-")));
  issues = await loadIssues();
});

describe("benchmark fixture", () => {
  it("T1.1 the baseline repo passes its visible test suite", async () => {
    const { stdout } = await exec("npm", ["test"], { cwd: bench.dir });
    expect(stdout).toMatch(/# fail 0/);
  });

  it("T1.2 the baseline fails every hidden test file", async () => {
    const score = await scoreCandidate({ repo: bench.dir, candidateRef: "main", issues });
    expect(score.total).toBe(9);
    for (const p of score.perIssue) expect(p.passed, `issue ${p.issue} should fail on baseline`).toBe(false);
  });

  it("T1.3 each reference solution passes its own hidden test", async () => {
    for (const issue of issues.filter((i) => i.hidden)) {
      const ref = bench.referenceBranches[String(issue.number).padStart(2, "0")]!;
      const score = await scoreCandidate({ repo: bench.dir, candidateRef: ref, issues: [issue] });
      expect(score.perIssue[0]!.passed, `${ref}: ${score.perIssue[0]!.outputTail}`).toBe(true);
    }
  });

  it("T1.4 all reference solutions merged resolve 9/9", async () => {
    const score = await scoreCandidate({
      repo: bench.dir,
      candidateRef: bench.referenceBranches.all!,
      issues,
    });
    expect(score.resolved).toBe(9);
    expect(score.resolveRate).toBe(1);
    const { stdout } = await exec("git", ["checkout", "-q", bench.referenceBranches.all!], {
      cwd: bench.dir,
    });
    void stdout;
    const visible = await exec("npm", ["test"], { cwd: bench.dir });
    expect(visible.stdout).toMatch(/# fail 0/);
    await git(bench.dir, "checkout", "-q", "main");
  });

  it("T1.6 a candidate cannot shadow hidden tests with its own files", async () => {
    await git(bench.dir, "checkout", "-q", "-b", "cheat", "main");
    await mkdir(join(bench.dir, "hidden"), { recursive: true });
    await writeFile(
      join(bench.dir, "hidden", "h01.test.ts"),
      `import { it } from "node:test";\nit("always passes", () => {});\n`,
    );
    await commitAll(bench.dir, "cheat");
    await git(bench.dir, "checkout", "-q", "main");
    const issue1 = issues.filter((i) => i.number === 1);
    const score = await scoreCandidate({ repo: bench.dir, candidateRef: "cheat", issues: issue1 });
    expect(score.perIssue[0]!.passed).toBe(false);
  });

  it("T1.8 scoring the same candidate twice gives identical per-issue results", async () => {
    const ref = bench.referenceBranches["05"]!;
    const a = await scoreCandidate({ repo: bench.dir, candidateRef: ref, issues });
    const b = await scoreCandidate({ repo: bench.dir, candidateRef: ref, issues });
    expect(a.perIssue.map((p) => [p.issue, p.passed])).toEqual(b.perIssue.map((p) => [p.issue, p.passed]));
    expect(a.candidateSha).toBe(b.candidateSha);
  });
});
