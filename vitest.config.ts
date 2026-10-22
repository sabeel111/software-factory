import { defineConfig } from "vitest/config";

const tier = (name: string, timeout: number) => ({
  test: { name, include: [`test/**/*.${name}.test.ts`], testTimeout: timeout, hookTimeout: timeout },
});

export default defineConfig({
  test: {
    projects: [
      tier("unit", 10_000),
      tier("integ", 120_000),
      tier("contract", 10_000),
      tier("e2e", 1_800_000),
    ],
  },
});
