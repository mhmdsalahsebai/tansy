#!/usr/bin/env node
/**
 * npx create-tansy <folder> [--template blank|blog|headless] [--database-url <url>] [--no-install]
 *
 * Writes its own small Next.js app rather than wrapping create-next-app, so the result
 * doesn't change when that tool's prompts or defaults do.
 *
 * --packages <folder> installs from tarballs instead of npm, to test a build before release.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const own = JSON.parse(readFileSync(path.join(import.meta.dirname, "package.json"), "utf8"));

// Must match Tansy's peer dependencies. A unit test holds them together.
export const VERSIONS = { next: "^16.4.5", react: "^19.3.0", "react-dom": "^19.3.0" };
const DEV_VERSIONS = { typescript: "^6.0.3", "@types/node": "^26.6.6", "@types/react": "^19.3.0", "@types/react-dom": "^19.3.0" };
const TEMPLATES = ["blank", "blog", "headless"];
const APP_NAME = /^[a-z0-9][a-z0-9._-]*$/;

const THEME = {
  blank: { package: "@tansy/theme-blank", call: "blank()", name: "blank" },
  // The blog theme renders the blog plugin's posts, so the plugin comes with it.
  blog: { package: "@tansy/theme-blog", call: "blog()", name: "blog", plugin: { package: "@tansy/blog", name: "blogPlugin", from: "blog", call: 'blogPlugin({ siteUrl: env.TANSY_SITE_URL ?? env.BETTER_AUTH_URL ?? "http://localhost:3000" })' } },
};

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const TSCONFIG = json({
  compilerOptions: {
    target: "ES2022",
    lib: ["dom", "dom.iterable", "esnext"],
    allowJs: true,
    skipLibCheck: true,
    strict: true,
    noEmit: true,
    esModuleInterop: true,
    module: "esnext",
    moduleResolution: "bundler",
    resolveJsonModule: true,
    isolatedModules: true,
    jsx: "react-jsx",
    incremental: true,
    plugins: [{ name: "next" }],
  },
  include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts", ".tansy/**/*.ts"],
  exclude: ["node_modules"],
});

const GITIGNORE = `node_modules
.next/
.env*
*.db
*.db-shm
*.db-wal
next-env.d.ts
*.tsbuildinfo
data/
`;

function manifest(name, template) {
  const theme = template === "blog" ? THEME.blog : THEME.blank;
  return {
    name,
    version: "0.1.0",
    private: true,
    scripts: { dev: "next dev", build: "next build", start: "next start", ...(template === "headless" ? {} : { cms: "cms" }) },
    dependencies: { next: VERSIONS.next, react: VERSIONS.react, "react-dom": VERSIONS["react-dom"], "tansy": `^${own.version}`, [theme.package]: `^${own.version}`, ...(theme.plugin ? { [theme.plugin.package]: `^${own.version}` } : {}) },
    devDependencies: DEV_VERSIONS,
  };
}

/** The app with the CMS in it. tansy init writes the rest, and keeps this config because it already exists. */
function sameAppFiles(template) {
  const theme = THEME[template];
  return {
    "next.config.ts": `import { withCms } from "tansy/next";\n\nexport default withCms({});\n`,
    "tansy.config.ts": `import { defineCms } from "tansy/config";
import { localStorage } from "tansy/storage";
import { ${theme.name} } from "${theme.package}";
${theme.plugin ? `import { ${theme.plugin.from} as ${theme.plugin.name} } from "${theme.plugin.package}";\n` : ""}
const env = process.env;

export default defineCms({
  // The public site's look. Change it here, then rebuild.
  theme: ${theme.call},
  // Plugins are npm packages added here, and they run with full access to the server.
  plugins: [${theme.plugin ? theme.plugin.call : ""}],
  // Local disk is refused in production unless explicitly allowed. s3Storage() suits any S3-compatible service.
  storage: {
    adapter: localStorage({ dir: env.UPLOADS_DIR ?? "data/uploads", allowInProduction: env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION === "true" }),
  },
});
`,
  };
}

