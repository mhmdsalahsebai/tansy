import path from "node:path";
import { defineConfig } from "vitest/config";
import AuthFirst from "./tests/integration/sequencer";

export default defineConfig({
  resolve: { alias: { "server-only": path.resolve(__dirname, "tests/helpers/empty.ts"), "@/components": path.resolve(__dirname, "packages/cms/components"), "@/core": path.resolve(__dirname, "packages/cms/core"), "@/lib": path.resolve(__dirname, "packages/cms/lib"), "@/sdk": path.resolve(__dirname, "packages/cms/sdk"), "@/styles": path.resolve(__dirname, "packages/cms/styles"), "@/types": path.resolve(__dirname, "packages/cms/types"), "@": path.resolve(__dirname, "apps/starter") } },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    fileParallelism: false,
    sequence: { sequencer: AuthFirst },
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
