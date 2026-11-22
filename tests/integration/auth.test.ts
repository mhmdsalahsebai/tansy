import { execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { APP_DIR, CLI, IS_HOST_INSTALL } from "./app-under-test";
import { blankStarterEnv } from "./server-env";

/** The version of a package as the app under test has it installed, from the nearest node_modules up from it. */
function installedVersion(name: string): string {
  for (let dir = APP_DIR; ; dir = path.dirname(dir)) {
    try {
      return JSON.parse(readFileSync(path.join(dir, "node_modules", name, "package.json"), "utf8")).version;
    } catch {
      if (path.dirname(dir) === dir) throw new Error(`${name} is not installed above ${APP_DIR}`);
    }
  }
}

const base = inject("baseUrl");
const PASSWORD = "correct-horse-battery-staple-9431";
const origin = { origin: base };

const POSTGRES = /^postgres(ql)?:/i.test(inject("databaseUrl"));

/** Direct access to the server's database, for checks the API can't make. */
class TestDb {
  private readonly database?: Database.Database;
  constructor(private readonly target: string) { if (!/^postgres(ql)?:/i.test(target)) this.database = new Database(target.replace(/^file:/, ""), { timeout: 10_000 }); }
  query(text: string, params: unknown[] = []): { rows: Array<Record<string, any>>; rowCount: number } { // eslint-disable-line @typescript-eslint/no-explicit-any -- test queries have many shapes
    if (!this.database) return JSON.parse(execFileSync(process.execPath, ["tests/integration/pg-query.mjs", this.target, text, JSON.stringify(params)], { encoding: "utf8" }));
    const statement = this.database.prepare(text.replace(/\$\d+/g, "?"));
    if (statement.reader) {
      const rows = statement.all(...params) as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any -- as above
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: statement.run(...params).changes };
  }
  end() { this.database?.close(); }
}

interface Actor { id: string; email: string; cookie: string }
let root: Actor, admin: Actor, editor: Actor, member: Actor, db: TestDb;

type Options = { method?: string; body?: unknown; as?: Actor | null; headers?: Record<string, string>; redirect?: RequestRedirect };

async function call(path: string, { method = "GET", body, as, headers = {}, redirect = "manual" }: Options = {}) {
  const response = await fetch(base + path, {
    method,
    redirect,
    headers: { ...origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(as ? { cookie: as.cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, text, headers: response.headers };
}

/** Applies Set-Cookie the way a browser does: the last value for a name wins, and expired cookies are dropped. */
function cookiesFrom(headers: Headers) {
  const jar = new Map<string, string>();
  for (const cookie of headers.getSetCookie()) {
    const pair = cookie.split(";")[0];
    const name = pair.slice(0, pair.indexOf("="));
    if (/max-age=0/i.test(cookie) || pair.endsWith("=")) jar.delete(name);
    else jar.set(name, pair);
  }
  return [...jar.values()].join("; ");
}

async function signIn(email: string, password = PASSWORD): Promise<Actor> {
  const r = await call("/api/auth/sign-in/email", { method: "POST", body: { email, password } });
  expect(r.status, r.text).toBe(200);
  return { id: r.json.user.id, email, cookie: cookiesFrom(r.headers) };
}

async function settings() {
  return (await call("/api/settings/auth", { as: root })).json.settings;
}

async function configure(mutate: (s: any) => void) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const s = await settings();
  mutate(s);
  const r = await call("/api/settings/auth", { method: "PUT", body: s, as: root });
  expect(r.status, r.text).toBe(204);
  await new Promise((resolve) => setTimeout(resolve, 2200));
}

async function mailbox(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let data = "";
    net.connect(2588, "127.0.0.1").on("data", (c) => (data += c)).on("end", () => resolve(JSON.parse(data))).on("error", reject);
  });
}

function decodeMail(raw: string) {
  return raw.replace(/=\n/g, "").replace(/=3D/g, "=");
}

async function latestLink(to: string, match: RegExp): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const found = (await mailbox()).map(decodeMail).reverse().find((m) => m.includes(to) && match.test(m));
    if (found) return match.exec(found)![0];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No mail for ${to} matching ${match}: ${(await mailbox()).slice(-1)}`);
}

function totp(secretBase32: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secretBase32.replace(/=+$/, "")) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[19] & 15;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function makeUser(name: string, role: string) {
  const email = `${name}@example.test`;
  const r = await call("/api/users", { method: "POST", as: root, body: { name, email, password: PASSWORD, role } });
  expect(r.status, r.text).toBe(200);
  return email;
}

beforeAll(async () => {
  db = new TestDb(inject("databaseUrl"));
});
afterAll(() => db.end());

describe("first run", () => {
  it("reports setup is needed and locks the app until then", async () => {
    expect((await call("/api/auth-config")).json.setupRequired).toBe(true);
  });
  it("rejects a wrong token and a weak password", async () => {
    expect((await call("/api/setup", { method: "POST", body: { token: "nope", name: "R", email: "root@example.test", password: PASSWORD } })).status).toBe(403);
    expect((await call("/api/setup", { method: "POST", body: { token: inject("setupToken"), name: "R", email: "root@example.test", password: "short" } })).json.error.code).toBe("PASSWORD_LENGTH");
  });
  it("creates the superadmin once", async () => {
    const body = { token: inject("setupToken"), name: "Root", email: "root@example.test", password: PASSWORD };
    expect((await call("/api/setup", { method: "POST", body })).status).toBe(200);
    expect((await call("/api/setup", { method: "POST", body })).status).toBe(403);
    root = await signIn("root@example.test");
    expect((await call("/api/auth-config")).json.setupRequired).toBe(false);
  });
  it("gives the superadmin every permission", async () => {
    const me = await call("/api/me", { as: root });
    expect(me.json.permissions).toContain("setting:update");
    expect(me.json.permissions).toContain("user:impersonate");
  });
  it("relaxes limits for the rest of this suite", async () => {
    await configure((s) => { s.rateLimit.authMax = 1000; s.lockout.enabled = false; s.mail.host = "127.0.0.1"; s.mail.port = inject("smtpPort"); s.mail.requireStartTls = false; s.mail.fromAddress = "cms@example.test"; });
  });
});

describe("account creation", () => {
  it("is closed by default", async () => {
    const r = await call("/api/auth/sign-up/email", { method: "POST", body: { name: "x", email: "x@example.test", password: PASSWORD } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await db.query(`SELECT 1 FROM "user" WHERE email='x@example.test'`)).rowCount).toBe(0);
  });
  it("creates staff through the guarded API", async () => {
    await makeUser("admin", "admin");
    await makeUser("editor", "editor");
    await makeUser("member", "user");
    [admin, editor, member] = await Promise.all([signIn("admin@example.test"), signIn("editor@example.test"), signIn("member@example.test")]);
  });
  it("enforces the password policy, including checks from plugins", async () => {
    const weak = await call("/api/users", { method: "POST", as: root, body: { name: "w", email: "w@example.test", password: "short", role: "user" } });
    expect(weak.json.error.code).toBe("PASSWORD_LENGTH");
    const breached = await call("/api/users", { method: "POST", as: root, body: { name: "w", email: "w@example.test", password: "a-long-forbiddenword-passphrase-22", role: "user" } });
    expect(breached.status).toBeGreaterThanOrEqual(400);
  });
});

describe("authorization", () => {
  it("answers 401 for anonymous and 403 for insufficient roles", async () => {
    expect((await call("/api/users")).status).toBe(401);
    expect((await call("/api/users", { as: member })).status).toBe(403);
    expect((await call("/api/users", { as: editor })).status).toBe(403);
    expect((await call("/api/users", { as: admin })).status).toBe(200);
    expect((await call("/api/settings/auth", { as: editor })).status).toBe(403);
    expect((await call("/api/audit", { as: member })).status).toBe(403);
  });
  it("runs background work from its endpoint only for the cron secret, and not beside the server's own timers", async () => {
    const tick = (authorization?: string) => fetch(base + "/api/background", { headers: authorization ? { authorization } : {} });
    expect((await tick()).status).toBe(401);
    expect((await tick("Bearer not-the-secret-at-all")).status).toBe(401);
    // This server runs it on its timers, so the endpoint would only run it twice.
    const right = await tick("Bearer integration-cron-secret");
    expect(right.status).toBe(409);
    expect((await right.json()).error.code).toBe("BACKGROUND_ON_TIMERS");
  });
  it("closes better-auth's admin endpoints to direct HTTP", async () => {
    for (const path of ["/admin/list-users", "/admin/ban-user", "/admin/set-role", "/admin/create-user", "/admin/remove-user", "/api-key/create", "/api-key/list"]) {
      for (const method of ["GET", "POST"]) {
        const r = await call(`/api/auth${path}`, { method, as: root, body: method === "POST" ? { userId: member.id, role: "admin" } : undefined });
        expect(r.status, `${method} ${path}`).toBe(404);
      }
    }
    expect((await db.query(`SELECT role FROM "user" WHERE id=$1`, [member.id])).rows[0].role).toBe("user");
  });
  it("blocks users from granting themselves a role", async () => {
    await call("/api/auth/update-user", { method: "POST", as: member, body: { role: "superadmin" } });
    expect((await db.query(`SELECT role FROM "user" WHERE id=$1`, [member.id])).rows[0].role).toBe("user");
  });
  it("blocks vertical escalation", async () => {
    expect((await call(`/api/users/${member.id}/role`, { method: "PUT", as: admin, body: { role: "superadmin" } })).json.error.code).toBe("ROLE_EXCEEDS_ACTOR");
    expect((await call(`/api/users`, { method: "POST", as: admin, body: { name: "e", email: "e@example.test", password: PASSWORD, role: "superadmin" } })).json.error.code).toBe("ROLE_EXCEEDS_ACTOR");
    expect((await call(`/api/roles/editor`, { method: "PUT", as: admin, body: { label: "E", permissions: ["setting:update"] } })).status).toBe(403);
  });
  it("blocks acting on more privileged accounts and on yourself", async () => {
    expect((await call(`/api/users/${root.id}/ban`, { method: "POST", as: admin, body: {} })).json.error.code).toBe("TARGET_MORE_PRIVILEGED");
    expect((await call(`/api/users/${root.id}/role`, { method: "PUT", as: root, body: { role: "user" } })).json.error.code).toBe("CANNOT_TARGET_SELF");
  });
  it("protects the superadmin role", async () => {
    expect((await call("/api/roles/superadmin", { method: "PUT", as: root, body: { label: "x", permissions: [] } })).json.error.code).toBe("ROLE_IMMUTABLE");
    expect((await call("/api/roles/editor", { method: "DELETE", as: root })).json.error.code).toBe("ROLE_IMMUTABLE");
  });
  it("drops a saved permission that no longer exists when the role is saved", async () => {
    expect((await call("/api/roles", { method: "POST", as: root, body: { name: "leftover", label: "Leftover", permissions: ["dashboard:access"] } })).status).toBe(200);
    // Such as log:read, from before request logs became a plugin.
    db.query(POSTGRES ? `UPDATE "Role" SET permissions = $1::jsonb WHERE name = 'leftover'` : `UPDATE "Role" SET permissions = ? WHERE name = 'leftover'`, [JSON.stringify(["dashboard:access", "log:read"])]);
    const saved = await call("/api/roles/leftover", { method: "PUT", as: root, body: { label: "Leftover", permissions: ["dashboard:access", "log:read"] } });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(db.query(`SELECT permissions FROM "Role" WHERE name = 'leftover'`).rows)).not.toContain("log:read");
    expect((await call("/api/roles/leftover", { method: "PUT", as: root, body: { label: "Leftover", permissions: ["dashboard:access", "user:fly"] } })).json.error.code).toBe("UNKNOWN_PERMISSION");
    await call("/api/roles/leftover", { method: "DELETE", as: root });
  });
  it("applies dashboard-defined roles to better-auth at once", async () => {
    const created = await call("/api/roles", { method: "POST", as: root, body: { name: "auditor", label: "Auditor", permissions: ["dashboard:access", "audit:read"] } });
    expect(created.status, created.text).toBe(200);
    expect((await call("/api/roles", { method: "POST", as: root, body: { name: "bad", label: "B", permissions: ["user:fly"] } })).json.error.code).toBe("UNKNOWN_PERMISSION");
    expect((await call(`/api/users/${member.id}/role`, { method: "PUT", as: root, body: { role: "auditor" } })).status, "assign custom role").toBe(204);
    member = await signIn(member.email);
    expect((await call("/api/audit?perPage=1", { as: member })).status).toBe(200);
    expect((await call("/api/users", { as: member })).status).toBe(403);
    expect((await call(`/api/users/${member.id}/role`, { method: "PUT", as: root, body: { role: "user" } })).status).toBe(204);
  });
  it("ends sessions when a role changes", async () => {
    expect((await call("/api/me", { as: member })).status).toBe(401);
    member = await signIn(member.email);
  });
  it("rejects cross-site writes and unsafe content types", async () => {
    expect((await call("/api/collections", { method: "POST", as: root, body: { name: "x", slug: "x", fields: [] }, headers: { origin: "https://evil.test" } })).json.error.code).toBe("CSRF_REJECTED");
    expect((await call("/api/collections", { method: "POST", as: root, body: { name: "x", slug: "x", fields: [] }, headers: { origin: "", "sec-fetch-site": "cross-site" } })).status).toBe(403);
    const form = await fetch(base + "/api/collections", { method: "POST", headers: { ...origin, cookie: root.cookie, "content-type": "text/plain" }, body: "{}" });
    expect(form.status).toBe(415);
  });
  it("validates input and hides internals", async () => {
    const r = await call("/api/collections", { method: "POST", as: root, body: { name: "", slug: "Bad Slug", fields: "nope" } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("VALIDATION_FAILED");
    expect((await call("/api/collections/abc", { as: root })).status).toBe(404);
  });
});

describe("headless frontends", () => {
  const SITE = "https://site.example.test";
  let token: string;

  it("are trusted once listed, with bearer tokens on", async () => {
    await configure((s) => { s.network.trustedOrigins = [SITE]; s.methods.bearer = true; });
  });
  it("get CORS answers, and other origins get none", async () => {
    const pre = await call("/api/auth/sign-in/email", { method: "OPTIONS", headers: { origin: SITE, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(pre.headers.get("access-control-allow-credentials")).toBe("true");
    expect(pre.headers.get("access-control-allow-headers")).toBe("content-type");
    const evil = await call("/api/auth/sign-in/email", { method: "OPTIONS", headers: { origin: "https://evil.test", "access-control-request-method": "POST" } });
    expect(evil.headers.has("access-control-allow-origin")).toBe(false);
    const read = await call("/api/auth-config", { headers: { origin: SITE } });
    expect(read.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(read.headers.get("vary")).toMatch(/origin/i);
    expect((await call("/api/auth-config", { headers: { origin: "https://evil.test" } })).headers.has("access-control-allow-origin")).toBe(false);
    // Errors too, so the site can show them.
    const denied = await call("/api/users", { headers: { origin: SITE } });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-allow-origin")).toBe(SITE);
  });
  it("sign members in with a token the site can read", async () => {
    const r = await call("/api/auth/sign-in/email", { method: "POST", headers: { origin: SITE }, body: { email: member.email, password: PASSWORD } });
    expect(r.status, r.text).toBe(200);
    token = r.headers.get("set-auth-token")!;
    expect(token).toMatch(/\./);
    expect(r.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(r.headers.get("access-control-expose-headers")).toMatch(/set-auth-token/);
    const me = await call("/api/me", { headers: { origin: SITE, authorization: `Bearer ${token}` } });
    expect(me.status, me.text).toBe(200);
    expect(me.json.user.email).toBe(member.email);
  });
  it("sign in from a server, which sends no Origin", async () => {
    const r = await fetch(base + "/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: member.email, password: PASSWORD }) });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(r.headers.get("set-auth-token")).toBeTruthy();
  });
  it("write with a bearer token from another site, which isn't ambient, so CSRF doesn't apply", async () => {
    const r = await call("/api/users", { method: "POST", headers: { origin: SITE, "sec-fetch-site": "cross-site", authorization: `Bearer ${token}` }, body: { name: "n", email: "n@example.test", password: PASSWORD, role: "user" } });
    // Refused for lack of permission, never as a cross-site request.
    expect(r.json.error.code).toBe("FORBIDDEN");
  });
  it("can't use a token without its signature, or once bearer tokens are off", async () => {
    expect((await call("/api/me", { headers: { authorization: `Bearer ${token.split(".")[0]}` } })).status).toBe(401);
    await configure((s) => { s.network.trustedOrigins = []; s.methods.bearer = false; });
    expect((await call("/api/me", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect((await call("/api/auth-config", { headers: { origin: SITE } })).headers.has("access-control-allow-origin")).toBe(false);
  });
});

describe("collections and API rules", () => {
  let collection: { id: number; fields: Array<{ id: number }> };
  let other: { id: number; fields: Array<{ id: number }> };
  let published: number, draft: number;
  const content = () => `/api/collections/${collection.id}/content`;

  it("are locked by default", async () => {
    collection = (await call("/api/collections", { method: "POST", as: root, body: { name: "Posts", slug: "posts", fields: [{ name: "title", type: "text" }] } })).json;
    other = (await call("/api/collections", { method: "POST", as: root, body: { name: "Other", slug: "other", fields: [{ name: "x", type: "text" }] } })).json;
    expect((await call(content())).status).toBe(403);
    expect((await call(content(), { as: member })).status).toBe(403);
  });
  it("let staff with record permissions manage content", async () => {
    const value = (v: string) => [{ fieldId: collection.fields[0].id, value: v }];
    const a = await call(content(), { method: "POST", as: editor, body: { status: "published", values: value("hello") } });
    expect(a.status, a.text).toBe(200);
    expect(a.json.publishedAt, "publish sets publishedAt").toBeTruthy();
    published = a.json.id;
    draft = (await call(content(), { method: "POST", as: editor, body: { values: value("secret") } })).json.id;
  });
  it("reject values for another collection's field and invalid statuses", async () => {
    expect((await call(content(), { method: "POST", as: editor, body: { values: [{ fieldId: other.fields[0].id, value: "x" }] } })).status).toBe(400);
    expect((await call(content(), { method: "POST", as: editor, body: { status: "banana", values: [] } })).status).toBe(400);
  });
  it("reject invalid rules at save time", async () => {
    const rules = { listRule: 'titel = "x"', viewRule: null, createRule: null, updateRule: null, deleteRule: null };
    const r = await call(`/api/collections/${collection.id}/rules`, { method: "PUT", as: root, body: rules });
    expect(r.json.error.code).toBe("INVALID_RULE");
    expect((await call(`/api/collections/${collection.id}/rules`, { method: "PUT", as: editor, body: rules })).status).toBe(403);
  });
  it("filter lists and hide unauthorized records with PocketBase status codes", async () => {
    const rules = {
      listRule: 'status = "published"',
      viewRule: 'status = "published"',
      createRule: '@request.auth.id != ""',
      updateRule: "@request.auth.id = createdById",
      deleteRule: null,
    };
    expect((await call(`/api/collections/${collection.id}/rules`, { method: "PUT", as: root, body: rules })).status).toBe(200);
    const list = await call(content());
    expect(list.status).toBe(200);
    expect(list.json.items.map((i: { id: number }) => i.id)).toEqual([published]);
    expect((await call(`${content()}/${published}`)).status).toBe(200);
    expect((await call(`${content()}/${draft}`)).status).toBe(404);
    expect((await call(content(), { method: "POST", body: { values: [] } })).status).toBe(400);
    const mine = await call(content(), { method: "POST", as: member, body: { values: [] } });
    expect(mine.status, mine.text).toBe(200);
    expect((await call(`${content()}/${mine.json.id}`, { method: "PATCH", as: member, body: { values: [] } })).status).toBe(200);
    expect((await call(`${content()}/${published}`, { method: "PATCH", as: member, body: { values: [] } })).status).toBe(404);
    expect((await call(`${content()}/${published}`, { method: "DELETE", as: member })).status).toBe(403);
  });
  it("read as a member over HTTP under the rules alone, never with the role's permissions", async () => {
    // A headless site's viewer() reads this way, as a same-app page's does.
    expect((await call(`${content()}/${draft}`, { as: editor })).status).toBe(200);
    expect((await call(`${content()}/${draft}`, { as: editor, headers: { "x-cms-as": "member" } })).status).toBe(404);
    const list = await call(content(), { as: editor, headers: { "x-cms-as": "member" } });
    expect(list.json.items.map((i: { id: number }) => i.id)).not.toContain(draft);
    // Who they are still counts: the update rule lets an author edit their own record.
    const mine = await call(content(), { method: "POST", as: member, headers: { "x-cms-as": "member" }, body: { values: [] } });
    expect(mine.status, mine.text).toBe(200);
    expect((await call(`${content()}/${mine.json.id}`, { method: "PATCH", as: member, headers: { "x-cms-as": "member" }, body: { values: [] } })).status).toBe(200);
    expect((await call(`${content()}/${published}`, { method: "PATCH", as: member, headers: { "x-cms-as": "member" }, body: { values: [] } })).status).toBe(404);
    // A member is a person: with an API key, or as anything else, it's refused.
    expect((await call(content(), { headers: { "x-api-key": "cms_nope", "x-cms-as": "member" } })).json.error.code).toBe("MEMBER_NEEDS_SESSION");
    expect((await call(content(), { as: editor, headers: { "x-cms-as": "admin" } })).status).toBe(400);
    // Management routes need permissions a member never has.
    expect((await call("/api/users", { as: root, headers: { "x-cms-as": "member" } })).status).toBe(403);
  });
  it("can be deleted even with fields and content", async () => {
    expect((await call(`/api/collections/${other.id}`, { method: "DELETE", as: root })).status).toBe(204);
  });
});

describe("collection schema and records", () => {
  let posts: { id: number; slug: string; fields: Array<{ id: number; name: string; type: string; config?: unknown }> };
  const schema = () => `/api/collections/${posts.id}/fields`;
  const content = () => `/api/collections/${posts.id}/content`;
  const kept = () => posts.fields.map((f) => ({ id: f.id, name: f.name, type: f.type, config: f.config as Record<string, unknown> }));
  const value = (name: string, v: unknown) => ({ fieldId: posts.fields.find((f) => f.name === name)!.id, value: v });
  const read = (json: { values: Array<{ field: { name: string }; value: unknown }> }, name: string) => json.values.find((v) => v.field.name === name)?.value;
  const put = async (fields: unknown, confirm = false) => call(schema(), { method: "PUT", as: root, body: { fields, confirm } });
  const update = async (fields: unknown, confirm = false) => {
    const r = await put(fields, confirm);
    expect(r.status, r.text).toBe(200);
    posts = r.json;
  };
  const rows = async <T,>(query: string, params: unknown[] = []) => (await db.query(query, params)).rows as T[];
  const columns = async (table: string) => (await rows<{ column_name: string }>(POSTGRES ? "SELECT column_name FROM information_schema.columns WHERE table_name = $1" : "SELECT name AS column_name FROM pragma_table_info($1)", [`rec_${table}`])).map((c) => c.column_name);

  it("publishes the field type catalogue to staff only", async () => {
    expect((await call("/api/field-types")).status).toBe(401);
    expect((await call("/api/field-types", { as: member })).status).toBe(403);
    const r = await call("/api/field-types", { as: root });
    expect(r.status, r.text).toBe(200);
    expect(r.json.map((t: { type: string }) => t.type)).toEqual(expect.arrayContaining(["text", "reference", "json"]));
  });
  it("creates a real table with typed columns", async () => {
    const r = await call("/api/collections", { method: "POST", as: root, body: { name: "Articles", slug: "blog-articles", fields: [
      { name: "title", type: "text", config: { required: true, maxLength: 10 } },
      { name: "views", type: "number", config: { min: 0 } },
      { name: "code", type: "text", config: { unique: true } },
    ] } });
    expect(r.status, r.text).toBe(200);
    posts = r.json;
    const types = await rows<{ column_name: string; data_type: string }>(POSTGRES ? "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'rec_blog_articles'" : "SELECT name AS column_name, type AS data_type FROM pragma_table_info('rec_blog_articles')");
    expect(Object.fromEntries(types.map((c) => [c.column_name, c.data_type]))).toMatchObject(POSTGRES ? { title: "text", views: "double precision", code: "text", id: "integer" } : { title: "TEXT", views: "REAL", code: "TEXT", id: "INTEGER" });
  });
  it("returns field-level errors for bad values", async () => {
    const bad = await call(content(), { method: "POST", as: editor, body: { values: [value("title", "far too long a title"), value("views", -1)] } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.details.map((d: { path: string }) => d.path).sort()).toEqual(["title", "views"]);
    const missing = await call(content(), { method: "POST", as: editor, body: { values: [] } });
    expect(missing.status).toBe(400);
    expect(missing.json.error.details[0]).toMatchObject({ path: "title" });
    const wrongType = await call(content(), { method: "POST", as: editor, body: { values: [value("title", "ok"), value("views", "text")] } });
    expect(wrongType.json.error.details[0].path).toBe("views");
  });
  it("keeps data when fields are added and removed", async () => {
    const created = await call(content(), { method: "POST", as: editor, body: { values: [value("title", "First"), value("views", 7), value("code", "a1")] } });
    expect(created.status, created.text).toBe(200);
    const id = created.json.id;

    await update([...kept(), { name: "subtitle", type: "text" }, { name: "extra", type: "text" }]);
    expect(await columns("blog_articles")).toEqual(expect.arrayContaining(["subtitle", "extra"]));
    let got = await call(`${content()}/${id}`, { as: editor });
    expect(read(got.json, "title")).toBe("First");
    expect(read(got.json, "subtitle")).toBeNull();

    const without = kept().filter((f) => f.name !== "extra");
    const refused = await put(without);
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("CONFIRMATION_REQUIRED");
    expect(await columns("blog_articles")).toContain("extra");

    await update(without, true);
    expect(await columns("blog_articles")).not.toContain("extra");
    got = await call(`${content()}/${id}`, { as: editor });
    expect(read(got.json, "views")).toBe(7);
  });
  it("updates only the submitted values", async () => {
    const created = (await call(content(), { method: "POST", as: editor, body: { values: [value("title", "Partial"), value("views", 1)] } })).json;
    const patched = await call(`${content()}/${created.id}`, { method: "PATCH", as: editor, body: { values: [value("views", 2)] } });
    expect(patched.status, patched.text).toBe(200);
    expect(read(patched.json, "title")).toBe("Partial");
    expect(read(patched.json, "views")).toBe(2);
    expect((await call(`${content()}/${created.id}`, { method: "DELETE", as: editor })).status).toBe(204);
    expect((await call(`${content()}/${created.id}`, { as: editor })).status).toBe(404);
  });
  it("reports unique violations on the field", async () => {
    const dup = await call(content(), { method: "POST", as: editor, body: { values: [value("title", "Second"), value("code", "a1")] } });
    expect(dup.status).toBe(400);
    expect(dup.json.error.details).toEqual([{ path: "code", message: expect.any(String) }]);
  });
  it("renames columns without losing values", async () => {
    await update(kept().map((f) => (f.name === "views" ? { ...f, name: "hits" } : f)));
    const list = await call(content(), { as: editor });
    expect(read(list.json.items[0], "hits")).toBe(7);
  });
  it("converts types, and requires confirmation when values can be lost", async () => {
    await update(kept().map((f) => (f.name === "hits" ? { ...f, type: "text", config: {} } : f)));
    let list = await call(content(), { as: editor });
    expect(read(list.json.items[0], "hits")).toBe("7");
    const back = kept().map((f) => (f.name === "hits" ? { ...f, type: "number", config: {} } : f));
    expect((await put(back)).status).toBe(409);
    await update(back, true);
    list = await call(content(), { as: editor });
    expect(read(list.json.items[0], "hits")).toBe(7);
  });
  it("rolls back the whole change on failure", async () => {
    await call(content(), { method: "POST", as: editor, body: { values: [value("title", "Dup"), value("subtitle", "same")] } });
    await call(content(), { method: "POST", as: editor, body: { values: [value("title", "Dup2"), value("subtitle", "same")] } });
    const before = (await rows("SELECT 1 FROM \"SchemaMigration\" WHERE \"collectionId\" = $1", [posts.id])).length;
    const r = await put([...kept().map((f) => (f.name === "subtitle" ? { ...f, config: { unique: true } } : f)), { name: "shouldVanish", type: "text" }]);
    expect(r.status).toBe(409);
    expect(r.json.error.details[0].path).toMatch(/config\.unique$/);
    expect(await columns("blog_articles")).not.toContain("shouldVanish");
    expect((await call(`/api/collections/${posts.id}`, { as: root })).json.fields.map((f: { name: string }) => f.name)).not.toContain("shouldVanish");
    expect((await rows("SELECT 1 FROM \"SchemaMigration\" WHERE \"collectionId\" = $1", [posts.id])).length).toBe(before);
    expect(before).toBeGreaterThan(0);
  });
  it("refuses names that are unsafe or reserved, without touching the database", async () => {
    for (const name of ['x"; DROP TABLE "user"; --', "id", "createdAt", "has space"]) {
      const r = await put([...kept(), { name, type: "text" }]);
      expect(r.status, name).toBe(400);
      expect(r.json.error.details[0].path).toMatch(/name$/);
    }
    expect((await rows('SELECT 1 FROM "user" LIMIT 1')).length).toBe(1);
  });
  it("refuses changes that would break an API rule", async () => {
    const rules = { listRule: 'subtitle != ""', viewRule: null, createRule: null, updateRule: null, deleteRule: null };
    expect((await call(`/api/collections/${posts.id}/rules`, { method: "PUT", as: root, body: rules })).status).toBe(200);
    const r = await put(kept().filter((f) => f.name !== "subtitle"), true);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("INVALID_RULE");
    expect((await call(`/api/collections/${posts.id}/rules`, { method: "PUT", as: root, body: { ...rules, listRule: null } })).status).toBe(200);
  });
  it("requires the update permission and hides validation from callers who may not write", async () => {
    expect((await call(schema(), { method: "PUT", body: { fields: [] } })).status).toBe(401);
    expect((await call(schema(), { method: "PUT", as: member, body: { fields: [] } })).status).toBe(403);
    expect((await call(content(), { method: "POST", as: member, body: { values: [value("hits", "bad")] } })).json.error.code).toBe("RULE_LOCKED");
  });
  it("renames the table with the slug, keeping records", async () => {
    const r = await call(`/api/collections/${posts.id}`, { method: "PATCH", as: root, body: { slug: "news" } });
    expect(r.status, r.text).toBe(200);
    expect(await columns("blog_articles")).toEqual([]);
    expect(await columns("news")).toContain("title");
    expect((await call(content(), { as: editor })).json.totalItems).toBeGreaterThan(0);
    posts.slug = "news";
  });
  it("validates references, clears them when the target goes, and protects target collections", async () => {
    const target = (await call("/api/collections", { method: "POST", as: root, body: { name: "Authors", slug: "authors", fields: [] } })).json;
    await update([...kept(), { name: "author", type: "reference", config: { collection: target.id } }]);
    const missing = await call(content(), { method: "POST", as: editor, body: { values: [value("title", "Ref"), value("author", 999)] } });
    expect(missing.status).toBe(400);
    expect(missing.json.error.details[0].path).toBe("author");
    const author = (await call(`/api/collections/${target.id}/content`, { method: "POST", as: editor, body: { values: [] } })).json;
    const linked = await call(content(), { method: "POST", as: editor, body: { values: [value("title", "Ref"), value("author", author.id)] } });
    expect(linked.status, linked.text).toBe(200);
    expect((await call(`/api/collections/${target.id}`, { method: "DELETE", as: root })).status).toBe(409);
    expect((await call(`/api/collections/${target.id}/content/${author.id}`, { method: "DELETE", as: editor })).status).toBe(204);
    expect(read((await call(`${content()}/${linked.json.id}`, { as: editor })).json, "author")).toBeNull();
    expect((await put([...kept(), { name: "nowhere", type: "reference", config: { collection: 999999 } }])).json.error.details[0].path).toMatch(/config\.collection$/);
  });
  it("stores multi-value references as a list and removes deleted targets from it", async () => {
    const target = (await call("/api/collections", { method: "POST", as: root, body: { name: "Labels", slug: "labels", fields: [] } })).json;
    await update([...kept(), { name: "labels", type: "reference", config: { collection: target.id, allowMultiple: true } }]);
    const label = async () => (await call(`/api/collections/${target.id}/content`, { method: "POST", as: editor, body: { values: [] } })).json.id as number;
    const [a, b, c] = [await label(), await label(), await label()];

    const missing = await call(content(), { method: "POST", as: editor, body: { values: [value("title", "Many"), value("labels", [a, 999999])] } });
    expect(missing.status).toBe(400);
    expect(missing.json.error.details[0].path).toBe("labels");

    const linked = await call(content(), { method: "POST", as: editor, body: { values: [value("title", "Many"), value("labels", [a, b, c])] } });
    expect(linked.status, linked.text).toBe(200);
    expect(read(linked.json, "labels")).toEqual([a, b, c]);

    expect((await call(`/api/collections/${target.id}`, { method: "DELETE", as: root })).status).toBe(409);
    expect((await call(`/api/collections/${target.id}/content/${b}`, { method: "DELETE", as: editor })).status).toBe(204);
    expect(read((await call(`${content()}/${linked.json.id}`, { as: editor })).json, "labels")).toEqual([a, c]);

    const flipped = await put(kept().map((f) => (f.name === "labels" ? { ...f, config: { ...f.config, allowMultiple: false } } : f)));
    expect(flipped.status).toBe(400);
  });
  it("round-trips every field type through real columns", async () => {
    const OPTIONS = { options: [{ label: "A", value: "a" }, { label: "B", value: "b" }] };
    const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const newFile = async () => {
      const r = await fetch(`${base}/api/files/upload?name=a.png`, { method: "POST", headers: { ...origin, cookie: editor.cookie, "content-type": "image/png" }, body: PNG });
      expect(r.status).toBe(200);
      return (await r.json()).id as string;
    };
    const [one, two, three, four] = [await newFile(), await newFile(), await newFile(), await newFile()];
    const samples: Array<[string, Record<string, unknown>, unknown]> = [
      ["text", {}, "héllo 'quoted' \"x\""],
      ["rich_text", {}, { type: "doc", content: [{ type: "text", text: "hi" }] }],
      ["code", {}, "const a = 1;\nconst b = 2;"],
      ["number", {}, 1.5],
      ["email", {}, "a@example.test"],
      ["url", {}, "https://example.test/a?b=1"],
      ["date", {}, "2026-03-29"],
      ["datetime", {}, "2026-03-29T10:00:00.000Z"],
      ["image", {}, one],
      ["file", {}, two],
      ["gallery", {}, [three, four]],
      ["checkbox", OPTIONS, ["a", "b"]],
      ["radio", OPTIONS, "b"],
      ["boolean", {}, false],
      ["json", {}, [1, "two", { three: null }]],
    ];
    const made = await call("/api/collections", { method: "POST", as: root, body: { name: "Types", slug: "all-types", fields: samples.map(([type, config]) => ({ name: `f_${type}`, type, config })) } });
    expect(made.status, made.text).toBe(200);
    const url = `/api/collections/${made.json.id}/content`;
    const fieldId = (type: string) => made.json.fields.find((f: { type: string }) => f.type === type).id;

    const created = await call(url, { method: "POST", as: editor, body: { values: samples.map(([type, , v]) => ({ fieldId: fieldId(type), value: v })) } });
    expect(created.status, created.text).toBe(200);
    for (const [type, , v] of samples) expect(read(created.json, `f_${type}`), type).toEqual(v);

    // The dashboard sends back exactly what it received.
    const resent = await call(`${url}/${created.json.id}`, { method: "PATCH", as: editor, body: { values: created.json.values.map((x: { fieldId: number; value: unknown }) => ({ fieldId: x.fieldId, value: x.value })) } });
    expect(resent.status, resent.text).toBe(200);
    for (const [type, , v] of samples) expect(read(resent.json, `f_${type}`), type).toEqual(v);

    const blank = await call(url, { method: "POST", as: editor, body: { values: samples.map(([type]) => ({ fieldId: fieldId(type), value: "" })) } });
    expect(blank.status, blank.text).toBe(200);
    for (const [type] of samples) expect(read(blank.json, `f_${type}`), type).toBeNull();
  });
  it("supports a collection referencing itself, and deleting it", async () => {
    const self = (await call("/api/collections", { method: "POST", as: root, body: { name: "Tree", slug: "tree", fields: [] } })).json;
    const r = await call(`/api/collections/${self.id}/fields`, { method: "PUT", as: root, body: { fields: [{ name: "parent", type: "reference", config: { collection: self.id } }] } });
    expect(r.status, r.text).toBe(200);
    expect((await call(`/api/collections/${self.id}`, { method: "DELETE", as: root })).status).toBe(204);
  });
  it("removes unique and reference fields, keeping the others", async () => {
    const target = (await call("/api/collections", { method: "POST", as: root, body: { name: "Target", slug: "target", fields: [] } })).json;
    const made = (await call("/api/collections", { method: "POST", as: root, body: { name: "Removable", slug: "removable", fields: [
      { name: "code", type: "text", config: { unique: true } },
      { name: "link", type: "reference", config: { collection: target.id } },
      { name: "keep", type: "boolean" },
    ] } })).json;
    const keep = made.fields.find((f: { name: string }) => f.name === "keep");
    const url = `/api/collections/${made.id}/content`;
    const row = await call(url, { method: "POST", as: editor, body: { values: [{ fieldId: keep.id, value: true }] } });
    const r = await call(`/api/collections/${made.id}/fields`, { method: "PUT", as: root, body: { confirm: true, fields: [{ id: keep.id, name: "keep", type: "boolean", config: {} }] } });
    expect(r.status, r.text).toBe(200);
    expect(read((await call(`${url}/${row.json.id}`, { as: editor })).json, "keep")).toBe(true);
    expect((await call(`/api/collections/${target.id}`, { method: "DELETE", as: root })).status).toBe(204);
  });
  it("keeps uniqueness through a rename and a conversion", async () => {
    const made = (await call("/api/collections", { method: "POST", as: root, body: { name: "Uniq", slug: "uniq", fields: [{ name: "code", type: "text", config: { unique: true } }] } })).json;
    const url = `/api/collections/${made.id}/content`;
    const id = made.fields[0].id;
    expect((await call(url, { method: "POST", as: editor, body: { values: [{ fieldId: id, value: "1" }] } })).status).toBe(200);
    expect((await call(url, { method: "POST", as: editor, body: { values: [{ fieldId: id, value: "1.0" }] } })).status).toBe(200);
    const fields = (body: unknown) => call(`/api/collections/${made.id}/fields`, { method: "PUT", as: root, body });
    const collide = await fields({ confirm: true, fields: [{ id, name: "serial", type: "number", config: { unique: true } }] });
    expect(collide.status, collide.text).toBe(409);
    expect((await columns("uniq")).filter((c) => c === "code").length).toBe(1);

    expect((await fields({ fields: [{ id, name: "serial", type: "text", config: { unique: true } }] })).status).toBe(200);
    const dup = await call(url, { method: "POST", as: editor, body: { values: [{ fieldId: id, value: "1" }] } });
    expect(dup.json.error.details).toEqual([{ path: "serial", message: expect.any(String) }]);
  });
  it("drops the table on delete and keeps the history", async () => {
    const id = posts.id;
    expect((await call(`/api/collections/${id}`, { method: "DELETE", as: root })).status).toBe(204);
    expect(await columns("news")).toEqual([]);
    const history = await rows<{ action: string }>('SELECT action FROM "SchemaMigration" WHERE "collectionId" = $1 ORDER BY id', [id]);
    expect(history[0].action).toBe("create");
    expect(history.at(-1)!.action).toBe("delete");
  });
});

describe("sessions", () => {
  const age = (actor: Actor, seconds: number) => db.query(POSTGRES ? `UPDATE session SET "createdAt" = now() AT TIME ZONE 'UTC' - make_interval(secs => $1) WHERE "userId" = $2` : `UPDATE session SET "createdAt" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || $1 || ' seconds') WHERE "userId" = $2`, [seconds, actor.id]);

  it("require a recent sign-in for sensitive actions", async () => {
    const victim = await makeUser("fresh", "user");
    const target = (await signIn(victim)).id;
    await age(root, 1000);
    expect((await call(`/api/users/${target}/role`, { method: "PUT", as: root, body: { role: "editor" } })).json.error.code).toBe("REAUTH_REQUIRED");
    root = await signIn(root.email);
  });
  it("end after the absolute timeout even when active", async () => {
    const email = await makeUser("expired", "user");
    const actor = await signIn(email);
    expect((await call("/api/me", { as: actor })).status).toBe(200);
    await age(actor, 8 * 86400);
    expect((await call("/api/me", { as: actor })).status).toBe(401);
    expect((await db.query(`SELECT 1 FROM session WHERE "userId"=$1`, [actor.id])).rowCount).toBe(0);
  });
  it("end immediately on ban, and sign-in is refused", async () => {
    const email = await makeUser("banned", "user");
    const actor = await signIn(email);
    expect((await call(`/api/users/${actor.id}/ban`, { method: "POST", as: root, body: { reason: "test" } })).status).toBe(204);
    expect((await call("/api/me", { as: actor })).status).toBe(401);
    expect((await call("/api/auth/sign-in/email", { method: "POST", body: { email, password: PASSWORD } })).status).toBe(403);
  });
  it("never expose session tokens to admins", async () => {
    const r = await call(`/api/users/${editor.id}/sessions`, { as: root });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("token");
  });
});

describe("impersonation", () => {
  it("works on end users, is restricted, and cannot escalate", async () => {
    expect((await call(`/api/users/${editor.id}/impersonate`, { method: "POST", as: root })).json.error.code).toBe("CANNOT_IMPERSONATE_STAFF");
    expect((await call(`/api/users/${member.id}/impersonate`, { method: "POST", as: admin })).status).toBe(403);
    const r = await call(`/api/users/${member.id}/impersonate`, { method: "POST", as: root });
    expect(r.status, r.text).toBe(204);
    const impersonated: Actor = { ...member, cookie: cookiesFrom(r.headers) };
    const me = await call("/api/me", { as: impersonated });
    expect(me.json.user.id).toBe(member.id);
    expect(me.json.impersonating).toBe(true);
    expect((await call("/api/users", { as: impersonated })).status).toBe(403);
  });
});

describe("API keys", () => {
  let key: string, keyId: string;
  it("cannot exceed the creator's permissions", async () => {
    expect((await call("/api/account/api-keys", { method: "POST", as: admin, body: { name: "x", permissions: ["setting:update"], expiresInDays: 1 } })).json.error.code).toBe("KEY_EXCEEDS_ACTOR");
    expect((await call("/api/account/api-keys", { method: "POST", as: editor, body: { name: "x", permissions: ["record:list"], expiresInDays: 1 } })).status).toBe(403);
  });
  it("authenticate data routes only, and are shown once", async () => {
    admin = await signIn(admin.email);
    const created = await call("/api/account/api-keys", { method: "POST", as: admin, body: { name: "ci", permissions: ["collection:read"], expiresInDays: 30 } });
    expect(created.status, created.text).toBe(200);
    key = created.json.key;
    keyId = created.json.id;
    expect(key.startsWith("cms_")).toBe(true);
    const list = await call("/api/account/api-keys", { as: admin });
    expect(list.text).not.toContain(key);
    expect((await call("/api/collections", { headers: { "x-api-key": key } })).status).toBe(200);
    expect((await call("/api/users", { headers: { "x-api-key": key } })).json.error.code).toBe("API_KEY_NOT_ACCEPTED");
    expect((await call("/api/collections", { headers: { "x-api-key": "cms_invalid" } })).json.error.code).toBe("INVALID_API_KEY");
  });
  it("lose power when their owner does", async () => {
    await db.query(`UPDATE "user" SET role='user' WHERE id=$1`, [admin.id]);
    expect((await call("/api/collections", { headers: { "x-api-key": key } })).status).toBe(403);
    await db.query(`UPDATE "user" SET role='admin' WHERE id=$1`, [admin.id]);
  });
  it("stop working when revoked", async () => {
    expect((await call(`/api/account/api-keys/${keyId}`, { method: "DELETE", as: admin })).status).toBe(204);
    expect((await call("/api/collections", { headers: { "x-api-key": key } })).status).toBe(401);
  });
});

describe("public records API", () => {
  type Created = { id: number; fields: Array<{ id: number; name: string }> };
  const makeCollection = async (name: string, slug: string, fields: unknown[]): Promise<Created> => {
    const r = await call("/api/collections", { method: "POST", as: root, body: { name, slug, fields } });
    expect(r.status, r.text).toBe(200);
    return r.json;
  };
  const setRules = (id: number, rules: Record<string, string | null>) =>
    call(`/api/collections/${id}/rules`, { method: "PUT", as: root, body: { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, ...rules } });
  const add = async (collection: Created, status: string, values: Record<string, unknown>) => {
    const body = { status, values: Object.entries(values).map(([name, value]) => ({ fieldId: collection.fields.find((f) => f.name === name)!.id, value })) };
    const r = await call(`/api/collections/${collection.id}/content`, { method: "POST", as: root, body });
    expect(r.status, r.text).toBe(200);
    return r.json.id as number;
  };
  const list = (query = "", as?: Actor) => call(`/api/collections/stories/records${query}`, { as });
  const q = encodeURIComponent;
  const titles = (r: { json: { items: Array<{ title: string }> } }) => r.json.items.map((item) => item.title).sort();

  let writers: Created, stories: Created, remarks: Created;
  let ann: number, bob: number, live: number, draft: number;

  beforeAll(async () => {
    writers = await makeCollection("Writers", "writers", [{ name: "name", type: "text" }, { name: "payroll", type: "text", config: { hidden: true } }]);
    stories = await makeCollection("Stories", "stories", [
      { name: "title", type: "text" },
      { name: "views", type: "number" },
      { name: "meta", type: "json" },
      { name: "author", type: "reference", config: { collection: writers.id } },
      { name: "reviewers", type: "reference", config: { collection: writers.id, allowMultiple: true } },
      { name: "editor", type: "reference", config: { collection: writers.id, hidden: true } },
    ]);
    remarks = await makeCollection("Remarks", "remarks", [{ name: "body", type: "text" }, { name: "approved", type: "boolean" }, { name: "story", type: "reference", config: { collection: stories.id } }]);

    ann = await add(writers, "published", { name: "Ann", payroll: "ann-salary" });
    bob = await add(writers, "draft", { name: "Bob", payroll: "bob-salary" });
    live = await add(stories, "published", { title: "Live", views: 10, meta: { lang: "en" }, author: ann, reviewers: [ann, bob], editor: ann });
    await add(stories, "published", { title: "Other", views: 5, meta: { lang: "fr" }, author: bob });
    draft = await add(stories, "draft", { title: "Secret draft", views: 99, author: ann });
    await add(remarks, "published", { body: "good", approved: true, story: live });
    await add(remarks, "published", { body: "spam", approved: false, story: live });

    for (const [id, rules] of [
      [stories.id, { listRule: 'status = "published"', viewRule: 'status = "published"' }],
      [writers.id, { viewRule: 'status = "published"' }],
      [remarks.id, { viewRule: "approved = true" }],
    ] as const) {
      const r = await setRules(id, rules);
      expect(r.status, r.text).toBe(200);
    }
  });

  it("serves a public blog with no session, with drafts hidden by rule alone", async () => {
    const r = await list();
    expect(r.status, r.text).toBe(200);
    expect(titles(r)).toEqual(["Live", "Other"]);
    expect(r.json).toMatchObject({ page: 1, perPage: 30, totalItems: 2, totalPages: 1 });
    expect(r.text).not.toContain("Secret draft");
    expect((await call(`/api/collections/stories/records/${live}`)).json.title).toBe("Live");
    expect((await call(`/api/collections/stories/records/${draft}`)).status).toBe(404);
  });
  it("answers 403 for a locked rule and 404 for an unknown collection", async () => {
    expect((await call("/api/collections/writers/records")).json.error.code).toBe("RULE_LOCKED");
    expect((await call("/api/collections/nope/records")).status).toBe(404);
  });
  it("lets staff with the record permission see everything", async () => {
    expect(titles(await list("", root))).toEqual(["Live", "Other", "Secret draft"]);
  });
  it("filters, without ever widening the list rule", async () => {
    expect(titles(await list(`?filter=${q('views > 7')}`))).toEqual(["Live"]);
    expect(titles(await list(`?filter=${q('title ~ "liv%"')}`))).toEqual(["Live"]);
    expect(titles(await list(`?filter=${q('meta.lang = "fr"')}`))).toEqual(["Other"]);
    const widened = await list(`?filter=${q('status = "draft" || id > 0')}`);
    expect(titles(widened)).toEqual(["Live", "Other"]);
    expect((await list(`?filter=${q('status = "draft"')}`)).json.totalItems).toBe(0);
  });
  it("sorts, pages and can skip the total", async () => {
    const asc = await list("?sort=views");
    expect(asc.json.items.map((i: { title: string }) => i.title)).toEqual(["Other", "Live"]);
    const desc = await list("?sort=-views&perPage=1&page=2");
    expect(desc.json.items.map((i: { title: string }) => i.title)).toEqual(["Other"]);
    expect(desc.json.totalPages).toBe(2);
    const skipped = await list("?skipTotal=true");
    expect(skipped.json).toMatchObject({ totalItems: -1, totalPages: -1 });
    expect(skipped.json.items).toHaveLength(2);
  });
  it("selects fields", async () => {
    const r = await list(`?fields=${q("id,title")}&sort=views&perPage=1`);
    expect(Object.keys(r.json.items[0]).sort()).toEqual(["id", "title"]);
  });
  it("keeps hidden fields out of responses, filters, sorts and expansion", async () => {
    const r = await list();
    expect(r.json.items[0]).not.toHaveProperty("editor");
    expect((await list(`?filter=${q("editor > 0")}`)).json.error.code).toBe("INVALID_FILTER");
    expect((await list("?sort=editor")).json.error.code).toBe("INVALID_SORT");
    expect((await list("?expand=editor")).json.error.code).toBe("INVALID_EXPAND");
    expect((await list("?expand=author")).text).not.toContain("salary");
    const older = await call(`/api/collections/${writers.id}/content/${ann}`);
    expect(older.status, older.text).toBe(200);
    expect(older.text).not.toContain("salary");
    expect((await call(`/api/collections/stories/records/${live}?expand=author`, { as: root })).json.expand.author.payroll).toBe("ann-salary");
  });
  it("expands relations only as far as each target's view rule allows", async () => {
    const r = await call(`/api/collections/stories/records/${live}?expand=${q("author,reviewers")}`);
    expect(r.status, r.text).toBe(200);
    expect(r.json.expand.author.name).toBe("Ann");
    expect(r.json.expand.reviewers.map((w: { name: string }) => w.name)).toEqual(["Ann"]);
    expect(r.text).not.toContain("Bob");
    const denied = await list(`?expand=author&filter=${q('title = "Other"')}`);
    expect(denied.json.items[0].author).toBe(bob);
    expect(denied.json.items[0].expand).toBeUndefined();
  });
  it("expands reverse relations, applying the rule to each record", async () => {
    const r = await call(`/api/collections/stories/records/${live}?expand=remarks_via_story`);
    expect(r.json.expand.remarks_via_story.map((c: { body: string }) => c.body)).toEqual(["good"]);
    expect(r.text).not.toContain("spam");
  });
  it("expands nested relations and can select inside them", async () => {
    const path = q("remarks_via_story.story.author");
    const r = await call(`/api/collections/stories/records/${live}?expand=${path}&fields=${q("expand.remarks_via_story.expand.story.expand.author.name")}`);
    expect(r.json).toEqual({ expand: { remarks_via_story: [{ expand: { story: { expand: { author: { name: "Ann" } } } } }] } });
  });
  it("refuses unknown and over-deep expansion", async () => {
    expect((await list("?expand=title")).json.error.code).toBe("INVALID_EXPAND");
    expect((await list("?expand=nope_via_story")).json.error.code).toBe("INVALID_EXPAND");
    expect((await list("?expand=a.b.c.d.e")).json.error.code).toBe("INVALID_EXPAND");
  });
  it("survives injection attempts in every parameter", async () => {
    const attacks = [`' OR 1=1 --`, `" OR ""="`, `title = "' OR 1=1 --"`, `title = 1; DROP TABLE "user"; --`, `1=1) OR (1=1`, `@collection.writers.payroll ?= "guess"`, `"; DELETE FROM rec_stories; --`, `sqlite_master.sql ~ "a"`];
    for (const attack of attacks) {
      for (const parameter of ["filter", "sort", "expand", "fields"]) {
        const r = await list(`?${parameter}=${q(attack)}`);
        expect(r.status, `${parameter}=${attack}: ${r.text}`).toBeLessThan(500);
        expect(r.text, `${parameter}=${attack}`).not.toContain("Secret draft");
        expect(r.text, `${parameter}=${attack}`).not.toContain("salary");
      }
    }
    expect((await db.query(`SELECT count(*) AS n FROM rec_stories`)).rows[0].n).toBe(3);
    expect((await db.query(`SELECT 1 FROM "user" LIMIT 1`)).rowCount).toBe(1);
  });
  it("reads other collections through @collection rules, and checks them when saved", async () => {
    expect((await setRules(remarks.id, { listRule: '@collection.writers.name ?= "Nobody"', viewRule: "approved = true" })).status).toBe(200);
    expect((await call("/api/collections/remarks/records")).json.totalItems).toBe(0);
    expect((await setRules(remarks.id, { listRule: '@collection.writers.name ?= "Ann"', viewRule: "approved = true" })).status).toBe(200);
    expect((await call("/api/collections/remarks/records")).json.totalItems).toBe(2);
    expect((await setRules(remarks.id, { listRule: '@collection.writers.nope ?= "Ann"' })).json.error.code).toBe("INVALID_RULE");
    expect((await setRules(remarks.id, { listRule: '@collection.missing.name ?= "Ann"' })).json.error.code).toBe("INVALID_RULE");
  });
  it("refuses schema changes that would break another collection's rule", async () => {
    const fields = writers.fields.filter((f) => f.name !== "name").map((f) => ({ id: f.id, name: f.name, type: "text", config: { hidden: true } }));
    const r = await call(`/api/collections/${writers.id}/fields`, { method: "PUT", as: root, body: { fields, confirm: true } });
    expect(r.json.error.code, r.text).toBe("INVALID_RULE");
    expect((await call(`/api/collections/${writers.id}`, { method: "PATCH", as: root, body: { slug: "authors-two" } })).json.error.code).toBe("INVALID_RULE");
    expect((await setRules(remarks.id, { viewRule: "approved = true" })).status).toBe(200);
  });
});

describe("password reset", () => {
  it("behaves identically for known and unknown accounts", async () => {
    const known = await call("/api/auth/request-password-reset", { method: "POST", body: { email: "member@example.test", redirectTo: "/dashboard/auth/reset-password" } });
    const unknown = await call("/api/auth/request-password-reset", { method: "POST", body: { email: "ghost@example.test", redirectTo: "/dashboard/auth/reset-password" } });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(unknown.text).toBe(known.text);
  });
  it("is single-use, revokes sessions and notifies the user", async () => {
    const before = member;
    const link = await latestLink(member.email, new RegExp(`${base}/api/auth/reset-password/[\\w-]+`));
    const token = link.split("/").pop()!.split("?")[0];
    const next = "another-long-passphrase-for-reset-77";
    const reset = await call("/api/auth/reset-password", { method: "POST", body: { newPassword: next, token } });
    expect(reset.status, reset.text).toBe(200);
    expect((await call("/api/auth/reset-password", { method: "POST", body: { newPassword: next + "x", token } })).status).toBe(400);
    expect((await call("/api/me", { as: before })).status).toBe(401);
    await latestLink(member.email, /password was changed/i);
    member = await signIn(member.email, next);
  });
});

describe("two-factor authentication", () => {
  let actor: Actor;
  let secret: string;
  it("enrolls with a verified code", async () => {
    actor = await signIn(await makeUser("mfa", "user"));
    const enable = await call("/api/auth/two-factor/enable", { method: "POST", as: actor, body: { password: PASSWORD } });
    expect(enable.status, enable.text).toBe(200);
    secret = new URL(enable.json.totpURI).searchParams.get("secret")!;
    const verify = await call("/api/auth/two-factor/verify-totp", { method: "POST", as: actor, body: { code: totp(secret) } });
    expect(verify.status, verify.text).toBe(200);
  });
  it("challenges password sign-in and creates no session until verified", async () => {
    const first = await call("/api/auth/sign-in/email", { method: "POST", body: { email: actor.email, password: PASSWORD } });
    expect(first.json.twoFactorRedirect).toBe(true);
    const pending = { ...actor, cookie: cookiesFrom(first.headers) };
    expect((await call("/api/me", { as: pending })).status).toBe(401);
    const verified = await call("/api/auth/two-factor/verify-totp", { method: "POST", as: pending, body: { code: totp(secret) } });
    expect(verified.status, verified.text).toBe(200);
    expect((await call("/api/me", { as: { ...actor, cookie: cookiesFrom(verified.headers) } })).status).toBe(200);
  });
  it("cannot be skipped through a magic link", async () => {
    await configure((s) => { s.methods.magicLink = true; });
    await call("/api/auth/sign-in/magic-link", { method: "POST", body: { email: actor.email, callbackURL: "/" } });
    const link = await latestLink(actor.email, new RegExp(`${base}/api/auth/magic-link/verify[^\\s"<]+`));
    const r = await fetch(link, { redirect: "manual", headers: origin });
    expect(r.headers.getSetCookie().join(";")).not.toContain("session_token=");
    // Proves the link itself was valid and it was the 2FA check that stopped it.
    expect((await db.query(`SELECT 1 FROM "AuditLog" WHERE action='auth.single_factor_blocked' AND "actorId"=$1`, [actor.id])).rowCount).toBe(1);
    await configure((s) => { s.methods.magicLink = false; });
  });
  it("disables methods turned off in the dashboard", async () => {
    expect((await call("/api/auth/sign-in/magic-link", { method: "POST", body: { email: actor.email, callbackURL: "/" } })).status).toBe(404);
  });
  it("can be required for dashboard staff", async () => {
    root = await signIn(root.email);
    await db.query(`UPDATE "user" SET "twoFactorEnabled"=true WHERE id=$1`, [root.id]);
    await configure((s) => { s.mfa.requireForDashboard = true; });
    expect((await call("/api/users", { as: admin })).json.error.code).toBe("MFA_ENROLLMENT_REQUIRED");
    expect((await call("/api/me", { as: admin })).status).toBe(200);
    await configure((s) => { s.mfa.requireForDashboard = false; });
    await db.query(`UPDATE "user" SET "twoFactorEnabled"=false WHERE id=$1`, [root.id]);
  });
});

