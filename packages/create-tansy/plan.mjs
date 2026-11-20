/**
 * What create-tansy can make, and the files each choice writes. No prompts here, so the same
 * plan comes out of flags, answers to questions, or a test.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

export const TEMPLATES = ["site", "headless"];
export const HOSTS = ["local", "server", "serverless"];
export const DATABASES = ["sqlite", "postgres", "docker"];
export const STORAGES = ["local", "s3", "vercel-blob"];
export const APP_NAME = /^[a-z0-9][a-z0-9._-]*$/;
export const POSTGRES_URL = /^postgres(ql)?:\/\//i;

/** Why a folder can't take a new app, or undefined when it can. */
export function folderProblem(folder) {
  if (!folder) return "Name a folder.";
  const name = path.basename(path.resolve(folder));
  if (!APP_NAME.test(name)) return `"${name}" can't be a package name. Use lowercase letters, digits, dots, hyphens and underscores.`;
  if (existsSync(folder) && readdirSync(folder).length) return `${folder} already exists and isn't empty.`;
  return undefined;
}

/** Each theme is a site for a feature, and turns that feature's plugins on with it. */
export const THEMES = {
  blank: { label: "Blank", hint: "unstyled, a starting point for your own", plugins: [] },
  blog: { label: "Blog", hint: "posts, categories and comments", plugins: ["blog"] },
  magazine: { label: "Magazine", hint: "a publication with featured stories", plugins: ["blog"] },
  halo: { label: "Halo", hint: "a news front page with curated sections", plugins: ["blog"] },
  dispatch: { label: "Dispatch", hint: "a newsletter and its archive", plugins: ["blog", "newsletter"] },
  storefront: { label: "Storefront", hint: "a shop that takes payments", plugins: ["payments", "shop"] },
  academy: { label: "Academy", hint: "courses, lessons and quizzes", plugins: ["lms"] },
};

/** The ones a provider plugs into. Their keys are set later, in the dashboard or the environment. */
export const PROVIDERS = {
  payments: {
    stripe: { label: "Stripe", fn: "stripe" },
    polar: { label: "Polar", fn: "polar" },
    dodo: { label: "Dodo Payments", fn: "dodo" },
    creem: { label: "Creem", fn: "creem" },
    commet: { label: "Commet", fn: "commet" },
  },
  email: {
    resend: { label: "Resend", fn: "resend" },
    postmark: { label: "Postmark", fn: "postmark" },
    sendgrid: { label: "SendGrid", fn: "sendgrid" },
    mailgun: { label: "Mailgun", fn: "mailgun" },
    ses: { label: "Amazon SES", fn: "ses" },
    brevo: { label: "Brevo", fn: "brevo" },
  },
  captcha: {
    turnstile: { label: "Cloudflare Turnstile", fn: "turnstile" },
    hcaptcha: { label: "hCaptcha", fn: "hcaptcha" },
    recaptcha: { label: "Google reCAPTCHA", fn: "recaptcha" },
  },
  ai: {
    openai: { label: "OpenAI", fn: "openai" },
    anthropic: { label: "Anthropic", fn: "anthropic" },
    google: { label: "Google Gemini", fn: "google" },
    mistral: { label: "Mistral", fn: "mistral" },
    xai: { label: "xAI", fn: "xai" },
    groq: { label: "Groq", fn: "groq" },
    deepseek: { label: "DeepSeek", fn: "deepseek" },
    openrouter: { label: "OpenRouter", fn: "openrouter" },
    gateway: { label: "Vercel AI Gateway", fn: "gateway" },
  },
};

const providerPackage = (family, id) => `@tansy/${family}-${id}`;

/**
 * Every plugin create-tansy can add, in the order they go into the config. Payments comes
 * before the LMS, so the LMS finds it and gives courses their "Included in" field.
 * `pick` marks the ones offered as optional features; the rest come with a theme.
 */
