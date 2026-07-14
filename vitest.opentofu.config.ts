import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["adapters/infrastructure/opentofu/test/**/*.integration.test.ts"],
    testTimeout: 30_000,
  },
});
