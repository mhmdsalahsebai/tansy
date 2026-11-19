/**
 * Row scopes, through the workspaces example (examples/workspaces), which global-setup turns on
 * with two workspaces: alpha, where wsann edits, and beta, where wsbob edits. Runs after
 * auth.test.ts, which completes setup. Both editors are plain users: everything they can do
 * comes from the scoped role their workspace gives them. With TEST_SCOPES=off there is no
 * provider, and only the last block runs. With TEST_SCOPES=multi-tenant, nothing here runs.
 */
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { beforeAll, describe, expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");
const SCOPES = inject("scopes");
// With TEST_SCOPES=multi-tenant the multi-tenant plugin provides scopes instead: multi-tenant.test.ts.
const TENANTS = inject("tenants");
const databaseUrl = inject("databaseUrl");

/** Tables with a scope column, read from the database itself rather than through the API. */
function tablesWithScopeColumn(): string[] {
  if (/^postgres(ql)?:/i.test(databaseUrl)) {
    const text = `SELECT table_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = '_scope'`;
    const result = JSON.parse(execFileSync(process.execPath, ["tests/integration/pg-query.mjs", databaseUrl, text, "[]"], { encoding: "utf8" }));
    return result.rows.map((row: { name: string }) => row.name).sort();
  }
  const database = new Database(databaseUrl.replace(/^file:/, ""), { readonly: true, timeout: 10_000 });
  try {
    const rows = database.prepare(`SELECT m.name AS name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND p.name = '_scope'`).all() as Array<{ name: string }>;
    return rows.map((row) => row.name).sort();
  } finally {
    database.close();
  }
}
const PASSWORD = "correct-horse-battery-staple-9431";

interface Actor { id: string; cookie: string }
let root: Actor, ann: Actor, bob: Actor;
let collectionId: number, titleId: number, sharedId: number;
/** The scoped pages collection the site page test makes, and its fields by name. */
let pages: { id: number; fields: Array<{ id: number; name: string }> };

async function call(path: string, { method = "GET", body, as, workspace }: { method?: string; body?: unknown; as?: Actor | null; workspace?: string } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    redirect: "manual",
    headers: {
      origin: baseUrl,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(as ? { cookie: as.cookie } : {}),
      ...(workspace ? { "x-workspace": workspace } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any -- API responses have many shapes
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, text };
}

async function signIn(email: string): Promise<Actor> {
  const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, { method: "POST", headers: { origin: baseUrl, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie().map((c) => c.split(";")[0]).filter((pair) => !pair.endsWith("=")).join("; ");
  return { id: (await response.json()).user.id, cookie };
}

async function user(name: string) {
  const r = await call("/api/users", { method: "POST", as: root, body: { name, email: `${name}@example.test`, password: PASSWORD, role: "user" } });
  expect(r.status, r.text).toBe(200);
  return signIn(`${name}@example.test`);
}

const content = (suffix = "", collection = collectionId) => `/api/collections/${collection}/content${suffix}`;
interface Item { id: number; values: Array<{ fieldId: number; value: unknown }> }
const title = (item: Item) => item.values.find((value) => value.fieldId === titleId)?.value;
const titles = (json: { items: Item[] }) => json.items.map(title).sort();

async function create(title: string, as: Actor, workspace?: string) {
  return call(content(), { method: "POST", as, workspace, body: { status: "published", values: [{ fieldId: titleId, value: title }] } });
}

describe.runIf(SCOPES)("row scopes", () => {
  beforeAll(async () => {
    root = await signIn("root@example.test");
    ann = await user("wsann");
    bob = await user("wsbob");
    const made = await call("/api/collections", { method: "POST", as: root, body: { name: "Notes", slug: "scope-notes", fields: [{ name: "title", type: "text", config: { unique: true } }] } });
    expect(made.status, made.text).toBe(200);
    expect(made.json.scoped).toBe(false);
    collectionId = made.json.id;
    titleId = made.json.fields[0].id;
    // Written before the collection is scoped, so it moves to the provider's first workspace.
    expect((await create("before", root)).status).toBe(200);
    const shared = await call("/api/collections", { method: "POST", as: root, body: { name: "Shared", slug: "scope-shared", fields: [{ name: "note", type: "reference", config: { collection: collectionId } }] } });
    expect(shared.status, shared.text).toBe(200);
    sharedId = shared.json.id;
  });

  it("scopes a collection, moving its records to the first workspace", async () => {
    expect(tablesWithScopeColumn()).toEqual([]);
    const r = await call(`/api/collections/${collectionId}/scope`, { method: "PUT", as: root, body: { scoped: true } });
    expect(r.status, r.text).toBe(200);
    // Only the scoped collection's table gains the column. It has no translations table, being unlocalized.
    expect(tablesWithScopeColumn()).toEqual(["rec_scope_notes"]);
    const alpha = await call(content(), { as: root, workspace: "alpha" });
    expect(titles(alpha.json)).toEqual(["before"]);
    expect(titles((await call(content(), { as: root, workspace: "beta" })).json)).toEqual([]);
  });

  it("refuses a scoped collection to requests for no workspace, or one that doesn't exist", async () => {
    expect((await call(content(), { as: root })).json.error.code).toBe("SCOPE_REQUIRED");
    expect((await create("nowhere", root)).json.error.code).toBe("SCOPE_REQUIRED");
    // Without a workspace, ann holds no role there.
    expect((await create("nowhere", ann)).status).toBe(403);
    const missing = await call(content(), { as: root, workspace: "gamma" });
    expect(missing.status).toBe(404);
    expect(missing.json.error.code).toBe("SCOPE_NOT_FOUND");
  });

  it("gives a member their workspace's role there, and nowhere else", async () => {
    const created = await create("ann's", ann, "alpha");
    expect(created.status, created.text).toBe(200);
    expect(created.json).not.toHaveProperty("_scope");
    expect((await create("bob's", bob, "beta")).status).toBe(200);
    // Not a member of alpha: a plain user there.
    expect((await create("bob in alpha", bob, "alpha")).status).toBe(403);
    // Scoped roles never reach a shared collection.
    expect((await call(content("", sharedId), { method: "POST", as: ann, workspace: "alpha", body: { values: [] } })).status).toBe(403);
  });

  it("keeps each workspace's records apart, whoever asks", async () => {
    expect(titles((await call(content(), { as: ann, workspace: "alpha" })).json)).toEqual(["ann's", "before"]);
    expect(titles((await call(content(), { as: bob, workspace: "beta" })).json)).toEqual(["bob's"]);
    expect(titles((await call(content(), { as: root, workspace: "beta" })).json)).toEqual(["bob's"]);
    const annId = (await call(content(), { as: ann, workspace: "alpha" })).json.items.find((item: Item) => title(item) === "ann's").id;
    // Root in beta, and bob, can't see, change or delete it by id.
    expect((await call(content(`/${annId}`), { as: root, workspace: "beta" })).status).toBe(404);
    expect((await call(content(`/${annId}`), { method: "PATCH", as: bob, workspace: "beta", body: { values: [{ fieldId: titleId, value: "taken" }] } })).status).toBe(404);
    expect((await call(content(`/${annId}`), { method: "DELETE", as: bob, workspace: "beta" })).status).toBe(404);
    expect(title((await call(content(`/${annId}`), { as: ann, workspace: "alpha" })).json)).toBe("ann's");
  });

  it("checks unique values within a workspace", async () => {
    expect((await create("ann's", bob, "beta")).status).toBe(200);
    const duplicate = await create("ann's", ann, "alpha");
    expect(duplicate.status).toBe(400);
    expect(duplicate.text).toContain("already in use");
  });

  it("won't link a shared record to a scoped one", async () => {
    const annId = (await call(content(), { as: ann, workspace: "alpha" })).json.items[0].id;
    const linked = await call(content("", sharedId), { method: "POST", as: root, workspace: "alpha", body: { values: [{ fieldId: (await call(`/api/collections/${sharedId}`, { as: root })).json.fields[0].id, value: annId }] } });
    expect(linked.status, linked.text).toBe(400);
    expect(linked.text).toContain("can't link to a record in a scoped collection");
  });

  it("keeps each workspace's files apart, and lets records use only their own and the instance's", async () => {
    const upload = async (name: string, workspace?: string) => {
      const response = await fetch(`${baseUrl}/api/files/upload?name=${name}`, { method: "POST", headers: { origin: baseUrl, cookie: root.cookie, "content-type": "text/plain", ...(workspace ? { "x-workspace": workspace } : {}) }, body: name });
      expect(response.status).toBe(200);
      return (await response.json()).id as string;
    };
    const alphaFile = await upload("alpha.txt", "alpha");
    const betaFile = await upload("beta.txt", "beta");
    const instanceFile = await upload("instance.txt");

    // Another workspace's file answers as missing, even to root, and even with a valid token.
    expect((await call(`/api/files/${alphaFile}`, { as: root, workspace: "alpha" })).text).toBe("alpha.txt");
    expect((await call(`/api/files/${alphaFile}`, { as: root, workspace: "beta" })).status).toBe(404);
    expect((await call(`/api/files/${alphaFile}`, { as: root })).status).toBe(404);
    expect((await call(`/api/files/${alphaFile}/info`, { as: root, workspace: "beta" })).status).toBe(404);
    const token = (await call(`/api/files/${alphaFile}/token`, { method: "POST", as: root, workspace: "alpha" })).json.token;
    expect((await call(`/api/files/${alphaFile}?token=${token}`, { workspace: "alpha" })).status).toBe(200);
    expect((await call(`/api/files/${alphaFile}?token=${token}`, { workspace: "beta" })).status).toBe(404);
    expect((await call(`/api/files/${alphaFile}`, { method: "DELETE", as: root, workspace: "beta" })).status).toBe(404);
    // The instance's files are shared by every workspace.
    expect((await call(`/api/files/${instanceFile}`, { as: root, workspace: "beta" })).text).toBe("instance.txt");

    // The library lists only the workspace's own files.
    const listed = async (workspace?: string) => (await call("/api/files?perPage=100", { as: root, workspace })).json.items.map((file: { name: string }) => file.name);
    expect(await listed("alpha")).toContain("alpha.txt");
    expect(await listed("alpha")).not.toContain("beta.txt");
    expect(await listed("alpha")).not.toContain("instance.txt");
    expect(await listed()).toContain("instance.txt");
    expect(await listed()).not.toContain("alpha.txt");

    const docs = await call("/api/collections", { method: "POST", as: root, body: { name: "Scoped docs", slug: "scope-docs", fields: [{ name: "doc", type: "file" }] } });
    expect(docs.status, docs.text).toBe(200);
    const doc = (fileId: string, workspace?: string) => call(content("", docs.json.id), { method: "POST", as: root, workspace, body: { values: [{ fieldId: docs.json.fields[0].id, value: fileId }] } });
    // A shared record's readers span every workspace, so it takes only the instance's files.
    const sharedUse = await doc(alphaFile, "alpha");
    expect(sharedUse.status, sharedUse.text).toBe(400);
    expect(sharedUse.text).toContain("This file does not exist.");
    expect((await doc(instanceFile, "alpha")).status).toBe(200);

    expect((await call(`/api/collections/${docs.json.id}/scope`, { method: "PUT", as: root, body: { scoped: true } })).status).toBe(200);
    expect((await doc(alphaFile, "alpha")).status).toBe(200);
    expect((await doc(instanceFile, "alpha")).status).toBe(200);
    const foreign = await doc(betaFile, "alpha");
    expect(foreign.status, foreign.text).toBe(400);
    expect(foreign.text).toContain("This file does not exist.");
  });

  // Spike T2: site pages are server components outside route(). They resolve their own scope, as
  // a signed-out visitor (Phase 23), and must never inherit startup's unscoped() context, which
  // would show every workspace's records.
  it("serves a scoped record from a site page only in the scope the page resolves", async () => {
    const made = await call("/api/collections", { method: "POST", as: root, body: { name: "Scoped pages", slug: "scope-pages", urlPattern: "/scoped-pages/:slug", fields: [{ name: "slug", type: "text", config: { unique: true, required: true } }, { name: "title", type: "text" }] } });
    expect(made.status, made.text).toBe(200);
    pages = made.json;
    const field = (name: string) => pages.fields.find((item) => item.name === name)!.id;
    expect((await call(`/api/collections/${pages.id}/rules`, { method: "PUT", as: root, body: { listRule: "", viewRule: "", createRule: null, updateRule: null, deleteRule: null } })).status).toBe(200);
    expect((await call(`/api/collections/${pages.id}/scope`, { method: "PUT", as: root, body: { scoped: true } })).status).toBe(200);
    const added = await call(content("", pages.id), { method: "POST", as: root, workspace: "alpha", body: { status: "published", values: [{ fieldId: field("slug"), value: "hello" }, { fieldId: field("title"), value: "alpha-only-title" }] } });
    expect(added.status, added.text).toBe(200);
    // Through the API, in its workspace, the address resolves.
    const resolved = await call("/api/resolve?path=/scoped-pages/hello", { workspace: "alpha" });
    expect(resolved.status, resolved.text).toBe(200);
    expect(resolved.json.record.title).toBe("alpha-only-title");
    expect((await call("/api/resolve?path=/scoped-pages/hello", { workspace: "beta" })).status).toBe(404);
    // The site page resolves its workspace as the API does for a visitor: this example takes it from a header.
    // Without one, or in another workspace, it isn't there.
    for (const workspace of [undefined, "beta", "nowhere"]) {
      const page = await call("/scoped-pages/hello", { workspace });
      expect(page.status, `${workspace}: ${page.status}`).toBe(404);
      expect(page.text).not.toContain("alpha-only-title");
    }
    const alpha = await call("/scoped-pages/hello", { workspace: "alpha" });
    expect(alpha.status, alpha.text.slice(0, 300)).toBe(200);
    expect(alpha.text).toContain("alpha-only-title");
  });

  it("gives each workspace its own site name and colour, over the instance's", async () => {
    const none = await call("/api/settings/site", { as: root });
    expect(none.status).toBe(400);
    expect(none.json.error.code).toBe("SCOPE_REQUIRED");
    // Ann edits alpha's records, and her role there doesn't reach its site.
    expect((await call("/api/settings/site", { as: ann, workspace: "alpha" })).status).toBe(403);
    expect((await call("/api/settings/site", { method: "PUT", as: root, workspace: "alpha", body: { name: "x", logoUrl: "https://elsewhere.test/logo.svg", accentColor: "" } })).status).toBe(400);
    const saved = await call("/api/settings/site", { method: "PUT", as: root, workspace: "alpha", body: { name: "Alpha site", logoUrl: "", accentColor: "#123456" } });
    expect(saved.status, saved.text).toBe(200);
    // `theme` is empty: this workspace serves the build's default theme, having chosen none.
    expect((await call("/api/settings/site", { as: root, workspace: "alpha" })).json).toEqual({ name: "Alpha site", logoUrl: "", accentColor: "#123456", theme: "", hiddenLocales: [] });
    expect((await call("/api/settings/site", { as: root, workspace: "beta" })).json).toEqual({ name: "", logoUrl: "", accentColor: "", theme: "", hiddenLocales: [] });
    // A page with no title of its own is titled with its site's name.
    const slug = pages.fields.find((item) => item.name === "slug")!.id;
    for (const workspace of ["alpha", "beta"]) {
      const made = await call(content("", pages.id), { method: "POST", as: root, workspace, body: { status: "published", values: [{ fieldId: slug, value: "untitled" }] } });
      expect(made.status, made.text).toBe(200);
    }
    const alpha = await call("/scoped-pages/untitled", { workspace: "alpha" });
    expect(alpha.status).toBe(200);
    expect(alpha.text).toContain("<title>Alpha site</title>");
    expect(alpha.text).toContain("#123456");
    const beta = await call("/scoped-pages/untitled", { workspace: "beta" });
    expect(beta.status).toBe(200);
    expect(beta.text).not.toContain("Alpha site");
    expect(beta.text).not.toContain("#123456");
  });

  it("keeps a workspace's own value for a plugin setting marked perScope, and shares the rest", async () => {
    const SETTINGS = "/api/extensions/workspaces/settings";
    const greeting = async (workspace?: string) => (await call("/api/ext/workspaces/greeting", { workspace })).json;
    const saved = await call(SETTINGS, { method: "PUT", as: root, workspace: "alpha", body: { values: { greeting: "Hi from alpha", signature: "Everyone" } } });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json.values).toEqual({ greeting: "Hi from alpha", signature: "Everyone" });
    expect(await greeting("alpha")).toEqual({ greeting: "Hi from alpha", signature: "Everyone" });
    // Beta and the instance keep the instance's greeting, and share the signature.
    expect(await greeting("beta")).toEqual({ greeting: "Hello", signature: "Everyone" });
    expect(await greeting()).toEqual({ greeting: "Hello", signature: "Everyone" });
    expect((await call(SETTINGS, { as: root, workspace: "beta" })).json.values).toEqual({ greeting: "Hello", signature: "Everyone" });
    // A new instance greeting reaches every workspace without its own.
    expect((await call(SETTINGS, { method: "PUT", as: root, body: { values: { greeting: "Welcome", signature: "Everyone" } } })).status).toBe(200);
    expect((await greeting("beta")).greeting).toBe("Welcome");
    expect((await greeting("alpha")).greeting).toBe("Hi from alpha");
    // Setting alpha's back to the instance's keeps nothing of its own, so it follows the instance again.
    expect((await call(SETTINGS, { method: "PUT", as: root, workspace: "alpha", body: { values: { greeting: "Welcome", signature: "Everyone" } } })).status).toBe(200);
    expect((await call(SETTINGS, { method: "PUT", as: root, body: { values: { greeting: "Hello", signature: "Everyone" } } })).status).toBe(200);
    expect((await greeting("alpha")).greeting).toBe("Hello");
    // A workspace editor holds no settings permission.
    expect((await call(SETTINGS, { method: "PUT", as: ann, workspace: "alpha", body: { values: { greeting: "Mine", signature: "Everyone" } } })).status).toBe(403);
  });

  it("keeps a plugin's store per workspace", async () => {
    const VISITS = "/api/ext/workspaces/visits";
    const visit = async (workspace?: string) => (await call(VISITS, { method: "POST", as: root, workspace })).json.visits;
    const before = (await call(VISITS, { as: root })).json.visits;
    expect(await visit("alpha")).toBe(1);
    expect(await visit("alpha")).toBe(2);
    expect(await visit("beta")).toBe(1);
    // Outside any workspace the instance keeps its own count, untouched by the workspaces'.
    expect(await visit()).toBe(before + 1);
    expect((await call(VISITS, { as: ann, workspace: "alpha" })).json.visits).toBe(2);
    expect((await call(VISITS, { as: bob, workspace: "beta" })).json.visits).toBe(1);
  });

  it("refuses to stop scoping while records belong to more than one workspace", async () => {
    const r = await call(`/api/collections/${collectionId}/scope`, { method: "PUT", as: root, body: { scoped: false } });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("SCOPE_VALUES_REMAIN");
  });
});

describe.runIf(!SCOPES && !TENANTS)("without a scope provider", () => {
  it("adds no scope column and refuses to scope a collection", async () => {
    root = await signIn("root@example.test");
    const made = await call("/api/collections", { method: "POST", as: root, body: { name: "Unscoped", slug: "scope-none", fields: [{ name: "title", type: "text" }] } });
    expect(made.status, made.text).toBe(200);
    expect(made.json.scoped).toBe(false);
    // A workspace header means nothing without a provider.
    const listed = await call(`/api/collections/${made.json.id}/content`, { as: root, workspace: "alpha" });
    expect(listed.status, listed.text).toBe(200);
    const r = await call(`/api/collections/${made.json.id}/scope`, { method: "PUT", as: root, body: { scoped: true } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("NO_SCOPE_PROVIDER");
    expect(tablesWithScopeColumn()).toEqual([]);
  });
});
