import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/*.integration.test.ts"],
    coverage: {
      exclude: ["apps/*/src/server.ts"],
      include: [
        "adapters/*/*/src/**/*.ts",
        "apps/*/src/**/*.ts",
        "packages/*/src/**/*.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
    include: [
      "adapters/*/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
    ],
  },
});
