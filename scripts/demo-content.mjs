#!/usr/bin/env node
/**
 * Fills the live demo with stories for the halo theme, and takes "Courses" out of its menu.
 * Run it yourself: it signs in as the demo's admin from .demo-admin (gitignored), whose lines are
 * "URL: …", "Email: …" and "Password: …".
 *
 *   node scripts/demo-content.mjs
 *
 * Safe to run again: posts, categories and tags are matched by slug or name, and only what is
 * missing is added, including a category and tags for posts that had none. Covers are drawn
 * here with sharp, so nothing is downloaded.
 */
import { readFileSync } from "node:fs";
import sharp from "sharp";

const file = readFileSync(new URL("../.demo-admin", import.meta.url), "utf8");
const field = (name) => file.match(new RegExp(`^${name}:\\s*(.+)$`, "mi"))?.[1].trim();
const base = (field("URL") ?? "").replace(/\/(dashboard.*)?$/, "");
const email = field("Email");
const password = field("Password");
if (!base || !email || !password) throw new Error(".demo-admin needs URL, Email and Password lines.");

let cookie = "";
async function call(method, path, body, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { origin: base, accept: "application/json", cookie, ...(body && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}), ...headers },
    body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
  });
  const set = response.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = [cookie, ...set.map((one) => one.split(";")[0])].filter(Boolean).join("; ");
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}
const list = async (slug, query = "") => (await call("GET", `/api/collections/${slug}/records?perPage=200${query}`)).items ?? [];

/* ----------------------------------------------------------------- content */

const paragraph = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const textBlock = (id, ...paragraphs) => ({ id, type: "blog_text", v: 1, value: { body: { type: "doc", content: paragraphs.map(paragraph) } } });
const quoteBlock = (id, text, source) => ({ id, type: "blog_quote", v: 1, value: { text, source } });

const CATEGORIES = ["News", "Guides", "Releases", "Security", "Community"];
const TAGS = ["nextjs", "postgres", "plugins", "security", "themes", "search", "i18n", "performance", "headless", "ai"];

/** Each story: slug, title, excerpt, category, tags, featured, and the hue of its cover. */
const STORIES = [
  ["halo-theme-lands", "The halo theme lands: a news front page editors curate", "A Front page record picks the lead, spotlight and trending stories. Leave a section empty and it fills itself.", "Releases", ["themes"], true, 262],
  ["runtime-schemas-explained", "Runtime schemas, explained: change collections without a deploy", "Fields, rules and URL patterns live in the database, so editors reshape content while the site keeps serving.", "Guides", ["nextjs", "postgres"], true, 220],
  ["access-rules-in-practice", "Access rules in practice: one filter language for the API and the site", "The same rule decides what a visitor lists, what an editor changes and what a theme can show.", "Security", ["security"], false, 340],
  ["search-engines-plug-in", "Meilisearch, Typesense or Algolia, with nothing to change in your theme", "Search goes through the records API, so swapping engines is a setting, not a rewrite.", "Guides", ["search", "plugins"], false, 190],
  ["arabic-first-class", "Right to left, first class: shipping a site in English and Arabic", "Every theme mirrors its layout and keeps links in the page's language, with words owners can edit.", "Community", ["i18n", "themes"], true, 30],
  ["sqlite-to-postgres-move", "Moving from SQLite to Postgres when the site outgrows a file", "Start on one file, switch the database URL later, and keep every migration for both.", "Guides", ["postgres", "performance"], false, 200],
  ["headless-same-theme", "Headless, with the same theme package: render it anywhere", "A theme reads the site over HTTP as easily as in process, so one package serves both setups.", "News", ["headless", "themes"], false, 280],
  ["plugin-proves-core", "Why every plugin we ship has to prove the core first", "Blog, shop, newsletter and courses use only public extension points, so yours can too.", "Community", ["plugins"], false, 300],
  ["audit-log-otel", "Audit and request logs, now over OpenTelemetry", "Ship who changed what to the tools you already run, with repeated denials folded together.", "Releases", ["security", "performance"], false, 160],
  ["ai-drafts-with-review", "AI drafts that wait for a human: review before anything publishes", "Workflows draft, translate and summarise, and every result lands as a draft for an editor to approve.", "News", ["ai", "plugins"], true, 245],
  ["image-focal-points", "Focal points keep faces in frame at every crop", "Set it once in the library and every theme's cards, rows and covers respect it.", "Guides", ["themes", "performance"], false, 15],
  ["multi-tenant-paths", "One instance, many sites: tenants under a path or their own domain", "Each tenant picks its theme and colour, while the build and the database stay shared.", "News", ["headless", "nextjs"], false, 175],
  ["scheduled-publishing", "Scheduled publishing and revisions, without a plugin", "Drafts, history and a publish time are part of every collection from the first record.", "Guides", ["nextjs"], false, 320],
  ["security-model-tour", "A tour of the security model: what a route has to declare", "Every API route names its access policy and audit action, and the contract tests hold the line.", "Security", ["security", "plugins"], false, 355],
];

