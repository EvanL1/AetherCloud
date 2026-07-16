import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "adapters/cloudlink/mqtt/test/**/*.integration.test.ts",
      "apps/cloudlink/test/**/*.integration.test.ts",
    ],
    testTimeout: 20_000,
  },
});
