/**
 * Enforces docs/contributing/security-model.md. A failure here means new code bypasses the
 * auth model: fix the code, don't relax the test.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { admin } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { describe, expect, it } from "vitest";
import { ROUTE_POLICY, type RoutePolicy } from "@/core/authz/guard";
import { ALLOWED_ADMIN_HTTP_PATHS, SERVER_ONLY_PATHS } from "@/core/auth/server-only-paths";
import { apiRoutes } from "../../packages/cms/routes/api-table.generated";
import { authPages, dashboardPages } from "../../packages/cms/routes/pages-table.generated";

const ROOT = path.resolve(__dirname, "../../apps/starter");
const PACKAGE = path.resolve(__dirname, "../../packages/cms");
const HOST_ADMIN = "app/(cms)/dashboard";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const routePath = (file: string) => "/" + path.relative(path.join(PACKAGE, "app"), path.dirname(file)).replaceAll(path.sep, "/");
const dashboardFiles = () => walk(path.join(PACKAGE, "app/dashboard")).filter((f) => path.basename(f) === "page.tsx");
const routeFiles = () => walk(path.join(PACKAGE, "app/api")).filter((f) => path.basename(f) === "route.ts");

/** Adding a public route means adding it here, in a reviewed diff. */
const PUBLIC_ROUTES = ["GET /api/auth-config", "GET /api/background", "GET /api/auth/[...all]", "GET /api/ext/[...path]", "GET /api/health", "GET /api/locales", "GET /api/preview/exit", "GET /api/ready", "POST /api/ext/[...path]", "PUT /api/ext/[...path]", "PATCH /api/ext/[...path]", "DELETE /api/ext/[...path]", "GET /api/realtime", "POST /api/auth/[...all]", "POST /api/setup"];

/** Writes that deliberately don't get an audit entry. */
const UNAUDITED_WRITES: string[] = [];

async function loadPolicies() {
  const policies: Record<string, RoutePolicy> = {};
  for (const file of routeFiles()) {
    const exported = await import(file);
    for (const [name, handler] of Object.entries(exported)) {
      expect(METHODS, `${file} exports "${name}", which isn't an HTTP method`).toContain(name);
      const policy = (handler as Record<symbol, RoutePolicy>)[ROUTE_POLICY];
      expect(policy, `${name} ${routePath(file)} is not wrapped in route()`).toBeDefined();
      policies[`${name} ${routePath(file)}`] = policy;
    }
  }
  return policies;
}

