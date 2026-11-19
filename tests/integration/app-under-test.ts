import path from "node:path";

// Unset for the clone install. tests/package/run.mjs points it at a fresh app with the tarball installed.
const host = process.env.TANSY_TEST_APP;

export const IS_HOST_INSTALL = Boolean(host);
export const APP_DIR = host ? path.resolve(host) : path.resolve("apps/starter");
export const CLI = path.join(host ? path.resolve(host, "node_modules/tansy") : path.resolve("packages/cms"), "scripts/tansy.mjs");
