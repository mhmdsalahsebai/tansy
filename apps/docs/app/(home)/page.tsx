import Link from 'next/link';
import {
  ArrowRight,
  Blocks,
  Database,
  FileCode,
  Globe,
  KeyRound,
  Layers,
  ShieldCheck,
  Terminal,
} from 'lucide-react';

const features = [
  {
    icon: Layers,
    title: 'One app, not two',
    body: 'The dashboard is at /dashboard and the API at /api, in the same Next.js app as your pages. Your own routes keep working beside them.',
  },
  {
    icon: Database,
    title: 'Schema at runtime',
    body: 'Collections, fields, blocks and URL patterns are defined on the dashboard and take effect at once. No migration, no redeploy, no generated types to commit.',
  },
  {
    icon: ShieldCheck,
    title: 'Authorization as data',
    body: 'Roles carry permissions, and per-collection rules decide which rows a caller may touch. The same rules cover the API, the dashboard, realtime, files and your pages.',
  },
  {
    icon: Blocks,
    title: 'Everything is a plugin',
    body: 'Blog, LMS, shop, payments, forms, newsletter, analytics and AI are packages on the public extension API — the same one your plugin uses.',
  },
  {
    icon: Globe,
    title: 'Many languages',
    body: 'A language per record with fallbacks, an address per language, hreflang, right-to-left pages, XLIFF import and export, and the dashboard itself translated.',
  },
  {
    icon: KeyRound,
    title: 'Yours to host',
    body: 'SQLite or any Postgres, files on disk or any storage provider, encrypted backups you hold the key to. Nothing is hosted for you.',
  },
];

const config = `import { defineCms } from "tansy/config";
import { blog } from "@tansy/blog";
import { magazine } from "@tansy/theme-magazine";

export default defineCms({
  theme: magazine(),
  plugins: [
    blog({ siteUrl: "https://example.com", comments: "moderated" }),
  ],
});`;

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="relative overflow-hidden border-b border-fd-border px-6 py-24 text-center sm:py-32">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,var(--color-fd-primary)/8%,transparent_60%)]"
        />
        <div className="relative mx-auto flex max-w-3xl flex-col items-center">
          <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card px-3 py-1 text-xs text-fd-muted-foreground">
            <Terminal className="size-3.5" />
            npm create tansy@latest
          </span>
          <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
            A content backend that lives inside your Next.js app
          </h1>
          <p className="mt-6 text-balance text-lg text-fd-muted-foreground">
            Tansy is a self-hosted CMS you install as a package. Collections, fields and access
            rules are defined at runtime from its own dashboard, and your content stays in your own
            database.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/docs"
              className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
            >
              Get started
              <ArrowRight className="size-4" />
            </Link>
            <Link
              href="/docs/plugins"
              className="inline-flex items-center gap-2 rounded-lg border border-fd-border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
            >
              <Blocks className="size-4" />
              Browse plugins
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-6 py-20">
        <div className="grid gap-px overflow-hidden rounded-xl border border-fd-border bg-fd-border sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, body }) => (
            <div key={title} className="bg-fd-card p-6">
              <Icon className="size-5 text-fd-primary" />
              <h2 className="mt-4 font-medium">{title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-fd-border bg-fd-card/40 px-6 py-20">
        <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-2">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Features are lines in one config file
            </h2>
            <p className="mt-4 text-fd-muted-foreground">
              A plugin can add collections, field types, blocks, permissions, dashboard pages, API
              routes, jobs and record hooks. Removing its line removes the feature, and{' '}
              <code className="rounded bg-fd-muted px-1.5 py-0.5 text-sm">tansy migrate</code>{' '}
              applies whatever schema it brought with it.
            </p>
            <ul className="mt-6 space-y-2 text-sm text-fd-muted-foreground">
              <li className="flex items-start gap-2">
                <FileCode className="mt-0.5 size-4 shrink-0 text-fd-primary" />
                Hook files for routes, jobs and record hooks, with no build step.
              </li>
              <li className="flex items-start gap-2">
                <FileCode className="mt-0.5 size-4 shrink-0 text-fd-primary" />
                Themes render the whole site from your content, headless or in the same app.
              </li>
              <li className="flex items-start gap-2">
                <FileCode className="mt-0.5 size-4 shrink-0 text-fd-primary" />
                REST, realtime, webhooks, OpenAPI, MCP and a typed SDK for everything outside it.
              </li>
            </ul>
            <Link
              href="/docs/extending"
              className="mt-8 inline-flex items-center gap-2 text-sm font-medium text-fd-primary hover:underline"
            >
              Read the extension API
              <ArrowRight className="size-4" />
            </Link>
          </div>
          <pre className="overflow-x-auto rounded-xl border border-fd-border bg-fd-background p-5 text-[13px] leading-relaxed">
            <code>{config}</code>
          </pre>
        </div>
      </section>

      <section className="px-6 py-24 text-center">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Run it in one command
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-fd-muted-foreground">
          Start a new project, add it to an app you already have, or run the container. The first
          start prints a one-time link to create your superadmin.
        </p>
        <div className="mx-auto mt-8 flex max-w-xl flex-col gap-3 text-left">
          {[
            { label: 'New project', command: 'npm create tansy@latest' },
            { label: 'Existing app', command: 'npm install tansy && npx tansy init' },
            { label: 'Docker', command: 'docker run -p 8090:8090 -v tansy-data:/data tansy' },
          ].map(({ label, command }) => (
            <div
              key={label}
              className="flex items-center gap-4 rounded-lg border border-fd-border bg-fd-card px-4 py-3"
            >
              <span className="w-28 shrink-0 text-xs uppercase tracking-wide text-fd-muted-foreground">
                {label}
              </span>
              <code className="overflow-x-auto text-sm">{command}</code>
            </div>
          ))}
        </div>
        <Link
          href="/docs/getting-started/new-project"
          className="mt-10 inline-flex items-center gap-2 rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
        >
          Start here
          <ArrowRight className="size-4" />
        </Link>
      </section>
    </main>
  );
}