describe("API routes", () => {
  it("are all guarded, and match the reviewed access manifest", async () => {
    const policies = await loadPolicies();
    const sorted = Object.fromEntries(Object.entries(policies).sort(([a], [b]) => a.localeCompare(b)));
    await expect(JSON.stringify(sorted, null, 2) + "\n").toMatchFileSnapshot("./access-manifest.json");
  });

  it("are public only when explicitly allowlisted, with a reason", async () => {
    const policies = await loadPolicies();
    const open = Object.entries(policies).filter(([, p]) => p.access === "public");
    expect(open.map(([key]) => key).sort()).toEqual([...PUBLIC_ROUTES].sort());
    for (const [key, policy] of open) expect(policy.reason, key).toBeTruthy();
  });

  it("audit every permission-checked write", async () => {
    const policies = await loadPolicies();
    for (const [key, policy] of Object.entries(policies)) {
      const write = !key.startsWith("GET ") && policy.access !== "public";
      if (write && !UNAUDITED_WRITES.includes(key)) expect(policy.audit, `${key} has no audit action`).toBeTruthy();
    }
  });

  it("require a fresh session for the most sensitive operations", async () => {
    const policies = await loadPolicies();
    for (const key of ["PUT /api/users/[id]/role", "PUT /api/users/[id]/password", "DELETE /api/users/[id]", "POST /api/users/[id]/impersonate", "PUT /api/settings/auth", "POST /api/roles", "PUT /api/roles/[name]", "DELETE /api/roles/[name]", "POST /api/account/api-keys", "PUT /api/collections/[id]/rules", "POST /api/webhooks", "PATCH /api/webhooks/[id]", "DELETE /api/webhooks/[id]", "POST /api/schema/import"]) {
      expect(policies[key]?.fresh, key).toBe(true);
    }
  });

  it("never accept API keys on management endpoints", async () => {
    const policies = await loadPolicies();
    for (const [key, policy] of Object.entries(policies)) {
      if (/\/api\/(users|roles|settings|audit|account|setup|webhooks|schema\/(import|export))/.test(key)) expect(policy.apiKey, key).toBe(false);
    }
  });

  it("that use API rules actually evaluate them", () => {
    for (const file of routeFiles()) {
      const source = readFileSync(file, "utf8");
      const handlers = source.match(/access: "rules"/g)?.length ?? 0;
      const checks = source.match(/\b(authorizeRecord|decideRecord)\(/g)?.length ?? 0;
      expect(checks, `${file}: every rules route must call authorizeRecord or decideRecord`).toBeGreaterThanOrEqual(handlers);
    }
  });
});

describe("route table", () => {
  it("serves exactly the route files on disk, each one from its own file", async () => {
    const onDisk = routeFiles().map((file) => routePath(file).replace("/api/", "")).sort();
    expect(apiRoutes.map((entry) => entry.pattern).sort()).toEqual(onDisk);
    for (const entry of apiRoutes) {
      const fromFile = await import(path.join(PACKAGE, "app/api", entry.pattern, "route.ts"));
      expect(await entry.load(), entry.pattern).toBe(fromFile);
    }
  });

  it("is the only API route in the app, so nothing skips the guard beside it", () => {
    const hostRoutes = walk(path.join(ROOT, "app/api")).filter((f) => path.basename(f) === "route.ts").map((f) => path.relative(ROOT, f).replaceAll(path.sep, "/"));
    expect(hostRoutes).toEqual(["app/api/[...cms]/route.ts"]);
    expect(readFileSync(path.join(ROOT, hostRoutes[0]), "utf8")).toMatch(/createApiHandlers\(config\)/);
  });
});

describe("dashboard page table", () => {
  it("serves exactly the page files on disk", () => {
    const onDisk = dashboardFiles().map((file) => path.relative(path.join(PACKAGE, "app/dashboard"), path.dirname(file)).replaceAll(path.sep, "/")).sort();
    expect(dashboardPages.map((entry) => entry.pattern).sort()).toEqual(onDisk);
  });

  it("is the only dashboard page in the app, so nothing skips requirePage beside it", () => {
    const host = walk(path.join(ROOT, HOST_ADMIN)).filter((f) => path.basename(f) === "page.tsx").map((f) => path.relative(ROOT, f).replaceAll(path.sep, "/"));
    expect(host.sort()).toEqual([`${HOST_ADMIN}/(public)/account/page.tsx`, `${HOST_ADMIN}/(public)/auth/[...cms]/page.tsx`, `${HOST_ADMIN}/(shell)/[[...cms]]/page.tsx`]);
    expect(readFileSync(path.join(ROOT, `${HOST_ADMIN}/(shell)/[[...cms]]/page.tsx`), "utf8")).toMatch(/createDashboardPage\(config, admin\)/);
    expect(readFileSync(path.join(ROOT, `${HOST_ADMIN}/(public)/account/page.tsx`), "utf8")).toMatch(/createAccountPage\(config, admin\)/);
    expect(readFileSync(path.join(ROOT, `${HOST_ADMIN}/(public)/auth/[...cms]/page.tsx`), "utf8")).toMatch(/createAuthPage\(config\)/);
  });

  it("serves exactly the sign-in pages on disk, and nothing that belongs behind a session", () => {
    const onDisk = walk(path.join(PACKAGE, "app/auth")).filter((f) => path.basename(f) === "page.tsx").map((f) => path.relative(path.join(PACKAGE, "app/auth"), path.dirname(f)).replaceAll(path.sep, "/")).sort();
    expect(authPages.map((entry) => entry.pattern).sort()).toEqual(onDisk);
    expect(onDisk).toEqual(["forgot-password", "reset-password", "setup", "signin", "signup", "two-factor"]);
  });

  it("load client code on demand, so one page's code doesn't reach every page", () => {
    const allowed = ["components/ui/kit.tsx"];
    for (const file of dashboardFiles()) {
      for (const [, target] of readFileSync(file, "utf8").matchAll(/^import (?!type )[^\n]*from "(\.[^"]+)";$/gm)) {
        const base = path.resolve(path.dirname(file), target);
        const resolved = [`${base}.tsx`, `${base}.ts`, path.join(base, "index.ts")].find((candidate) => { try { return statSync(candidate).isFile(); } catch { return false; } });
        expect(resolved, `${file}: ${target}`).toBeDefined();
        if (allowed.some((name) => resolved!.endsWith(name))) continue;
        expect(readFileSync(resolved!, "utf8").trimStart().startsWith('"use client"'), `${file} imports the client component ${target}. Use clientPage().`).toBe(false);
      }
    }
  });
});

describe("pages", () => {
  it("under /dashboard are server components that call requirePage", () => {
    for (const file of dashboardFiles()) {
      const source = readFileSync(file, "utf8");
      expect(source.trimStart().startsWith('"use client"'), `${file} must be a server component`).toBe(false);
      expect(source, `${file} must call requirePage()`).toMatch(/\brequirePage\(/);
    }
  });

  it("under /account call requireUser", () => {
    for (const file of walk(path.join(PACKAGE, "app/account")).filter((f) => path.basename(f) === "page.tsx")) {
      expect(readFileSync(file, "utf8"), `${file} must call requireUser()`).toMatch(/\brequireUser\(/);
    }
  });
});

describe("better-auth surface", () => {
  it("closes every admin and API-key HTTP endpoint unless explicitly allowed", () => {
    const endpoints = [...Object.values(admin().endpoints), ...Object.values(apiKey().endpoints)];
    const paths = endpoints.map((e) => (e as { path?: string }).path).filter((p): p is string => Boolean(p));
    expect(paths.length).toBeGreaterThan(10);
    for (const p of paths) {
      if (!ALLOWED_ADMIN_HTTP_PATHS.includes(p)) expect(SERVER_ONLY_PATHS, `${p} is reachable over HTTP`).toContain(p);
    }
  });
});
