import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      PAPER_ONLY: "true",
      LIVE_FUNDS_ENABLED: "false",
    },
    include: ["test/**/*.test.ts"],
    coverage: { enabled: false },
    testTimeout: 10_000,
    hookTimeout: 10_000,
    sequence: { concurrent: false },
  },
});
