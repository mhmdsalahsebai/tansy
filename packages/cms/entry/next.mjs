/**
 * Used from next.config.ts, which Node loads before anything is compiled, so this file
 * and what it imports stay plain JavaScript.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { hasCmsConfig, sync, syncedPackages, syncedRootFiles } from "../scripts/sync.mjs";

const DEFAULTS = { admin: "/dashboard", api: "/api" };
const PATH = /^(\/[a-z0-9][a-z0-9-]*)+$/;
// Packages that load native code or files of their own, so they can't be bundled.
const EXTERNAL = ["argon2", "libpg-query", "better-sqlite3", "sharp"];

export function resolveRoutes(routes = {}) {
  const resolved = { ...DEFAULTS, ...routes };
  for (const [name, value] of Object.entries(resolved)) {
    if (!PATH.test(value) || value === "/_next" || value.startsWith("/_next/")) throw new Error(`routes.${name} must look like "/admin", in lowercase, and can't be under /_next. Got "${value}".`);
  }
  const { admin, api } = resolved;
  if (admin === api || admin.startsWith(`${api}/`) || api.startsWith(`${admin}/`)) throw new Error(`routes.admin ("${admin}") and routes.api ("${api}") can't overlap.`);
  return resolved;
}

/** Each path is a real folder in the app, so a setting without its folder would serve nothing. */
function assertFolders({ admin, api }, cwd) {
  const app = ["app", "src/app"].map((dir) => path.join(cwd, dir)).find(existsSync);
  if (!app) return;
  const adminFolder = path.join(app, "(cms)", admin.slice(1), "(shell)");
  const apiFolder = path.join(app, api.slice(1), "[...cms]");
  for (const folder of [adminFolder, apiFolder]) {
    if (!existsSync(folder)) throw new Error(`routes in withCms() don't match the app: ${path.relative(cwd, folder)} doesn't exist. Rename the folder or change the setting.`);
  }
}

async function withRootFileFallback(rewrites, api, declared) {
  const existing = (await rewrites?.()) ?? [];
  const groups = Array.isArray(existing) ? { beforeFiles: [], afterFiles: existing, fallback: [] } : existing;
  // A file name at the site root, such as /sitemap.xml, can be served by an extension route.
  // Fallback runs only after every page and static file, and the route is still guarded.
  const fallback = { source: "/:file([^/]+\\.[A-Za-z0-9]+)", destination: `${api}/ext/:file` };
  // A site's catch-all page matches before fallback does, so the files plugins declare go ahead of
  // dynamic routes, by exact name. A real page or file in public/ still wins, and any other
  // address with a dot in it stays free for the site.
  const named = declared.map((file) => ({ source: file, destination: `${api}/ext${file}` }));
  return { ...groups, afterFiles: [...named, ...(groups.afterFiles ?? [])], fallback: [...(groups.fallback ?? []), fallback] };
}

// The proxy sets the full set. These cover what it skips: static files and uploads.
const BASE_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
];

/**
 * In dev and build. Failing here fails the build, so it can't ship stale maps.
 * `next start` uses what the build made, and Next.js's own workers inherit TANSY_SYNCED.
 */
function syncMaps(cwd) {
  if (process.env.TANSY_SYNCED || process.argv[2] === "start" || !hasCmsConfig(cwd)) return;
  sync({ cwd });
  process.env.TANSY_SYNCED = "true";
}

export function withCms(nextConfig = {}, { routes, cwd = process.cwd() } = {}) {
  const resolved = resolveRoutes(routes);
  assertFolders(resolved, cwd);
  syncMaps(cwd);
  if (nextConfig.cacheComponents || nextConfig.partialPrefetching) {
    console.warn("tansy: turning off cacheComponents and partialPrefetching. Every page carries a per-request Content Security Policy nonce, which a prerendered page can't.");
  }
  return {
    poweredByHeader: false,
    ...nextConfig,
    cacheComponents: false,
    partialPrefetching: false,
    // In the browser bundle too, where tansy.config.ts can't reach.
    env: { ...nextConfig.env, NEXT_PUBLIC_TANSY_ADMIN_PATH: resolved.admin, NEXT_PUBLIC_TANSY_API_PATH: resolved.api },
    transpilePackages: [...new Set(["tansy", ...syncedPackages(cwd), ...(nextConfig.transpilePackages ?? [])])],
    serverExternalPackages: [...new Set([...EXTERNAL, ...(nextConfig.serverExternalPackages ?? [])])],
    rewrites: () => withRootFileFallback(nextConfig.rewrites, resolved.api, syncedRootFiles(cwd)),
    headers: async () => [{ source: "/:path*", headers: BASE_HEADERS }, ...((await nextConfig.headers?.()) ?? [])],
  };
}
