// Runs the full factory against the benchmark (implemented in Phase 4/5).
import type { BenchIssue, PreparedBench, Split } from "./benchmark.js";

export interface FactoryBenchOptions {
  bench: PreparedBench;
  issues: BenchIssue[];
  split: Split;
  repeat: number;
  configPath?: string;
}

export async function runFactoryBenchmark(_opts: FactoryBenchOptions): Promise<number> {
  console.error(
    "factory bench: running the factory needs the pipeline (Phase 4); use --reference or --candidate",
  );
  return 2;
}
