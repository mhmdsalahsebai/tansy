#!/usr/bin/env node
/**
 * npm create tansy@latest [folder] [options]
 *
 * In a terminal it asks for whatever the flags leave out. With --yes, or anywhere without a
 * terminal (CI, a script), it asks nothing and takes the defaults: a site with the blank theme,
 * SQLite, uploads on local disk, no extra plugins.
 *
 *   --template site|headless          blank and blog still work, as site with that theme
 *   --theme blank|blog|magazine|halo|dispatch|storefront|academy
 *   --payments <provider>             for themes that sell: stripe, polar, dodo, creem, commet
 *   --host local|server|serverless    where it will run, which rules out what can't work there
 *   --database sqlite|postgres|docker docker writes docker-compose.yml and starts Postgres
 *   --database-url <url>              a Postgres URL, or a file: URL for SQLite
 *   --storage local|s3|vercel-blob
 *   --plugins email:resend,forms,...  see OPTIONAL_PLUGINS in plan.mjs
 *   --admin-email <email>             create the superadmin, with TANSY_ADMIN_PASSWORD when not asked
 *   --cms-url <url>                   the server a headless front end reads
 *   --git / --no-git                  start a repository. Asked in a terminal, off otherwise
 *   --no-install                      write the files and stop
 *   --yes                             ask nothing
 *
 * Writes its own small Next.js app rather than wrapping create-next-app, so the result
 * doesn't change when that tool's prompts or defaults do.
 *
 * --packages <folder> installs from tarballs instead of npm, to test a build before release.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  composeFile, DATABASES, dependenciesFor, cmsConfig, dockerDatabaseUrl, envAdditions, folderProblem, HOSTS, NATIVE, newPostgresPassword,
  packageManager, parsePlugin, POSTGRES_URL, problems, PROVIDERS, runScript, STORAGES, TEMPLATES, THEMES, VERCEL_JSON,
} from "./plan.mjs";

const own = JSON.parse(readFileSync(path.join(import.meta.dirname, "package.json"), "utf8"));

// Must match Tansy's peer dependencies. A unit test holds them together.
export const VERSIONS = { next: "^16.4.6", react: "^19.3.0", "react-dom": "^19.3.0" };
const DEV_VERSIONS = { typescript: "^6.0.3", "@types/node": "^26.6.6", "@types/react": "^19.3.0", "@types/react-dom": "^19.3.0" };
const LEGACY_TEMPLATES = { blank: "blank", blog: "blog" };
const SQLITE_URL = "file:./dev.db";
const LOCAL_URL = "http://localhost:3000";

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

function manifest(name, plan, pm) {
  return {
    name,
    version: "0.1.0",
    private: true,
    scripts: { dev: "next dev", build: "next build", start: "next start", ...(plan.template === "headless" ? {} : { tansy: "tansy" }) },
    dependencies: { next: VERSIONS.next, react: VERSIONS.react, "react-dom": VERSIONS["react-dom"], ...dependenciesFor(plan, own.version) },
    devDependencies: DEV_VERSIONS,
    // Both skip install scripts unless told which may run, and the CMS has native modules to build.
    ...(pm === "pnpm" ? { pnpm: { onlyBuiltDependencies: NATIVE } } : {}),
    ...(pm === "bun" ? { trustedDependencies: NATIVE } : {}),
  };
}

/** The app with the CMS in it. tansy init writes the rest, and keeps this config because it already exists. */
const siteFiles = (plan) => ({
  "next.config.ts": `import { withCms } from "tansy/next";\n\nexport default withCms({});\n`,
  "tansy.config.ts": cmsConfig(plan),
  ...(plan.database === "docker" ? { "docker-compose.yml": composeFile(plan.name) } : {}),
  ...(plan.host === "serverless" ? { "vercel.json": VERCEL_JSON } : {}),
});

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
  ".env.example": `# The address of your tansy server.\nTANSY_URL=${LOCAL_URL}\n# The secret of a webhook in the CMS that posts to /api/cms-revalidate, so pages update when content changes.\nTANSY_WEBHOOK_SECRET=\n`,
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

const oneOf = (flag, value, allowed) => {
  if (value !== undefined && !allowed.includes(value)) fail(`Unknown ${flag} "${value}". Choose ${allowed.join(", ")}.`);
  return value;
};