describe("dashboard-controlled settings", () => {
  it("never return or store secrets in clear", async () => {
    await configure((s) => { s.oauth.providers.github = { enabled: true, clientId: "abc", clientSecret: "plaintext-oauth-secret" }; });
    const fetched = await call("/api/settings/auth", { as: root });
    expect(fetched.text).not.toContain("plaintext-oauth-secret");
    const stored = await db.query(`SELECT value FROM "AppSetting" WHERE key='auth'`);
    expect(stored.rows[0].value).not.toContain("plaintext-oauth-secret");
    expect((await call("/api/auth-config")).json.oauth).toEqual(["github"]);
  });
  it("keep a stored secret when the mask is sent back", async () => {
    await configure(() => {});
    const stored = await db.query(`SELECT value->'oauth'->'providers'->'github'->>'clientSecret' AS s FROM "AppSetting" WHERE key='auth'`);
    expect(stored.rows[0].s.startsWith("enc:v1:")).toBe(true);
    await configure((s) => { s.oauth.providers.github.enabled = false; });
  });
  it("refuse a privileged default role", async () => {
    const s = await settings();
    s.signUp.defaultRole = "admin";
    expect((await call("/api/settings/auth", { method: "PUT", as: root, body: s })).json.error.code).toBe("VALIDATION_FAILED");
  });
  it("open sign-up, with domain restrictions, and never grant a role", async () => {
    await configure((s) => { s.signUp.enabled = true; s.signUp.allowedDomains = ["allowed.test"]; });
    const denied = await call("/api/auth/sign-up/email", { method: "POST", body: { name: "a", email: "a@blocked.test", password: PASSWORD } });
    // better-auth deliberately answers 403s here with a generic success, so the response can't confirm anything.
    expect(denied.json.token).toBeNull();
    expect((await db.query(`SELECT 1 FROM "user" WHERE email='a@blocked.test'`)).rowCount).toBe(0);
    const forged = await call("/api/auth/sign-up/email", { method: "POST", body: { name: "b", email: "b@allowed.test", password: PASSWORD, role: "superadmin" } });
    expect(forged.json.code).toBe("FIELD_NOT_ALLOWED");
    const ok = await call("/api/auth/sign-up/email", { method: "POST", body: { name: "b", email: "b@allowed.test", password: PASSWORD } });
    expect(ok.status, ok.text).toBe(200);
    expect((await db.query(`SELECT role FROM "user" WHERE email='b@allowed.test'`)).rows[0].role).toBe("user");
    await configure((s) => { s.signUp.enabled = false; s.signUp.allowedDomains = []; });
  });
  it("lock accounts per email, with no way to tell if the account exists", async () => {
    await configure((s) => { s.lockout.enabled = true; s.lockout.maxFailures = 3; s.lockout.baseDelaySeconds = 60; });
    const attempt = (email: string) => call("/api/auth/sign-in/email", { method: "POST", body: { email, password: "wrong-password-wrong-password" } });
    for (const email of [editor.email, "nobody@example.test"]) {
      for (let i = 0; i < 3; i++) expect((await attempt(email)).status).toBe(401);
      const locked = await attempt(email);
      expect(locked.status).toBe(429);
      expect(locked.json.code).toBe("ACCOUNT_LOCKED");
    }
    expect((await call("/api/auth/sign-in/email", { method: "POST", body: { email: editor.email, password: PASSWORD } })).status).toBe(429);
    await db.query(`DELETE FROM "LoginThrottle"`);
    await configure((s) => { s.lockout.enabled = false; });
  });
  it("let anyone sign in to a shared account, and nobody change it or lock it", async () => {
    const email = await makeUser("shared", "editor");
    await configure((s) => { s.lockout.enabled = true; s.lockout.maxFailures = 3; s.lockout.baseDelaySeconds = 60; });
    for (let i = 0; i < 5; i++) expect((await call("/api/auth/sign-in/email", { method: "POST", body: { email, password: "wrong-password-wrong-password" } })).status).toBe(401);
    const visitor = await signIn(email);
    const refused = async (path: string, body: unknown, method = "POST") => {
      const r = await call(path, { method, body, as: visitor });
      expect(r.status, `${path}: ${r.text}`).toBe(403);
      expect(r.text).toContain("SHARED_ACCOUNT");
    };
    await refused("/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "another-long-password-1234" });
    await refused("/api/auth/change-email", { newEmail: "taken@example.test" });
    await refused("/api/auth/update-user", { name: "Mine now" });
    await refused("/api/auth/two-factor/enable", { password: PASSWORD });
    await refused("/api/auth/revoke-other-sessions", {});
    await refused("/api/auth/delete-user", { password: PASSWORD });
    await refused("/api/account/fields", { values: {} }, "PATCH");
    const reset = await call("/api/auth/request-password-reset", { method: "POST", body: { email, redirectTo: "/" } });
    expect(reset.status).toBe(403);
    // Still the same password, and still signed in.
    expect((await call("/api/auth/get-session", { as: visitor })).json.user.email).toBe(email);
    await signIn(email);
    await db.query(`DELETE FROM "LoginThrottle"`);
    await configure((s) => { s.lockout.enabled = false; });
  });
  it("rate-limit authentication endpoints", async () => {
    await configure((s) => { s.rateLimit.authMax = 3; s.rateLimit.authWindow = 60; });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await call("/api/auth/sign-in/email", { method: "POST", body: { email: "rl@example.test", password: "x".repeat(20) }, headers: { "x-forwarded-for": "198.51.100.7" } })).status);
    expect(codes).toContain(429);
    await db.query(`DELETE FROM "rateLimit"`);
    await configure((s) => { s.rateLimit.authMax = 1000; });
  });
});

