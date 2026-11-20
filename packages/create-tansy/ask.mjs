/**
 * The questions, asked only in a terminal and only for what no flag already answered.
 * Pressing Enter at each one gives the same app as running with no flags.
 */
import * as p from "@clack/prompts";
import { folderProblem, OPTIONAL_PLUGINS, PLUGINS, POSTGRES_URL, PROVIDERS, THEMES, problems } from "./plan.mjs";

function answer(value) {
  if (p.isCancel(value)) {
    p.cancel("Nothing was created.");
    process.exit(0);
  }
  return value;
}

const options = (table) => Object.entries(table).map(([value, { label, hint }]) => ({ value, label, hint }));

export async function askPlan(given) {
  p.intro("Create a Tansy app");
  const plan = { ...given };

  plan.folder ??= answer(await p.text({ message: "Where should it go?", placeholder: "my-tansy", defaultValue: "my-tansy", validate: (value) => folderProblem(value || "my-tansy") }));

  plan.template ??= answer(await p.select({
    message: "What are you making?",
    options: [
      { value: "site", label: "A site with the CMS in it", hint: "admin, API and a themed public site in one Next.js app" },
      { value: "headless", label: "A front end for a Tansy server you already run", hint: "reads it over HTTP, no database" },
    ],
  }));

  if (plan.template === "headless") {
    plan.cmsUrl ??= answer(await p.text({ message: "Your Tansy server's address", placeholder: "http://localhost:3000", defaultValue: "http://localhost:3000" }));
    return finish(plan);
  }

  plan.theme ??= answer(await p.select({ message: "Pick a theme", options: options(THEMES) }));
  if (THEMES[plan.theme].plugins.includes("payments")) {
    plan.payments ??= answer(await p.select({ message: "Which payment provider? You can add more later.", options: options(PROVIDERS.payments) }));
  }

  plan.host ??= answer(await p.select({
    message: "Where will it run?",
    options: [
      { value: "local", label: "On this computer for now", hint: "decide about hosting later" },
      { value: "server", label: "On a server I run", hint: "a VPS, Docker, Railway, Fly" },
      { value: "serverless", label: "On Vercel or another serverless host", hint: "needs Postgres and file storage" },
    ],
  }));

  const serverless = plan.host === "serverless";
  plan.database ??= answer(await p.select({
    message: "Which database?",
    initialValue: plan.host === "local" ? "sqlite" : "postgres",
    options: [
      ...(serverless ? [] : [{ value: "sqlite", label: "SQLite", hint: plan.host === "local" ? "a file beside the app, nothing to set up" : "fine for one server with backups" }]),
      { value: "postgres", label: "Postgres", hint: "I have a connection URL" },
      { value: "docker", label: "Postgres in Docker", hint: "started for you, on this machine" },
    ],
  }));
  if (plan.database === "postgres" && !plan.databaseUrl) {
    plan.databaseUrl = answer(await p.text({
      message: "Postgres connection URL",
      placeholder: "postgres://user:password@host:5432/name",
      validate: (value) => (POSTGRES_URL.test(value ?? "") ? undefined : "Starts with postgres:// or postgresql://"),
    }));
  }

  plan.storage ??= answer(await p.select({
    message: "Where should uploaded files go?",
    initialValue: serverless ? "s3" : "local",
    options: [
      ...(serverless ? [] : [{ value: "local", label: "This server's disk", hint: "data/uploads" }]),
      { value: "s3", label: "S3-compatible storage", hint: "AWS, Cloudflare R2, Backblaze B2, MinIO" },
      { value: "vercel-blob", label: "Vercel Blob" },
    ],
  }));

  if (!plan.plugins) {
    const themePlugins = THEMES[plan.theme].plugins;
    // A newsletter can't send without the site's email, so the theme that has one starts with it ticked.
    const picked = answer(await p.multiselect({
      message: "Add features? Space to choose, Enter to go on.",
      required: false,
      initialValues: themePlugins.includes("newsletter") ? ["email"] : [],
      options: OPTIONAL_PLUGINS.map((name) => ({ value: name, label: PLUGINS[name].pick.label, hint: PLUGINS[name].pick.hint })),
    }));
    plan.plugins = [];
    for (const name of picked) {
      const family = PLUGINS[name].family;
      const provider = family ? answer(await p.select({ message: `Which ${PLUGINS[name].pick.noun} provider?`, options: options(PROVIDERS[family]) })) : undefined;
      plan.plugins.push(provider ? { name, provider } : { name });
    }
  }

  if (plan.adminEmail === undefined) {
    const now = answer(await p.confirm({ message: "Create your admin account now? Otherwise the server prints a first-run link.", initialValue: false }));
    plan.adminEmail = now
      ? answer(await p.text({ message: "Your email", validate: (value) => (/^[^@\s]+@[^@\s]+$/.test(value ?? "") ? undefined : "An email address, like you@example.com") }))
      : null;
  }
  return finish(plan);
}

async function finish(plan) {
  for (const problem of problems(plan)) p.log.warn(problem);
  plan.git ??= answer(await p.confirm({ message: "Start a git repository?", initialValue: true }));
  return plan;
}

export { p as prompts };
