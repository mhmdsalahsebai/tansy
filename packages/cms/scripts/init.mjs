/**
 * Writes the files a host app owns. Safe to run again: nothing that exists is overwritten,
 * and whatever it can't change safely is printed as a step for the person to do.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeMaps } from "./sync.mjs";

const HOST_ROOT_FILE = /^(layout|page|globals|.+\.module)\.(tsx|ts|jsx|js|css)$/;
// A prerendered page can't carry the per-request nonce, so the policy would block its scripts.
const SITE_DYNAMIC = `// Added by tansy init. Pages need a per-request nonce to pass the Content Security Policy.\nexport const dynamic = "force-dynamic";\n\n`;
const NEXT_CONFIGS = ["next.config.ts", "next.config.mjs", "next.config.js"];

/** The folder an import path is written from, so templates don't depend on a host's tsconfig aliases. */
const importPath = (fromFile, toFile) => {
  const relative = path.relative(path.dirname(fromFile), toFile).replaceAll(path.sep, "/");
  return relative.startsWith("../") ? relative : `./${relative}`;
};

const rootConfig = (fromFile) => importPath(fromFile, "tansy.config");
const rootAdmin = (fromFile) => importPath(fromFile, ".tansy/admin");

/** A site at the root needs [[...path]], which can't sit beside a page that also answers "/". */
const siteFiles = (app, keepHome) => {
  const layout = `${app}/(site)/layout.tsx`;
  const page = `${app}/(site)/${keepHome ? "[...path]" : "[[...path]]"}/page.tsx`;
  return {
    [layout]: `import type { ReactNode } from "react";

${SITE_DYNAMIC.trimEnd()}

export default function SiteLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
    [page]: `import { createSiteMetadata, createSitePage } from "tansy/site";
import components from "${importPath(page, ".tansy/theme")}";
import renderers from "${importPath(page, ".tansy/render")}";
import config from "${rootConfig(page)}";

export const dynamic = "force-dynamic";

const entry = { components, renderers };

export const generateMetadata = createSiteMetadata(config, entry);
export default createSitePage(config, entry);
`,
  };
};

const hostFiles = ({ app, src, admin, api, withLanding }) => {
  const adminFolder = `${app}/(cms)/${admin.slice(1)}`;
  const shellLayout = `${adminFolder}/(shell)/layout.tsx`;
  const shellPage = `${adminFolder}/(shell)/[[...cms]]/page.tsx`;
  const shellLoading = `${adminFolder}/(shell)/[[...cms]]/loading.tsx`;
  const accountPage = `${adminFolder}/(public)/account/page.tsx`;
  const authPage = `${adminFolder}/(public)/auth/[...cms]/page.tsx`;
  const apiRoute = `${app}/${api.slice(1)}/[...cms]/route.ts`;
  const layout = `${app}/(cms)/layout.tsx`;
  const provider = `${app}/(cms)/admin-client-provider.tsx`;
  const proxy = `${src}proxy.ts`;
  const instrumentation = `${src}instrumentation.ts`;
  const landing = `${app}/(cms)/page.tsx`;
  // The matcher has to be a literal, so the API path is written into it here.
  const uploads = `${api.slice(1)}/files/upload$`;

  return {
    "tansy.config.ts": `import { defineCms } from "tansy/config";
import { localStorage } from "tansy/storage";

const env = process.env;

export default defineCms({
  // Plugins are npm packages added here, and they run with full access to the server. See docs/EXTENDING.md.
  plugins: [],
  // Local disk is refused in production unless explicitly allowed. s3Storage() suits any S3-compatible service.
  storage: {
    adapter: localStorage({ dir: env.UPLOADS_DIR ?? "data/uploads", allowInProduction: env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION === "true" }),
  },
});
`,
    [instrumentation]: `export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ startCms }, { default: config }] = await Promise.all([import("tansy/start"), import("${rootConfig(instrumentation)}")]);
  await startCms(config);
}
`,
    [proxy]: `import { createCmsProxy } from "tansy/proxy";