describe("block types and stream fields", () => {
  type Created = { id: number; fields: Array<{ id: number; name: string }> };
  let authors: Created, pages: Created;
  let ann: number, page: number;
  const blocks = "/api/block-types";

  const makeCollection = async (name: string, slug: string, fields: unknown[]): Promise<Created> => {
    const r = await call("/api/collections", { method: "POST", as: root, body: { name, slug, fields } });
    expect(r.status, r.text).toBe(200);
    return r.json;
  };
  const makeBlock = async (name: string, fields: unknown[]) => {
    const r = await call(blocks, { method: "POST", as: root, body: { name, label: name, fields } });
    expect(r.status, r.text).toBe(200);
    return r.json as { id: number; version: number };
  };
  const bodyId = () => pages.fields.find((f) => f.name === "body")!.id;
  const savePage = (value: unknown) => call(`/api/collections/${pages.id}/content`, { method: "POST", as: root, body: { values: [{ fieldId: bodyId(), value }] } });
  const editPage = (id: number, value: unknown) => call(`/api/collections/${pages.id}/content/${id}`, { method: "PATCH", as: root, body: { values: [{ fieldId: bodyId(), value }] } });
  const refs = (recordId: number) => db.query('SELECT "blockId", "targetRecordId" FROM "RecordRef" WHERE "sourceCollectionId" = ? AND "sourceRecordId" = ?', [pages.id, recordId]).rows;
  const byline = (id: string, person: number) => ({ id, type: "byline", v: 1, value: { person } });

  beforeAll(async () => {
    authors = await makeCollection("Authors", "block-authors", [{ name: "name", type: "text" }, { name: "salary", type: "text", config: { hidden: true } }]);
    pages = await makeCollection("Pages", "block-pages", [{ name: "body", type: "stream" }]);
    const r = await call(`/api/collections/${authors.id}/content`, { method: "POST", as: root, body: { values: [{ fieldId: authors.fields[0].id, value: "Ann" }] } });
    expect(r.status, r.text).toBe(200);
    ann = r.json.id;
    await makeBlock("byline", [{ name: "person", type: "reference", config: { collection: authors.id } }]);
    await makeBlock("note", [{ name: "text", type: "text", config: { required: true } }]);
  });

  it("restrict block definitions to schema managers", async () => {
    const definition = { name: "nope", label: "Nope", fields: [] };
    expect((await call(blocks, { method: "POST", body: definition })).status).toBe(401);
    expect((await call(blocks, { method: "POST", as: member, body: definition })).status).toBe(403);
    expect((await call(blocks, { as: member })).status).toBe(403);
  });
  it("refuse options a block field couldn't honour", async () => {
    for (const config of [{ hidden: true }, { unique: true }, { readonly: true }]) {
      const r = await call(blocks, { method: "POST", as: root, body: { name: "bad", label: "Bad", fields: [{ name: "x", type: "text", config }] } });
      expect(r.status, r.text).toBe(400);
    }
    expect((await call(blocks, { method: "POST", as: root, body: { name: "bad", label: "Bad", fields: [{ name: "x", type: "reference", config: { collection: 999999 } }] } })).status).toBe(400);
    expect((await call(blocks, { method: "POST", as: root, body: { name: "note", label: "Dup", fields: [] } })).status).toBe(409);
  });
  it("validate blocks and index their links on save", async () => {
    expect((await savePage([{ id: "n", type: "note", v: 1, value: {} }])).status).toBe(400);
    expect((await savePage([{ id: "n", type: "ghost", v: 1, value: {} }])).status).toBe(400);
    const missing = await savePage([byline("b", 999999)]);
    expect(missing.status, missing.text).toBe(400);
    const saved = await savePage([byline("b", ann)]);
    expect(saved.status, saved.text).toBe(200);
    page = saved.json.id;
    expect(refs(page)).toEqual([{ blockId: "b", targetRecordId: ann }]);
  });
  it("re-index on edit", async () => {
    const r = await editPage(page, [{ id: "n", type: "note", v: 1, value: { text: "hello" } }]);
    expect(r.status, r.text).toBe(200);
    expect(refs(page)).toEqual([]);
    expect((await editPage(page, [byline("b", ann)])).status).toBe(200);
    expect(refs(page)).toEqual([{ blockId: "b", targetRecordId: ann }]);
  });
  it("expand links inside blocks only where the target's view rule allows", async () => {
    const publish = async (name: string, status: string, secret: string) => {
      const body = { status, values: [{ fieldId: authors.fields[0].id, value: name }, { fieldId: authors.fields[1].id, value: secret }] };
      const r = await call(`/api/collections/${authors.id}/content`, { method: "POST", as: root, body });
      expect(r.status, r.text).toBe(200);
      return r.json.id as number;
    };
    const rules = (id: number, viewRule: string, listRule: string | null = null) =>
      call(`/api/collections/${id}/rules`, { method: "PUT", as: root, body: { listRule, viewRule, createRule: null, updateRule: null, deleteRule: null } });
    expect((await rules(authors.id, 'status = "published"')).status).toBe(200);
    expect((await rules(pages.id, 'status = "published"', 'status = "published"')).status).toBe(200);

    const visible = await publish("Visible", "published", "visible-salary");
    const hiddenAuthor = await publish("Private", "draft", "private-salary");
    const body = [byline("__proto__", visible), byline("open", visible), byline("closed", hiddenAuthor)];
    const saved = await call(`/api/collections/${pages.id}/content`, { method: "POST", as: root, body: { status: "published", values: [{ fieldId: bodyId(), value: body }] } });
    expect(saved.status, saved.text).toBe(200);
    const id = saved.json.id;

    const anonymous = await call(`/api/collections/block-pages/records/${id}?expand=body`);
    expect(anonymous.status, anonymous.text).toBe(200);
    expect(anonymous.json.expand.body.open.person.name).toBe("Visible");
    expect(anonymous.json.expand.body.closed).toBeUndefined();
    expect(anonymous.text).not.toContain("Private");
    expect(anonymous.text).not.toContain("salary");
    expect(Object.keys(JSON.parse(anonymous.text).expand.body).sort()).toEqual(["__proto__", "open"]);

    const staff = await call(`/api/collections/block-pages/records/${id}?expand=body`, { as: root });
    expect(staff.json.expand.body.closed.person.name).toBe("Private");

    const listed = await call(`/api/collections/block-pages/records?expand=body`);
    expect(listed.status, listed.text).toBe(200);
    expect(listed.text).not.toContain("Private");
    expect((await call(`/api/collections/block-pages/records/${id}?expand=body.person`)).status).toBe(400);

    expect((await call(`/api/collections/${pages.id}/content/${id}`, { method: "DELETE", as: root })).status).toBe(204);
    for (const record of [visible, hiddenAuthor]) expect((await call(`/api/collections/${authors.id}/content/${record}`, { method: "DELETE", as: root })).status).toBe(204);
  });
  it("sanitize rich text on the way in, including inside blocks", async () => {
    await makeBlock("prose", [{ name: "body", type: "rich_text" }]);
    const doc = (href: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href } }] }] }] });
    const block = (href: string) => [{ id: "p", type: "prose", v: 1, value: { body: doc(href) } }];
    expect((await savePage(block("javascript:alert(1)"))).status).toBe(400);
    const good = await savePage(block("https://example.com"));
    expect(good.status, good.text).toBe(200);
    expect((await call(`/api/collections/${pages.id}/content/${good.json.id}`, { method: "DELETE", as: root })).status).toBe(204);
  });
  it("protect a linked record from deletion until the link is gone", async () => {
    const del = () => call(`/api/collections/${authors.id}/content/${ann}`, { method: "DELETE", as: root });
    expect((await del()).status).toBe(409);
    expect((await call(`/api/collections/${authors.id}/content/${ann}`, { as: root })).status).toBe(200);
  });
  it("keep blocks through a version bump, then require the new version for changes", async () => {
    const list = (await call(blocks, { as: root })).json as Array<{ id: number; name: string }>;
    const id = list.find((b) => b.name === "byline")!.id;
    const fields = [{ name: "person", type: "reference", config: { collection: authors.id } }, { name: "role", type: "text" }];
    const updated = await call(`${blocks}/${id}`, { method: "PUT", as: root, body: { label: "Byline", fields } });
    expect(updated.status, updated.text).toBe(200);
    expect(updated.json.version).toBe(2);
    const same = await call(`${blocks}/${id}`, { method: "PUT", as: root, body: { label: "Renamed", fields } });
    expect(same.json.version).toBe(2);

    expect((await editPage(page, [byline("b", ann)])).status).toBe(200);
    expect(refs(page)).toEqual([{ blockId: "b", targetRecordId: ann }]);
    expect((await editPage(page, [{ ...byline("b", ann), value: { person: ann, sneaky: 1 } }])).status).toBe(400);
    const stored = (await call(`/api/collections/${pages.id}/content/${page}`, { as: root })).json.values[0].value;
    expect(stored).toEqual([byline("b", ann)]);
  });
  it("keep a deleted type's blocks in stored records", async () => {
    const made = await makeBlock("temp", [{ name: "text", type: "text" }]);
    const block = { id: "t", type: "temp", v: 1, value: { text: "precious" } };
    const saved = await savePage([block]);
    expect(saved.status, saved.text).toBe(200);
    expect((await call(`${blocks}/${made.id}`, { method: "DELETE", as: root })).status).toBe(204);
    expect((await editPage(saved.json.id, [block])).status).toBe(200);
    const read = await call(`/api/collections/${pages.id}/content/${saved.json.id}`, { as: root });
    expect(read.json.values[0].value).toEqual([block]);
  });
  it("release links when the source record is deleted", async () => {
    expect((await call(`/api/collections/${pages.id}/content/${page}`, { method: "DELETE", as: root })).status).toBe(204);
    expect(refs(page)).toEqual([]);
    expect((await call(`/api/collections/${authors.id}/content/${ann}`, { method: "DELETE", as: root })).status).toBe(204);
  });
  it("refuse converting a stream field away", async () => {
    const r = await call(`/api/collections/${pages.id}/fields`, { method: "PUT", as: root, body: { fields: [{ id: bodyId(), name: "body", type: "json" }] } });
    expect(r.status, r.text).toBe(400);
  });
});

