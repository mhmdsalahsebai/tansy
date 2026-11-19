import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@/components": path.resolve(__dirname, "packages/cms/components"),
      "@/core": path.resolve(__dirname, "packages/cms/core"),
      "@/lib": path.resolve(__dirname, "packages/cms/lib"),
      "@/sdk": path.resolve(__dirname, "packages/cms/sdk"),
      "@/styles": path.resolve(__dirname, "packages/cms/styles"),
      "@/types": path.resolve(__dirname, "packages/cms/types"),
      "@": path.resolve(__dirname, "apps/starter"),
      "server-only": path.resolve(__dirname, "tests/helpers/empty.ts"),
      "next/font/local": path.resolve(__dirname, "tests/helpers/local-font.ts"),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/contract/**/*.test.ts"],
    setupFiles: ["tests/helpers/provide-config.ts"],
    env: { BETTER_AUTH_SECRET: "unit-test-secret-unit-test-secret", DATABASE_URL: "file::memory:", BETTER_AUTH_URL: "http://localhost:3000" },
    /**
     * One worker per test file is the default, and this suite has over eighty: dozens of
     * copies of Next, Prisma and sharp at once need more memory than a developer's machine
     * has, and the swapping starves plain assertions into their timeouts. Four workers run
     * the suite in about the same time and make it say the same thing every run.
     */
    maxWorkers: 4,
    /** Not for slow tests: for a worker that waits its turn. The CLI tests also spawn node. */
    testTimeout: 15_000,
  },
});