/** An abstract halo in the story's hue: a soft orb and rings on a pale wash. */
function coverSvg(hue, seed) {
  const x = 30 + ((seed * 37) % 45);
  const y = 35 + ((seed * 53) % 30);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 160 100">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 94%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 65% 78%)"/></linearGradient>
    <radialGradient id="orb" cx="0.4" cy="0.35" r="0.7"><stop offset="0" stop-color="#fff" stop-opacity="0.95"/><stop offset="0.45" stop-color="hsl(${(hue + 300) % 360} 85% 82%)"/><stop offset="1" stop-color="hsl(${hue} 70% 55%)"/></radialGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="0.6"/></filter>
  </defs>
  <rect width="160" height="100" fill="url(#bg)"/>
  <g fill="none" stroke="#fff" stroke-opacity="0.45" stroke-width="0.4">
    ${Array.from({ length: 7 }, (_, i) => `<ellipse cx="${x}" cy="${y}" rx="${26 + i * 9}" ry="${18 + i * 6}" transform="rotate(-14 ${x} ${y})"/>`).join("")}
  </g>
  <circle cx="${x}" cy="${y}" r="20" fill="url(#orb)" filter="url(#soft)"/>
  <circle cx="${x}" cy="${y}" r="11" fill="#fff" fill-opacity="0.35"/>
</svg>`;
}

async function uploadCover(name, hue, seed) {
  const png = new Uint8Array(await sharp(Buffer.from(coverSvg(hue, seed))).resize(1600, 1000).png({ compressionLevel: 9 }).toBuffer());
  const uploaded = await call("POST", `/api/files/upload?name=${encodeURIComponent(name)}`, png, { "content-type": "image/png" });
  return uploaded.id;
}

/* -------------------------------------------------------------------- run */

console.log(`Signing in to ${base} as ${email}…`);
const signedIn = await call("POST", "/api/auth/sign-in/email", { email, password });
if (signedIn?.twoFactorRedirect) throw new Error("This account asks for a second factor. Turn it off for the demo admin, or add the stories in the dashboard.");

// The menu: drop Courses and anything under it, since the demo runs without the LMS.
const [menu] = await list("site-menu");
if (menu && Array.isArray(menu.items)) {
  const items = menu.items.filter((item) => !String(item?.value?.url ?? "").startsWith("/courses"));
  if (items.length !== menu.items.length) {
    await call("PATCH", `/api/collections/site-menu/records/${menu.id}`, { items, status: "published" });
    console.log("Menu: removed Courses.");
  } else console.log("Menu: no Courses link.");
}

async function ensureNamed(slug, names) {
  const existing = new Map((await list(slug)).map((record) => [String(record.name).toLowerCase(), record.id]));
  for (const name of names) {
    if (existing.has(name.toLowerCase())) continue;
    const created = await call("POST", `/api/collections/${slug}/records`, { name, status: "published" });
    existing.set(name.toLowerCase(), created.id);
    console.log(`${slug}: added ${name}`);
  }
  return existing;
}
const categories = await ensureNamed("blog-categories", CATEGORIES);
const tags = await ensureNamed("blog-tags", TAGS);

const posts = await list("blog-posts", "&fields=id,slug,title,cover,categories,tags");
const slugs = new Set(posts.map((post) => post.slug));

// Covers for the posts that were there before.
for (const [index, post] of posts.entries()) {
  if (post.cover) continue;
  const cover = await uploadCover(`${post.slug || post.id}.png`, (index * 67 + 240) % 360, index + 20);
  await call("PATCH", `/api/collections/blog-posts/records/${post.id}`, { cover, status: "published" });
  console.log(`Cover added: ${post.title}`);
}

// A category and tags for the posts that were there before, guessed from the title, so no card
// on the front page goes without its label.
const GUESSES = [
  [/release|is out|1\.\d/i, "Releases", ["performance"]],
  [/security|access|rule|backup/i, "Security", ["security"]],
  [/plugin/i, "Guides", ["plugins"]],
  [/theme|yours|design/i, "Guides", ["themes"]],
  [/postgres|sqlite|vps|deploy|hosting/i, "Guides", ["postgres", "performance"]],
  [/wordpress|moving|migrat/i, "Guides", ["headless"]],
  [/.*/, "News", ["nextjs"]],
];
for (const post of posts) {
  const hasCategory = Array.isArray(post.categories) && post.categories.length > 0;
  const hasTags = Array.isArray(post.tags) && post.tags.length > 0;
  if (hasCategory && hasTags) continue;
  const [, category, guessed] = GUESSES.find(([pattern]) => pattern.test(String(post.title)));
  await call("PATCH", `/api/collections/blog-posts/records/${post.id}`, {
    ...(hasCategory ? {} : { categories: [categories.get(category.toLowerCase())] }),
    ...(hasTags ? {} : { tags: guessed.map((tag) => tags.get(tag)) }),
    status: "published",
  });
  console.log(`Labelled: ${post.title}`);
}

for (const [index, [slug, title, excerpt, category, storyTags, featured, hue]] of STORIES.entries()) {
  if (slugs.has(slug)) continue;
  const cover = await uploadCover(`${slug}.png`, hue, index + 1);
  await call("POST", "/api/collections/blog-posts/records", {
    title,
    slug,
    excerpt,
    cover,
    categories: [categories.get(category.toLowerCase())],
    tags: storyTags.map((tag) => tags.get(tag)),
    featured,
    body: [
      textBlock("intro", excerpt, "This is a demo story, written to show how the halo theme lays out a busy front page: lead, spotlight, trending, readers' choice and the popular carousel all draw from posts like this one."),
      quoteBlock("quote", "Editors choose what leads; the page fills in the rest.", "The halo theme"),
      textBlock("more", "Open the dashboard with the shared demo login to see how the post, its category, its tags and its cover are stored, and how the Front page record can pin it to any section."),
    ],
    status: "published",
  });
  console.log(`Published: ${title}`);
}

console.log("Done.");