describe("files", () => {
  type Created = { id: number; fields: Array<{ id: number; name: string }> };
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  let posts: Created;
  let photo: string;

  const upload = (data: Buffer | string, as: Actor | null = editor, name = "photo.png", type = "image/png", headers: Record<string, string> = {}) =>
    fetch(`${base}/api/files/upload?name=${encodeURIComponent(name)}`, { method: "POST", headers: { ...origin, "content-type": type, ...(as ? { cookie: as.cookie } : {}), ...headers }, body: data as BodyInit })
      .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const uploaded = async (data: Buffer | string, as: Actor | null = editor, name?: string, type?: string) => {
    const r = await upload(data, as, name, type);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json as { id: string; type: string; size: number; width: number | null };
  };
  const field = (name: string, collection = posts) => collection.fields.find((f) => f.name === name)!.id;
  const save = (values: Array<{ fieldId: number; value: unknown }>, as: Actor | null = root, status = "published", collection = posts) =>
    call(`/api/collections/${collection.id}/content`, { method: "POST", as, body: { status, values } });
  const edit = (id: number, values: Array<{ fieldId: number; value: unknown }>, as: Actor | null = root, status?: string) =>
    call(`/api/collections/${posts.id}/content/${id}`, { method: "PATCH", as, body: { status, values } });
  const rules = (id: number, viewRule: string | null, createRule: string | null = null) =>
    call(`/api/collections/${id}/rules`, { method: "PUT", as: root, body: { listRule: null, viewRule, createRule, updateRule: null, deleteRule: null } });
  const download = (id: string, as: Actor | null = null, suffix = "", headers: Record<string, string> = {}) =>
    fetch(`${base}/api/files/${id}${suffix}`, { redirect: "manual", headers: { ...(as ? { cookie: as.cookie } : {}), ...headers } });

  beforeAll(async () => {
    const r = await call("/api/collections", { method: "POST", as: root, body: { name: "File posts", slug: "file-posts", fields: [
      { name: "cover", type: "image" },
      { name: "attachment", type: "file", config: { maxSize: 10, allowedTypes: ["text/plain"] } },
      { name: "album", type: "gallery" },
      { name: "secret", type: "file", config: { hidden: true } },
      { name: "body", type: "stream" },
    ] } });
    expect(r.status, r.text).toBe(200);
    posts = r.json;
    expect((await rules(posts.id, 'status = "published"')).status).toBe(200);
    const block = await call("/api/block-types", { method: "POST", as: root, body: { name: "figure", label: "Figure", fields: [{ name: "image", type: "image" }] } });
    expect(block.status, block.text).toBe(200);
    photo = (await uploaded(PNG)).id;
  });

  it("restrict uploads to holders of the permission", async () => {
    expect((await upload(PNG, null)).status).toBe(401);
    expect((await upload(PNG, member)).status).toBe(403);
    expect((await call("/api/files", { as: member })).status).toBe(403);
    expect((await upload(PNG, editor, "a.png", "image/png", { origin: "https://evil.example" })).status).toBe(403);
  });
  it("record the real type and size, whatever the client claims", async () => {
    const file = await uploaded(PNG);
    expect(file).toMatchObject({ type: "image/png", size: PNG.length, width: 1 });
    expect((await uploaded("<html><script>alert(1)</script></html>", editor, "x.png", "image/png")).type).toBe("text/html");
    expect((await upload("not really a png at all", editor, "x.png", "image/png")).json.type).toBe("text/plain");
    const fake = Buffer.concat([PNG.subarray(0, 12), Buffer.alloc(40, 1)]);
    expect((await upload(fake)).status).toBe(400);
    expect((await upload("")).status).toBe(400);
  });
  it("accept files beyond the proxy's buffer limit, intact", async () => {
    const large = Buffer.alloc(11 * 1024 * 1024, "a");
    large.write("end-marker", large.length - 10);
    const file = await uploaded(large, editor, "large.txt", "text/plain");
    expect(file.size).toBe(large.length);
    const back = Buffer.from(await (await download(file.id, editor)).arrayBuffer());
    expect(back.equals(large)).toBe(true);
  });
  it("stop an upload over the limit, even with no declared length", async () => {
    // The server stops reading and drops the connection, so these must not be reused for later requests.
    const closing = { connection: "close" };
    expect((await upload(Buffer.alloc(13 * 1024 * 1024, "a"), editor, "big.txt", "text/plain", closing)).status).toBe(413);
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    let sent = 0;
    const body = new ReadableStream({ pull(controller) { if (sent++ >= 13) controller.close(); else controller.enqueue(chunk); } });
    const r = await fetch(`${base}/api/files/upload?name=stream.txt`, { method: "POST", headers: { ...origin, cookie: editor.cookie, "content-type": "text/plain", ...closing }, body, duplex: "half" } as RequestInit);
    expect(r.status).toBe(413);
  });
  it("keep an unattached file from everyone but its uploader and file readers", async () => {
    expect((await download(photo)).status).toBe(404);
    expect((await download(photo, member)).status).toBe(404);
    expect((await call(`/api/files/${photo}/info`, { as: member })).status).toBe(404);
    expect((await download(photo, editor)).status).toBe(200);
    expect((await download(photo, root)).status).toBe(200);
    expect((await download("not-a-real-id")).status).toBe(404);
  });
  it("follow the record's view rule once attached", async () => {
    const saved = await save([{ fieldId: field("cover"), value: photo }], root, "draft");
    expect(saved.status, saved.text).toBe(200);
    expect((await download(photo)).status).toBe(404);
    expect((await edit(saved.json.id, [], root, "published")).status).toBe(200);
    expect((await download(photo)).status).toBe(200);
    expect((await download(photo, null, "?thumb=100x100")).status).toBe(200);
    expect((await edit(saved.json.id, [{ fieldId: field("cover"), value: "" }])).status).toBe(200);
    expect((await download(photo)).status).toBe(404);
    expect((await edit(saved.json.id, [{ fieldId: field("cover"), value: photo }])).status).toBe(200);
    expect((await call(`/api/collections/${posts.id}/content/${saved.json.id}`, { method: "DELETE", as: root })).status).toBe(204);
    expect((await download(photo)).status).toBe(404);
  });
  it("serve files used inside blocks, under the same rule", async () => {
    const file = (await uploaded(PNG)).id;
    const saved = await save([{ fieldId: field("body"), value: [{ id: "fig", type: "figure", v: 1, value: { image: file } }] }]);
    expect(saved.status, saved.text).toBe(200);
    expect((await download(file)).status).toBe(200);
    expect(db.query('SELECT "blockId" FROM "FileRef" WHERE "fileId" = ?', [file]).rows).toEqual([{ blockId: "fig" }]);
    expect((await edit(saved.json.id, [{ fieldId: field("body"), value: [] }])).status).toBe(200);
    expect((await download(file)).status).toBe(404);
  });
  it("not let a hidden field expose a file", async () => {
    const file = (await uploaded("secret text", editor, "s.txt", "text/plain")).id;
    expect((await save([{ fieldId: field("secret"), value: file }])).status).toBe(200);
    expect((await download(file)).status).toBe(404);
    expect((await download(file, member)).status).toBe(404);
    expect((await download(file, editor)).status).toBe(200);
  });
  it("stop anyone attaching a file they have no claim to", async () => {
    const open = await call("/api/collections", { method: "POST", as: root, body: { name: "Open", slug: "file-open", fields: [{ name: "doc", type: "file" }] } });
    expect(open.status, open.text).toBe(200);
    expect((await rules(open.json.id, "", "")).status).toBe(200);
    const victim = (await uploaded("private notes", editor, "n.txt", "text/plain")).id;
    const value = [{ fieldId: open.json.fields[0].id, value: victim }];
    for (const actor of [member, null]) {
      const r = await save(value, actor, "published", open.json);
      expect(r.status, r.text).toBe(400);
      expect(r.json.error.details[0].message).toBe("This file does not exist.");
    }
    const missing = await save([{ fieldId: open.json.fields[0].id, value: "AAAAAAAAAAAAAAAAAAAAAA" }], member, "published", open.json);
    expect(missing.json.error.details[0].message).toBe("This file does not exist.");
    expect((await download(victim)).status).toBe(404);
  });
  it("enforce each field's limits when a file is attached", async () => {
    const text = (await uploaded("hello", editor, "a.txt", "text/plain")).id;
    const long = (await uploaded("much too long for this field", editor, "b.txt", "text/plain")).id;
    expect((await save([{ fieldId: field("cover"), value: text }])).json.error.details[0].message).toBe("This file is not an image.");
    expect((await save([{ fieldId: field("attachment"), value: long }])).json.error.details[0].message).toBe("This file is too large for this field.");
    expect((await save([{ fieldId: field("attachment"), value: (await uploaded(PNG)).id }])).status).toBe(400);
    expect((await save([{ fieldId: field("attachment"), value: text }])).status).toBe(200);
    const svg = (await uploaded("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", editor, "a.svg", "image/svg+xml")).id;
    expect((await save([{ fieldId: field("cover"), value: svg }])).json.error.details[0].message).toBe("This file is not an image.");
    expect((await save([{ fieldId: field("album"), value: [text, (await uploaded(PNG)).id] }])).status).toBe(200);
  });
  it("download anything a browser might run", async () => {
    for (const [content, name] of [["<html><script>alert(1)</script></html>", "a.html"], ["<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "b.svg"]]) {
      const file = await uploaded(content, editor, name, "text/plain");
      const r = await download(file.id, editor);
      expect(r.headers.get("content-disposition"), name).toMatch(/^attachment;/);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    }
    expect((await download(photo, editor)).headers.get("content-disposition")).toMatch(/^inline;/);
  });
  it("issue tokens only to callers who can read the file, for that file alone", async () => {
    const [mine, other] = [(await uploaded(PNG)).id, (await uploaded(PNG)).id];
    expect((await call(`/api/files/${mine}/token`, { method: "POST" })).status).toBe(404);
    expect((await call(`/api/files/${mine}/token`, { method: "POST", as: member })).status).toBe(404);
    const minted = await call(`/api/files/${mine}/token`, { method: "POST", as: editor });
    expect(minted.status, minted.text).toBe(200);
    const { token } = minted.json;
    expect((await download(mine)).status).toBe(404);
    expect((await download(mine, null, `?token=${token}`)).status).toBe(200);
    expect((await download(mine, null, `?token=${token}&thumb=300x300`)).status).toBe(200);
    expect((await download(other, null, `?token=${token}`)).status).toBe(404);
    expect((await download(mine, null, `?token=${token.slice(0, -2)}xx`)).status).toBe(404);
    const audit = db.query(`SELECT metadata FROM "AuditLog" WHERE action = 'file.token' ORDER BY "at" DESC LIMIT 1`).rows[0];
    expect(JSON.stringify(audit)).not.toContain(token.split(".")[1]);
  });
  it("make thumbnails at fixed sizes only", async () => {
    const r = await download(photo, editor, "?thumb=100x100");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/webp");
    expect(Buffer.from(await r.arrayBuffer()).subarray(8, 12).toString()).toBe("WEBP");
    expect((await download(photo, editor, "?thumb=9999x9999")).status).toBe(400);
    const text = await uploaded("hello", editor, "a.txt", "text/plain");
    expect((await download(text.id, editor, "?thumb=100x100")).status).toBe(400);
  });
  it("serve byte ranges", async () => {
    const file = await uploaded("0123456789", editor, "r.txt", "text/plain");
    const part = await download(file.id, editor, "", { range: "bytes=2-4" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await part.text()).toBe("234");
    expect((await download(file.id, editor, "", { range: "bytes=50-" })).status).toBe(416);
  });
  it("protect files in use from deletion", async () => {
    const file = (await uploaded(PNG)).id;
    const saved = await save([{ fieldId: field("cover"), value: file }]);
    expect((await call(`/api/files/${file}`, { method: "DELETE", as: member })).status).toBe(403);
    expect((await call(`/api/files/${file}`, { method: "DELETE", as: root })).status).toBe(409);
    expect((await edit(saved.json.id, [{ fieldId: field("cover"), value: "" }])).status).toBe(200);
    expect((await call(`/api/files/${file}`, { method: "DELETE", as: root })).status).toBe(204);
    expect((await download(file, root)).status).toBe(404);
  });
  it("drop access when the field is removed, and refuse conversions the index couldn't follow", async () => {
    const created = await call("/api/collections", { method: "POST", as: root, body: { name: "Temp", slug: "file-temp", fields: [{ name: "doc", type: "file" }] } });
    expect(created.status, created.text).toBe(200);
    expect((await rules(created.json.id, "")).status).toBe(200);
    const file = (await uploaded("to be removed", editor, "t.txt", "text/plain")).id;
    expect((await save([{ fieldId: created.json.fields[0].id, value: file }], root, "published", created.json)).status).toBe(200);
    expect((await download(file)).status).toBe(200);
    const fieldsUrl = `/api/collections/${created.json.id}/fields`;
    const convert = await call(fieldsUrl, { method: "PUT", as: root, body: { fields: [{ id: created.json.fields[0].id, name: "doc", type: "text" }], confirm: true } });
    expect(convert.status, convert.text).toBe(400);
    const removed = await call(fieldsUrl, { method: "PUT", as: root, body: { fields: [], confirm: true } });
    expect(removed.status, removed.text).toBe(200);
    expect((await download(file)).status).toBe(404);
  });
  it("show the library in the dashboard only to those allowed", async () => {
    const page = await call("/dashboard/files", { as: editor });
    expect(page.status).toBe(200);
    expect(page.text).toContain("Everything uploaded to this site.");
    const denied = await call("/dashboard/files", { as: member });
    expect([303, 307]).toContain(denied.status);
  });
  it("list files for those allowed, and audit uploads", async () => {
    const r = await call("/api/files?perPage=5", { as: editor });
    expect(r.status, r.text).toBe(200);
    expect(r.json.items.length).toBeGreaterThan(0);
    expect(r.json.items[0]).not.toHaveProperty("key");
    expect(db.query(`SELECT 1 FROM "AuditLog" WHERE action = 'file.upload'`).rowCount).toBeGreaterThan(0);
  });
});

describe("unused upload cleanup", () => {
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const add = async (query: string) => {
    const r = await fetch(`${inject("baseUrl")}/api/files/upload?name=a.png${query}`, { method: "POST", headers: { ...origin, cookie: root.cookie, "content-type": "image/png" }, body: PNG });
    expect(r.status).toBe(200);
    return ((await r.json()) as { id: string }).id;
  };
  const exists = async (id: string) => (await call(`/api/files/${id}/info`, { as: root })).status === 200;
  const age = (id: string) => db.query('UPDATE "StoredFile" SET "createdAt" = ? WHERE "id" = ?', ["2000-01-01T00:00:00.000Z", id]);

  it("removes only old form uploads that nothing uses", async () => {
    const made = await call("/api/collections", { method: "POST", as: root, body: { name: "Cleanup", slug: "cleanup", fields: [{ name: "doc", type: "file" }] } });
    expect(made.status, made.text).toBe(200);
    const abandoned = await add("&temporary=true");
    const used = await add("&temporary=true");
    const library = await add("");
    const recent = await add("&temporary=true");
    const record = await call("/api/collections/cleanup/records", { method: "POST", as: root, body: { doc: used } });
    expect(record.status, record.text).toBe(200);
    for (const id of [abandoned, used, library]) age(id);
    for (let i = 0; i < 60 && await exists(abandoned); i++) await new Promise((r) => setTimeout(r, 200));
    expect(await exists(abandoned)).toBe(false);
    expect(await exists(used)).toBe(true);
    expect(await exists(library)).toBe(true);
    expect(await exists(recent)).toBe(true);
  });
});

describe("revisions, drafts and scheduling", () => {
  type Created = { id: number; fields: Array<{ id: number; name: string }> };
  let posts: Created;
  let writer: Actor;
  const base = (id: number, collection = posts) => `/api/collections/${collection.id}/content/${id}`;
  const fieldId = (name: string) => posts.fields.find((f) => f.name === name)!.id;
  const create = async (title: string, status = "published") => {
    const r = await call(`/api/collections/${posts.id}/content`, { method: "POST", as: editor, body: { status, values: [{ fieldId: fieldId("title"), value: title }] } });
    expect(r.status, r.text).toBe(200);
    return r.json.id as number;
  };
  const setValues = (id: number, values: Array<[string, unknown]>, as: Actor = editor) =>
    call(base(id), { method: "PATCH", as, body: { values: values.map(([name, value]) => ({ fieldId: fieldId(name), value })) } });
  const revisions = async (id: number) => {
    const r = await call(`${base(id)}/revisions`, { as: editor });
    expect(r.status, r.text).toBe(200);
    return r.json.items as Array<{ id: number; number: number; note: string | null; status: string }>;
  };
  const publicTitle = async (id: number) => (await call(`/api/collections/revision-posts/records/${id}`)).json?.title;
  const para = (id: string, text: string, v = 1) => ({ id, type: "para", v, value: { text } });
  const waitUntil = async (check: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 40; i++) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };

  beforeAll(async () => {
    const r = await call("/api/collections", { method: "POST", as: root, body: { name: "Revision posts", slug: "revision-posts", fields: [
      { name: "title", type: "text" }, { name: "note", type: "text", config: { hidden: true } }, { name: "body", type: "stream" }, { name: "doc", type: "file" },
    ] } });
    expect(r.status, r.text).toBe(200);
    posts = r.json;
    const rules = await call(`/api/collections/${posts.id}/rules`, { method: "PUT", as: root, body: { listRule: 'status = "published"', viewRule: 'status = "published"', createRule: null, updateRule: null, deleteRule: null } });
    expect(rules.status, rules.text).toBe(200);
    const block = await call("/api/block-types", { method: "POST", as: root, body: { name: "para", label: "Para", fields: [{ name: "text", type: "text" }] } });
    expect(block.status, block.text).toBe(200);
    const role = await call("/api/roles", { method: "POST", as: root, body: { name: "writer", label: "Writer", permissions: ["dashboard:access", "collection:read", "record:list", "record:read", "record:update"] } });
    expect(role.status, role.text).toBe(200);
    writer = await signIn(await makeUser("writer", "writer"));
  });

  it("record a revision per real change, and none for a save that changes nothing", async () => {
    const id = await create("one");
    expect((await revisions(id)).map((r) => r.number)).toEqual([1]);
    await setValues(id, [["title", "two"]]);
    await setValues(id, [["title", "two"]]);
    expect((await revisions(id)).map((r) => r.number)).toEqual([2, 1]);
  });
  it("refuse a save based on an out-of-date copy, unless it opts out", async () => {
    const id = await create("v1");
    const stamp = (await call(base(id), { as: editor })).json.updatedAt;
    const write = (title: string, extra: object) => call(base(id), { method: "PATCH", as: editor, body: { values: [{ fieldId: fieldId("title"), value: title }], ...extra } });
    expect((await write("mine", { expectedUpdatedAt: stamp })).status).toBe(200);
    const stale = await write("theirs", { expectedUpdatedAt: stamp });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("RECORD_CHANGED");
    expect((await call(base(id), { as: editor })).json.values.find((v: { fieldId: number }) => v.fieldId === fieldId("title")).value).toBe("mine");
    expect((await write("forced", {})).status).toBe(200);
    expect((await write("x", { expectedUpdatedAt: "not a date" })).status).toBe(400);
    expect((await call(`/api/collections/revision-posts/records/${id}`, { method: "PATCH", as: root, headers: { "if-match": `"${stamp}"` }, body: { title: "flat" } })).status).toBe(409);
    expect((await call(`/api/collections/revision-posts/records/${id}`, { method: "PATCH", as: root, headers: { "if-match": "nonsense" }, body: { title: "flat" } })).status).toBe(400);
  });
  it("refuse a draft that would replace one the editor never saw", async () => {
    const id = await create("live");
    expect((await call(base(id), { method: "PATCH", as: editor, body: { status: "published", values: [] } })).status).toBe(200);
    const values = [{ fieldId: fieldId("title"), value: "draft one" }];
    const first = await call(`${base(id)}/draft`, { method: "PUT", as: editor, body: { values, expectedDraftAt: null } });
    expect(first.status, first.text).toBe(200);
    expect((await call(`${base(id)}/draft`, { method: "PUT", as: editor, body: { values, expectedDraftAt: null } })).json.error.code).toBe("RECORD_CHANGED");
    expect((await call(`${base(id)}/draft`, { method: "PUT", as: editor, body: { values, expectedDraftAt: first.json.createdAt } })).status).toBe(200);
  });
  it("capture records from before history existed, so the first edit can be undone", async () => {
    const id = await create("original");
    db.query('DELETE FROM "Revision" WHERE "collectionId" = ? AND "recordId" = ?', [posts.id, id]);
    await setValues(id, [["title", "edited"]]);
    const [latest, baseline] = await revisions(id);
    expect((await call(`${base(id)}/revisions/${baseline.id}`, { as: editor })).json.values.find((v: { fieldId: number }) => v.fieldId === fieldId("title")).value).toBe("original");
    expect(latest.number).toBe(2);
  });
  it("keep history from anyone without record:read, even on a public record", async () => {
    const id = await create("visible");
    await setValues(id, [["note", "hidden staff note"]]);
    const [revision] = await revisions(id);
    expect(await publicTitle(id)).toBe("visible");
    for (const path of ["revisions", `revisions/${revision.id}`, `revisions/${revision.id}/diff`, "draft", "schedule"]) {
      expect((await call(`${base(id)}/${path}`)).status, path).toBe(401);
      expect((await call(`${base(id)}/${path}`, { as: member })).status, path).toBe(403);
    }
    expect((await call(`${base(id)}/revisions/${revision.id}/restore`, { method: "POST", as: member })).status).toBe(403);
    expect((await call(`${base(id)}/draft`, { method: "PUT", as: member, body: { values: [] } })).status).toBe(403);
  });
  it("restore an old revision as a new one, which can itself be undone", async () => {
    const id = await create("first");
    await setValues(id, [["title", "second"]]);
    const before = await revisions(id);
    const oldest = before[before.length - 1];
    const restored = await call(`${base(id)}/revisions/${oldest.id}/restore`, { method: "POST", as: writer });
    expect(restored.status, restored.text).toBe(200);
    expect(await publicTitle(id)).toBe("first");
    const after = await revisions(id);
    expect(after[0]).toMatchObject({ number: 3, note: "Restored revision 1", status: "published" });
    expect((await call(`${base(id)}/revisions/${after[1].id}/restore`, { method: "POST", as: writer })).status).toBe(200);
    expect(await publicTitle(id)).toBe("second");
  });
  it("not serve a revision through another record's URL", async () => {
    const [a, b] = [await create("a"), await create("b")];
    const [revision] = await revisions(a);
    expect((await call(`${base(b)}/revisions/${revision.id}`, { as: editor })).status).toBe(404);
    expect((await call(`${base(b)}/revisions/${revision.id}/restore`, { method: "POST", as: editor })).status).toBe(404);
  });
  it("keep draft changes away from the live record until published", async () => {
    const id = await create("live");
    const saved = await call(`${base(id)}/draft`, { method: "PUT", as: editor, body: { values: [{ fieldId: fieldId("title"), value: "pending" }] } });
    expect(saved.status, saved.text).toBe(200);
    expect(await publicTitle(id)).toBe("live");
    const list = await call(`/api/collections/revision-posts/records?filter=${encodeURIComponent('title = "pending"')}`);
    expect(list.json.totalItems).toBe(0);
    expect((await call(`${base(id)}/draft`, { as: editor })).json.values[0].value).toBe("pending");
    expect(await revisions(id)).toHaveLength(1);

    const published = await call(`${base(id)}/draft/publish`, { method: "POST", as: editor });
    expect(published.status, published.text).toBe(200);
    expect(await publicTitle(id)).toBe("pending");
    expect((await call(`${base(id)}/draft`, { as: editor })).status).toBe(204);
    expect((await revisions(id))[0].note).toBe("Published draft");
  });
  it("discard drafts, validate them, and refuse them on unpublished records", async () => {
    const id = await create("live");
    expect((await call(`${base(id)}/draft`, { method: "PUT", as: editor, body: { values: [{ fieldId: fieldId("title"), value: 12 }] } })).status).toBe(400);
    expect((await call(`${base(id)}/draft`, { method: "PUT", as: editor, body: { values: [{ fieldId: fieldId("title"), value: "x" }] } })).status).toBe(200);
    expect((await call(`${base(id)}/draft`, { method: "DELETE", as: editor })).status).toBe(204);
    expect((await call(`${base(id)}/draft/publish`, { method: "POST", as: editor })).status).toBe(404);
    const unpublished = await create("hidden", "draft");
    expect((await call(`${base(unpublished)}/draft`, { method: "PUT", as: editor, body: { values: [] } })).status).toBe(409);
  });
  it("apply the file claim check to drafts, so publishing can't launder one", async () => {
    const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const uploaded = await fetch(`${inject("baseUrl")}/api/files/upload?name=a.png`, { method: "POST", headers: { ...origin, cookie: editor.cookie, "content-type": "image/png" }, body: PNG });
    const file = (await uploaded.json()).id as string;
    const id = await create("with file");
    const attempt = await call(`${base(id)}/draft`, { method: "PUT", as: writer, body: { values: [{ fieldId: fieldId("doc"), value: file }] } });
    expect(attempt.status, attempt.text).toBe(400);
    expect(attempt.json.error.details[0].message).toBe("This file does not exist.");
    expect((await call(`${base(id)}/draft`, { method: "PUT", as: editor, body: { values: [{ fieldId: fieldId("doc"), value: file }] } })).status).toBe(200);
    expect((await call(`${base(id)}/draft/publish`, { method: "POST", as: writer })).status).toBe(200);
    expect((await call(`/api/files/${file}`)).status).toBe(200);

    await setValues(id, [["doc", ""]]);
    expect((await call(`/api/files/${file}`, { method: "DELETE", as: root })).status).toBe(204);
    const [, withFile] = await revisions(id);
    const restore = await call(`${base(id)}/revisions/${withFile.id}/restore`, { method: "POST", as: editor });
    expect(restore.status, restore.text).toBe(400);
    expect(restore.json.error.details[0].message).toBe("This file does not exist.");
  });
  it("protect a file used by a pending draft, but not one only in old history", async () => {
    const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const uploaded = await fetch(`${inject("baseUrl")}/api/files/upload?name=a.png`, { method: "POST", headers: { ...origin, cookie: editor.cookie, "content-type": "image/png" }, body: PNG });
    const file = (await uploaded.json()).id as string;
    const id = await create("draft file");
    expect((await call(`${base(id)}/draft`, { method: "PUT", as: editor, body: { values: [{ fieldId: fieldId("doc"), value: file }] } })).status).toBe(200);
    const used = (await call("/api/files?perPage=200", { as: editor })).json.items.find((f: { id: string }) => f.id === file);
    expect(used.usedBy).toBe(1);
    const blocked = await call(`/api/files/${file}`, { method: "DELETE", as: root });
    expect(blocked.status, blocked.text).toBe(409);
    expect((await call(`${base(id)}/draft`, { method: "DELETE", as: editor })).status).toBe(204);
    expect((await call(`/api/files/${file}`, { method: "DELETE", as: root })).status).toBe(204);
  });
  it("compare revisions block by block", async () => {
    const id = await create("blocks");
    await setValues(id, [["body", [para("a", "A"), para("b", "B"), para("c", "C")]]]);
    await setValues(id, [["body", [para("c", "C"), para("a", "A edited"), para("d", "D")]]]);
    const [latest] = await revisions(id);
    const diff = await call(`${base(id)}/revisions/${latest.id}/diff`, { as: editor });
    expect(diff.status, diff.text).toBe(200);
    const blocks = diff.json.changes[0].blocks as Array<{ id: string; change: string }>;
    expect(Object.fromEntries(blocks.map((b) => [b.id, b.change]))).toMatchObject({ a: "changed", b: "removed", d: "added" });
    expect((await call(`${base(id)}/revisions/${latest.id}/diff?against=current`, { as: editor })).json.changes).toEqual([]);
  });
  it("restore across schema changes: renamed fields, removed fields and old block versions", async () => {
    const id = await create("before");
    await setValues(id, [["body", [para("p", "version one")]]]);
    const update = await call("/api/block-types", { as: root });
    const para1 = update.json.find((b: { name: string }) => b.name === "para");
    expect((await call(`/api/block-types/${para1.id}`, { method: "PUT", as: root, body: { label: "Para", fields: [{ name: "text", type: "text" }, { name: "extra", type: "text" }] } })).status).toBe(200);
    await setValues(id, [["title", "after"], ["body", []]]);
    const history = await revisions(id);
    const old = history.find((r) => r.number === 2)!;

    const fieldsUrl = `/api/collections/${posts.id}/fields`;
    const renamed = posts.fields.map((f) => (f.name === "title" ? { id: f.id, name: "headline", type: "text" } : { id: f.id, name: f.name, type: (f as unknown as { type: string }).type, config: (f as unknown as { config: Record<string, unknown> }).config }));
    const rulesBack = await call(fieldsUrl, { method: "PUT", as: root, body: { fields: [...renamed, { name: "extra_field", type: "text" }], confirm: true } });
    expect(rulesBack.status, rulesBack.text).toBe(200);
    const restored = await call(`${base(id)}/revisions/${old.id}/restore`, { method: "POST", as: editor });
    expect(restored.status, restored.text).toBe(200);
    const value = (name: string) => restored.json.values.find((v: { field: { name: string } }) => v.field.name === name).value;
    expect(value("headline")).toBe("before");
    expect(value("body")).toEqual([para("p", "version one", 1)]);
    const back = await call(fieldsUrl, { method: "PUT", as: root, body: { fields: renamed.map((f) => (f.name === "headline" ? { ...f, name: "title" } : f)), confirm: true } });
    expect(back.status, back.text).toBe(200);
  });
  it("delete history with its record", async () => {
    const id = await create("gone");
    expect((await call(base(id), { method: "DELETE", as: editor })).status).toBe(204);
    expect(db.query('SELECT 1 FROM "Revision" WHERE "collectionId" = ? AND "recordId" = ?', [posts.id, id]).rowCount).toBe(0);
  });
  it("validate schedules", async () => {
    const id = await create("timing", "draft");
    const soon = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
    expect((await call(`${base(id)}/schedule`, { method: "PUT", as: editor, body: { publishAt: soon(-60), unpublishAt: null } })).status).toBe(400);
    expect((await call(`${base(id)}/schedule`, { method: "PUT", as: editor, body: { publishAt: soon(120), unpublishAt: soon(60) } })).status).toBe(400);
    expect((await call(`${base(id)}/schedule`, { method: "PUT", as: member, body: { publishAt: soon(60), unpublishAt: null } })).status).toBe(403);
    expect((await call(`${base(id)}/schedule`, { method: "PUT", as: editor, body: { publishAt: "tomorrow", unpublishAt: null } })).status).toBe(400);
  });
  it("publish and unpublish on schedule", async () => {
    const id = await create("scheduled", "draft");
    const soon = (ms: number) => new Date(Date.now() + ms).toISOString();
    const planned = await call(`${base(id)}/schedule`, { method: "PUT", as: editor, body: { publishAt: soon(800), unpublishAt: soon(2400) } });
    expect(planned.status, planned.text).toBe(200);
    expect(await publicTitle(id)).toBeUndefined();
    expect(await waitUntil(async () => (await publicTitle(id)) === "scheduled")).toBe(true);
    expect(await waitUntil(async () => (await publicTitle(id)) === undefined)).toBe(true);
    expect((await call(`${base(id)}/schedule`, { as: editor })).json).toEqual({ publish: null, unpublish: null });
    expect(db.query(`SELECT 1 FROM "AuditLog" WHERE action = 'record.scheduled_publish' AND "targetId" = ? AND outcome = 'success'`, [String(id)]).rowCount).toBe(1);
  });
  it("publish a pending draft on schedule", async () => {
    const id = await create("old text");
    await call(`${base(id)}/draft`, { method: "PUT", as: editor, body: { values: [{ fieldId: fieldId("title"), value: "new text" }] } });
    await call(`${base(id)}/schedule`, { method: "PUT", as: editor, body: { publishAt: new Date(Date.now() + 500).toISOString(), unpublishAt: null } });
    expect(await waitUntil(async () => (await publicTitle(id)) === "new text")).toBe(true);
    expect((await call(`${base(id)}/draft`, { as: editor })).status).toBe(204);
  });
  it("not let a schedule outlive its author's access", async () => {
    const email = await makeUser("leaver", "editor");
    const leaver = await signIn(email);
    const id = await create("should stay hidden", "draft");
    const planned = await call(`${base(id)}/schedule`, { method: "PUT", as: leaver, body: { publishAt: new Date(Date.now() + 1500).toISOString(), unpublishAt: null } });
    expect(planned.status, planned.text).toBe(200);
    db.query(`UPDATE "user" SET role = 'user' WHERE id = ?`, [leaver.id]);
    const failed = await waitUntil(async () => Boolean((await call(`${base(id)}/schedule`, { as: editor })).json.publish?.failedAt));
    expect(failed).toBe(true);
    expect((await call(`${base(id)}/schedule`, { as: editor })).json.publish.error).toContain("no longer edit");
    expect(await publicTitle(id)).toBeUndefined();
  });
  it("show the history page only to staff who can read records", async () => {
    const id = await create("page");
    const path = `/dashboard/collections/${posts.id}/content/${id}/history`;
    expect((await call(path, { as: editor })).status).toBe(200);
    expect([303, 307]).toContain((await call(path, { as: member })).status);
  });
});

describe("realtime", () => {
  type Created = { id: number; slug: string; fields: Array<{ id: number; name: string }> };
  let posts: Created, single: Created;
  const opened: Array<{ close: () => void }> = [];

  async function connect(as: Actor | null = null) {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/realtime`, { headers: as ? { cookie: as.cookie } : {}, signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events: Array<{ event: string; data: any }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const state = { ended: false };
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const name = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (name && data) events.push({ event: name, data: JSON.parse(data) });
          }
        }
      } catch { /* closed by the test */ }
      state.ended = true;
    })();
    const handle = { events, state, close: () => controller.abort(), clientId: "" };
    opened.push(handle);
    for (let i = 0; i < 40 && !events.length; i++) await new Promise((r) => setTimeout(r, 25));
    expect(events[0]?.event).toBe("PB_CONNECT");
    handle.clientId = events[0].data.clientId;
    events.length = 0;
    return handle;
  }
  const subscribe = (client: { clientId: string }, subscriptions: string[], as: Actor | null = null) =>
    call("/api/realtime", { method: "POST", as, body: { clientId: client.clientId, subscriptions } });
  const write = async (values: Record<string, unknown>, status = "published", collection = posts) => {
    const r = await call(`/api/collections/${collection.id}/content`, { method: "POST", as: root, body: { status, values: Object.entries(values).map(([name, value]) => ({ fieldId: collection.fields.find((f) => f.name === name)!.id, value })) } });
    expect(r.status, r.text).toBe(200);
    return r.json.id as number;
  };
  const settle = () => new Promise((r) => setTimeout(r, 300));
  const until = async (check: () => boolean) => { for (let i = 0; i < 40 && !check(); i++) await new Promise((r) => setTimeout(r, 100)); return check(); };
  const titles = (client: { events: Array<{ data: any }> }) => client.events.map((e) => e.data.record.title); // eslint-disable-line @typescript-eslint/no-explicit-any

  beforeAll(async () => {
    const make = async (slug: string, rules: Record<string, string | null>) => {
      const r = await call("/api/collections", { method: "POST", as: root, body: { name: slug, slug, fields: [{ name: "title", type: "text" }, { name: "secret", type: "text", config: { hidden: true } }] } });
      expect(r.status, r.text).toBe(200);
      const applied = await call(`/api/collections/${r.json.id}/rules`, { method: "PUT", as: root, body: { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, ...rules } });
      expect(applied.status, applied.text).toBe(200);
      return r.json as Created;
    };
    const rule = 'status = "published"';
    posts = await make("rt-posts", { listRule: rule, viewRule: rule });
    await make("rt-locked", {});
    single = await make("rt-single", { viewRule: "" });
  });
  afterAll(() => { for (const client of opened) client.close(); });

  it("give two viewers only the events their rules allow", async () => {
    const [visitor, staff] = [await connect(), await connect(editor)];
    expect((await subscribe(visitor, ["rt-posts/*"])).status).toBe(204);
    expect((await subscribe(staff, ["rt-posts/*"], editor)).status).toBe(204);
    await write({ title: "public one" });
    await write({ title: "private draft" }, "draft");
    expect(await until(() => staff.events.length === 2)).toBe(true);
    await settle();
    expect(titles(visitor)).toEqual(["public one"]);
    expect(titles(staff)).toEqual(["public one", "private draft"]);
    expect(staff.events[0].event).toBe("rt-posts/*");
    expect(staff.events[0].data.action).toBe("create");
  });
  it("never send hidden fields to those who can't read them", async () => {
    const [visitor, staff] = [await connect(), await connect(editor)];
    await subscribe(visitor, ["rt-posts/*"]);
    await subscribe(staff, ["rt-posts/*"], editor);
    await write({ title: "with secret", secret: "classified" });
    expect(await until(() => visitor.events.length === 1 && staff.events.length === 1)).toBe(true);
    expect(visitor.events[0].data.record).not.toHaveProperty("secret");
    expect(staff.events[0].data.record.secret).toBe("classified");
  });
  it("send update and delete events, and only the record subscribed to", async () => {
    const [a, b] = [await write({ title: "a" }), await write({ title: "b" })];
    const client = await connect();
    await subscribe(client, [`rt-posts/${a}`]);
    const titleField = posts.fields[0].id;
    await call(`/api/collections/${posts.id}/content/${b}`, { method: "PATCH", as: root, body: { values: [{ fieldId: titleField, value: "b2" }] } });
    await call(`/api/collections/${posts.id}/content/${a}`, { method: "PATCH", as: root, body: { values: [{ fieldId: titleField, value: "a2" }] } });
    await call(`/api/collections/${posts.id}/content/${a}`, { method: "DELETE", as: root });
    expect(await until(() => client.events.length === 2)).toBe(true);
    expect(client.events.map((e) => [e.event, e.data.action, e.data.record.title])).toEqual([[`rt-posts/${a}`, "update", "a2"], [`rt-posts/${a}`, "delete", "a2"]]);
  });
  it("apply a topic's filter, within what the caller may read", async () => {
    const topic = (filter: string) => `rt-posts/*?options=${encodeURIComponent(JSON.stringify({ query: { filter } }))}`;
    const client = await connect();
    expect((await subscribe(client, [topic('secret = "x"')])).status).toBe(400);
    expect((await subscribe(client, [topic("(((")])).status).toBe(400);
    expect((await subscribe(client, [topic('title = "wanted"')])).status).toBe(204);
    await write({ title: "other" });
    const id = await write({ title: "wanted" });
    expect(await until(() => client.events.length === 1)).toBe(true);
    expect(client.events[0].data.record.title).toBe("wanted");
    await call(`/api/collections/${posts.id}/content/${id}`, { method: "PATCH", as: root, body: { values: [{ fieldId: posts.fields[0].id, value: "renamed" }] } });
    expect(await until(() => client.events.length === 2)).toBe(true);
    expect(client.events[1].data).toEqual({ action: "delete", record: { id } });
  });
  it("tell a client when a record stops being visible, with nothing but its id", async () => {
    const id = await write({ title: "going", secret: "s" });
    const client = await connect();
    await subscribe(client, ["rt-posts/*"]);
    await call(`/api/collections/${posts.id}/content/${id}`, { method: "PATCH", as: root, body: { status: "draft", values: [] } });
    expect(await until(() => client.events.length === 1)).toBe(true);
    expect(client.events[0].data).toEqual({ action: "delete", record: { id } });
    await call(`/api/collections/${posts.id}/content/${id}`, { method: "PATCH", as: root, body: { values: [{ fieldId: posts.fields[0].id, value: "still hidden" }] } });
    await new Promise((r) => setTimeout(r, 300));
    expect(client.events).toHaveLength(1);
  });
  it("keep pending drafts silent until they're published", async () => {
    const id = await write({ title: "live" });
    const client = await connect();
    await subscribe(client, ["rt-posts/*"]);
    const value = [{ fieldId: posts.fields[0].id, value: "pending" }];
    expect((await call(`/api/collections/${posts.id}/content/${id}/draft`, { method: "PUT", as: editor, body: { values: value } })).status).toBe(200);
    await settle();
    expect(client.events).toEqual([]);
    expect((await call(`/api/collections/${posts.id}/content/${id}/draft/publish`, { method: "POST", as: editor })).status).toBe(200);
    expect(await until(() => client.events.length === 1)).toBe(true);
    expect(titles(client)).toEqual(["pending"]);
  });
  it("deliver scheduled publishes, which run outside any request", async () => {
    const id = await write({ title: "later" }, "draft");
    const client = await connect();
    await subscribe(client, ["rt-posts/*"]);
    await call(`/api/collections/${posts.id}/content/${id}/schedule`, { method: "PUT", as: editor, body: { publishAt: new Date(Date.now() + 500).toISOString(), unpublishAt: null } });
    expect(await until(() => client.events.length === 1)).toBe(true);
    expect(titles(client)).toEqual(["later"]);
  });
  it("use the list rule for collections and the view rule for records", async () => {
    const id = await write({ title: "by id" }, "published", single);
    const client = await connect();
    expect((await subscribe(client, ["rt-single/*"])).status).toBe(403);
    expect((await subscribe(client, [`rt-single/${id}`])).status).toBe(204);
    await call(`/api/collections/${single.id}/content/${id}`, { method: "PATCH", as: root, body: { values: [{ fieldId: single.fields[0].id, value: "changed" }] } });
    expect(await until(() => client.events.length === 1)).toBe(true);
  });
  it("refuse bad subscriptions", async () => {
    const client = await connect();
    expect((await subscribe(client, ["rt-locked/*"])).status).toBe(403);
    expect((await subscribe(client, ["no-such-collection/*"])).status).toBe(404);
    for (const topic of ["rt-posts", "rt-posts/abc", "RT/*", 'rt-posts/*?options=not-json', "rt-posts/*\nevent: forged"]) expect((await subscribe(client, [topic])).status, topic).toBe(400);
    expect((await call("/api/realtime", { method: "POST", body: { clientId: "missing", subscriptions: [] } })).status).toBe(404);
    expect((await call("/api/realtime", { method: "POST", as: editor, headers: { origin: "https://evil.example" }, body: { clientId: client.clientId, subscriptions: [] } })).status).toBe(403);
  });
  it("bind a connection to whoever subscribes first", async () => {
    const client = await connect();
    expect((await subscribe(client, ["rt-posts/*"], editor)).status).toBe(204);
    expect((await subscribe(client, [], member)).status).toBe(403);
    expect((await subscribe(client, [])).status).toBe(403);
  });
  it("apply fields and expand options, and keep hidden fields out of them", async () => {
    const client = await connect();
    await subscribe(client, ['rt-posts/*?options=' + encodeURIComponent(JSON.stringify({ query: { fields: "id,title,secret" } }))]);
    await write({ title: "picked", secret: "nope" });
    expect(await until(() => client.events.length === 1)).toBe(true);
    expect(Object.keys(client.events[0].data.record).sort()).toEqual(["id", "title"]);
  });
  it("stop events as soon as access ends", async () => {
    const leaver = await signIn(await makeUser("rt-leaver", "editor"));
    const client = await connect(leaver);
    await subscribe(client, ["rt-posts/*"], leaver);
    await write({ title: "still staff" }, "draft");
    expect(await until(() => client.events.length === 1)).toBe(true);

    db.query(`UPDATE "user" SET role = 'user' WHERE id = ?`, [leaver.id]);
    await new Promise((r) => setTimeout(r, 2300));
    await write({ title: "secret draft after demotion" }, "draft");
    await write({ title: "public after demotion" });
    expect(await until(() => titles(client).includes("public after demotion"))).toBe(true);
    expect(titles(client)).not.toContain("secret draft after demotion");

    db.query(`DELETE FROM "session" WHERE "userId" = ?`, [leaver.id]);
    await new Promise((r) => setTimeout(r, 2300));
    await write({ title: "after sign-out" });
    expect(await until(() => client.state.ended)).toBe(true);
    expect(titles(client)).not.toContain("after sign-out");
  });
});

describe("batch requests", () => {
  type Created = { id: number; slug: string; fields: Array<{ id: number; name: string }> };
  let items: Created;
  const batch = (requests: unknown[], as: Actor | null = root) => call("/api/batch", { method: "POST", as, body: { requests } });
  const url = (suffix = "") => `/api/collections/batch-items/records${suffix}`;
  const count = () => db.query("SELECT count(*) AS n FROM rec_batch_items").rows[0].n as number;

  beforeAll(async () => {
    const r = await call("/api/collections", { method: "POST", as: root, body: { name: "Items", slug: "batch-items", fields: [{ name: "title", type: "text", config: { required: true } }, { name: "code", type: "text", config: { unique: true } }] } });
    expect(r.status, r.text).toBe(200);
    items = r.json;
    const rules = await call(`/api/collections/${items.id}/rules`, { method: "PUT", as: root, body: { listRule: "", viewRule: "", createRule: '@request.auth.id != ""', updateRule: null, deleteRule: null } });
    expect(rules.status, rules.text).toBe(200);
  });
  afterAll(async () => { await configure((s) => { s.batch.enabled = false; }); });

  it("stay off until enabled", async () => {
    const r = await batch([{ method: "POST", url: url(), body: { title: "x" } }]);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("BATCH_DISABLED");
    await configure((s) => { s.batch.enabled = true; s.batch.maxRequests = 5; });
  });
  it("apply creates, updates and deletes together", async () => {
    const before = count();
    const made = await batch([{ method: "POST", url: url(), body: { title: "one", status: "published" } }, { method: "POST", url: url(), body: { title: "two" } }]);
    expect(made.status, made.text).toBe(200);
    expect(made.json.map((m: { body: { title: string } }) => m.body.title)).toEqual(["one", "two"]);
    const [first, second] = made.json.map((m: { body: { id: number } }) => m.body.id);
    const changed = await batch([{ method: "PATCH", url: url(`/${first}`), body: { title: "uno" } }, { method: "DELETE", url: url(`/${second}`) }]);
    expect(changed.status, changed.text).toBe(200);
    expect(changed.json[1]).toEqual({ status: 204 });
    expect(count()).toBe(before + 1);
    expect(db.query(`SELECT 1 FROM "Revision" WHERE "collectionId" = ? AND "recordId" = ?`, [items.id, first]).rowCount).toBe(2);
    expect(db.query(`SELECT metadata FROM "AuditLog" WHERE action = 'record.batch' ORDER BY "at" DESC LIMIT 1`).rows[0].metadata).toContain("batch-items");
  });
  it("roll everything back when one request fails, and say which", async () => {
    const before = count();
    const r = await batch([{ method: "POST", url: url(), body: { title: "kept?" } }, { method: "POST", url: url(), body: {} }]);
    expect(r.status, r.text).toBe(400);
    expect(r.json.error.code).toBe("BATCH_FAILED");
    expect(r.json.error.details[0]).toMatchObject({ index: 1, status: 400, code: "VALIDATION_FAILED" });
    expect(count()).toBe(before);
    const clash = await batch([{ method: "POST", url: url(), body: { title: "a", code: "same" } }, { method: "POST", url: url(), body: { title: "b", code: "same" } }]);
    expect(clash.status, clash.text).toBe(400);
    expect(clash.json.error.details[0].details[0].path).toBe("code");
    expect(count()).toBe(before);
  });
  it("apply each record's rules, as a single write would", async () => {
    const before = count();
    const denied = await batch([{ method: "POST", url: url(), body: { title: "anon" } }], null);
    expect(denied.status).toBe(400);
    expect(denied.json.error.details[0]).toMatchObject({ status: 400, code: "RULE_REJECTED" });
    const made = await batch([{ method: "POST", url: url(), body: { title: "mine" } }], member);
    expect(made.status, made.text).toBe(200);
    const update = await batch([{ method: "PATCH", url: url(`/${made.json[0].body.id}`), body: { title: "hijacked" } }], member);
    expect(update.json.error.details[0]).toMatchObject({ status: 403, code: "RULE_LOCKED" });
    expect(count()).toBe(before + 1);
  });
  it("refuse anything but record writes, and oversized batches", async () => {
    for (const target of ["/api/users", "/api/collections/batch-items/content", url("/1/../2"), "/api/collections/none/records"]) expect((await batch([{ method: "POST", url: target, body: {} }])).status, target).toBe(400);
    expect((await batch([{ method: "PATCH", url: url(), body: {} }])).status).toBe(400);
    expect((await batch([{ method: "POST", url: url(), body: { nope: 1 } }])).status).toBe(400);
    expect((await batch(Array.from({ length: 6 }, () => ({ method: "POST", url: url(), body: { title: "x" } })))).json.error.code).toBe("BATCH_TOO_LARGE");
  });
});

describe("view collections", () => {
  type Created = { id: number; slug: string; fields: Array<{ id: number; name: string; type: string; config: Record<string, unknown> }> };
  let authors: Created, stats: Created;
  const makeView = (slug: string, query: string, as: Actor = root) => call("/api/collections/views", { method: "POST", as, body: { name: slug, slug, query } });
  const QUERY = "SELECT id, name, salary, 1 AS one FROM rec_vw_authors";

  beforeAll(async () => {
    const r = await call("/api/collections", { method: "POST", as: root, body: { name: "VW authors", slug: "vw-authors", fields: [{ name: "name", type: "text" }, { name: "salary", type: "text", config: { hidden: true } }, { name: "extra", type: "text" }] } });
    expect(r.status, r.text).toBe(200);
    authors = r.json;
    const value = (name: string, v: string) => ({ fieldId: authors.fields.find((f) => f.name === name)!.id, value: v });
    expect((await call(`/api/collections/${authors.id}/content`, { method: "POST", as: root, body: { status: "published", values: [value("name", "Ann"), value("salary", "100")] } })).status).toBe(200);
  });

  it("need their own permission, which admins don't hold by default", async () => {
    expect((await makeView("vw-denied", QUERY, editor)).status).toBe(403);
    expect((await makeView("vw-denied", QUERY, admin)).status).toBe(403);
  });
  it("can't read system tables, however the SQL is written", async () => {
    for (const query of [
      'SELECT id, email FROM "user"', 'SELECT id, password FROM account', 'SELECT rowid AS id, sql FROM sqlite_master', 'SELECT rowid AS id, name FROM "SQLITE_SCHEMA"',
      'SELECT 1 AS id FROM rec_vw_authors WHERE EXISTS (SELECT 1 FROM session)', 'WITH s AS (SELECT * FROM "user") SELECT id FROM s', 'SELECT 1 AS id, name FROM pragma_table_info(\'user\')',
      'SELECT rowid AS id FROM dbstat', "SELECT 1 AS id, load_extension('x') AS y",
      'SELECT id, email FROM public."user"', 'SELECT 1 AS id, usename FROM pg_catalog.pg_user', 'SELECT 1 AS id, rolpassword FROM pg_authid', 'SELECT 1 AS id, tablename FROM pg_tables',
      `SELECT 1 AS id, query_to_xml('select * from "user"', true, true, '') AS x`, "SELECT 1 AS id, pg_read_file('/etc/passwd') AS x", "SELECT 1 AS id, current_setting('data_directory') AS x",
      "SELECT 1 AS id, pg_sleep(30) AS x", "SELECT 1 AS id, dblink('dbname=x', 'select 1') AS x", "SELECT 1 AS id, pg_catalog.pg_read_file('/etc/passwd') AS x", "SELECT 1 AS id, public.lower('x') AS x",
      // On SQLite this reads only its own WITH clause, because the sandbox holds no "user" table. Postgres refuses the name.
      ...(POSTGRES ? [`WITH "user" AS (SELECT 1 AS id) SELECT id FROM "user"`] : []), `SELECT id FROM rec_vw_authors WHERE id IN (WITH account AS (SELECT 1 AS id) SELECT id FROM account) AND id IN (SELECT id FROM account)`,
      `SELECT 1 AS id, '"user"'::regclass AS x`, 'SELECT 1 AS id, current_user AS x', `SELECT id INTO rec_stolen FROM rec_vw_authors`,
    ]) {
      const r = await makeView("vw-bad", query);
      expect(r.status, query).toBe(400);
      expect(r.json.error.code, query).toBe("INVALID_VIEW_QUERY");
    }
  });
  it("accept only a single, read-only SELECT with usable columns", async () => {
    for (const query of [
      "DELETE FROM rec_vw_authors", "DROP TABLE rec_vw_authors", `${QUERY}; DROP TABLE rec_vw_authors`, "SELECT name FROM rec_vw_authors", "SELECT id, name, name FROM rec_vw_authors",
      "SELECT id, count(*) FROM rec_vw_authors", "SELECT id, ? AS x FROM rec_vw_authors", `${QUERY} /* open`, "PRAGMA table_info(rec_vw_authors)", "",
      "SELECT id, $1 AS x FROM rec_vw_authors", "SELECT id FROM rec_vw_authors FOR UPDATE",
    ]) expect((await makeView("vw-bad", query)).status, query).toBe(400);
  });
  it("start locked, and serve computed rows once a rule allows", async () => {
    const r = await makeView("vw-stats", QUERY);
    expect(r.status, r.text).toBe(200);
    stats = r.json;
    expect(stats.fields.map((f) => [f.name, f.type])).toEqual([["name", "text"], ["salary", "text"], ["one", "text"]]);
    expect((await call("/api/collections/vw-stats/records")).status).toBe(403);
    expect((await call(`/api/collections/${stats.id}/rules`, { method: "PUT", as: root, body: { listRule: "", viewRule: "", createRule: null, updateRule: null, deleteRule: null } })).status).toBe(200);
    const list = await call("/api/collections/vw-stats/records");
    expect(list.status, list.text).toBe(200);
    expect(list.json.items[0]).toMatchObject({ name: "Ann", one: 1, status: "published" });
  });
  it("keep a source column's hidden flag", async () => {
    expect((await call("/api/collections/vw-stats/records")).json.items[0]).not.toHaveProperty("salary");
    expect((await call("/api/collections/vw-stats/records", { as: editor })).json.items[0].salary).toBe("100");
    const probe = await call(`/api/collections/vw-stats/records?filter=${encodeURIComponent('salary = "100"')}`);
    expect(probe.status).toBe(400);
  });
  it("are read-only", async () => {
    const value = [{ fieldId: stats.fields[0].id, value: "x" }];
    expect((await call(`/api/collections/${stats.id}/content`, { method: "POST", as: root, body: { values: value } })).status).toBe(405);
    const id = (await call("/api/collections/vw-stats/records")).json.items[0].id;
    expect((await call(`/api/collections/${stats.id}/content/${id}`, { method: "PATCH", as: root, body: { values: value } })).status).toBe(405);
    expect((await call(`/api/collections/${stats.id}/content/${id}`, { method: "DELETE", as: root })).status).toBe(405);
    expect((await call(`/api/collections/${stats.id}/content/${id}/draft`, { method: "PUT", as: root, body: { values: value } })).status).toBe(405);
    expect((await call(`/api/collections/${stats.id}/fields`, { method: "PUT", as: root, body: { fields: [], confirm: true } })).status).toBe(400);
    expect((await call(`/api/collections/${stats.id}/rules`, { method: "PUT", as: root, body: { listRule: "", viewRule: "", createRule: "", updateRule: null, deleteRule: null } })).status).toBe(400);
  });
  it("have no realtime events", async () => {
    const opened = await fetch(`${base}/api/realtime`);
    const reader = opened.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    const clientId = JSON.parse(/data: (.*)/.exec(first)![1]).clientId;
    expect((await call("/api/realtime", { method: "POST", body: { clientId, subscriptions: ["vw-stats/*"] } })).status).toBe(400);
    await reader.cancel();
  });
  it("protect the columns and tables they depend on", async () => {
    const fields = authors.fields.map((f) => ({ id: f.id, name: f.name, type: f.type, config: f.config }));
    const put = (next: unknown[]) => call(`/api/collections/${authors.id}/fields`, { method: "PUT", as: root, body: { fields: next, confirm: true } });
    expect((await put(fields.filter((f) => f.name !== "salary"))).status).toBe(409);
    expect((await put(fields.map((f) => (f.name === "name" ? { ...f, name: "full_name" } : f)))).status).toBe(409);
    expect((await call(`/api/collections/${authors.id}`, { method: "DELETE", as: root })).status).toBe(409);
    expect((await call(`/api/collections/${authors.id}`, { method: "PATCH", as: root, body: { slug: "vw-renamed" } })).status).toBe(409);
    const unrelated = await put(fields.filter((f) => f.name !== "extra"));
    expect(unrelated.status, unrelated.text).toBe(200);
  });
  it("change query, keeping field ids, and refuse a change that breaks a rule", async () => {
    const before = stats.fields.find((f) => f.name === "name")!.id;
    const rule = await call(`/api/collections/${stats.id}/rules`, { method: "PUT", as: root, body: { listRule: 'one = 1', viewRule: "", createRule: null, updateRule: null, deleteRule: null } });
    expect(rule.status, rule.text).toBe(200);
    expect((await call(`/api/collections/${stats.id}/view`, { method: "PUT", as: root, body: { query: "SELECT id, name FROM rec_vw_authors" } })).status).toBe(400);
    const updated = await call(`/api/collections/${stats.id}/view`, { method: "PUT", as: root, body: { query: "SELECT id, name, 1 AS one, 2 AS two FROM rec_vw_authors" } });
    expect(updated.status, updated.text).toBe(200);
    expect(updated.json.fields.find((f: { name: string }) => f.name === "name").id).toBe(before);
    expect((await call("/api/collections/vw-stats/records")).json.items[0].two).toBe(2);
    expect((await call(`/api/collections/${stats.id}/view`, { method: "PUT", as: admin, body: { query: "SELECT id FROM rec_vw_authors" } })).status).toBe(403);
  });
  it("delete cleanly, freeing their source", async () => {
    expect((await call(`/api/collections/${stats.id}`, { method: "DELETE", as: root })).status).toBeLessThan(300);
    expect((await call(`/api/collections/${authors.id}`, { method: "DELETE", as: root })).status).toBeLessThan(300);
  });
});

describe("custom user fields", () => {
  type Field = { id: number; name: string; type: string; config: Record<string, unknown>; selfEditable: boolean };
  let fields: Field[], person: Actor, gated: { id: number; fields: Array<{ id: number }> };
  const save = (next: unknown[], confirm = false, as: Actor = root) => call("/api/user-fields", { method: "PUT", as, body: { fields: next, confirm } });
  const asRequest = (list: Field[]) => list.map(({ id, name, type, config, selfEditable }) => ({ id, name, type, config, selfEditable }));
  const setOwn = (values: Record<string, unknown>, as: Actor = person) => call("/api/account/fields", { method: "PATCH", as, body: { values } });
  const setAs = (id: string, values: Record<string, unknown>, as: Actor = root) => call(`/api/users/${id}/fields`, { method: "PUT", as, body: { values } });
  const rules = (id: number, viewRule: string | null, listRule: string | null = null) => call(`/api/collections/${id}/rules`, { method: "PUT", as: root, body: { listRule, viewRule, createRule: null, updateRule: null, deleteRule: null } });

  beforeAll(async () => {
    // Plugins' fields, such as the LMS's lms_courses, stay: a rule relies on them, as it would on a real site.
    const existing = await call("/api/user-fields", { as: root });
    expect(existing.status, existing.text).toBe(200);
    const r = await save([
      ...asRequest(existing.json as Field[]),
      { name: "department", type: "text" },
      { name: "nickname", type: "text", selfEditable: true },
      { name: "risk_score", type: "number", config: { hidden: true } },
      { name: "plan", type: "text", config: { defaultValue: "free" } },
    ]);
    expect(r.status, r.text).toBe(200);
    fields = r.json;
    person = await signIn(await makeUser("custom-person", "user"));
    const made = await call("/api/collections", { method: "POST", as: root, body: { name: "Gated", slug: "gated-docs", fields: [{ name: "title", type: "text" }] } });
    expect(made.status, made.text).toBe(200);
    gated = made.json;
    expect((await call(`/api/collections/${gated.id}/content`, { method: "POST", as: root, body: { status: "published", values: [{ fieldId: gated.fields[0].id, value: "Finance plan" }] } })).status).toBe(200);
  });

  it("are defined only by those who can change settings, with a fresh session", async () => {
    expect((await call("/api/user-fields", { method: "PUT", body: { fields: [] } })).status).toBe(401);
    expect((await save([], true, member)).status).toBe(403);
    expect((await save([], true, admin)).status).toBe(403);
    expect((await call("/api/user-fields", { as: member })).status).toBe(403);
  });
  it("refuse names, types and options they couldn't honour", async () => {
    const keep = asRequest(fields);
    const cases: unknown[] = [
      { name: "role", type: "text" }, { name: "email", type: "text" }, { name: "Password", type: "text" }, { name: "__proto__", type: "text" }, { name: "department", type: "text" },
      { name: "body", type: "stream" }, { name: "photo", type: "image" }, { name: "boss", type: "reference", config: { collection: gated.id } },
      { name: "code", type: "text", config: { unique: true } }, { name: "both", type: "text", config: { hidden: true }, selfEditable: true }, { name: "bad", type: "nope" },
    ];
    for (const entry of cases) expect((await save([...keep, entry])).status, JSON.stringify(entry)).toBe(400);
    const retyped = keep.map((f) => (f.name === "department" ? { ...f, type: "number" } : f));
    expect((await save(retyped)).status).toBe(400);
  });
  it("can't be made editable by users when a running plugin sets them", async () => {
    // social-sign-in always runs, so its prefix belongs to it.
    const r = await save([...asRequest(fields), { name: "social_sign_in_tier", type: "text", selfEditable: true }]);
    expect(r.status, r.text).toBe(400);
    expect(r.json.error.details[0]).toEqual({ path: `fields.${fields.length}.selfEditable`, message: "The social-sign-in plugin sets this field, so users can't edit it themselves." });
  });
  it("let a person edit only what's marked editable", async () => {
    const ok = await setOwn({ nickname: "Zed" });
    expect(ok.status, ok.text).toBe(200);
    for (const values of [{ department: "finance" }, { nickname: "x", plan: "enterprise" }]) {
      const r = await setOwn(values);
      expect(r.status, r.text).toBe(400);
      expect(r.json.error.details[0].message).toBe("Only an administrator can change this field.");
    }
    expect((await call("/api/account/fields", { method: "PATCH", body: { values: {} } })).status).toBe(401);
  });
  it("not reveal that a hidden field exists", async () => {
    const hidden = await setOwn({ risk_score: 1 });
    const missing = await setOwn({ no_such_field: 1 });
    expect(hidden.status).toBe(400);
    expect(hidden.json.error.details[0].message).toBe(missing.json.error.details[0].message);
  });
  it("show a person their visible values and defaults, never hidden ones", async () => {
    expect((await setAs(person.id, { department: "finance", risk_score: 7 })).status).toBe(200);
    const me = await call("/api/me", { as: person });
    expect(me.json.fields).toEqual({ department: "finance", nickname: "Zed", plan: "free" });
    expect(me.text).not.toContain("risk_score");
    const page = await call("/dashboard/account", { as: person });
    expect(page.status).toBe(200);
    expect(page.text).not.toContain("risk_score");
    const managed = await call(`/api/users/${person.id}/fields`, { as: root });
    expect(managed.json.find((f: { name: string }) => f.name === "risk_score").value).toBe(7);
    expect((await call(`/api/users/${person.id}/fields`, { as: member })).status).toBe(403);
  });
  it("validate values, and let empty clear them", async () => {
    expect((await setAs(person.id, { risk_score: "high" })).status).toBe(400);
    expect((await setAs(person.id, { nope: 1 })).status).toBe(400);
    expect((await setOwn({ nickname: "" })).status).toBe(200);
    expect((await call("/api/me", { as: person })).json.fields.nickname).toBeNull();
  });
  it("can't be set by a manager on themselves, or on someone more privileged", async () => {
    expect((await setAs(admin.id, { department: "x" }, admin)).status).toBe(400);
    expect((await setAs(root.id, { department: "x" }, admin)).status).toBe(403);
    expect((await setAs(person.id, { department: "x" }, member)).status).toBe(403);
  });
  it("work in API rules, including hidden values and defaults", async () => {
    const read = async (as: Actor | null) => (await call("/api/collections/gated-docs/records", { as })).json.items?.length;
    expect((await rules(gated.id, null, '@request.auth.department = "finance"')).status).toBe(200);
    expect(await read(person)).toBe(1);
    expect(await read(member)).toBe(0);
    expect(await read(null)).toBe(0);
    expect((await rules(gated.id, null, "@request.auth.risk_score > 5")).status).toBe(200);
    expect(await read(person)).toBe(1);
    expect((await rules(gated.id, null, '@request.auth.plan = "free"')).status).toBe(200);
    expect(await read(member)).toBe(1);
    expect((await rules(gated.id, null, '@request.auth.nope = "x"')).status).toBe(400);
  });
  it("apply a change to rules on the next request", async () => {
    expect((await rules(gated.id, null, '@request.auth.department = "finance"')).status).toBe(200);
    expect((await setAs(person.id, { department: "sales" })).status).toBe(200);
    expect((await call("/api/collections/gated-docs/records", { as: person })).json.items).toEqual([]);
  });
  it("can't be probed through a caller's filter", async () => {
    await rules(gated.id, null, "");
    const probe = await call(`/api/collections/gated-docs/records?filter=${encodeURIComponent("@request.auth.risk_score > 5")}`, { as: person });
    expect(probe.status).toBe(400);
  });
  it("can't stand in for a built-in field", async () => {
    await rules(gated.id, null, '@request.auth.role = "user"');
    expect((await call("/api/collections/gated-docs/records", { as: person })).json.items.length).toBe(1);
  });
  it("can't be renamed or removed while a rule uses them, and removal deletes values", async () => {
    expect((await rules(gated.id, null, '@request.auth.department = "sales"')).status).toBe(200);
    const renamed = asRequest(fields).map((f) => (f.name === "department" ? { ...f, name: "team" } : f));
    expect((await save(renamed)).status).toBe(400);
    expect((await save(asRequest(fields).filter((f) => f.name !== "department"), true)).status).toBe(400);
    expect((await rules(gated.id, null, "")).status).toBe(200);

    const withoutScore = asRequest(fields).filter((f) => f.name !== "risk_score");
    const unconfirmed = await save(withoutScore);
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.json.error.code).toBe("CONFIRMATION_REQUIRED");
    const scoreId = fields.find((f) => f.name === "risk_score")!.id;
    expect((await save(withoutScore, true)).status, "remove").toBe(200);
    expect(db.query('SELECT "values" FROM "UserProfile" WHERE "userId" = ?', [person.id]).rows[0].values).not.toContain(`"${scoreId}"`);
    expect((await save(renamed.filter((f) => f.name !== "risk_score"))).status).toBe(200);
    expect((await call("/api/me", { as: person })).json.fields.team).toBe("sales");
  });
  it("disappear with their user", async () => {
    const gone = await signIn(await makeUser("custom-gone", "user"));
    expect((await setAs(gone.id, { team: "x" })).status).toBe(200);
    expect((await call(`/api/users/${gone.id}`, { method: "DELETE", as: root })).status).toBeLessThan(300);
    expect(db.query('SELECT 1 FROM "UserProfile" WHERE "userId" = ?', [gone.id]).rowCount).toBe(0);
  });
  it("keep values out of the audit log", async () => {
    expect((await setAs(person.id, { team: "very-distinctive-value" })).status).toBe(200);
    const row = db.query(`SELECT metadata FROM "AuditLog" WHERE action = 'user.update_fields' ORDER BY "at" DESC LIMIT 1`).rows[0];
    expect(row.metadata).toContain("team");
    expect(row.metadata).not.toContain("very-distinctive-value");
  });
  it("show the settings page only to those allowed", async () => {
    const allowed = await call("/dashboard/users/fields", { as: root });
    expect(allowed.status).toBe(200);
    // The fields themselves, which only the page's own render puts in the page.
    expect(allowed.text).toContain("nickname");
    // Denied at the page rather than at the layout, which the dashboard's loading skeleton has
    // already begun streaming past, so the redirect to "denied" arrives in the body (SECURITY_MODEL.md).
    const denied = await call("/dashboard/users/fields", { as: admin });
    expect(denied.headers.get("location") ?? denied.text).toContain("denied=1");
    expect(denied.text, "the page's own fields must not be in a denied response").not.toContain("nickname");
  });
  afterAll(async () => { await save([], true); });
});

describe("extensibility", () => {
  const create = async (slug: string, fields: unknown[], rules?: Record<string, string | null>) => {
    const r = await call("/api/collections", { method: "POST", as: root, body: { name: slug, slug, fields } });
    expect(r.status, r.text).toBe(200);
    if (rules) expect((await call(`/api/collections/${r.json.id}/rules`, { method: "PUT", as: root, body: { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, ...rules } })).status).toBe(200);
    return r.json as { id: number; fields: Array<{ id: number; name: string }> };
  };
  const records = (slug: string, suffix = "") => `/api/collections/${slug}/records${suffix}`;
  const until = async <T,>(read: () => T | Promise<T>, done: (value: T) => boolean, label: string) => {
    for (let i = 0; i < 120; i++) {
      const value = await read();
      if (done(value)) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for ${label}`);
  };

  beforeAll(async () => {
    root = await signIn(root.email);
    await create("hooked", [{ name: "title", type: "text", config: { maxLength: 20 } }]);
    await create("hook-log", [{ name: "title", type: "text" }]);
  });

  describe("flat record writes", () => {
    beforeAll(() => create("flat", [{ name: "title", type: "text", config: { required: true } }, { name: "secret", type: "text", config: { hidden: true } }], { listRule: "", createRule: "", viewRule: 'status = "published"', updateRule: '@request.auth.id != ""' }));
    it("pass the rule and validation, and only show what the caller can view", async () => {
      expect((await call(records("flat"), { method: "POST", body: { nope: 1 } })).status).toBe(400);
      expect((await call(records("flat"), { method: "POST", body: {} })).json.error.details[0].path).toBe("title");
      const draft = await call(records("flat"), { method: "POST", body: { title: "a", secret: "s" } });
      expect(draft.status, draft.text).toBe(200);
      expect(draft.json).toEqual({ id: draft.json.id });
      const published = await call(records("flat"), { method: "POST", body: { title: "b", status: "published", secret: "s" } });
      expect(published.json.title).toBe("b");
      expect(published.json.secret).toBeUndefined();
      expect((await call(records("flat", `/${published.json.id}`), { method: "PATCH", body: { title: "c" } })).status).toBe(404);
      expect((await call(records("flat", `/${published.json.id}`), { method: "PATCH", as: root, body: { title: "c" } })).json.title).toBe("c");
      expect((await call(records("flat", `/${published.json.id}`), { method: "DELETE" })).status).toBe(403);
      expect((await call(records("flat", `/${published.json.id}`), { method: "DELETE", as: root })).status).toBe(204);
    });
  });

  describe("cms_hooks", () => {
    it("change values, reject writes, and have their output validated", async () => {
      const made = await call(records("hooked"), { method: "POST", as: root, body: { title: "hello" } });
      expect(made.json.title).toBe("HELLO");
      const refused = await call(records("hooked"), { method: "POST", as: root, body: { title: "forbidden" } });
      expect(refused.status).toBe(400);
      expect(refused.json.error.code).toBe("HOOK_REJECTED");
      expect(refused.json.error.details[0].path).toBe("title");
      expect((await call(records("hooked"), { method: "POST", as: root, body: { title: "too-long" } })).json.error.details[0].path).toBe("title");
      await until(() => db.query("SELECT count(*) AS n FROM rec_hook_log WHERE title = ?", [`saw ${made.json.id}`]).rows[0].n, (n) => n === 1, "after hook");
    });
    it("apply to the dashboard's API and to batches, outside the transaction", async () => {
      const collection = db.query(`SELECT id FROM "Collection" WHERE slug = 'hooked'`).rows[0];
      const field = db.query(`SELECT id FROM "Field" WHERE "collectionId" = ?`, [collection.id]).rows[0];
      expect((await call(`/api/collections/${collection.id}/content`, { method: "POST", as: root, body: { values: [{ fieldId: field.id, value: "forbidden" }] } })).json.error.code).toBe("HOOK_REJECTED");
      await configure((s) => { s.batch.enabled = true; });
      const ok = await call("/api/batch", { method: "POST", as: root, body: { requests: [{ method: "POST", url: records("hooked"), body: { title: "from batch" } }] } });
      expect(ok.status, ok.text).toBe(200);
      expect(ok.json[0].body.title).toBe("FROM BATCH");
      const bad = await call("/api/batch", { method: "POST", as: root, body: { requests: [{ method: "POST", url: records("hooked"), body: { title: "fine" } }, { method: "POST", url: records("hooked"), body: { title: "forbidden" } }] } });
      expect(bad.status).toBe(400);
      expect(bad.json.error.details[0].index).toBe(1);
      await configure((s) => { s.batch.enabled = false; });
    });
    it("have their system writes audited under their own name", async () => {
      const made = await call(records("hooked"), { method: "POST", as: root, body: { title: "attributed" } });
      expect(made.status, made.text).toBe(200);
      const attributed = () => db.query(`SELECT "actorKind", action FROM "AuditLog" WHERE "actorEmail" = 'cms_hooks/main.ts'`).rows;
      await until(async () => attributed().length, (count) => count > 0, "attributed audit entry");
      expect(attributed()[0]).toEqual({ actorKind: "system", action: "record.create" });
    });
    it("hear about schema changes after they commit, and keep their own store", async () => {
      await create("announced", [{ name: "title", type: "text" }]);
      await until(async () => (await call("/api/ext/last-collection")).json?.slug, (slug) => slug === "announced", "schema event");
    });
    it("tell an afterUpdate hook what the record was before", async () => {
      const made = await call(records("hooked"), { method: "POST", as: root, body: { title: "before" } });
      expect((await call(records("hooked", `/${made.json.id}`), { method: "PATCH", as: root, body: { title: "after" } })).status).toBe(200);
      await until(() => db.query("SELECT count(*) AS n FROM rec_hook_log WHERE title = ?", ["upd BEFORE>after"]).rows[0].n, (n) => n === 1, "afterUpdate with previous");
    });
    it("retry an after-hook that fails until it succeeds, without anyone writing again", async () => {
      const made = await call(records("hooked"), { method: "POST", as: root, body: { title: "flaky" } });
      expect(made.status, made.text).toBe(200);
      const succeeded = () => db.query("SELECT count(*) AS n FROM rec_hook_log WHERE title = ?", [`flaky ok ${made.json.id}`]).rows[0].n;
      // The first attempt throws, and the retry comes 10 seconds later.
      for (let i = 0; i < 300 && succeeded() === 0; i++) await new Promise((r) => setTimeout(r, 100));
      expect(succeeded()).toBe(1);
      // The delivery is removed just after the hook returns.
      await until(() => db.query(`SELECT count(*) AS n FROM "HookDelivery" WHERE "recordId" = ? AND source = 'cms_hooks/main.ts' AND event = 'record.afterCreate'`, [made.json.id]).rows[0].n, (n) => n === 0, "delivery cleared");
    }, 45_000);
    it("let exactly one of many concurrent claims of a store key win", async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => call("/api/ext/claim/event-1", { method: "POST", as: root })));
      expect(results.map((r) => r.json.won).filter(Boolean)).toHaveLength(1);
      expect((await call("/api/ext/claim/event-1", { method: "POST", as: root })).json.won).toBe(false);
    });
    it("apply exactly one of many concurrent conditional updates from the same state", async () => {
      const made = await call(records("hooked"), { method: "POST", as: root, body: { title: "pending" } });
      const results = await Promise.all(Array.from({ length: 8 }, (_, n) => call(`/api/ext/cas/${made.json.id}/PENDING/paid${n}`, { method: "POST", as: root })));
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect(results.filter((r) => r.json.matched)).toHaveLength(1);
      const winner = results.findIndex((r) => r.json.matched);
      expect((await call(records("hooked", `/${made.json.id}`), { as: root })).json.title).toBe(`paid${winner}`);
      expect((await call(`/api/ext/cas/${made.json.id}/PENDING/again`, { method: "POST", as: root })).json.matched).toBe(false);
    });
    it("refuse a condition on a field that is unknown, or can't be compared", async () => {
      const made = await call(records("hooked"), { method: "POST", as: root, body: { title: "cond" } });
      expect((await call(`/api/ext/cas-field/${made.json.id}/nope`, { method: "POST", as: root })).status).toBe(400);
      expect((await call(`/api/ext/cas-field/${made.json.id}/createdById`, { method: "POST", as: root })).status).toBe(400);
    });
    it("can veto a delete", async () => {
      const made = await call(records("hooked"), { method: "POST", as: root, body: { title: "keep" } });
      expect((await call(records("hooked", `/${made.json.id}`), { method: "DELETE", as: root })).json.error.code).toBe("HOOK_REJECTED");
    });
    it("serve routes under their own declared policy", async () => {
      expect((await call("/api/ext/whoami")).status).toBe(401);
      expect((await call("/api/ext/whoami", { as: root })).json.id).toBe(root.id);
      expect((await call("/api/ext/staff", { as: member })).status).toBe(403);
      expect((await call("/api/ext/staff", { as: root })).json.ok).toBe(true);
      expect((await call("/api/ext/nothing-here", { as: root })).status).toBe(404);
      expect((await call("/api/ext/echo/ada", { method: "POST", as: root, headers: { origin: "https://evil.test", "sec-fetch-site": "cross-site" } })).json.error.code).toBe("CSRF_REJECTED");
      expect((await call("/api/ext/echo/ada", { method: "POST", as: root })).json.name).toBe("ada");
      expect(db.query(`SELECT count(*) AS n FROM "AuditLog" WHERE action = 'hook.echo'`).rows[0].n).toBe(1);
    });
    it("run jobs on schedule", async () => {
      await until(() => db.query(`SELECT status FROM "JobRun" WHERE name = 'test.tick'`).rows[0]?.status, (status) => status === "success", "job");
    });
    it("refuse a file that takes a route another file already serves", async () => {
      const file = path.join(inject("hooksDir"), "clash.ts");
      writeFileSync(file, "export default (cms: any) => { cms.route({ method: 'GET', path: '/clash-marker', access: 'authenticated', handler: () => ({ ok: true }) }); cms.route({ method: 'GET', path: '/whoami', access: 'public', reason: 'test', handler: () => ({ id: 'stolen' }) }); };");
      await new Promise((r) => setTimeout(r, 1000));
      expect((await call("/api/ext/clash-marker", { as: root })).status).toBe(404);
      expect((await call("/api/ext/whoami")).status).toBe(401);
      rmSync(file);
    });
    it("reload without a restart, and keep the old version when a save is broken", async () => {
      const file = path.join(inject("hooksDir"), "main.ts");
      const original = readFileSync(file, "utf8");
      writeFileSync(file, original.replace("version: 1", "version: 2"));
      await until(async () => (await call("/api/ext/version")).json?.version, (v) => v === 2, "hook reload");
      writeFileSync(file, "export default (cms: any) => { throw new Error('broken'); };");
      await new Promise((r) => setTimeout(r, 1000));
      expect((await call("/api/ext/version")).json.version).toBe(2);
      expect((await call(records("hooked"), { method: "POST", as: root, body: { title: "forbidden" } })).status).toBe(400);
      writeFileSync(file, original);
      await until(async () => (await call("/api/ext/version")).json?.version, (v) => v === 1, "hook restore");
    });
  });

  describe("a field type whose plugin was removed", () => {
    it("leaves the collection readable, writable and able to drop the field", async () => {
      const made = await create("orphans", [{ name: "title", type: "text" }, { name: "extra", type: "json" }]);
      const record = await call(records("orphans"), { method: "POST", as: root, body: { title: "one", extra: { kept: true } } });
      expect(record.status, record.text).toBe(200);
      const field = db.query(`SELECT id, storage FROM "Field" WHERE "collectionId" = ? AND name = 'extra'`, [made.id]).rows[0];
      expect(field.storage).toBe("json");
      db.query(`UPDATE "Field" SET type = 'gone_plugin_type' WHERE id = ?`, [field.id]);

      const url = records("orphans", `/${record.json.id}`);
      expect((await call(url, { as: root })).json.extra).toEqual({ kept: true });
      const saved = await call(url, { method: "PATCH", as: root, body: { title: "two", extra: { kept: false } } });
      expect(saved.status, saved.text).toBe(200);
      expect(saved.json.title).toBe("two");
      expect(saved.json.extra).toEqual({ kept: true });
      expect((await call(records("orphans"), { method: "POST", as: root, body: { title: "three" } })).status).toBe(200);

      const fieldsUrl = `/api/collections/${made.id}/fields`;
      const title = db.query(`SELECT id FROM "Field" WHERE "collectionId" = ? AND name = 'title'`, [made.id]).rows[0];
      const keep = await call(fieldsUrl, { method: "PUT", as: root, body: { fields: [{ id: title.id, name: "title", type: "text", config: { label: "Title" } }, { id: field.id, name: "extra", type: "gone_plugin_type", config: {} }] } });
      expect(keep.status, keep.text).toBe(200);
      const dropped = await call(fieldsUrl, { method: "PUT", as: root, body: { confirm: true, fields: [{ id: title.id, name: "title", type: "text", config: { label: "Title" } }] } });
      expect(dropped.status, dropped.text).toBe(200);
      expect((await call(url, { as: root })).json.extra).toBeUndefined();
    });
  });

  describe("the SEO plugin", () => {
    it("owns its block, which the dashboard can't change or delete", async () => {
      const block = db.query(`SELECT id, source FROM "BlockType" WHERE name = 'seo_faq'`).rows[0];
      expect(block.source).toBe("seo");
      expect((await call(`/api/block-types/${block.id}`, { method: "PUT", as: root, body: { label: "Changed", fields: [] } })).status).toBe(409);
      expect((await call(`/api/block-types/${block.id}`, { method: "DELETE", as: root })).status).toBe(409);
    });

    beforeAll(() => create("seo-posts", [{ name: "title", type: "text" }, { name: "seo_title", type: "seo_title" }], { listRule: 'status = "published"', viewRule: 'status = "published"' }));
    it("registers its field, block and permission, fills values, and serves a sitemap at the root", async () => {
      expect((await call("/api/field-types", { as: root })).text).toContain("seo_title");
      expect(db.query(`SELECT count(*) AS n FROM "BlockType" WHERE name = 'seo_faq'`).rows[0].n).toBe(1);
      expect((await call("/api/roles", { as: root })).text).toContain("ext.seo");
      const live = await call(records("seo-posts"), { method: "POST", as: root, body: { title: "Live <post>", status: "published" } });
      expect(live.json.seo_title).toBe("Live <post>");
      const draft = await call(records("seo-posts"), { method: "POST", as: root, body: { title: "Draft" } });
      const map = await call("/sitemap.xml", { redirect: "manual" });
      expect(map.status, map.text).toBe(200);
      expect(map.headers.get("content-type")).toContain("application/xml");
      expect(map.text).toContain(`/seo-posts/${live.json.id}<`);
      expect(map.text).not.toContain(`/seo-posts/${draft.json.id}<`);
    });
    it("serves its routes under its own name, and only a declared root file at the root", async () => {
      expect((await call("/api/ext/seo/sitemap.xml")).status).toBe(200);
      expect((await call("/api/ext/nope/sitemap.xml")).status).toBe(404);
    });
    describe("a third-party object field in nested blocks", () => {
      let pages: { id: number }, published: number, unpublished: number, version: Record<string, number>;
      const link = (label: string, id: number, file?: string) => ({ label, id, ...(file ? { file } : {}) });
      const page = (top: unknown, card: unknown, second: unknown = card) => ({
        status: "published",
        link: top,
        body: [{ id: "section", type: "seo_section", v: version.seo_section, value: { title: "Links", cards: [
          { id: "first", type: "seo_card", v: version.seo_card, value: { link: card } },
          { id: "second", type: "seo_card", v: version.seo_card, value: { link: second } },
        ] } }],
      });
      const post = (body: unknown, as: Actor = root) => call(records("seo-link-pages"), { method: "POST", as, body });
      const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
      const png = async () => (await (await fetch(`${inject("baseUrl")}/api/files/upload?name=a.png`, { method: "POST", headers: { ...origin, cookie: root.cookie, "content-type": "image/png" }, body: PNG })).json()).id as string;

      beforeAll(async () => {
        await create("seo-targets", [{ name: "title", type: "text" }], { listRule: 'status = "published"', viewRule: 'status = "published"' });
        pages = await create("seo-link-pages", [{ name: "body", type: "stream", config: { searchable: true } }, { name: "link", type: "seo_link", config: { target: "seo-targets", searchable: true } }], { listRule: "", viewRule: "", createRule: '@request.auth.id != ""', updateRule: '@request.auth.id != ""' });
        version = Object.fromEntries((await call("/api/block-types", { as: root })).json.map((block: { name: string; version: number }) => [block.name, block.version]));
        published = (await call(records("seo-targets"), { method: "POST", as: root, body: { title: "Public", status: "published" } })).json.id;
        unpublished = (await call(records("seo-targets"), { method: "POST", as: root, body: { title: "Secret", status: "draft" } })).json.id;
      });

      it("tidies the value, and refuses a link to a record that doesn't exist at any depth", async () => {
        const saved = await post(page(link(" Top ", published), link(" Nested ", published)));
        expect(saved.status, saved.text).toBe(200);
        expect(saved.json.link.label).toBe("Top");
        expect(saved.json.body[0].value.cards[0].value.link.label).toBe("Nested");
        expect((await post(page(link("Top", 999_999), link("Nested", published)))).status).toBe(400);
        expect((await post(page(link("Top", published), link("Nested", 999_999)))).status).toBe(400);
        expect((await post(page({ label: "Top", id: published, extra: 1 }, link("Nested", published)))).status).toBe(400);
      });

      it("indexes the links, so a linked record can't be deleted", async () => {
        const target = (await call(records("seo-targets"), { method: "POST", as: root, body: { title: "Linked", status: "published" } })).json.id;
        const saved = await post(page(link("Top", target), link("Nested", published)));
        expect((await call(records("seo-targets", `/${target}`), { method: "DELETE", as: root })).status).toBe(409);
        expect((await call(records("seo-link-pages", `/${saved.json.id}`), { method: "PATCH", as: root, body: { link: null } })).status).toBe(200);
        expect((await call(records("seo-targets", `/${target}`), { method: "DELETE", as: root })).status).toBe(204);
      });

      it("expands only what the caller may view", async () => {
        const saved = await post(page(link("Top", unpublished), link("One", published), link("Two", unpublished)));
        const seen = (await call(records("seo-link-pages", `/${saved.json.id}?expand=body,link`))).json;
        expect(seen.expand.link).toBeUndefined();
        expect(seen.expand.body.first.link.map((record: { title: string }) => record.title)).toEqual(["Public"]);
        expect(seen.expand.body.second).toBeUndefined();
        const staff = (await call(records("seo-link-pages", `/${saved.json.id}?expand=link`), { as: root })).json;
        expect(staff.expand.link[0].title).toBe("Secret");
        expect((await call(records("seo-link-pages", `/${saved.json.id}?expand=link.title`))).status).toBe(400);
      });

      it("opens a file only through a record that links it, and only for someone entitled to attach it", async () => {
        const file = await png();
        expect((await call(`/api/files/${file}`)).status).toBe(404);
        const refused = await post(page(link("Top", published, file), link("Nested", published)), member);
        expect(refused.status).toBe(400);
        expect(refused.json.error.details[0].message).toBe("This file does not exist.");
        const saved = await post(page(link("Top", published), link("Nested", published, file)));
        expect(saved.status, saved.text).toBe(200);
        expect((await call(`/api/files/${file}`)).status).not.toBe(404);
        expect((await call(records("seo-link-pages", `/${saved.json.id}`), { method: "PATCH", as: root, body: { body: [] } })).status).toBe(200);
        expect((await call(`/api/files/${file}`)).status).toBe(404);
      });

      it("is found by search, limited in filters and summarized for the grid", async () => {
        const saved = await post(page(link("Zebrafish", published), link("Okapi", published)));
        for (const word of ["Zebrafish", "Okapi"]) expect((await call(records("seo-link-pages", `?search=${word}`))).json.items.map((item: { id: number }) => item.id)).toContain(saved.json.id);
        expect((await call(records("seo-link-pages", `?filter=${encodeURIComponent('link = "x"')}`))).status).toBe(400);
        const listed = (await call(records("seo-link-pages", `/${saved.json.id}?summaries=1`))).json;
        expect(listed.summaries.link).toBe(`Zebrafish → #${published}`);
        expect((await call(records("seo-link-pages", `/${saved.json.id}`))).json.summaries).toBeUndefined();
      });

      it("shows in revision diffs and generated types", async () => {
        const saved = await post(page(link("Before", published), link("Nested", published)));
        await call(records("seo-link-pages", `/${saved.json.id}`), { method: "PATCH", as: root, body: { link: link("After", published) } });
        const content = `/api/collections/${pages.id}/content/${saved.json.id}/revisions`;
        const [latest] = (await call(content, { as: root })).json.items ?? (await call(content, { as: root })).json;
        const diff = await call(`${content}/${latest.id}/diff?against=previous`, { as: root });
        expect(diff.status, diff.text).toBe(200);
        expect(diff.json.changes[0]).toMatchObject({ name: "link", beforeSummary: `Before → #${published}`, afterSummary: `After → #${published}` });
        const types = (await call("/api/schema/types", { as: root })).text;
        expect(types).toContain("export interface BlockSeoCard");
        expect(types).toContain('"cards"?: Array<BlockSeoCard>');
        expect(types).toContain('"label": string');
      });
    });
    describe("field presets and saved layouts", () => {
      it("keeps presets valid, and behind the collection permissions", async () => {
        const body = { name: "Price", type: "number", config: { min: 0 } };
        const made = await call("/api/field-presets", { method: "POST", as: root, body });
        expect(made.status, made.text).toBe(200);
        expect(made.json.config.min).toBe(0);
        expect((await call("/api/field-presets", { method: "POST", as: root, body })).status).toBe(409);
        expect((await call("/api/field-presets", { method: "POST", as: root, body: { name: "Bad", type: "no_such_type" } })).status).toBe(400);
        expect((await call("/api/field-presets", { method: "POST", as: root, body: { name: "Bad", type: "number", config: { min: "x" } } })).status).toBe(400);
        expect((await call("/api/field-presets", { method: "POST", as: member, body: { name: "Mine", type: "text" } })).status).toBe(403);
        expect((await call("/api/field-presets", { as: root })).json.map((preset: { name: string }) => preset.name)).toContain("Price");
        expect((await call("/api/field-presets")).status).toBe(401);
        const changed = await call(`/api/field-presets/${made.json.id}`, { method: "PUT", as: root, body: { name: "Cost", config: { min: 1 } } });
        expect(changed.json).toMatchObject({ name: "Cost", type: "number", config: { min: 1 } });
        expect((await call(`/api/field-presets/${made.json.id}`, { method: "DELETE", as: member })).status).toBe(403);
        expect((await call("/dashboard/field-presets", { as: root })).status).toBe(200);
        expect((await call("/dashboard/field-presets", { as: member })).status).toBe(307);
        expect((await call(`/api/field-presets/${made.json.id}`, { method: "DELETE", as: root })).status).toBe(204);
        expect((await call(`/api/field-presets/${made.json.id}`, { method: "DELETE", as: root })).status).toBe(404);
      });

      it("validates a layout, and keeps it behind the collection permissions", async () => {
        const version = (await call("/api/block-types", { as: root })).json.find((block: { name: string }) => block.name === "seo_faq").version;
        const faq = (value: Record<string, unknown>) => ({ id: "a", type: "seo_faq", v: version, value });
        const good = { name: "FAQ starter", blocks: [faq({ question: "Why?", answer: "Because." })] };
        const made = await call("/api/block-layouts", { method: "POST", as: root, body: good });
        expect(made.status, made.text).toBe(200);
        expect((await call("/api/block-layouts", { method: "POST", as: root, body: good })).status).toBe(409);
        expect((await call("/api/block-layouts", { method: "POST", as: root, body: { name: "Bad", blocks: [faq({ question: "Why?" })] } })).status).toBe(400);
        expect((await call("/api/block-layouts", { method: "POST", as: root, body: { name: "Bad", blocks: [{ id: "a", type: "no_such_block", v: 1, value: {} }] } })).status).toBe(400);
        expect((await call("/api/block-layouts", { method: "POST", as: member, body: { ...good, name: "Mine" } })).status).toBe(403);
        expect((await call("/api/block-layouts")).status).toBe(401);
        expect((await call(`/api/block-layouts/${made.json.id}`, { method: "DELETE", as: member })).status).toBe(403);
        expect((await call(`/api/block-layouts/${made.json.id}`, { method: "DELETE", as: root })).status).toBe(204);
      });
    });
    it("records the version it was installed at", () => {
      expect(db.query(`SELECT version FROM "PluginState" WHERE name = 'seo'`).rows[0].version).toBe(installedVersion("@tansy/seo"));
    });
    it("adds an admin page and widget behind its permission", async () => {
      const page = await call("/dashboard/ext/seo", { as: root });
      expect(page.status).toBe(200);
      expect(page.text).toContain("without an SEO title");
      expect((await call("/dashboard/ext/seo", { as: member })).status).toBe(307);
      expect((await call("/dashboard", { as: root })).text).toContain("records without an SEO title");
      for (const path of ["/dashboard/webhooks", "/dashboard/schema", "/dashboard/extensions"]) {
        expect((await call(path, { as: root })).status, path).toBe(200);
        expect((await call(path, { as: member })).status, path).toBe(307);
      }
    });
  });

  describe("webhooks", () => {
    let server: http.Server;
    const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
    let respond = 200;
    let url = "";
    beforeAll(async () => {
      server = http.createServer((req, res) => { let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => { received.push({ headers: req.headers, body }); res.statusCode = respond; res.end(); }); });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/hook`;
      await create("hook-target", [{ name: "title", type: "text" }, { name: "secret", type: "text", config: { hidden: true } }]);
    });
    afterAll(() => new Promise((resolve) => server.close(resolve)));

    it("need webhook:manage and a fresh session, and hide the secret afterwards", async () => {
      const body = { name: "t", url, events: ["create", "delete"], collections: ["hook-target"] };
      expect((await call("/api/webhooks", { method: "POST", as: member, body })).status).toBe(403);
      const made = await call("/api/webhooks", { method: "POST", as: root, body });
      expect(made.status, made.text).toBe(200);
      expect(made.json.secret.length).toBeGreaterThan(30);
      const list = await call("/api/webhooks", { as: root });
      expect(list.text).not.toContain(made.json.secret);
      expect(db.query(`SELECT secret FROM "Webhook" WHERE id = ?`, [made.json.id]).rows[0].secret).toMatch(/^enc:v1:/);

      const record = await call(records("hook-target"), { method: "POST", as: root, body: { title: "sent" } });
      const delivery = await until(() => received.at(-1), (r) => Boolean(r), "delivery");
      const signature = /^t=(\d+),v1=([0-9a-f]+)$/.exec(String(delivery!.headers["x-cms-signature"]))!;
      expect(createHmac("sha256", made.json.secret).update(`${signature[1]}.${delivery!.body}`).digest("hex")).toBe(signature[2]);
      const payload = JSON.parse(delivery!.body);
      expect(payload.event).toBe("record.create");
      expect(payload.record.id).toBe(record.json.id);

      const count = received.length;
      await call(records("hook-target", `/${record.json.id}`), { method: "PATCH", as: root, body: { title: "unsubscribed event" } });
      await new Promise((r) => setTimeout(r, 600));
      expect(received.length).toBe(count);

      respond = 500;
      const failing = await call(records("hook-target"), { method: "POST", as: root, body: { title: "will retry" } });
      expect(failing.status).toBe(200);
      const pending = await until(() => db.query(`SELECT status, attempts, "responseStatus" FROM "WebhookDelivery" WHERE payload LIKE '%will retry%'`).rows[0], (row) => row?.attempts === 1, "failed attempt");
      expect(pending).toMatchObject({ status: "pending", responseStatus: 500 });
      respond = 200;
      expect((await call(`/api/webhooks/${made.json.id}/deliveries`, { as: root })).text).not.toContain("will retry");
      expect((await call(`/api/webhooks/${made.json.id}`, { method: "DELETE", as: root })).status).toBe(204);
    });

    it("stop when the owner loses access, and don't send what the owner can't read", async () => {
      const made = await call("/api/webhooks", { method: "POST", as: root, body: { name: "owned", url, events: ["create"], collections: ["hook-target"] } });
      db.query(`UPDATE "Webhook" SET "createdById" = ? WHERE id = ?`, [member.id, made.json.id]);
      const count = received.length;
      await call(records("hook-target"), { method: "POST", as: root, body: { title: "not for you" } });
      await new Promise((r) => setTimeout(r, 800));
      expect(received.length).toBe(count);
      expect((await call(`/api/webhooks/${made.json.id}`, { method: "DELETE", as: root })).status).toBe(204);
    });
  });

  describe("generated clients and agents", () => {
    let key: string;
    beforeAll(async () => {
      await create("typed-posts", [{ name: "title", type: "text", config: { required: true } }, { name: "hiddenNote", type: "text", config: { hidden: true } }], { listRule: "", viewRule: "" });
      root = await signIn(root.email);
      const created = await call("/api/account/api-keys", { method: "POST", as: root, body: { name: "gen", permissions: ["collection:read"], expiresInDays: 1 } });
      expect(created.status, created.text).toBe(200);
      key = created.json.key;
    });
    it("types and OpenAPI follow the schema and leave out hidden fields", async () => {
      const types = await call("/api/schema/types", { headers: { "x-api-key": key } });
      expect(types.status, types.text).toBe(200);
      expect(types.text).toContain("export interface TypedPosts extends CmsRecord");
      expect(types.text).toContain("title: string;");
      expect(types.text).not.toContain("hiddenNote");
      expect((await call("/api/schema/types", { as: root })).text).toContain("hiddenNote");
      const spec = await call("/api/schema/openapi", { headers: { "x-api-key": key } });
      expect(spec.json.openapi).toBe("3.1.0");
      expect(spec.json.paths["/api/collections/typed-posts/records"].post).toBeDefined();
      expect(JSON.stringify(spec.json)).not.toContain("hiddenNote");
      expect((await call("/api/schema/types")).status).toBe(401);
    });
    it("MCP tools follow the same rules as the API", async () => {
      const rpc = (method: string, params?: unknown, id: number | undefined = 1) => call("/api/mcp", { method: "POST", headers: { "x-api-key": key }, body: { jsonrpc: "2.0", id, method, params } });
      expect((await call("/api/mcp", { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "ping" } })).status).toBe(401);
      expect((await rpc("initialize", { protocolVersion: "2025-06-18" })).json.result.protocolVersion).toBe("2025-06-18");
      expect((await call("/api/mcp", { method: "POST", headers: { "x-api-key": key }, body: { jsonrpc: "2.0", method: "notifications/initialized" } })).status).toBe(202);
      expect((await rpc("tools/list")).json.result.tools.map((t: { name: string }) => t.name)).toContain("list_records");
      expect((await rpc("nope")).json.error.code).toBe(-32601);
      const tool = async (name: string, args: unknown) => (await rpc("tools/call", { name, arguments: args })).json.result;
      const write = await tool("create_record", { collection: "typed-posts", data: { title: "by agent" } });
      expect(write.isError).toBe(true);
      expect(JSON.parse(write.content[0].text).code).toBe("RULE_LOCKED");
      await call(records("typed-posts"), { method: "POST", as: root, body: { title: "visible", hiddenNote: "shh", status: "published" } });
      const listed = await tool("list_records", { collection: "typed-posts" });
      expect(listed.content[0].text).toContain("visible");
      expect(listed.content[0].text).not.toContain("shh");
      expect(db.query(`SELECT count(*) AS n FROM "AuditLog" WHERE action = 'mcp.call'`).rows[0].n).toBeGreaterThan(0);
    });
  });

  describe("schema export and import", () => {
    it("needs every permission the import uses, and previews without changing anything", async () => {
      root = await signIn(root.email);
      const document = { version: 1, collections: [{ slug: "imp-a", name: "A", rules: { listRule: "", viewRule: null, createRule: null, updateRule: null, deleteRule: null }, fields: [{ name: "title", type: "text" }] }], blocks: [] };
      const preview = await call("/api/schema/import", { method: "POST", as: root, body: { document, dryRun: true } });
      expect(preview.status, preview.text).toBe(200);
      expect(preview.json.steps.map((s: { action: string }) => s.action)).toEqual(["create collection", "update rules"]);
      expect(db.query(`SELECT count(*) AS n FROM "Collection" WHERE slug = 'imp-a'`).rows[0].n).toBe(0);
      const applied = await call("/api/schema/import", { method: "POST", as: root, body: { document } });
      expect(applied.status, applied.text).toBe(200);
      expect((await call("/api/schema/import", { method: "POST", as: root, body: { document } })).json.steps).toEqual([]);
      expect((await call("/api/schema/import", { method: "POST", as: member, body: { document } })).status).toBe(403);
    });

    it("replays on a clean database at startup", async () => {
      root = await signIn(root.email);
      const a = await create("rpauthors", [{ name: "name", type: "text", config: { required: true } }]);
      await create("rpposts", [{ name: "title", type: "text" }, { name: "author", type: "reference", config: { collection: a.id } }, { name: "body", type: "stream", config: { allowedBlocks: ["rp_note"] } }], { listRule: 'status = "published"', viewRule: "@collection.rpauthors.name ?= \"x\"" });
      expect((await call("/api/block-types", { method: "POST", as: root, body: { name: "rp_note", label: "Note", fields: [{ name: "text", type: "text" }, { name: "link", type: "reference", config: { collection: a.id } }] } })).status).toBe(200);
      const view = await call("/api/collections/views", { method: "POST", as: root, body: { name: "Names", slug: "rpnames", query: "SELECT id, name FROM rec_rpauthors" } });
      expect(view.status, view.text).toBe(200);

      const exported = await call("/api/schema/export", { as: root });
      expect(exported.status, exported.text).toBe(200);
      const posts = exported.json.collections.find((c: { slug: string }) => c.slug === "rpposts");
      expect(posts.fields.find((f: { name: string }) => f.name === "author").config.collection).toBe("rpauthors");
      // The other tests' collections reference field types and blocks this copy doesn't need.
      const keep = exported.json.collections.filter((c: { slug: string }) => c.slug.startsWith("rp"));
      const document = { ...exported.json, collections: keep, blocks: exported.json.blocks.filter((b: { name: string }) => b.name === "rp_note"), userFields: [] };

      // Only the schema file is replayed, so plugins that create collections stay off.
      const dir = mkdtempSync(path.join(tmpdir(), "cms-test-replay-"));
      const file = path.join(dir, "replay_test.db");
      const schemaFile = path.join(dir, "schema.json");
      writeFileSync(schemaFile, JSON.stringify(document));
      // Every switch the starter config reads starts off, so neither apps/starter/.env nor this
      // suite's own server decides what the replay sees: the schema file alone does.
      const env = { ...process.env, ...blankStarterEnv(), DATABASE_URL: `file:${file}`, BETTER_AUTH_SECRET: "integration-secret-integration-secret", BETTER_AUTH_URL: "http://localhost:3461", TANSY_SCHEMA_FILE: schemaFile, ALLOW_LOCAL_STORAGE_IN_PRODUCTION: "true", UPLOADS_DIR: dir, S3_BUCKET: "" };
      execFileSync(process.execPath, [CLI, "migrate"], { cwd: APP_DIR, env, stdio: "pipe" });
      const server = spawn("npx", ["next", "start", "-p", "3461"], { env, cwd: APP_DIR, stdio: "ignore", detached: true });
      try {
        await until(() => fetch("http://localhost:3461/api/auth-config").then((r) => r.ok).catch(() => false), Boolean, "second server");
        const copy = new TestDb(file);
        // Only this document's own collections: a plugin that makes its own stays out of the way of what's asserted.
        const slugs = copy.query(`SELECT slug, type, "listRule" FROM "Collection" WHERE slug LIKE 'rp%' ORDER BY id`).rows;
        expect(slugs.map((c) => c.slug)).toEqual(["rpauthors", "rpposts", "rpnames"]);
        expect(slugs[1].listRule).toBe('status = "published"');
        expect(slugs[2].type).toBe("view");
        const authors = copy.query(`SELECT id FROM "Collection" WHERE slug = 'rpauthors'`).rows[0].id;
        const link = copy.query(`SELECT f.config FROM "Field" f JOIN "Collection" c ON c.id = f."collectionId" WHERE c.slug = 'rpposts' AND f.name = 'author'`).rows[0];
        expect(JSON.parse(link.config).collection).toBe(authors);
        expect(copy.query("SELECT name FROM sqlite_master WHERE name = 'rec_rpposts'").rowCount).toBe(1);
        expect(JSON.stringify(copy.query(`SELECT fields FROM "BlockType" WHERE name = 'rp_note'`).rows[0])).toContain(`\\"collection\\":${authors}`);
        copy.end();
      } finally {
        try { process.kill(-server.pid!, "SIGTERM"); } catch { /* already gone */ }
        await new Promise((r) => setTimeout(r, 300));
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  });
});