/** What the flags answered. Anything left undefined is asked in a terminal, or defaulted. */
function fromFlags(values, positionals) {
  const given = { folder: positionals[0] };
  let template = values.template;
  if (template && LEGACY_TEMPLATES[template]) {
    given.theme = LEGACY_TEMPLATES[template];
    template = "site";
  }
  given.template = oneOf("template", template, TEMPLATES);
  given.theme = oneOf("theme", values.theme ?? given.theme, Object.keys(THEMES));
  given.payments = oneOf("payment provider", values.payments, Object.keys(PROVIDERS.payments));
  given.host = oneOf("host", values.host, HOSTS);
  given.database = oneOf("database", values.database, DATABASES);
  given.storage = oneOf("storage", values.storage, STORAGES);
  const url = values["database-url"];
  if (url) {
    if (!POSTGRES_URL.test(url) && !url.startsWith("file:")) fail("--database-url takes a postgres:// URL, or a file: URL for SQLite.");
    const kind = POSTGRES_URL.test(url) ? "postgres" : "sqlite";
    if (given.database && given.database !== kind) fail(`--database ${given.database} doesn't match --database-url.`);
    given.database = kind;
    given.databaseUrl = url;
  }
  if (values.plugins !== undefined) {
    try {
      given.plugins = values.plugins.split(",").map((spec) => spec.trim()).filter(Boolean).map(parsePlugin);
    } catch (error) {
      fail(error.message);
    }
  }
  if (values["admin-email"] !== undefined) {
    if (!/^[^@\s]+@[^@\s]+$/.test(values["admin-email"])) fail(`"${values["admin-email"]}" isn't an email address.`);
    given.adminEmail = values["admin-email"].toLowerCase();
  }
  given.cmsUrl = values["cms-url"];
  given.git = values.git;
  return given;
}

/** The answers nobody gave: what pressing Enter at every question would choose. */
function withDefaults(given) {
  const plan = { ...given };
  plan.template ??= "site";
  plan.theme ??= "blank";
  plan.host ??= "local";
  plan.database ??= plan.host === "local" ? "sqlite" : "postgres";
  if (plan.database === "postgres" && !plan.databaseUrl) fail("Postgres needs --database-url, or --database docker to start one.");
  plan.storage ??= plan.host === "serverless" ? "s3" : "local";
  plan.plugins ??= [];
  plan.adminEmail ??= null;
  plan.git ??= false;
  return plan;
}

function main(ask) {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      allowNegative: true,
      options: {
        template: { type: "string" },
        theme: { type: "string" },
        payments: { type: "string" },
        host: { type: "string" },
        database: { type: "string" },
        "database-url": { type: "string" },
        storage: { type: "string" },
        plugins: { type: "string" },
        "admin-email": { type: "string" },
        "cms-url": { type: "string" },
        git: { type: "boolean" },
        install: { type: "boolean", default: true },
        yes: { type: "boolean", short: "y", default: false },
        packages: { type: "string" },
      },
    });
  } catch (error) {
    fail(error.message);
  }
  const { positionals, values } = parsed;
  if (positionals.length > 1) fail("Usage: create-tansy [folder] [--template site|headless] [--theme <name>] [--database sqlite|postgres|docker] [--yes]");
  const given = fromFlags(values, positionals);
  const interactive = !values.yes && process.stdin.isTTY && process.stdout.isTTY && !process.env.CI;
  if (!interactive && !given.folder) fail("Name a folder: create-tansy <folder>. Run it in a terminal to be asked instead.");
  return create(interactive ? ask(given) : given, { interactive, install: values.install, packages: values.packages });
}