export const PLUGINS = {
  blog: { package: "@tansy/blog", imports: "blog as blogPlugin", call: () => "blogPlugin({ siteUrl })", siteUrl: true },
  payments: { package: "@tansy/payments", imports: "payments", family: "payments", call: (fns) => `payments({ siteUrl, providers: [${fns}] })`, siteUrl: true },
  lms: { package: "@tansy/lms", imports: "lms", call: () => "lms()" },
  email: { package: "@tansy/email", imports: "email", family: "email", call: (fns) => `email({ providers: [${fns}] })`, pick: { label: "Email through a provider's API", hint: "instead of SMTP", noun: "email" } },
  captcha: { package: "@tansy/captcha", imports: "captcha", family: "captcha", call: (fns) => `captcha({ providers: [${fns}] })`, pick: { label: "CAPTCHA", hint: "on sign-in and forms", noun: "CAPTCHA" } },
  forms: { package: "@tansy/forms", imports: "forms", call: () => "forms()", pick: { label: "Forms", hint: "contact forms and submissions" } },
  newsletter: { package: "@tansy/newsletter", imports: "newsletter", call: () => "newsletter({ siteUrl })", siteUrl: true },
  shop: { package: "@tansy/shop", imports: "shop", call: () => "shop({ siteUrl })", siteUrl: true },
  analytics: { package: "@tansy/analytics", imports: "analytics", call: () => "analytics()", pick: { label: "Analytics", hint: "page views with no cookies" } },
  "social-sign-in": { package: "@tansy/social-sign-in", imports: "socialSignIn", call: () => "socialSignIn()", pick: { label: "Social sign-in", hint: "Google, GitHub and others" } },
  ai: { package: "@tansy/ai", imports: "ai", family: "ai", call: (fns) => `ai({ providers: [${fns}] })`, pick: { label: "AI assistant", hint: "writing help in the editor", noun: "AI" } },
  "pwned-passwords": { package: "@tansy/pwned-passwords", imports: "pwnedPasswords", call: () => "pwnedPasswords()", pick: { label: "Breached password check", hint: "refuses leaked passwords" } },
};

export const OPTIONAL_PLUGINS = Object.keys(PLUGINS).filter((name) => PLUGINS[name].pick);

/** "email:postmark" → { name: "email", provider: "postmark" }. A plugin with providers gets its first one by default. */
export function parsePlugin(spec) {
  const [name, provider] = spec.split(":");
  const plugin = PLUGINS[name];
  if (!plugin) throw new Error(`Unknown plugin "${name}". Choose from ${Object.keys(PLUGINS).join(", ")}.`);
  if (!plugin.family) {
    if (provider) throw new Error(`The ${name} plugin takes no provider.`);
    return { name };
  }
  const providers = PROVIDERS[plugin.family];
  const chosen = provider ?? Object.keys(providers)[0];
  if (!providers[chosen]) throw new Error(`Unknown ${name} provider "${chosen}". Choose from ${Object.keys(providers).join(", ")}.`);
  return { name, provider: chosen };
}

/**
 * The theme's own plugins, then the ones asked for, each once and in config order.
 * A provider asked for wins over a theme's default one.
 * @param {{ theme: string, payments?: string, plugins?: Array<{ name: string, provider?: string }> }} plan
 */
export function pluginsFor({ theme, payments, plugins = [] }) {
  const wanted = new Map();
  for (const name of THEMES[theme].plugins) wanted.set(name, parsePlugin(name === "payments" && payments ? `payments:${payments}` : name));
  for (const plugin of plugins) wanted.set(plugin.name, plugin);
  return Object.keys(PLUGINS).filter((name) => wanted.has(name)).map((name) => wanted.get(name));
}

/** Combinations that would start, then fail in production. */
export function problems({ host, database, storage }) {
  const found = [];
  if (host === "serverless" && database === "sqlite") found.push("A serverless host has no lasting disk for a SQLite file. Choose Postgres.");
  if (host === "serverless" && storage === "local") found.push("A serverless host has no lasting disk for uploads. Choose S3 or Vercel Blob.");
  return found;
}

/** Where the dependencies get their versions: the same release as create-tansy itself. */
export function dependenciesFor(plan, version) {
  const range = `^${version}`;
  const names = ["tansy"];
  if (plan.template === "headless") names.push("@tansy/theme-blank");
  else {
    names.push(`@tansy/theme-${plan.theme}`);
    for (const plugin of pluginsFor(plan)) {
      names.push(PLUGINS[plugin.name].package);
      if (plugin.provider) names.push(providerPackage(PLUGINS[plugin.name].family, plugin.provider));
    }
    if (plan.storage === "vercel-blob") names.push("@tansy/storage-vercel-blob");
  }
  return Object.fromEntries(names.map((name) => [name, range]));
}

const STORAGE_FALLBACK = `localStorage({ dir: env.UPLOADS_DIR ?? "data/uploads", allowInProduction: env.ALLOW_LOCAL_STORAGE_IN_PRODUCTION === "true" })`;

const STORAGE = {
  local: {
    comment: "Local disk is refused in production unless explicitly allowed. s3Storage() suits any S3-compatible service.",
    adapter: STORAGE_FALLBACK,
  },
  s3: {
    comment: "Any S3-compatible service: AWS, Cloudflare R2, Backblaze B2, MinIO. Until S3_BUCKET is set in .env, files go to local disk, which production refuses.",
    adapter: `env.S3_BUCKET
      ? s3Storage({ endpoint: env.S3_ENDPOINT || "", bucket: env.S3_BUCKET, region: env.S3_REGION, accessKeyId: env.S3_ACCESS_KEY_ID || "", secretAccessKey: env.S3_SECRET_ACCESS_KEY || "" })
      : ${STORAGE_FALLBACK}`,
  },
  "vercel-blob": {
    comment: "Vercel Blob. Until BLOB_READ_WRITE_TOKEN is set, files go to local disk, which production refuses.",
    adapter: `env.BLOB_READ_WRITE_TOKEN
      ? vercelBlobStorage({ token: env.BLOB_READ_WRITE_TOKEN })
      : ${STORAGE_FALLBACK}`,
  },
};