/** SQLite runs one writer at a time, and Postgres doesn't, so these hold only if the locks are right. */
describe("concurrent writes", () => {
  interface Made { id: number; slug: string; fields: Array<{ id: number; name: string }> }
  const make = async (slug: string, fields: unknown[]): Promise<Made> => {
    const r = await call("/api/collections", { method: "POST", as: root, body: { name: slug, slug, fields } });
    expect(r.status, r.text).toBe(200);
    return r.json;
  };
  const values = (collection: Made, data: Record<string, unknown>) => Object.entries(data).map(([name, value]) => ({ fieldId: collection.fields.find((f) => f.name === name)!.id, value }));
  const add = (collection: Made, data: Record<string, unknown>, status = "published") => call(`/api/collections/${collection.id}/content`, { method: "POST", as: root, body: { status, values: values(collection, data) } });

  it("let one claim of a unique value win", async () => {
    const seats = await make("race-seats", [{ name: "code", type: "text", config: { unique: true } }]);
    const results = await Promise.all(Array.from({ length: 12 }, () => add(seats, { code: "A1" })));
    expect(results.map((r) => r.status).sort()).toEqual([200, ...Array(11).fill(400)]);
  });

  it("keep one draft however many saves arrive together", async () => {
    const pages = await make("race-pages", [{ name: "title", type: "text" }]);
    const { json: { id } } = await add(pages, { title: "live" });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => call(`/api/collections/${pages.id}/content/${id}/draft`, { method: "PUT", as: root, body: { values: values(pages, { title: `draft ${i}` }) } })));
    expect(results.every((r) => r.status < 300), results.map((r) => r.status).join()).toBe(true);
    expect(db.query(`SELECT 1 FROM "Revision" WHERE "collectionId" = ? AND "recordId" = ? AND kind = 'draft'`, [pages.id, id]).rowCount).toBe(1);
  });

  it("never leave a link to a record deleted at the same moment", async () => {
    const owners = await make("race-owners", [{ name: "name", type: "text" }]);
    const pets = await make("race-pets", [{ name: "name", type: "text" }, { name: "owner", type: "reference", config: { collection: owners.id } }]);
    for (let round = 0; round < 5; round++) {
      const { json: { id } } = await add(owners, { name: `owner ${round}` });
      const results = await Promise.all([
        ...Array.from({ length: 6 }, (_, i) => add(pets, { name: `pet ${round}.${i}`, owner: id })),
        call(`/api/collections/${owners.id}/content/${id}`, { method: "DELETE", as: root }),
      ]);
      expect(results.every((r) => r.status < 500), results.map((r) => r.status).join()).toBe(true);
    }
    const dangling = db.query(`SELECT 1 FROM rec_race_pets WHERE owner IS NOT NULL AND owner NOT IN (SELECT id FROM rec_race_owners)`);
    expect(dangling.rowCount).toBe(0);
  });

  it("apply schema changes one at a time", async () => {
    const notes = await make("race-notes", [{ name: "title", type: "text" }]);
    const base = notes.fields.map((field) => ({ id: field.id, name: field.name, type: "text" }));
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => call(`/api/collections/${notes.id}/fields`, { method: "PUT", as: root, body: { fields: [...base, { name: `extra_${i}`, type: "text" }], confirm: true } })));
    expect(results.every((r) => r.status === 200), results.map((r) => `${r.status} ${r.text.slice(0, 120)}`).join("\n")).toBe(true);
    // Each request replaces the field list, so the last one to run decides what's left: one extra column, matching the catalogue.
    const stored = db.query(`SELECT name FROM "Field" WHERE "collectionId" = ? ORDER BY name`, [notes.id]).rows.map((row) => row.name);
    expect(stored).toHaveLength(2);
    expect(stored).toContain("title");
    const added = stored.find((name: string) => name !== "title");
    expect(db.query(`SELECT ${added} FROM rec_race_notes LIMIT 1`).rowCount).toBe(0);
  });
});