async function create(answers, { interactive, install, packages }) {
  const p = interactive ? (await import("./ask.mjs")).prompts : undefined;
  const plan = withDefaults(await answers);
  const say = interactive ? { step: p.log.step, warn: p.log.warn, done: (text) => p.outro(text) } : { step: console.log, warn: console.warn, done: console.log };

  const target = path.resolve(plan.folder);
  plan.name = path.basename(target);
  const problem = folderProblem(plan.folder);
  if (problem) fail(problem);
  const conflicts = problems(plan);
  if (conflicts.length) fail(conflicts.join("\n"));

  const headless = plan.template === "headless";
  const pm = packageManager();
  const postgresPassword = plan.database === "docker" ? newPostgresPassword() : undefined;
  if (postgresPassword) plan.databaseUrl = dockerDatabaseUrl(plan.name, postgresPassword);
  plan.databaseUrl ??= SQLITE_URL;

  const pkg = manifest(plan.name, plan, pm);
  if (packages) pointAtTarballs(pkg.dependencies, path.resolve(packages));
  const files = {
    "package.json": json(pkg),
    "tsconfig.json": TSCONFIG,
    ".gitignore": GITIGNORE,
    ...(headless ? HEADLESS_FILES : siteFiles(plan)),
    ...(headless && plan.cmsUrl ? { ".env.local": `TANSY_URL=${plan.cmsUrl}\nTANSY_WEBHOOK_SECRET=\n` } : {}),
    // Yarn's Plug'n'Play has no node_modules, where Next.js and the tansy command are looked for.
    ...(pm === "yarn" ? { ".yarnrc.yml": "nodeLinker: node-modules\n" } : {}),
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    writeFileSync(path.join(target, file), content);
  }

  const relative = path.relative(process.cwd(), target) || ".";
  const windows = process.platform === "win32";
  const inApp = { cwd: target, stdio: "inherit", shell: windows };
  const attempt = (command, args, options = inApp) => {
    try {
      execFileSync(command, args, options);
      return true;
    } catch {
      return false;
    }
  };
  const tansy = (...args) => attempt(path.join(target, "node_modules/.bin", windows ? "tansy.cmd" : "tansy"), args);
  const command = (script) => runScript(pm, script);
  const later = [];

  if (!install) {
    if (plan.git) startRepository(target, attempt);
    if (!headless) later.push(`${pm} install`, `npx tansy init --site --database-url "${plan.databaseUrl}"`, ...(postgresPassword ? [`echo 'POSTGRES_PASSWORD="${postgresPassword}"' >> .env`, "docker compose up -d --wait"] : []), "npx tansy migrate", ...(plan.adminEmail ? [`npx tansy superadmin ${plan.adminEmail}`] : []));
    say.done(`Wrote ${relative}. Next, in it: ${later.join(", ") || `${pm} install`}.`);
    return;
  }

  say.step(`Installing with ${pm}`);
  if (!attempt(pm, pm === "npm" ? ["install", "--no-audit", "--no-fund"] : ["install"])) fail(`${pm} install failed. Fix what it printed, then run it again in ${relative}.`);

  if (!headless) {
    say.step("Writing the CMS's entry files and .env");
    if (!tansy("init", "--site", "--database-url", plan.databaseUrl, "--url", LOCAL_URL)) fail(`tansy init failed in ${relative}.`);
    const extra = envAdditions(plan, { postgresPassword });
    if (extra) appendFileSync(path.join(target, ".env"), extra);

    let databaseReady = true;
    if (plan.database === "docker") {
      say.step("Starting Postgres in Docker");
      databaseReady = attempt("docker", ["compose", "up", "-d", "--wait"]);
      if (!databaseReady) {
        say.warn("Couldn't start Postgres. Is Docker running, and is port 5432 free?");
        later.push("docker compose up -d --wait");
      }
    }
    if (databaseReady) {
      say.step("Creating the database tables");
      databaseReady = tansy("migrate");
      if (!databaseReady) say.warn(`Couldn't migrate the database.${plan.database === "postgres" ? " Check DATABASE_URL in .env." : ""}`);
    }
    if (!databaseReady) later.push(command("tansy migrate"));

    if (plan.adminEmail) {
      if (databaseReady) {
        say.step(`Creating the admin account ${plan.adminEmail}. Choose a password of at least 15 characters.`);
        if (!tansy("superadmin", plan.adminEmail)) {
          say.warn("The admin account wasn't created.");
          later.push(command(`tansy superadmin ${plan.adminEmail}`));
        }
      } else later.push(command(`tansy superadmin ${plan.adminEmail}`));
    }
  }

  if (plan.git) startRepository(target, attempt);

  const next = [`cd ${relative}`, ...later, command("dev")];
  const notes = [];
  if (headless) notes.push(plan.cmsUrl ? `It reads ${plan.cmsUrl}, set in .env.local.` : "Copy .env.example to .env.local and set TANSY_URL.");
  else {
    notes.push(plan.adminEmail ? `Sign in at ${LOCAL_URL}/dashboard.` : "The first-run link is printed in the server's output.");
    if (plan.storage === "s3") notes.push("Fill in the S3_ settings in .env to keep uploads in your bucket.");
    if (plan.storage === "vercel-blob") notes.push("Connect a Blob store to the Vercel project, or set BLOB_READ_WRITE_TOKEN in .env.");
    if (plan.host === "serverless") notes.push("vercel.json runs background work once a day. Add your .env values to the host's environment.");
    if (plan.host !== "local") notes.push("Before going live: https://github.com/mhmdsalahsebai/tansy/blob/main/docs/guides/production.md");
  }
  say.done(`Created ${relative}.\n\n${next.map((line) => `  ${line}`).join("\n")}\n\n${notes.join("\n")}`);
}

/** A first commit, unless the app is already inside a repository. Without a git identity, the repository is left with nothing committed. */
function startRepository(target, attempt) {
  const quiet = { cwd: target, stdio: "ignore" };
  if (!attempt("git", ["--version"], quiet)) return;
  if (attempt("git", ["rev-parse", "--is-inside-work-tree"], { cwd: path.dirname(target), stdio: "ignore" })) return;
  if (attempt("git", ["init", "-q"], quiet) && attempt("git", ["add", "-A"], quiet)) attempt("git", ["commit", "-q", "-m", "Create a Tansy app"], quiet);
}

// Run directly or through npx's link, and not when a test imports the version table.
if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) {
  main((given) => import("./ask.mjs").then(({ askPlan }) => askPlan(given)));
}