/** tansy.config.ts, written out so a reader sees every plugin and can remove a line to remove a feature. */
export function cmsConfig(plan) {
  const plugins = pluginsFor(plan);
  const imports = [
    `import { defineCms } from "tansy/config";`,
    `import { ${["localStorage", ...(plan.storage === "s3" ? ["s3Storage"] : [])].join(", ")} } from "tansy/storage";`,
    ...(plan.storage === "vercel-blob" ? [`import { vercelBlobStorage } from "@tansy/storage-vercel-blob";`] : []),
    `import { ${plan.theme} } from "@tansy/theme-${plan.theme}";`,
  ];
  const calls = [];
  for (const plugin of plugins) {
    const spec = PLUGINS[plugin.name];
    imports.push(`import { ${spec.imports} } from "${spec.package}";`);
    let fns = "";
    if (plugin.provider) {
      const provider = PROVIDERS[spec.family][plugin.provider];
      imports.push(`import { ${provider.fn} } from "${providerPackage(spec.family, plugin.provider)}";`);
      fns = `${provider.fn}()`;
    }
    calls.push(spec.call(fns));
  }
  const usesSiteUrl = plugins.some((plugin) => PLUGINS[plugin.name].siteUrl);
  const storage = STORAGE[plan.storage];
  return `${imports.join("\n")}

const env = process.env;
${usesSiteUrl ? `// The public site's address. Links in emails, feeds and payments are built from it.\nconst siteUrl = env.TANSY_SITE_URL || env.BETTER_AUTH_URL || "http://localhost:3000";\n` : ""}
export default defineCms({
  // The public site's look. Change it here, then rebuild.
  theme: ${plan.theme}(),
  // Features are plugins: npm packages added here, which run with full access to the server.
  // Providers' keys are set in the dashboard, or in the environment. Remove a line to remove a feature.
  plugins: [${calls.length ? `\n${calls.map((call) => `    ${call},`).join("\n")}\n  ` : ""}],
  storage: {
    // ${storage.comment}
    adapter: ${storage.adapter},
  },
});
`;
}

/** Lines added to the .env tansy init writes, for the services chosen. Empty until the person fills them in. */
export function envAdditions(plan, { postgresPassword } = {}) {
  const lines = [];
  if (plan.storage === "s3") lines.push("# Uploads, on any S3-compatible service. Leave S3_ENDPOINT empty for AWS.", "S3_BUCKET=", "S3_REGION=", "S3_ENDPOINT=", "S3_ACCESS_KEY_ID=", "S3_SECRET_ACCESS_KEY=", "");
  if (plan.storage === "vercel-blob") lines.push("# Uploads, on Vercel Blob. Vercel sets this itself once a Blob store is connected to the project.", "BLOB_READ_WRITE_TOKEN=", "");
  if (postgresPassword) lines.push("# The password docker-compose.yml gives Postgres. It is in DATABASE_URL above too.", `POSTGRES_PASSWORD="${postgresPassword}"`, "");
  return lines.length ? `\n${lines.join("\n")}` : "";
}

export const newPostgresPassword = () => randomBytes(18).toString("hex");

/** A database name Postgres takes without quoting. */
export const databaseName = (app) => app.replace(/[^a-z0-9_]/g, "_").replace(/^([0-9])/, "_$1");

export const dockerDatabaseUrl = (app, password) => `postgres://tansy:${password}@localhost:5432/${databaseName(app)}`;

/** Postgres for development, on this machine only. Its password stays in .env, which git ignores. */
export const composeFile = (app) => `# Postgres for development. Start it with: docker compose up -d
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: tansy
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: ${databaseName(app)}
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U tansy -d ${databaseName(app)}"]
      interval: 2s
      timeout: 5s
      retries: 30

volumes:
  postgres:
`;

/** Nothing keeps timers running on Vercel, so its cron calls the background endpoint. Hobby allows once a day. */
export const VERCEL_JSON = `${JSON.stringify({ $schema: "https://openapi.vercel.sh/vercel.json", crons: [{ path: "/api/background", schedule: "0 5 * * *" }] }, null, 2)}\n`;

/** Native modules the CMS builds on install, which pnpm and bun skip unless told they may run. */
export const NATIVE = ["argon2", "better-sqlite3", "prisma", "@prisma/engines", "sharp", "libpg-query"];

/** The package manager that ran create-tansy, from the user agent it sets. */
export function packageManager(agent = process.env.npm_config_user_agent ?? "") {
  const name = agent.split("/")[0];
  return ["pnpm", "yarn", "bun"].includes(name) ? name : "npm";
}

export const runScript = (pm, script) => (pm === "npm" ? `npm run ${script}` : `${pm} ${script}`);
