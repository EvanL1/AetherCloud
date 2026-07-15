import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["adapters/fleet/postgres/test/**/*.integration.test.ts"],
    testTimeout: 20_000,
  },
});
