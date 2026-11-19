import { defineConfig } from "@playwright/test";

export const E2E_PORT = 3458;

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  workers: 1,
  timeout: 60_000,
  outputDir: "test-results",
  reporter: [["list"]],
  // Reference screenshots are made on demand and aren't committed. See the last test in smoke.spec.ts.
  snapshotPathTemplate: `${process.env.E2E_VISUAL_DIR ?? "test-results/visual"}/{arg}{ext}`,
  use: {
    baseURL: `http://localhost:${E2E_PORT}`,
    // Locally the installed Chrome saves a browser download. CI installs Chromium.
    channel: process.env.CI ? undefined : "chrome",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
});