/** A front end with no database of its own. Everything it shows comes over HTTP, with a visitor's access. */
const HEADLESS_FILES = {
  // Previews arrive with ?token= in the address, which mustn't leak to other sites through the Referer header.
  "next.config.ts": `import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["tansy", "@tansy/theme-blank"],
  headers: async () => [{ source: "/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] }],
};

export default config;
`,
  ".env.example": `# The address of your tansy server.\nCMS_URL=http://localhost:3000\n# The secret of a webhook in the CMS that posts to /api/cms-revalidate, so pages update when content changes.\nCMS_WEBHOOK_SECRET=\n`,
  "app/layout.tsx": `import type { ReactNode } from "react";

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
`,
  "app/[[...path]]/page.tsx": `import { notFound, redirect } from "next/navigation";
import { blank } from "@tansy/theme-blank";
import components from "@tansy/theme-blank/render";
import { loadSitePage, ThemedPage } from "tansy/react";
import { CmsClient } from "tansy/sdk";

// Content changes without a rebuild, and the server may not be running when this app is built.
export const dynamic = "force-dynamic";

const theme = { manifest: blank(), components };

// Reads are cached until the CMS's webhook says something changed, or for at most 5 minutes without one.
const CACHE = { tags: ["cms"], revalidate: 300 };

export default async function Page({ params, searchParams }: { params: Promise<{ path?: string[] }>; searchParams: Promise<{ token?: string; page?: string }> }) {
  if (!process.env.TANSY_URL) throw new Error("Set TANSY_URL to the address of your tansy server.");
  const client = new CmsClient({ url: process.env.TANSY_URL });
  const path = \`/\${((await params).path ?? []).join("/")}\`;
  const { token, page: pageNumber } = await searchParams;
  const page = await loadSitePage(theme, client.reader(CACHE), path, { previewToken: token, page: pageNumber });
  if (page.type === "redirect") redirect(page.to);
  if (page.type === "missing") notFound();
  return <ThemedPage theme={theme} page={page} />;
}
`,
  "app/api/cms-revalidate/route.ts": `import { createRevalidateRoute } from "tansy/headless";

// In the CMS, add a webhook for create, update and delete that posts here, and put its secret in TANSY_WEBHOOK_SECRET.
export const { POST } = createRevalidateRoute({ secret: process.env.TANSY_WEBHOOK_SECRET, tag: "cms" });
`,
};

/** A tarball is named after its package, as npm pack writes it. */
function pointAtTarballs(dependencies, folder) {
  const tarballs = readdirSync(folder).filter((name) => name.endsWith(".tgz"));
  for (const name of Object.keys(dependencies)) {
    const stem = `${name.replace(/^@/, "").replace("/", "-")}-`;
    const match = tarballs.find((file) => file.startsWith(stem) && /^\d/.test(file.slice(stem.length)));
    if (match) dependencies[name] = `file:${path.join(folder, match)}`;
  }
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        template: { type: "string", default: "blank" },
        "database-url": { type: "string", default: "file:./dev.db" },
        "no-install": { type: "boolean", default: false },
        packages: { type: "string" },
      },
    });
  } catch (error) {
    fail(error.message);
  }
  const { positionals, values } = parsed;
  if (positionals.length !== 1) fail("Usage: create-tansy <folder> [--template blank|blog|headless] [--database-url <url>] [--no-install]");
  if (!TEMPLATES.includes(values.template)) fail(`Unknown template "${values.template}". Choose ${TEMPLATES.join(", ")}.`);

  const target = path.resolve(positionals[0]);
  const name = path.basename(target);
  if (!APP_NAME.test(name)) fail(`"${name}" can't be a package name. Use lowercase letters, digits, dots, hyphens and underscores.`);
  if (existsSync(target) && readdirSync(target).length) fail(`${positionals[0]} already exists and isn't empty.`);

  const headless = values.template === "headless";
  const pkg = manifest(name, values.template);
  if (values.packages) pointAtTarballs(pkg.dependencies, path.resolve(values.packages));
  const files = { "package.json": json(pkg), "tsconfig.json": TSCONFIG, ".gitignore": GITIGNORE, ...(headless ? HEADLESS_FILES : sameAppFiles(values.template)) };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    writeFileSync(path.join(target, file), content);
  }

  const relative = path.relative(process.cwd(), target) || ".";
  if (values["no-install"]) {
    console.log(`Wrote ${relative}. Next: npm install${headless ? "" : `, npx tansy init --site, npx tansy migrate`}.`);
    return;
  }
  const inApp = { cwd: target, stdio: "inherit" };
  execFileSync("npm", ["install", "--no-audit", "--no-fund"], inApp);
  if (headless) {
    console.log(`\nCreated ${relative}.\n\n  cd ${relative}\n  cp .env.example .env.local   # then set TANSY_URL\n  npm run dev`);
    return;
  }
  const cms = path.join(target, "node_modules/.bin/tansy");
  execFileSync(cms, ["init", "--site", "--database-url", values["database-url"]], inApp);
  execFileSync(cms, ["migrate"], inApp);
  console.log(`\nCreated ${relative}.\n\n  cd ${relative}\n  npm run dev\n\nThe first-run link is printed in the server's output.`);
}

// Run directly or through npx's link, and not when a test imports the version table.
if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) main();