describe("operations", () => {
  const cli = (args: string[], password: string) => execFileSync(process.execPath, [CLI, ...args], { env: { ...process.env, DATABASE_URL: inject("databaseUrl"), TANSY_ADMIN_PASSWORD: password }, encoding: "utf8", stdio: "pipe" });

  it("limit reads per caller, however the path varies, and leave staff alone", async () => {
    await configure((s) => { s.rateLimit.apiReadWindow = 1; s.rateLimit.apiReadMax = 3; });
    const anonymous = await Promise.all(Array.from({ length: 8 }, (_, i) => call(`/api/collections/no-such-${i}/records`)));
    expect(anonymous.filter((r) => r.status === 429).length).toBeGreaterThan(0);
    const staff = await Promise.all(Array.from({ length: 8 }, () => call("/api/roles", { as: root })));
    expect(staff.every((r) => r.status === 200)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await configure((s) => { s.rateLimit.apiReadWindow = 60; s.rateLimit.apiReadMax = 1200; });
  });

  it("log requests through the request-logs plugin, without their query strings, for those allowed to read them", async () => {
    await call("/api/auth-config?token=do-not-store-this");
    let items: Array<{ path: string; method: string; status: number }> = [];
    for (let i = 0; i < 40 && !items.length; i++) {
      items = (await call("/api/ext/request-logs/entries?path=auth-config", { as: root })).json.items;
      if (!items.length) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(items[0]).toMatchObject({ path: "/api/auth-config", method: "GET", status: 200 });
    expect(JSON.stringify(db.query(`SELECT value FROM "PluginData" WHERE plugin = 'request-logs'`).rows)).not.toContain("do-not-store-this");
    expect((await call("/api/ext/request-logs/entries")).status).toBe(401);
    expect((await call("/api/ext/request-logs/entries", { as: member })).status).toBe(403);
  });

  it("recover a superadmin from the command line, and audit it", async () => {
    expect(() => cli(["superadmin", "recovered@example.test"], "short")).toThrow();
    cli(["superadmin", "Recovered@Example.test"], PASSWORD);
    const recovered = await signIn("recovered@example.test");
    expect((await call("/api/roles", { as: recovered })).status).toBe(200);
    expect(db.query(`SELECT 1 FROM "AuditLog" WHERE action = 'auth.cli_recovery'`).rowCount).toBe(1);
    expect(JSON.stringify(db.query(`SELECT * FROM "AuditLog" WHERE action = 'auth.cli_recovery'`).rows)).not.toContain(PASSWORD);

    db.query(`UPDATE "user" SET banned = ?, role = 'user' WHERE email = ?`, [POSTGRES ? true : 1, "recovered@example.test"]);
    cli(["superadmin", "recovered@example.test"], `${PASSWORD}-2`);
    expect((await call("/api/roles", { as: recovered })).status).toBe(401);
    expect((await call("/api/roles", { as: await signIn("recovered@example.test", `${PASSWORD}-2`) })).status).toBe(200);
  });
});

// Redirects the starter keeps for old bookmarks. A fresh install never had those addresses.
describe.skipIf(IS_HOST_INSTALL)("moved addresses", () => {
  it("send old sign-in links to the new place, keeping the query", async () => {
    const r = await fetch(`${inject("baseUrl")}/reset-password?token=abc`, { redirect: "manual" });
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toContain("/dashboard/auth/reset-password?token=abc");
  });

  it("serve the sign-in pages without a session, and refuse unknown ones", async () => {
    expect((await call("/dashboard/auth/signin")).status).toBe(200);
    expect((await call("/dashboard/auth/nope")).status).toBe(404);
  });

  it("keep the account page behind a session", async () => {
    const r = await fetch(`${inject("baseUrl")}/dashboard/account`, { redirect: "manual" });
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toContain("/dashboard/auth/signin?next=");
  });
});

describe("branding", () => {
  it("applies a logo and accent colour everywhere, accepting only safe values", async () => {
    await configure((s) => { s.general.logoUrl = "/logo.svg"; s.general.accentColor = "#123456"; });
    expect((await call("/api/auth-config")).json.logoUrl).toBe("/logo.svg");
    expect((await call("/dashboard/auth/signin")).text).toContain("--cms-color-accent:#123456");
    const save = async (general: object) => call("/api/settings/auth", { method: "PUT", as: root, body: { ...(await settings()), general: { appName: "x", ...general } } });
    for (const bad of [{ logoUrl: "//evil.example/x.png" }, { logoUrl: "https://evil.example/x.png" }, { logoUrl: "javascript:alert(1)" }, { accentColor: "red;}body{display:none" }, { accentColor: "url(x)" }]) expect((await save(bad)).status, JSON.stringify(bad)).toBe(400);
    await configure((s) => { s.general.logoUrl = ""; s.general.accentColor = ""; });
    expect((await call("/dashboard/auth/signin")).text).not.toContain("--cms-color-accent");
  });
});

describe("full-text search", () => {
  let id: number;
  const find = async (term: string, as: Actor | null = null) => {
    const r = await call(`/api/collections/docs/records?search=${encodeURIComponent(term)}`, { as });
    expect(r.status, r.text).toBe(200);
    return r.json.items.map((item: { id: number }) => item.id).sort((a: number, b: number) => a - b) as number[];
  };
  const add = async (values: object, status = "published") => {
    const r = await call("/api/collections/docs/records", { method: "POST", as: root, body: { ...values, status } });
    expect(r.status, r.text).toBe(200);
    return r.json.id as number;
  };
  beforeAll(async () => {
    expect((await call("/api/block-types", { method: "POST", as: root, body: { name: "searchnote", label: "Note", fields: [{ name: "words", type: "text" }] } })).status).toBe(200);
    const made = await call("/api/collections", { method: "POST", as: root, body: { name: "Docs", slug: "docs", fields: [
      { name: "title", type: "text", config: { searchable: true } }, { name: "secret", type: "text", config: { searchable: true, hidden: true } },
      { name: "plain", type: "text" }, { name: "body", type: "stream", config: { searchable: true } },
    ] } });
    expect(made.status, made.text).toBe(200);
    id = made.json.id;
    const rule = 'status = "published"';
    expect((await call(`/api/collections/${id}/rules`, { method: "PUT", as: root, body: { listRule: rule, viewRule: rule, createRule: null, updateRule: null, deleteRule: null } })).status).toBe(200);
  });
  it("finds words in fields and blocks, with the last word as a prefix", async () => {
    const one = await add({ title: "alphaword betaword", body: [{ id: crypto.randomUUID(), type: "searchnote", v: 1, value: { words: "insideblock" } }] });
    expect(await find("alphaword")).toEqual([one]);
    expect(await find("alphaword beta")).toEqual([one]);
    expect(await find("insideblock")).toEqual([one]);
    expect(await find("nothinglikethis")).toEqual([]);
  });
  it("returns only what the list rule allows", async () => {
    const hidden = await add({ title: "draftonlyword" }, "draft");
    expect(await find("draftonlyword")).toEqual([]);
    expect(await find("draftonlyword", root)).toEqual([hidden]);
  });
  it("never matches hidden or non-searchable fields", async () => {
    await add({ title: "t", secret: "classifiedword", plain: "unindexedword" });
    expect(await find("classifiedword", root)).toEqual([]);
    expect(await find("unindexedword", root)).toEqual([]);
  });
  it("follows updates and deletes", async () => {
    const record = await add({ title: "beforeword" });
    expect((await call(`/api/collections/docs/records/${record}`, { method: "PATCH", as: root, body: { title: "afterword" } })).status).toBe(200);
    expect(await find("beforeword")).toEqual([]);
    expect(await find("afterword")).toEqual([record]);
    expect((await call(`/api/collections/docs/records/${record}`, { method: "DELETE", as: root })).status).toBe(204);
    expect(await find("afterword")).toEqual([]);
  });
  it("treats query syntax as plain words", async () => {
    for (const term of ['" OR 1=1 --', "a) | b:* & !c", "NEAR(x y)", "title:x*", "'; DROP TABLE cms_search; --", "***", "\\"]) await find(term);
    expect((await call("/api/collections/docs/records")).status).toBe(200);
  });
  it("reindexes when a field becomes searchable", async () => {
    const record = await add({ plain: "laterindexedword" });
    const current = (await call(`/api/collections/${id}`, { as: root })).json.fields;
    const fields = current.map((f: { id: number; name: string; type: string; config: object }) => ({ id: f.id, name: f.name, type: f.type, config: f.name === "plain" ? { ...f.config, searchable: true } : f.config }));
    const saved = await call(`/api/collections/${id}/fields`, { method: "PUT", as: root, body: { fields } });
    expect(saved.status, saved.text).toBe(200);
    for (let i = 0; i < 40 && !(await find("laterindexedword")).length; i++) await new Promise((r) => setTimeout(r, 100));
    expect(await find("laterindexedword")).toEqual([record]);
  });
});

describe("plugin extension points", () => {
  const FROM = (ip: string) => ({ "x-forwarded-for": ip });
  const signInFrom = async (email: string, ip: string) => expect((await call("/api/auth/sign-in/email", { method: "POST", headers: FROM(ip), body: { email, password: PASSWORD } })).status).toBe(200);
  const mentions = async (to: string, text: RegExp) => (await mailbox()).map(decodeMail).some((m) => m.includes(to) && text.test(m));

  it("offer only the OAuth providers a plugin registered", async () => {
    const listed = (await call("/api/settings/auth", { as: root })).json.oauthProviders.map((p: { id: string }) => p.id);
    expect(listed).toEqual(expect.arrayContaining(["github", "google"]));
    await configure((s) => { s.oauth.providers.notinstalled = { enabled: true, clientId: "a", clientSecret: "b" }; });
    expect((await call("/api/auth-config")).json.oauth).not.toContain("notinstalled");
    await configure((s) => { delete s.oauth.providers.notinstalled; });
  });
  it("ask for the CAPTCHA on the sign-in forms its settings name, with only the public key reaching the browser", async () => {
    const captchaSettings = async (changes: Record<string, unknown>) => {
      const current = await call("/api/extensions/captcha/settings", { as: root });
      expect((await call("/api/extensions/captcha/settings", { method: "PUT", as: root, body: { values: { ...current.json.values, ...changes } } })).status).toBe(200);
    };
    const reset = (headers: Record<string, string> = {}) => call("/api/auth/request-password-reset", { method: "POST", headers, body: { email: "nobody-captcha@example.test", redirectTo: "/dashboard/auth/reset-password" } });
    // Off for every form at first, so the rest of the suite signs in without one.
    expect((await call("/api/auth-config")).json.captcha).toBeNull();
    expect((await reset()).status).toBe(200);
    await captchaSettings({ passwordReset: true });
    try {
      const config = await call("/api/auth-config");
      expect(config.json.captcha).toEqual({ forms: ["forgot-password"], widget: { provider: "turnstile", script: expect.stringMatching(/^https:\/\/challenges\.cloudflare\.com\//), global: "turnstile", siteKey: "public-site-key", options: {} } });
      expect(config.text).not.toContain("captcha-secret-value");
      expect((await reset()).json.code).toBe("CAPTCHA_REQUIRED");
      const wrong = await reset({ "x-captcha-response": "wrong" });
      expect([wrong.status, wrong.json.code]).toEqual([403, "CAPTCHA_FAILED"]);
      expect((await reset({ "x-captcha-response": "good-token" })).status).toBe(200);
      // Sign-in isn't named, so it goes without.
      expect((await call("/api/auth/sign-in/email", { method: "POST", body: { email: "nobody-captcha@example.test", password: PASSWORD } })).json.code).not.toMatch(/CAPTCHA/);
    } finally {
      await captchaSettings({ passwordReset: false });
    }
  });
  it("let a plugin refuse a password on every path that sets one", async () => {
    const email = await makeUser("pwcheck", "user");
    const actor = await signIn(email);
    const refused = await call("/api/auth/change-password", { method: "POST", as: actor, body: { currentPassword: PASSWORD, newPassword: "a-long-forbiddenword-passphrase-22" } });
    expect(refused.status).toBe(400);
    expect(refused.json.code).toBe("PASSWORD_REJECTED");
    const created = await call("/api/users", { method: "POST", as: root, body: { name: "x", email: "pwcheck2@example.test", password: "a-long-forbiddenword-passphrase-22", role: "user" } });
    expect(created.status).toBe(400);
  });
  it("let a plugin email someone about a sign-in from a new network, and only then", async () => {
    const email = await makeUser("alerted", "user");
    await signInFrom(email, "10.1.1.1");
    await signInFrom(email, "10.1.1.9");
    await new Promise((r) => setTimeout(r, 500));
    expect(await mentions(email, /New sign-in/)).toBe(false);
    await signInFrom(email, "20.2.2.2");
    expect(await latestLink(email, /sign in from 20\.2\.2\.2/)).toBeTruthy();
  });
  it("let a plugin change an email's wording, never its link", async () => {
    const made = await call("/api/collections", { method: "POST", as: root, body: { name: "Email templates", slug: "email-templates", fields: [{ name: "kind", type: "text" }, { name: "subject", type: "text" }, { name: "body", type: "text" }] } });
    expect(made.status, made.text).toBe(200);
    expect((await call("/api/collections/email-templates/records", { method: "POST", as: root, body: { kind: "reset-password", subject: "Custom reset", body: "Custom wording for {{appName}}.", status: "published" } })).status).toBe(200);
    const email = await makeUser("templated", "user");
    await call("/api/auth/request-password-reset", { method: "POST", body: { email, redirectTo: "/dashboard/auth/reset-password" } });
    expect(await latestLink(email, /Custom wording for [^.]+\./)).toContain("Custom wording");
    expect(await latestLink(email, new RegExp(`${base}/api/auth/reset-password/[\\w-]+`))).toContain("/reset-password/");
  });
  it("let a plugin refuse a request, without it being able to grant one", async () => {
    expect((await call("/api/users", { as: root, headers: FROM("10.0.0.1") })).status).toBe(200);
    const blocked = await call("/api/users", { as: root, headers: FROM("198.51.100.7") });
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.code).toBe("REQUEST_REFUSED");
    const page = await call("/dashboard", { as: root, headers: FROM("198.51.100.7"), redirect: "manual" });
    expect(page.headers.get("location") ?? page.text).toContain("denied=1");
    const email = await makeUser("outsider", "user");
    const actor = await signIn(email);
    expect((await call("/api/me", { as: actor, headers: FROM("198.51.100.7") })).status).toBe(200);
    expect((await call("/api/users", { as: actor, headers: FROM("10.0.0.1") })).status).toBe(403);
  });
});

describe("audit log", () => {
  it("records sign-ins, denials and admin actions without secrets", async () => {
    const r = await call("/api/audit?perPage=100", { as: root });
    const actions = new Set(r.json.items.map((i: { action: string }) => i.action));
    const all = await db.query(`SELECT action, metadata FROM "AuditLog"`);
    const names = new Set(all.rows.map((row) => row.action));
    for (const action of ["auth.sign_in", "authz.denied", "user.create", "user.ban", "settings.update", "user.impersonate", "role.create", "auth.mfa_verified", "auth.single_factor_blocked", "auth.sign_in_locked"]) {
      expect(names, action).toContain(action);
    }
    expect(actions.size).toBeGreaterThan(1);
    const dump = JSON.stringify(all.rows);
    for (const secret of [PASSWORD, "plaintext-oauth-secret"]) expect(dump).not.toContain(secret);
  });

  it("folds repeated denials from one caller at one address into one entry", async () => {
    const path = "/api/users/fold-check";
    for (let i = 0; i < 5; i++) expect((await call(path, { as: member })).status).toBe(403);
    // The audit write runs as the response goes out, so give the last one a moment.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const denied = await db.query(`SELECT metadata FROM "AuditLog" WHERE action='authz.denied' AND "actorId"=$1`, [member.id]);
    const here = denied.rows.filter((row) => JSON.stringify(row.metadata).includes("fold-check"));
    expect(here).toHaveLength(1);
  });
});

describe("browser protections", () => {
  it("redirect signed-out visitors away from protected pages", async () => {
    for (const path of ["/dashboard", "/dashboard/users", "/dashboard/account"]) {
      const r = await call(path);
      expect(r.status).toBe(307);
      expect(r.headers.get("location")).toContain("/dashboard/auth/signin?next=");
    }
  });
  it("stop an invalid cookie at the page, not just the proxy", async () => {
    const r = await call("/dashboard", { headers: { cookie: "better-auth.session_token=forged" } });
    expect([303, 307]).toContain(r.status);
    expect(r.headers.get("location")).toContain("/dashboard/auth/signin");
  });
  it("keep non-staff out of the dashboard", async () => {
    const r = await call("/dashboard/settings", { as: member });
    expect([303, 307]).toContain(r.status);
    expect(r.headers.get("location")).toContain("/dashboard/account");
  });
  it("set security headers and a per-request CSP nonce on every script", async () => {
    const [a, b] = [await call("/dashboard/auth/signin"), await call("/dashboard/auth/signin")];
    const csp = a.headers.get("content-security-policy")!;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1];
    expect(/'nonce-([^']+)'/.exec(b.headers.get("content-security-policy")!)![1]).not.toBe(nonce);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-inline' 'strict-dynamic'");
    const scripts = a.text.match(/<script\b[^>]*>/g)!;
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag, tag).toContain(`nonce="${nonce}"`);
    expect(a.headers.get("x-content-type-options")).toBe("nosniff");
    expect(a.headers.get("x-frame-options")).toBe("DENY");
    expect(a.headers.get("referrer-policy")).toBe("no-referrer");
    expect(a.headers.get("x-powered-by")).toBeNull();
  });
  it("mark API responses as uncacheable", async () => {
    const r = await call("/api/me", { as: root });
    expect(r.headers.get("cache-control")).toContain("no-store");
  });
});

describe.runIf(IS_HOST_INSTALL)("a host app with the package installed", () => {
  it("keeps its own API route next to the CMS", async () => {
    const hello = await fetch(`${base}/api/hello`);
    expect(hello.status).toBe(200);
    expect(await hello.json()).toEqual({ hello: "host" });
    expect((await fetch(`${base}/api/auth-config`)).status).toBe(200);
  });

  it("keeps its own site, with its own layout and the CMS's security headers", async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    const csp = page.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await page.text();
    expect(html).toContain('data-host-site="yes"');
    expect(html).not.toContain('class="cms-');
    expect(html).toContain(`nonce="${nonce}"`);
  });

  it("runs the host's proxy on its own paths, and never on the CMS's", async () => {
    const own = await fetch(`${base}/host-redirect`, { redirect: "manual" });
    expect(own.status).toBe(307);
    expect(own.headers.get("x-frame-options")).toBe("DENY");
    const signIn = await fetch(`${base}/dashboard/auth/signin?host-redirect=1`, { redirect: "manual" });
    expect(signIn.status).toBe(200);
  });
});

describe("content model for sites", () => {
  const records = (slug: string, suffix = "") => `/api/collections/${slug}/records${suffix}`;
  const resolve = (path: string, as?: Actor) => call(`/api/resolve?path=${encodeURIComponent(path)}`, { as });
  const makeCollection = async (body: Record<string, unknown>, rules?: Record<string, string | null>) => {
    const created = await call("/api/collections", { method: "POST", as: root, body });
    expect(created.status, created.text).toBe(200);
    if (rules) {
      const updated = await call(`/api/collections/${created.json.id}/rules`, { method: "PUT", as: root, body: { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, ...rules } });
      expect(updated.status, updated.text).toBe(200);
    }
    return created.json;
  };
  const add = async (slug: string, body: Record<string, unknown>) => {
    const created = await call(records(slug), { method: "POST", as: root, body });
    expect(created.status, created.text).toBe(200);
    return created.json;
  };
  const published = 'status = "published"';
  const slugField = { name: "slug", type: "text", config: { unique: true } };

  describe("singletons", () => {
    it("hold one record, even when two saves race, and can't lose it", async () => {
      await makeCollection({ name: "Settings", slug: "site-settings", type: "singleton", fields: [{ name: "tagline", type: "text" }] });
      const raced = await Promise.all([1, 2, 3].map((n) => call(records("site-settings"), { method: "POST", as: root, body: { tagline: `t${n}` } })));
      expect(raced.map((r) => r.status).sort()).toEqual([200, 409, 409]);
      expect(raced.find((r) => r.status === 409)!.json.error.code).toBe("SINGLETON_EXISTS");
      expect((await call(records("site-settings"), { as: root })).json.items).toHaveLength(1);

      const { id } = raced.find((r) => r.status === 200)!.json;
      expect((await call(records("site-settings", `/${id}`), { method: "PATCH", as: root, body: { tagline: "changed" } })).json.tagline).toBe("changed");
      expect((await call(records("site-settings", `/${id}`), { method: "DELETE", as: root })).json.error.code).toBe("SINGLETON_REQUIRED");
    });
  });

  describe("URL patterns", () => {
    let articles: { id: number; fields: Array<{ id: number; name: string; type: string; config: unknown }> };
    beforeAll(async () => {
      articles = await makeCollection({ name: "Articles", slug: "site-articles", urlPattern: "/articles/:slug", fields: [slugField, { name: "title", type: "text" }, { name: "secret", type: "text", config: { hidden: true } }] }, { viewRule: published });
    });
    const patch = (id: number, urlPattern: string | null) => call(`/api/collections/${id}`, { method: "PATCH", as: root, body: { urlPattern } });

    it("refuse addresses that can't identify one public record", async () => {
      const candidate = await makeCollection({ name: "Candidates", slug: "site-candidates", fields: [{ name: "title", type: "text" }, { name: "secret", type: "text", config: { hidden: true, unique: true } }, slugField] });
      for (const pattern of ["/c/:title", "/c/:secret", "/c/:missing", "/c", "no-slash", "/C/:slug", "/c/:slug/:slug", "/dashboard/:slug", "/api/:slug", "/../:slug"]) {
        const refused = await patch(candidate.id, pattern);
        expect(refused.json.error.code, pattern).toBe("INVALID_URL_PATTERN");
      }
      expect((await patch(candidate.id, "/articles/:title")).status).toBe(400);
      expect((await patch(candidate.id, "/articles/:slug")).json.error.code).toBe("CONFLICT");
      expect((await patch(candidate.id, "/c/:slug")).status).toBe(200);
      expect((await patch(candidate.id, null)).status).toBe(200);
    });

    it("stop a field change from breaking the pattern", async () => {
      const fields = articles.fields.map((field) => ({ id: field.id, name: field.name, type: field.type, config: field.config ?? {} }));
      const without = fields.map((field) => (field.name === "slug" ? { ...field, config: {} } : field));
      expect((await call(`/api/collections/${articles.id}/fields`, { method: "PUT", as: root, body: { fields: without, confirm: true } })).json.error.code).toBe("INVALID_URL_PATTERN");
      const renamed = fields.map((field) => (field.name === "slug" ? { ...field, name: "path" } : field));
      expect((await call(`/api/collections/${articles.id}/fields`, { method: "PUT", as: root, body: { fields: renamed, confirm: true } })).json.error.code).toBe("INVALID_URL_PATTERN");
      const hidden = fields.map((field) => (field.name === "slug" ? { ...field, config: { unique: true, hidden: true } } : field));
      expect((await call(`/api/collections/${articles.id}/fields`, { method: "PUT", as: root, body: { fields: hidden, confirm: true } })).json.error.code).toBe("INVALID_URL_PATTERN");
    });

    it("resolve a public record without its hidden fields, and hide private ones", async () => {
      await add("site-articles", { slug: "hello-world", title: "Hello", secret: "s3cret", status: "published" });
      await add("site-articles", { slug: "unfinished", title: "Draft" });

      const found = await resolve("/articles/hello-world/");
      expect(found.status, found.text).toBe(200);
      expect(found.json).toMatchObject({ type: "record", collection: "site-articles", path: "/articles/hello-world", record: { title: "Hello" } });
      expect(found.text).not.toContain("s3cret");

      const missing = await resolve("/articles/never-existed");
      const hiddenDraft = await resolve("/articles/unfinished");
      expect(hiddenDraft.status).toBe(404);
      expect(hiddenDraft.text).toBe(missing.text);
      expect((await resolve("/articles/unfinished", root)).json.record.title).toBe("Draft");
    });

    it("treat a locked collection like one that doesn't exist", async () => {
      await makeCollection({ name: "Locked", slug: "site-locked", urlPattern: "/locked/:id", fields: [{ name: "title", type: "text" }] });
      const { id } = await add("site-locked", { title: "Private", status: "published" });
      expect((await resolve(`/locked/${id}`)).status).toBe(404);
      expect((await resolve(`/locked/${id}`, root)).status).toBe(200);
      expect((await resolve("/locked/99999999999")).status).toBe(404);
      expect((await resolve("/locked/abc")).status).toBe(404);
    });

    it("prefer fixed addresses, and refuse paths that aren't plain site paths", async () => {
      await makeCollection({ name: "Archive", slug: "site-archive", type: "singleton", urlPattern: "/articles/archive", fields: [{ name: "title", type: "text" }] }, { viewRule: "" });
      await add("site-archive", { title: "All articles", status: "published" });
      await add("site-articles", { slug: "archive", title: "Shadowed", status: "published" });
      expect((await resolve("/articles/archive")).json.collection).toBe("site-archive");
      for (const path of ["//evil.test/x", "/articles/%00", "/articles/%E0%A4%A", "/articles/../x", "articles/x", "/dashboard/users", "/api/users"]) {
        expect((await resolve(path)).status, path).toBe(404);
      }
    });

    it("add each record's address to a list when asked", async () => {
      const listed = await call(`${records("site-articles")}?urls=1&fields=title&filter=${encodeURIComponent('slug = "hello-world"')}`, { as: root });
      expect(listed.json.items[0].recordPath).toBe("/articles/hello-world");
    });
  });

  describe("menus", () => {
    it("are a singleton of built-in, read-only menu_item blocks with checked links", async () => {
      const block = db.query(`SELECT id, source, version FROM "BlockType" WHERE name = 'menu_item'`).rows[0];
      expect(block.source).toBe("tansy");
      expect((await call(`/api/block-types/${block.id}`, { method: "DELETE", as: root })).status).toBe(409);

      // A menu is an ordinary singleton of these blocks, under whatever slug its theme names. Not
      // "site-menu": the themes installed here seed one of those, so this makes its own.
      await makeCollection({ name: "Main menu", slug: "site-nav", type: "singleton", fields: [{ name: "items", type: "stream", config: { allowedBlocks: ["menu_item"] } }] }, { listRule: "", viewRule: "" });
      const item = (id: string, url: string, children: unknown[] = []) => ({ id, type: "menu_item", v: block.version, value: { label: id, url, children } });
      await add("site-nav", { status: "published", items: [item("about", "/about", [item("team", "https://example.com/team")])] });

      const menu = (await call(records("site-nav"))).json.items[0];
      expect(menu.items[0].value.url).toBe("/about");
      expect(menu.items[0].value.children[0].value.url).toBe("https://example.com/team");

      const { id } = menu;
      for (const url of ["javascript:alert(1)", "//evil.test", "data:text/html,x"]) {
        const refused = await call(records("site-nav", `/${id}`), { method: "PATCH", as: root, body: { items: [item("bad", url)] } });
        expect(refused.status, url).toBe(400);
      }
    });
  });

  describe("redirects", () => {
    const addRedirect = (body: Record<string, unknown>, as: Actor = root) => call("/api/redirects", { method: "POST", as, body });

    it("take a changed URL to its new address", async () => {
      await makeCollection({ name: "Guides", slug: "site-guides", urlPattern: "/guides/:slug", fields: [slugField] }, { viewRule: published });
      const guide = await add("site-guides", { slug: "first-name", status: "published" });
      expect((await call(records("site-guides", `/${guide.id}`), { method: "PATCH", as: root, body: { slug: "second-name" } })).status).toBe(200);
      expect((await resolve("/guides/first-name")).status).toBe(404);

      expect((await addRedirect({ from: "/guides/first-name", to: "/guides/second-name" })).status).toBe(200);
      expect((await resolve("/guides/first-name")).json).toEqual({ type: "redirect", to: "/guides/second-name", status: 301 });
      expect((await resolve("/guides/second-name")).json.type).toBe("record");
    });

    it("give way to a record at the same address, without revealing a private one", async () => {
      await makeCollection({ name: "Notes", slug: "site-notes", urlPattern: "/notes/:slug", fields: [slugField] }, { viewRule: published });
      await add("site-notes", { slug: "private-note" });
      await addRedirect({ from: "/notes/private-note", to: "/elsewhere" });
      expect((await resolve("/notes/private-note")).json.type).toBe("redirect");
      expect((await resolve("/notes/private-note", root)).json.type).toBe("record");
    });

    it("stay on this site, and never chain or loop", async () => {
      for (const to of ["https://evil.test", "//evil.test", "/\\evil.test", "/a b", "javascript:alert(1)"]) {
        expect((await addRedirect({ from: "/open", to })).status, to).toBe(400);
      }
      expect((await addRedirect({ from: "/dashboard/users", to: "/x" })).status).toBe(400);
      expect((await addRedirect({ from: "/a1", to: "/a1" })).status).toBe(400);

      expect((await addRedirect({ from: "/b1", to: "/b2" })).status).toBe(200);
      expect((await addRedirect({ from: "/b1", to: "/b3" })).json.error.code).toBe("CONFLICT");
      const second = await addRedirect({ from: "/b2", to: "/b3?x=1" });
      expect(second.status).toBe(200);
      expect((await resolve("/b1")).json.to).toBe("/b3?x=1");
      expect((await addRedirect({ from: "/b0", to: "/b1" })).json.to).toBe("/b3?x=1");
      expect((await addRedirect({ from: "/b3", to: "/b1" })).status).toBe(400);
    });

    it("need their own permissions and are audited", async () => {
      expect((await call("/api/redirects")).status).toBe(401);
      expect((await call("/api/redirects", { as: member })).status).toBe(403);
      expect((await addRedirect({ from: "/m", to: "/n" }, member)).status).toBe(403);
      const made = await addRedirect({ from: "/audited", to: "/target" });
      const edited = await call(`/api/redirects/${made.json.id}`, { method: "PATCH", as: root, body: { status: 302 } });
      expect(edited.json).toMatchObject({ from: "/audited", to: "/target", status: 302 });
      expect((await call(`/api/redirects/${made.json.id}`, { method: "DELETE", as: root })).status).toBe(204);
      expect((await call(`/api/redirects/${made.json.id}`, { method: "DELETE", as: root })).status).toBe(404);
      expect(db.query(`SELECT count(*) AS n FROM "AuditLog" WHERE action IN ('redirect.create', 'redirect.update', 'redirect.delete') AND "targetType" = 'redirect'`).rows[0].n).toBeGreaterThanOrEqual(3);
    });
  });

  it("export singletons and URL patterns", async () => {
    const exported = (await call("/api/schema/export", { as: root })).json;
    expect(exported.collections.find((c: { slug: string }) => c.slug === "site-archive")).toMatchObject({ type: "singleton", urlPattern: "/articles/archive" });
  });
});

describe("site layer", () => {
  const records = (suffix = "") => `/api/collections/site-layer/records${suffix}`;
  const page = (path: string, as?: Actor, cookie?: string) => call(path, { as, headers: cookie ? { cookie } : {} });
  const SECRET = "hidden-value-never-public";
  let collectionId: number;
  let titleField: number;
  const content = (id: number) => `/api/collections/${collectionId}/content/${id}`;
  const add = async (slug: string, status: string, title: string) => {
    const created = await call(records(), { method: "POST", as: root, body: { slug, title, status, secret: SECRET } });
    expect(created.status, created.text).toBe(200);
    return created.json as { id: number };
  };
  const previewOf = async (id: number, as: Actor = root) => (await call(`${content(id)}/preview-token`, { method: "POST", as, body: {} }));

  beforeAll(async () => {
    const created = await call("/api/collections", { method: "POST", as: root, body: { name: "Site layer", slug: "site-layer", urlPattern: "/layer/:slug", fields: [{ name: "slug", type: "text", config: { unique: true } }, { name: "title", type: "text" }, { name: "secret", type: "text", config: { hidden: true } }] } });
    expect(created.status, created.text).toBe(200);
    collectionId = created.json.id;
    titleField = created.json.fields.find((f: { name: string }) => f.name === "title").id;
    const rules = await call(`/api/collections/${collectionId}/rules`, { method: "PUT", as: root, body: { listRule: 'status = "published"', viewRule: 'status = "published"', createRule: null, updateRule: null, deleteRule: null } });
    expect(rules.status, rules.text).toBe(200);
  });

  it("renders a published record through the theme, with the per-request nonce", async () => {
    await add("hello", "published", "Hello from the theme");
    const first = await page("/layer/hello");
    expect(first.status).toBe(200);
    expect(first.text).toContain("<h1>Hello from the theme</h1>");
    expect(first.text).toContain("<title>Hello from the theme</title>");
    const nonce = /'nonce-([^']+)'/.exec(first.headers.get("content-security-policy") ?? "")?.[1];
    expect(first.text).toContain(`nonce="${nonce}"`);
    const again = await page("/layer/hello");
    expect(/'nonce-([^']+)'/.exec(again.headers.get("content-security-policy") ?? "")?.[1]).not.toBe(nonce);
  });

  it("never gives a visitor a draft, a rule-hidden record or a hidden field", async () => {
    await add("unfinished", "draft", "Secret draft title");
    for (const as of [undefined, member, root]) {
      const hidden = await page("/layer/unfinished", as);
      expect(hidden.status).toBe(404);
      expect(hidden.text).not.toContain("Secret draft title");
    }
    expect((await page("/layer/hello")).text).not.toContain(SECRET);
    expect((await page("/layer/never-existed")).status).toBe(404);
  });

  it("gets the home page's content from the theme or falls back to sign-in, and leaves the CMS's own paths alone", async () => {
    if (!IS_HOST_INSTALL) expect((await page("/")).headers.get("location")).toContain("/dashboard/auth/signin");
    expect((await page("/dashboard/auth/signin")).status).toBe(200);
    expect((await page("/api/auth-config")).status).toBe(200);
  });

  it("answers a redirect over HTTP", async () => {
    for (const [from, status, expected] of [["/layer-moved-a", 301, 308], ["/layer-moved-b", 302, 307]] as const) {
      expect((await call("/api/redirects", { method: "POST", as: root, body: { from, to: "/layer/hello", status } })).status).toBe(200);
      const redirected = await page(from);
      expect(redirected.status).toBe(expected);
      expect(redirected.headers.get("location")).toBe("/layer/hello");
    }
  });

  it("caches reads, and shows a published edit straight away", async () => {
    const { id } = await add("cached", "published", "Original title");
    expect((await page("/layer/cached")).text).toContain("Original title");
    // Behind the CMS's back, so no event fires. Only a cached read can still show the old title.
    const table = '"rec_site_layer"';
    db.query(`UPDATE ${table} SET title = $1 WHERE id = $2`, ["Changed in the database", id]);
    expect((await page("/layer/cached")).text).toContain("Original title");

    const edited = await call(records(`/${id}`), { method: "PATCH", as: root, body: { title: "Edited and published" } });
    expect(edited.status, edited.text).toBe(200);
    expect((await page("/layer/cached")).text).toContain("Edited and published");
  });

  it("drops a record from cached pages as soon as a rule or status hides it", async () => {
    const { id } = await add("short-lived", "published", "Visible for now");
    expect((await page("/layer/short-lived")).status).toBe(200);
    expect((await call(records(`/${id}`), { method: "PATCH", as: root, body: { status: "draft" } })).status).toBe(200);
    expect((await page("/layer/short-lived")).status).toBe(404);

    await add("locked-later", "published", "Until locked");
    expect((await page("/layer/locked-later")).status).toBe(200);
    const rules = `/api/collections/${collectionId}/rules`;
    const open = { listRule: 'status = "published"', viewRule: 'status = "published"', createRule: null, updateRule: null, deleteRule: null };
    expect((await call(rules, { method: "PUT", as: root, body: { ...open, viewRule: null } })).status).toBe(200);
    expect((await page("/layer/locked-later")).status).toBe(404);
    expect((await call(rules, { method: "PUT", as: root, body: open })).status).toBe(200);
  });

  describe("previews", () => {
    let id: number;
    let token: string;
    beforeAll(async () => {
      ({ id } = await add("previewed", "published", "Live version"));
      const draft = await call(`${content(id)}/draft`, { method: "PUT", as: root, body: { values: [{ fieldId: titleField, value: "Pending version" }] } });
      expect(draft.status, draft.text).toBe(200);
      const made = await previewOf(id);
      expect(made.status, made.text).toBe(200);
      token = made.json.token;
      expect(made.json.url).toBe(`/api/preview/enter?token=${encodeURIComponent(token)}`);
    });

    it("can't be made without record:read", async () => {
      expect((await previewOf(id, member)).status).toBe(403);
      expect((await call(`${content(id)}/preview-token`, { method: "POST", body: {} })).status).toBe(401);
    });

    it("are audited without the token", () => {
      const rows = db.query(`SELECT metadata FROM "AuditLog" WHERE action = 'record.preview'`).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain(token);
    });

    it("give a headless site the pending version, without hidden fields", async () => {
      const seen = await call(`/api/preview?token=${encodeURIComponent(token)}`);
      expect(seen.status, seen.text).toBe(200);
      expect(seen.json).toMatchObject({ collection: "site-layer", path: "/layer/previewed", record: { title: "Pending version" } });
      expect(seen.text).not.toContain(SECRET);
    });

    it("refuse a forged or altered token the same way as a missing record", async () => {
      for (const bad of [`${token.slice(0, -2)}xx`, "nonsense", `${token.split(".")[0]}.`]) {
        const refused = await call(`/api/preview?token=${encodeURIComponent(bad)}`);
        expect(refused.status, bad).toBe(404);
      }
    });

    it("show the pending version only to the browser holding the cookie, and only at that record's address", async () => {
      const entered = await call(`/api/preview/enter?token=${encodeURIComponent(token)}`);
      expect(entered.status).toBe(307);
      expect(entered.headers.get("location")).toBe("/layer/previewed");
      const setCookie = entered.headers.get("set-cookie") ?? "";
      expect(setCookie).toMatch(/HttpOnly/);
      expect(setCookie).toMatch(/SameSite=Lax/);
      const cookie = setCookie.split(";")[0];

      const previewing = await page("/layer/previewed", undefined, cookie);
      expect(previewing.text).toContain("Pending version");
      expect(previewing.text).toContain("data-preview-notice");
      expect(previewing.text).not.toContain(SECRET);

      // Never stored, so the next visitor still gets the live page.
      const visitor = await page("/layer/previewed");
      expect(visitor.text).toContain("Live version");
      expect(visitor.text).not.toContain("Pending version");

      const elsewhere = await page("/layer/hello", undefined, cookie);
      expect(elsewhere.text).not.toContain("data-preview-notice");
      expect((await page("/layer/unfinished", undefined, cookie)).status).toBe(404);

      const exit = await call("/api/preview/exit");
      expect(exit.status).toBe(307);
      expect(exit.headers.get("set-cookie")).toMatch(/cms-preview=;.*Max-Age=0/);
    });

    it("show a draft that was never published", async () => {
      const { id: unpublished } = await add("preview-draft", "draft", "Not published yet");
      const made = await previewOf(unpublished);
      const entered = await call(made.json.url);
      const cookie = (entered.headers.get("set-cookie") ?? "").split(";")[0];
      expect((await page("/layer/preview-draft", undefined, cookie)).text).toContain("Not published yet");
      expect((await page("/layer/preview-draft")).status).toBe(404);
    });

    it("stop working once the person who made them loses access", async () => {
      const staff = await signIn(await makeUser("preview-staff", "admin"));
      const held = await previewOf(id, staff);
      expect(held.status, held.text).toBe(200);
      const url = `/api/preview?token=${encodeURIComponent(held.json.token)}`;
      expect((await call(url)).status).toBe(200);
      expect((await call(`/api/users/${staff.id}/ban`, { method: "POST", as: root, body: {} })).status).toBeLessThan(300);
      expect((await call(url)).status).toBe(404);
    });
  });

  it("renders the same markup in a headless site", async () => {
    const { CmsClient } = await import("@/sdk");
    const { ThemedPage } = await import("@/components/site/ThemedPage");
    const { loadSitePage } = await import("@/core/site/page");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { blank } = await import("../../themes/blank/index");
    const { default: components } = await import("../../themes/blank/render");

    const theme = { manifest: blank(), components: components as never };
    const reader = new CmsClient({ url: base }).reader();
    const loaded = await loadSitePage(theme, reader, "/layer/hello");
    expect(loaded.type).toBe("page");
    const headless = renderToStaticMarkup(createElement(ThemedPage, { theme, page: loaded as never }) as never);
    const sameApp = (await page("/layer/hello")).text.replaceAll("<!-- -->", "");
    expect(headless).toContain("Hello from the theme");
    expect(sameApp).toContain(headless);
  });
});

