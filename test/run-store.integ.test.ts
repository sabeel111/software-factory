import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunRecord } from "../src/contracts/index.js";
import { RunStore } from "../src/store/run-store.js";

const record = (runId: string): RunRecord => ({
  runId,
  batchId: "b1",
  issue: { repo: "o/r", number: 1, title: "t", body: "b", labels: [] },
  startedAt: new Date().toISOString(),
  factoryVersion: "sha",
  playbookHash: "h",
  stages: [],
});

describe("run store", () => {
  it("T0.8 a crash between temp write and rename leaves no partial line", async () => {
    const root = await mkdtemp(join(tmpdir(), "runs-"));
    const store = new RunStore(root);
    await store.append(record("r1"));
    await expect(
      store.append(record("r2"), {
        beforeRename: () => {
          throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");

    const text = await readFile(join(root, "b1", "records.jsonl"), "utf8");
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
    expect((await store.read("b1")).map((r) => r.runId)).toEqual(["r1"]);

    await store.append(record("r3"));
    expect((await store.read("b1")).map((r) => r.runId)).toEqual(["r1", "r3"]);
    const files = await readdir(join(root, "b1"));
    expect(files.filter((f) => f.endsWith(".jsonl"))).toEqual(["records.jsonl"]);
  });
});