import cspAdditions from "${importPath(proxy, ".tansy/csp")}";

// Your own proxy goes in the second argument, as createCmsProxy(cspAdditions, { proxy: yourProxy }).
export const proxy = createCmsProxy(cspAdditions);

// Uploads skip the proxy because Next.js buffers bodies it proxies and silently cuts them off
// at 10 MB. This only sets headers and grants nothing: the route is still fully guarded.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|${uploads}).*)"],
};
`,
    [layout]: `import type { ReactNode } from "react";
import { createRootLayout, enabledPlugins } from "tansy/layout";
import config from "${rootConfig(layout)}";
import { CmsAdminClient } from "./admin-client-provider";

export { metadata } from "tansy/layout";

const RootLayout = createRootLayout(config);

export default function Layout({ children }: { children: ReactNode }) {
  return <RootLayout><CmsAdminClient enabled={enabledPlugins(config)}>{children}</CmsAdminClient></RootLayout>;
}
`,
    [provider]: `"use client";

import type { ReactNode } from "react";
import { AdminClientProvider } from "tansy/admin";
import plugins, { sitePreview } from "${importPath(provider, ".tansy/admin.client")}";

export function CmsAdminClient({ enabled, children }: { enabled: string[]; children: ReactNode }) {
  return <AdminClientProvider plugins={plugins} enabled={enabled} sitePreview={sitePreview}>{children}</AdminClientProvider>;
}
`,
    [shellLayout]: `import { createDashboardLayout } from "tansy/pages";
import admin from "${rootAdmin(shellLayout)}";
import config from "${rootConfig(shellLayout)}";

export default createDashboardLayout(config, admin);
`,
    [shellPage]: `import { createDashboardPage } from "tansy/pages";
import admin from "${rootAdmin(shellPage)}";
import config from "${rootConfig(shellPage)}";

export default createDashboardPage(config, admin);
`,
    [shellLoading]: `export { DashboardLoading as default } from "tansy/pages";
`,
    [accountPage]: `import { createAccountPage } from "tansy/public-pages";
import admin from "${rootAdmin(accountPage)}";
import config from "${rootConfig(accountPage)}";

export default createAccountPage(config, admin);
`,
    [authPage]: `import { createAuthPage } from "tansy/public-pages";
import config from "${rootConfig(authPage)}";

export default createAuthPage(config);
`,
    [apiRoute]: `import { createApiHandlers } from "tansy/routes";
import config from "${rootConfig(apiRoute)}";

export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = createApiHandlers(config);
`,
    ...(withLanding ? { [landing]: `import { createLandingPage } from "tansy/public-pages";
import config from "${rootConfig(landing)}";

export default createLandingPage(config);
` } : {}),
  };
};

/**
 * The admin brings its own root layout, so the host's has to move into a route group
 * beside it, or the admin would render inside the site's <html>.
 */
function moveSiteRoot(cwd, app, report) {
  const appDir = path.join(cwd, app);
  if (!existsSync(appDir)) return;
  const names = readdirSync(appDir).filter((name) => HOST_ROOT_FILE.test(name));
  if (!names.some((name) => name.startsWith("layout."))) return;
  const site = path.join(appDir, "(site)");
  const stuck = names.filter((name) => {
    // An import that reaches outside the files being moved would break.
    return [...readFileSync(path.join(appDir, name), "utf8").matchAll(/(?:from\s+|import\s+)["'](\.[^"']*)["']/g)].some(([, target]) => {
      const file = path.basename(target);
      return target.startsWith("../") || !names.some((candidate) => candidate === file || candidate.replace(/\.\w+$/, "") === file);
    });
  });
  if (stuck.length || existsSync(site)) {
    report.manual.push(`Move ${app}/layout and the page beside it into ${app}/(site)/ yourself. The admin has its own root layout. Couldn't do it safely: ${stuck.join(", ") || `${app}/(site) already exists`}.`);
    return;
  }
  mkdirSync(site);
  for (const name of names) {
    renameSync(path.join(appDir, name), path.join(site, name));
    report.moved.push(`${app}/${name} -> ${app}/(site)/${name}`);
  }
  const layout = names.find((name) => name.startsWith("layout."));
  writeFileSync(path.join(site, layout), `${SITE_DYNAMIC}${readFileSync(path.join(site, layout), "utf8")}`);
}