describe("per-collection record permissions", () => {
  type Created = { id: number; slug: string; fields: Array<{ id: number; name: string }> };
  let granted: Created, other: Created, scoped: Actor;
  let grantedRecord: number, otherRecord: number;
  const make = async (slug: string): Promise<Created> => {
    const r = await call("/api/collections", { method: "POST", as: root, body: { name: slug, slug, fields: [{ name: "title", type: "text" }, { name: "secret", type: "text", config: { hidden: true } }] } });
    expect(r.status, r.text).toBe(200);
    return r.json;
  };
  const add = async (collection: Created, as: Actor, title: string) =>
    call(`/api/collections/${collection.id}/content`, { method: "POST", as, body: { status: "published", values: [{ fieldId: collection.fields[0].id, value: title }, { fieldId: collection.fields[1].id, value: "s" }] } });

  beforeAll(async () => {
    root = await signIn(root.email);
    granted = await make("scoped-granted");
    other = await make("scoped-other");
    grantedRecord = (await add(granted, root, "g")).json.id;
    otherRecord = (await add(other, root, "o")).json.id;
    const permissions = ["dashboard:access", "collection:read", ...["list", "read", "create", "update"].map((a) => `record:${a}@c${granted.id}`)];
    const role = await call("/api/roles", { method: "POST", as: root, body: { name: "scoped-writer", label: "Scoped writer", permissions } });
    expect(role.status, role.text).toBe(200);
    scoped = await signIn(await makeUser("scoped-writer", "scoped-writer"));
  });

  it("refuse grants for collections that don't exist", async () => {
    const r = await call("/api/roles", { method: "POST", as: root, body: { name: "ghostly", label: "G", permissions: ["record:read@c999999"] } });
    expect(r.json.error.code).toBe("UNKNOWN_PERMISSION");
  });
  it("open the granted collection, hidden fields included", async () => {
    const r = await call(`/api/collections/${granted.slug}/records`, { as: scoped });
    expect(r.status, r.text).toBe(200);
    expect(r.json.items.map((item: { secret: string }) => item.secret)).toEqual(["s"]);
    expect((await add(granted, scoped, "mine")).status).toBe(200);
    expect((await call(`/api/collections/${granted.id}/content/${grantedRecord}/revisions`, { as: scoped })).status).toBe(200);
  });
  it("grant nothing in other collections", async () => {
    expect((await call(`/api/collections/${other.slug}/records`, { as: scoped })).status).toBe(403);
    expect((await call(`/api/collections/${other.slug}/records/${otherRecord}`, { as: scoped })).status).toBe(403);
    expect((await add(other, scoped, "nope")).status).toBe(403);
    expect((await call(`/api/collections/${other.id}/content/${otherRecord}/revisions`, { as: scoped })).status).toBe(403);
    expect((await call(`/api/collections/${other.id}/content/${otherRecord}/draft`, { as: scoped })).status).toBe(403);
  });
  it("grant only the actions given", async () => {
    expect((await call(`/api/collections/${granted.id}/content/${grantedRecord}`, { method: "DELETE", as: scoped })).status).toBe(403);
  });
  it("leave the role when the collection is deleted", async () => {
    expect((await call("/api/collections", { method: "DELETE", as: root, body: { ids: [granted.id] } })).status).toBe(204);
    const roles = (await call("/api/roles", { as: root })).json.roles as Array<{ name: string; permissions: string[] }>;
    expect(roles.find((r) => r.name === "scoped-writer")!.permissions).toEqual(["dashboard:access", "collection:read"]);
  });
});

