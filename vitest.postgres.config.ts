import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["adapters/*/postgres/test/**/*.integration.test.ts"],
    testTimeout: 20_000,
  },
});