function wrapNextConfig(cwd, { admin, api }, report) {
  const isDefault = admin === "/dashboard" && api === "/api";
  const options = isDefault ? "" : `, { routes: ${JSON.stringify({ admin, api })} }`;
  const name = NEXT_CONFIGS.find((candidate) => existsSync(path.join(cwd, candidate)));
  if (!name) {
    writeFileSync(path.join(cwd, "next.config.ts"), `import { withCms } from "tansy/next";\n\nexport default withCms({}${options});\n`);
    report.written.push("next.config.ts");
    return;
  }
  const source = readFileSync(path.join(cwd, name), "utf8");
  if (source.includes("withCms")) return;
  const exported = /^export default (\w+);?\s*$/m;
  if (!exported.test(source)) {
    report.manual.push(`Wrap the config in ${name}: import { withCms } from "tansy/next", then export default withCms(yourConfig${options}).`);
    return;
  }
  writeFileSync(path.join(cwd, name), `import { withCms } from "tansy/next";\n${source.replace(exported, `export default withCms($1${options});`)}`);
  report.changed.push(name);
}

function ignoreGeneratedMaps(cwd, report) {
  const file = path.join(cwd, ".gitignore");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (existing.split(/\r?\n/).includes(".tansy/")) return;
  writeFileSync(file, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}.tansy/\n`);
  report.changed.push(".gitignore");
}

export function initHost({ cwd, admin, api, site = false }) {
  const src = existsSync(path.join(cwd, "src/app")) ? "src/" : "";
  const app = `${src}app`;
  const report = { written: [], moved: [], changed: [], kept: [], manual: [] };
  const hadPage = readdirSync(path.join(cwd, existsSync(path.join(cwd, app)) ? app : ".")).some((name) => /^page\.(tsx|jsx|ts|js)$/.test(name));

  moveSiteRoot(cwd, app, report);
  const answersRoot = (group) => existsSync(path.join(cwd, app, group)) && readdirSync(path.join(cwd, app, group)).some((name) => /^page\.(tsx|jsx|ts|js)$/.test(name));
  const keepHome = answersRoot("(site)") || answersRoot("(cms)");
  const files = {
    ...hostFiles({ app, src, admin, api, withLanding: !site && !hadPage && !existsSync(path.join(cwd, app, "(site)")) }),
    ...(site ? siteFiles(app, keepHome) : {}),
  };
  if (site && keepHome) report.manual.push(`Your existing home page stays in charge of "/". To let the theme render it, delete that page and rename ${app}/(site)/[...path] to [[...path]].`);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(cwd, file);
    if (existsSync(target)) {
      report.kept.push(file);
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    report.written.push(file);
  }
  wrapNextConfig(cwd, { admin, api }, report);
  // Empty for now, so the entry files resolve. The first dev or build fills them from the config.
  report.written.push(...writeMaps(cwd));
  ignoreGeneratedMaps(cwd, report);

  const proxy = path.join(cwd, `${src}proxy.ts`);
  if (!readFileSync(proxy, "utf8").includes("createCmsProxy")) report.manual.push(`Your ${src}proxy.ts was kept. Export createCmsProxy(cspAdditions, { proxy: yourProxy }) from tansy/proxy, or the admin has no security headers.`);
  const instrumentation = path.join(cwd, `${src}instrumentation.ts`);
  if (!readFileSync(instrumentation, "utf8").includes("startCms")) report.manual.push(`Your ${src}instrumentation.ts was kept. Call startCms(config) from tansy/start in register(), or the CMS won't start.`);
  return report;
}