describe("own-record permissions", () => {
  type Created = { id: number; slug: string; fields: Array<{ id: number; name: string }> };
  let posts: Created, view: { id: number }, author: Actor, other: Actor;
  let theirs: number, mine: number;
  const add = async (as: Actor, title: string) =>
    call(`/api/collections/${posts.id}/content`, { method: "POST", as, body: { status: "draft", values: [{ fieldId: posts.fields[0].id, value: title }, { fieldId: posts.fields[1].id, value: "s" }] } });
  const content = (id: number, suffix = "") => `/api/collections/${posts.id}/content/${id}${suffix}`;

  beforeAll(async () => {
    root = await signIn(root.email);
    const r = await call("/api/collections", { method: "POST", as: root, body: { name: "Own posts", slug: "own-posts", fields: [{ name: "title", type: "text" }, { name: "secret", type: "text", config: { hidden: true } }] } });
    expect(r.status, r.text).toBe(200);
    posts = r.json;
    const v = await call("/api/collections/views", { method: "POST", as: root, body: { name: "Own view", slug: "own-view", query: "SELECT id, title FROM rec_own_posts" } });
    expect(v.status, v.text).toBe(200);
    view = v.json;
    const permissions = ["dashboard:access", "collection:read", `record:create@c${posts.id}`, ...["list", "read", "update", "delete"].map((a) => `record:${a}@c${posts.id}:own`)];
    const role = await call("/api/roles", { method: "POST", as: root, body: { name: "own-writer", label: "Own writer", permissions } });
    expect(role.status, role.text).toBe(200);
    author = await signIn(await makeUser("own-writer", "own-writer"));
    other = await signIn(await makeUser("own-writer-2", "own-writer"));
    theirs = (await add(other, "theirs")).json.id;
    const created = await add(author, "mine");
    expect(created.status, created.text).toBe(200);
    mine = created.json.id;
  });

  it("list, read and edit only the holder's own records, hidden fields included", async () => {
    const list = await call(`/api/collections/${posts.slug}/records`, { as: author });
    expect(list.status, list.text).toBe(200);
    expect(list.json.items.map((item: { id: number; secret: string }) => [item.id, item.secret])).toEqual([[mine, "s"]]);
    expect((await call(`/api/collections/${posts.id}/content`, { as: author })).json.items.map((item: { id: number }) => item.id)).toEqual([mine]);
    expect((await call(content(mine), { as: author })).status).toBe(200);
    expect((await call(content(mine), { method: "PATCH", as: author, body: { values: [{ fieldId: posts.fields[0].id, value: "edited" }] } })).status).toBe(200);
    expect((await call(content(mine, "/revisions"), { as: author })).status).toBe(200);
    expect((await call(content(mine, "/schedule"), { as: author })).status).toBe(200);
  });

  it("answer 404 for anyone else's record, on every route", async () => {
    expect((await call(content(theirs), { as: author })).status).toBe(404);
    expect((await call(`/api/collections/${posts.slug}/records/${theirs}`, { as: author })).status).toBe(404);
    expect((await call(content(theirs), { method: "PATCH", as: author, body: { values: [{ fieldId: posts.fields[0].id, value: "x" }] } })).status).toBe(404);
    expect((await call(content(theirs), { method: "DELETE", as: author })).status).toBe(404);
    for (const suffix of ["/revisions", "/draft", "/schedule"]) expect((await call(content(theirs, suffix), { as: author })).status, suffix).toBe(404);
    expect((await call(content(theirs, "/preview-token"), { method: "POST", as: author })).status).toBe(404);
    expect((await call(content(theirs), { as: root })).json.values.find((v: { fieldId: number }) => v.fieldId === posts.fields[0].id).value).toBe("theirs");
  });

  it("can't be granted on a view, or for create", async () => {
    const r = await call("/api/roles", { method: "POST", as: root, body: { name: "own-bad", label: "B", permissions: [`record:update@c${view.id}:own`] } });
    expect(r.json.error.code).toBe("UNKNOWN_PERMISSION");
    expect((await call("/api/roles", { method: "POST", as: root, body: { name: "own-bad", label: "B", permissions: [`record:create@c${posts.id}:own`] } })).json.error.code).toBe("UNKNOWN_PERMISSION");
  });

  it("delete the holder's own records only", async () => {
    expect((await call(content(mine), { method: "DELETE", as: author })).status).toBe(204);
    expect((await call(content(theirs), { as: root })).status).toBe(200);
  });
});
