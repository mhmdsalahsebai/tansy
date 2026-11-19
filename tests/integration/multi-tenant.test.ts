/**
 * The multi-tenant plugin (plugins/multi-tenant), which global-setup turns on with
 * TEST_SCOPES=multi-tenant instead of the workspaces example. Runs after auth.test.ts, which
 * completes setup. Root makes two tenants, acme and globex, with a scoped collection whose
 * titles are unique per tenant. Ann runs acme and Bob writes in globex, each invited by email.
 * Everything they can do comes from the tenant role their membership gives them. Then the
 * cross-tenant matrix: every way of naming the other tenant gets 404 or 403.
 */
import http from "node:http";
import net from "node:net";
import { beforeAll, describe, expect, inject, it } from "vitest";
import { setTxt } from "./dns-server";

const baseUrl = inject("baseUrl");
const TENANTS = inject("tenants");
const PASSWORD = "correct-horse-battery-staple-9431";
const EXT = "/api/ext/multi-tenant";

interface Actor { id: string; cookie?: string; key?: string }
let root: Actor, ann: Actor, bob: Actor, cat: Actor, staff: Actor;
let acme: string, globex: string, collectionId: number, titleId: number;

const mailbox = () => new Promise<string[]>((resolve, reject) => {
  let data = "";
  net.connect(2588, "127.0.0.1").on("data", (c) => (data += c)).on("end", () => resolve(JSON.parse(data))).on("error", reject);
});

async function call(path: string, { method = "GET", body, as, tenant }: { method?: string; body?: unknown; as?: Actor | null; tenant?: string } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    redirect: "manual",
    headers: {
      origin: baseUrl,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(as?.cookie ? { cookie: as.cookie } : {}),
      ...(as?.key ? { "x-api-key": as.key } : {}),
      ...(tenant ? { "x-cms-tenant": tenant } : {}),
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

async function user(name: string, role = "user") {
  const r = await call("/api/users", { method: "POST", as: root, body: { name, email: `${name}@example.test`, password: PASSWORD, role } });
  expect(r.status, r.text).toBe(200);
  return signIn(`${name}@example.test`);
}

const content = (suffix = "") => `/api/collections/${collectionId}/content${suffix}`;
interface Item { id: number; values: Array<{ fieldId: number; value: unknown }> }
const title = (item: Item) => item.values.find((value) => value.fieldId === titleId)?.value;
const titles = (json: { items: Item[] }) => json.items.map(title).sort();
const create = (title: string, as: Actor, tenant?: string) => call(content(), { method: "POST", as, tenant, body: { status: "published", values: [{ fieldId: titleId, value: title }] } });

/** A request as it reaches the server on another host, such as a tenant's domain. fetch can't set Host. */
function onHost(host: string, path: string, { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const url = new URL(baseUrl);
  return new Promise<{ status: number; text: string; location: string | null }>((resolve, reject) => {
    const request = http.request({ host: url.hostname, port: url.port, path, method, headers: { host: `${host}:${url.port}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers } }, (response) => {
      let text = "";
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text, location: response.headers.location ?? null }));
    });
    request.on("error", reject);
    request.end(body !== undefined ? JSON.stringify(body) : undefined);
  });
}

/** Invites by email as `as` in `tenant`, then accepts as the invitee, through the invitation better-auth lists for them. */
async function join(tenant: string, as: Actor, invitee: Actor, email: string, roles: string[]) {
  const invited = await call(`${EXT}/invitations`, { method: "POST", as, tenant, body: { email, roles } });
  expect(invited.status, invited.text).toBe(200);
  const mine = await call(`${EXT}/invitations/mine`, { as: invitee });
  expect(mine.status, mine.text).toBe(200);
  expect(mine.json.items.map((item: { id: string }) => item.id)).toContain(invited.json.id);
  const accepted = await call(`${EXT}/invitations/${invited.json.id}/accept`, { method: "POST", as: invitee });
  expect(accepted.status, accepted.text).toBe(200);
  expect(accepted.json.tenant).toBe(tenant);
  return invited.json.id as string;
}

describe.runIf(TENANTS)("multi-tenant plugin", () => {
  beforeAll(async () => {
    root = await signIn("root@example.test");
    // An instance role that reads records anywhere it applies, for people who aren't tenant members.
    const reader = await call("/api/roles", { method: "POST", as: root, body: { name: "tenant-test-reader", label: "Reader", permissions: ["dashboard:access", "record:list", "record:read"] } });
    expect(reader.status, reader.text).toBe(200);
    // Staff: the same, in every tenant.
    const everywhere = await call("/api/roles", { method: "POST", as: root, body: { name: "tenant-test-staff", label: "Staff", permissions: ["dashboard:access", "record:list", "record:read", "ext.multi-tenant:all", "ext.multi-tenant:read"] } });
    expect(everywhere.status, everywhere.text).toBe(200);
    ann = await user("mtann");
    bob = await user("mtbob");
    cat = await user("mtcat", "tenant-test-reader");
    staff = await user("mtstaff", "tenant-test-staff");

    for (const [name, slug] of [["Acme", "acme"], ["Globex", "globex"]]) {
      const made = await call(`${EXT}/tenants`, { method: "POST", as: root, body: { name, slug } });
      expect(made.status, made.text).toBe(200);
      expect(made.json).toMatchObject({ name, slug, status: "active" });
      if (slug === "acme") acme = made.json.id;
      else globex = made.json.id;
    }
    const made = await call("/api/collections", { method: "POST", as: root, body: { name: "Tenant notes", slug: "tenant-notes", scoped: true, fields: [{ name: "title", type: "text", config: { unique: true } }] } });
    expect(made.status, made.text).toBe(200);
    expect(made.json.scoped).toBe(true);
    collectionId = made.json.id;
    titleId = made.json.fields[0].id;
  });

  it("closes every endpoint of better-auth's organization plugin to HTTP", async () => {
    for (const path of ["/organization/create", "/organization/list", "/organization/set-active", "/organization/invite-member", "/organization/accept-invitation", "/organization/update-member-role", "/organization/has-permission", "/organization/get-full-organization"]) {
      const r = await call(`/api/auth${path}`, { method: path === "/organization/list" || path === "/organization/get-full-organization" ? "GET" : "POST", as: ann, body: path.endsWith("list") || path.endsWith("get-full-organization") ? undefined : { name: "x", slug: "x", organizationId: acme } });
      expect(r.status, `${path}: ${r.text}`).toBe(404);
    }
  });

  it("makes the creator the tenant's first admin, and keeps tenants to who may make them", async () => {
    const listed = await call(`${EXT}/tenants`, { as: root });
    expect(listed.status, listed.text).toBe(200);
    const acmeItem = listed.json.items.find((item: { id: string }) => item.id === acme);
    expect(acmeItem.roles).toEqual(["multi-tenant-admin"]);
    expect((await call(`${EXT}/tenants`, { method: "POST", as: ann, body: { name: "Mine", slug: "mine" } })).status).toBe(403);
    expect((await call(`${EXT}/tenants`, { as: ann })).json.items).toEqual([]);
  });

  it("invites by email, and better-auth accepts as the invitee only", async () => {
    const id = await join(acme, root, ann, "mtann@example.test", ["multi-tenant-admin"]);
    // Quoted-printable bodies wrap long lines with a soft break, which can fall inside the id.
    const sent = (await mailbox()).map((message) => message.replace(/=\r?\n/g, "").replaceAll("=3D", "="));
    expect(sent.some((message) => message.includes("mtann@example.test") && message.includes(`invitation=${id}`))).toBe(true);
    // Bob can't take an invitation that isn't his.
    const other = await call(`${EXT}/invitations`, { method: "POST", as: root, tenant: globex, body: { email: "mtcat@example.test", roles: ["multi-tenant-editor"] } });
    expect(other.status, other.text).toBe(200);
    expect((await call(`${EXT}/invitations/${other.json.id}/accept`, { method: "POST", as: bob })).status).toBeGreaterThanOrEqual(400);
    expect((await call(`${EXT}/invitations/${other.json.id}`, { method: "DELETE", as: root, tenant: globex })).status).toBe(204);
    await join(globex, root, bob, "mtbob@example.test", ["multi-tenant-editor"]);
    const tenants = (await call(`${EXT}/tenants`, { as: ann })).json;
    expect(tenants.items.map((item: { slug: string }) => item.slug)).toEqual(["acme"]);
    // Accepting made acme ann's current tenant.
    expect(tenants.current).toBe(acme);
  });

  it("gives a member their tenant's role there, and keeps each tenant's records apart", async () => {
    expect((await create("same", ann, acme)).status).toBe(200);
    // The same title in another tenant: unique values are per tenant.
    expect((await create("same", bob, globex)).status).toBe(200);
    expect((await create("same", ann, acme)).status).toBe(400);
    expect(titles((await call(content(), { as: ann, tenant: acme })).json)).toEqual(["same"]);
    // Ann's session already points at acme, so she needn't name it.
    expect(titles((await call(content(), { as: ann })).json)).toEqual(["same"]);
    // Bob is an editor: no deleting, no managing members.
    const bobItem = (await call(content(), { as: bob, tenant: globex })).json.items[0];
    expect((await call(content(`/${bobItem.id}`), { method: "DELETE", as: bob, tenant: globex })).status).toBe(403);
    expect((await call(`${EXT}/members`, { as: bob, tenant: globex })).status).toBe(403);
  });

  it("answers 404 for another tenant, however it is named", async () => {
    const bobItem = (await call(content(), { as: bob, tenant: globex })).json.items[0];
    const annItem = (await call(content(), { as: ann, tenant: acme })).json.items[0];
    for (const [actor, tenant] of [[ann, globex], [bob, acme], [cat, acme]] as const) {
      const listed = await call(content(), { as: actor, tenant });
      expect(listed.status, listed.text).toBe(404);
      expect(listed.json.error.code).toBe("SCOPE_NOT_FOUND");
      expect((await call(`${EXT}/members`, { as: actor, tenant })).status).toBe(404);
    }
    // By id, from their own tenant.
    expect((await call(content(`/${bobItem.id}`), { as: ann, tenant: acme })).status).toBe(404);
    expect((await call(content(`/${annItem.id}`), { method: "PATCH", as: bob, tenant: globex, body: { values: [{ fieldId: titleId, value: "taken" }] } })).status).toBe(404);
    expect((await call(content(`/${annItem.id}`), { method: "DELETE", as: bob, tenant: globex })).status).toBe(404);
    // Switching to a tenant she isn't in is refused the same way, and doesn't move her.
    expect((await call(`${EXT}/switch`, { method: "POST", as: ann, body: { tenant: globex } })).status).toBe(404);
    expect((await call(`${EXT}/tenants`, { as: ann })).json.current).toBe(acme);
    // A tenant that doesn't exist, and no tenant at all.
    expect((await call(content(), { as: root, tenant: "nowhere" })).status).toBe(404);
    expect((await call(content(), { as: cat })).json.error.code).toBe("SCOPE_REQUIRED");
  });

  it("lets staff with every tenant work in any of them with their own roles", async () => {
    expect(titles((await call(content(), { as: staff, tenant: globex })).json)).toEqual(["same"]);
    expect((await create("staff", staff, globex)).status).toBe(403);
    const switched = await call(`${EXT}/switch`, { method: "POST", as: staff, body: { tenant: acme } });
    expect(switched.status, switched.text).toBe(200);
    expect(titles((await call(content(), { as: staff })).json)).toEqual(["same"]);
    expect((await call(`${EXT}/tenants`, { as: staff })).json.items.length).toBeGreaterThanOrEqual(2);
  });

  it("lets a tenant admin manage members with only the roles they hold", async () => {
    const members = await call(`${EXT}/members`, { as: ann, tenant: acme });
    expect(members.status, members.text).toBe(200);
    expect(members.json.items.map((item: { email: string }) => item.email).sort()).toEqual(["mtann@example.test", "root@example.test"]);
    // Ann holds tenant admin, not tenant editor, so she can't give it. Instance roles aren't tenant roles.
    expect((await call(`${EXT}/invitations`, { method: "POST", as: ann, tenant: acme, body: { email: "mtcat@example.test", roles: ["multi-tenant-editor"] } })).json.error.code).toBe("ROLE_NOT_HELD");
    expect((await call(`${EXT}/invitations`, { method: "POST", as: ann, tenant: acme, body: { email: "mtcat@example.test", roles: ["superadmin"] } })).json.error.code).toBe("UNKNOWN_ROLE");
    await join(acme, ann, cat, "mtcat@example.test", ["multi-tenant-admin"]);
    expect(titles((await call(content(), { as: cat, tenant: acme })).json)).toEqual(["same"]);
    const catMember = (await call(`${EXT}/members`, { as: ann, tenant: acme })).json.items.find((item: { email: string }) => item.email === "mtcat@example.test");
    // Another tenant's admin can't touch acme's members.
    expect((await call(`${EXT}/members/${catMember.id}`, { method: "DELETE", as: bob, tenant: globex })).status).toBe(403);
    expect((await call(`${EXT}/members/${catMember.id}`, { method: "DELETE", as: ann, tenant: acme })).status).toBe(204);
    // Cat's session still points at acme, which no longer applies to her: ignored, not an error everywhere.
    expect((await call(content(), { as: cat })).json.error.code).toBe("SCOPE_REQUIRED");
    expect((await call(content(), { as: cat, tenant: acme })).status).toBe(404);
    expect((await call(`${EXT}/tenants`, { as: cat })).status).toBe(200);
  });

  it("caps tenant roles to what applies within one tenant", async () => {
    for (const path of ["/api/roles", "/api/users", "/api/audit"]) {
      const r = await call(path, { as: ann, tenant: acme });
      expect(r.status, `${path}: ${r.text}`).toBe(403);
    }
    const rules = await call(`/api/collections/${collectionId}/rules`, { method: "PUT", as: ann, tenant: acme, body: { listRule: "", viewRule: "", createRule: "", updateRule: "", deleteRule: "" } });
    expect(rules.status, rules.text).toBe(403);
    // Another tenant's admin role reaches no further than its own tenant.
    expect((await call(`${EXT}/tenants`, { method: "POST", as: ann, tenant: acme, body: { name: "Mine", slug: "mine" } })).status).toBe(403);
  });

  it("keeps its tables system-owned: staff can read them, nobody writes them but the plugin", async () => {
    const members = await call("/api/collections/multi-tenant-member/records?perPage=50", { as: root });
    expect(members.status, members.text).toBe(200);
    const row = members.json.items[0];
    expect((await call(`/api/collections/multi-tenant-member/records/${row.id}`, { method: "PATCH", as: root, body: { role: "multi-tenant-admin" } })).status).toBe(403);
    expect((await call("/api/collections/multi-tenant-member/records", { method: "POST", as: root, body: { authId: "x", organizationId: globex, userId: ann.id, role: "multi-tenant-admin" } })).status).toBe(403);
    const organization = (await call("/api/collections/multi-tenant-organization/records?perPage=1", { as: root })).json.items[0];
    expect((await call(`/api/collections/multi-tenant-organization/records/${organization.id}`, { method: "DELETE", as: root })).status).toBe(403);
    expect((await call(`/api/collections/multi-tenant-organization/records/${organization.id}`, { method: "PATCH", as: root, body: { organizationStatus: "suspended" } })).status).toBe(403);
    expect((await call("/api/collections/multi-tenant-member/records", { as: ann, tenant: acme })).status).toBe(403);
  });

  it("opens the dashboard for a tenant member in their tenant only", async () => {
    expect((await create("acme-only-note", ann, acme)).status).toBe(200);
    expect((await create("globex-only-note", bob, globex)).status).toBe(200);
    const page = (path: string, as: Actor) => fetch(`${baseUrl}/dashboard${path}`, { redirect: "manual", headers: { cookie: as.cookie! } });
    // Ann's dashboard access comes from her tenant role alone, in the tenant her session works in.
    const home = await page("", ann);
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain("acme-only-note");
    expect(html).not.toContain("globex-only-note");
    expect((await page(`/collections/${collectionId}`, ann)).status).toBe(200);
    expect((await page("/ext/tenants/members", ann)).status).toBe(200);
    // Nothing her tenant role can't hold, and an editor doesn't manage members. A page streams its redirect after
    // loading.tsx has answered 200, so it can arrive in the body rather than as a Location header.
    const denied = async (path: string, as: Actor) => { const response = await page(path, as); return response.headers.get("location") ?? await response.text(); };
    expect(await denied("/roles", ann)).toContain("denied=1");
    expect(await denied("/ext/tenants/members", bob)).toContain("denied=1");
    // Someone invited but not yet in a tenant has no dashboard, only their account page, until they accept.
    const dan = await user("mtdan");
    expect((await page("", dan)).headers.get("location")).toContain("/account");
    expect((await page("/account", dan)).status).toBe(200);
    await join(globex, root, dan, "mtdan@example.test", ["multi-tenant-editor"]);
    const joined = await page("", dan);
    expect(joined.status).toBe(200);
    const joinedHtml = await joined.text();
    expect(joinedHtml).toContain("globex-only-note");
    expect(joinedHtml).not.toContain("acme-only-note");
  });

  it("switches tenant from the top bar, offering only what the caller can reach", async () => {
    const mine = await call(`${EXT}/switcher`, { as: ann });
    expect(mine.status, mine.text).toBe(200);
    expect(mine.json).toEqual({ current: acme, options: [{ value: acme, label: "Acme" }] });
    expect((await call(`${EXT}/switcher`, { method: "POST", as: ann, body: { value: globex } })).status).toBe(404);
    const everyone = (await call(`${EXT}/switcher`, { as: staff })).json;
    expect(everyone.options[0]).toEqual({ value: null, label: "No tenant" });
    expect(everyone.options.map((option: { value: string | null }) => option.value)).toEqual(expect.arrayContaining([acme, globex]));
    expect((await call(`${EXT}/switcher`, { method: "POST", as: staff, body: { value: globex } })).json).toEqual({ current: globex });
    expect((await call(`${EXT}/switcher`, { as: staff })).json.current).toBe(globex);
    expect((await call(`${EXT}/switcher`, { method: "POST", as: staff, body: { value: null } })).json).toEqual({ current: null });
    // A tenant admin is offered only the tenant roles she holds there.
    expect((await call(`${EXT}/roles`, { as: ann, tenant: acme })).json.items.map((role: { name: string }) => role.name)).toEqual(["multi-tenant-admin"]);
  });

  it("asks staff with no tenant chosen to choose one, rather than failing", async () => {
    root = await signIn("root@example.test");
    expect((await call(`${EXT}/switcher`, { method: "POST", as: root, body: { value: null } })).status).toBe(200);
    const page = await fetch(`${baseUrl}/dashboard/collections/${collectionId}`, { redirect: "manual", headers: { cookie: root.cookie! } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Choose one at the top of the page");
    const home = await fetch(`${baseUrl}/dashboard`, { redirect: "manual", headers: { cookie: root.cookie! } });
    expect(home.status).toBe(200);
    expect(await home.text()).not.toContain("acme-only-note");
    // Leaves each tenant's records as the cases after this one expect them.
    for (const [tenant, note] of [[acme, "acme-only-note"], [globex, "globex-only-note"]]) {
      const item = (await call(content(), { as: root, tenant })).json.items.find((entry: Item) => title(entry) === note);
      expect((await call(content(`/${item.id}`), { method: "DELETE", as: root, tenant })).status).toBe(204);
    }
  });

  it("binds an API key to one tenant", async () => {
    root = await signIn("root@example.test");
    const made = await call("/api/account/api-keys", { method: "POST", as: root, tenant: acme, body: { name: "acme key", permissions: ["record:list", "record:read"], expiresInDays: 1, scope: true } });
    expect(made.status, made.text).toBe(200);
    const key: Actor = { id: root.id, key: made.json.key };
    expect(titles((await call(content(), { as: key })).json)).toEqual(["same"]);
    const other = await call(content(), { as: key, tenant: globex });
    expect(other.status).toBe(403);
    expect(other.json.error.code).toBe("SCOPE_MISMATCH");
    expect((await call("/api/account/api-keys", { method: "POST", as: root, body: { name: "nowhere", permissions: ["record:list"], expiresInDays: 1, scope: true } })).json.error.code).toBe("SCOPE_REQUIRED");
  });

  describe("sites on tenants' domains", () => {
    const port = new URL(baseUrl).port;
    let pagesId: number;
    let acmeDomain: { id: number; record: { name: string; value: string } };

    /** Adds a domain to a tenant, puts its proof in DNS and verifies it. */
    async function verified(tenant: string, host: string) {
      const added = await call(`${EXT}/domains`, { method: "POST", as: root, tenant, body: { host } });
      expect(added.status, added.text).toBe(200);
      await setTxt(added.json.record.name, [added.json.record.value]);
      const checked = await call(`${EXT}/domains/${added.json.id}/verify`, { method: "POST", as: root, tenant });
      expect(checked.status, checked.text).toBe(200);
      return checked.json;
    }

    beforeAll(async () => {
      root = await signIn("root@example.test");
      const made = await call("/api/collections", { method: "POST", as: root, body: { name: "Tenant pages", slug: "tenant-pages", scoped: true, urlPattern: "/pages/:slug", fields: [{ name: "slug", type: "text", config: { required: true, unique: true } }, { name: "title", type: "text" }] } });
      expect(made.status, made.text).toBe(200);
      pagesId = made.json.id;
      const field = (name: string) => made.json.fields.find((item: { name: string }) => item.name === name).id;
      expect((await call(`/api/collections/${pagesId}/rules`, { method: "PUT", as: root, body: { listRule: "", viewRule: "", createRule: null, updateRule: null, deleteRule: null } })).status).toBe(200);
      for (const [tenant, text] of [[acme, "acme-home-page"], [globex, "globex-home-page"]]) {
        const page = await call(`/api/collections/${pagesId}/content`, { method: "POST", as: root, tenant, body: { status: "published", values: [{ fieldId: field("slug"), value: "home" }, { fieldId: field("title"), value: text }] } });
        expect(page.status, page.text).toBe(200);
      }
    });

    it("routes a domain only once DNS proves the tenant controls it", async () => {
      const added = await call(`${EXT}/domains`, { method: "POST", as: root, tenant: acme, body: { host: "https://Acme.Example.test/" } });
      expect(added.status, added.text).toBe(200);
      expect(added.json).toMatchObject({ host: "acme.example.test", verified: false, primary: false, record: { type: "TXT", name: "_cms-verification.acme.example.test" } });
      acmeDomain = added.json;
      // Not verified: the host is no tenant's, so the page isn't there.
      expect((await onHost("acme.example.test", "/pages/home")).status).toBe(404);
      const early = await call(`${EXT}/domains/${acmeDomain.id}/verify`, { method: "POST", as: root, tenant: acme });
      expect(early.status).toBe(400);
      expect(early.json.error.code).toBe("DOMAIN_NOT_VERIFIED");
      // The wrong value proves nothing.
      await setTxt(acmeDomain.record.name, ["cms-verification=someone-else"]);
      expect((await call(`${EXT}/domains/${acmeDomain.id}/verify`, { method: "POST", as: root, tenant: acme })).status).toBe(400);
      await setTxt(acmeDomain.record.name, [acmeDomain.record.value]);
      const done = await call(`${EXT}/domains/${acmeDomain.id}/verify`, { method: "POST", as: root, tenant: acme });
      expect(done.status, done.text).toBe(200);
      expect(done.json).toMatchObject({ verified: true, primary: true });
    });

    it("refuses domains that aren't one, are the dashboard's, or another tenant holds", async () => {
      for (const host of ["localhost", "127.0.0.1", "nodot", "a.localhost", "acme.example.test/path"]) {
        const r = await call(`${EXT}/domains`, { method: "POST", as: root, tenant: globex, body: { host } });
        expect(r.status, host).toBe(400);
      }
      const taken = await call(`${EXT}/domains`, { method: "POST", as: root, tenant: globex, body: { host: "acme.example.test" } });
      expect(taken.status).toBe(409);
      expect(taken.json.error.code).toBe("DOMAIN_UNAVAILABLE");
      // Only someone who manages domains, in the tenant they're for.
      expect((await call(`${EXT}/domains`, { as: ann, tenant: acme })).status).toBe(403);
      expect((await call(`${EXT}/domains`, { as: bob, tenant: globex })).status).toBe(403);
      // Another tenant's domain is as missing as one that never existed.
      expect((await call(`${EXT}/domains/${acmeDomain.id}/verify`, { method: "POST", as: root, tenant: globex })).status).toBe(404);
      expect((await call(`${EXT}/domains/${acmeDomain.id}`, { method: "DELETE", as: root, tenant: globex })).status).toBe(404);
    });

    it("serves each tenant's own pages on its domain", async () => {
      await verified(globex, "globex.example.test");
      const acmePage = await onHost("acme.example.test", "/pages/home");
      expect(acmePage.status, acmePage.text.slice(0, 300)).toBe(200);
      expect(acmePage.text).toContain("acme-home-page");
      expect(acmePage.text).not.toContain("globex-home-page");
      const globexPage = await onHost("globex.example.test", "/pages/home");
      expect(globexPage.status).toBe(200);
      expect(globexPage.text).toContain("globex-home-page");
      expect(globexPage.text).not.toContain("acme-home-page");
      // A visitor's header can't move them to another tenant: the domain decides.
      const named = await onHost("acme.example.test", "/pages/home", { headers: { "x-cms-tenant": globex } });
      expect(named.text).toContain("acme-home-page");
      expect(named.text).not.toContain("globex-home-page");
      // Through the API on the domain too, for a headless site.
      const resolved = await onHost("acme.example.test", "/api/resolve?path=/pages/home");
      expect(resolved.status, resolved.text).toBe(200);
      expect(JSON.parse(resolved.text).record.title).toBe("acme-home-page");
      // On a host no tenant has, scoped pages aren't there at all.
      expect((await onHost("nobody.example.test", "/pages/home")).status).toBe(404);
      expect((await call("/pages/home")).status).toBe(404);
    });

    it("keeps each tenant's redirects to its own site", async () => {
      const made = await call("/api/redirects", { method: "POST", as: root, tenant: acme, body: { from: "/old-home", to: "/pages/home", status: 301 } });
      expect(made.status, made.text).toBe(200);
      const moved = await onHost("acme.example.test", "/old-home");
      expect([301, 308]).toContain(moved.status);
      expect(moved.location).toContain("/pages/home");
      expect((await onHost("globex.example.test", "/old-home")).status).toBe(404);
      expect((await call("/api/redirects", { as: root, tenant: globex })).json.items).toEqual([]);
      // The same address can move somewhere else in another tenant.
      expect((await call("/api/redirects", { method: "POST", as: root, tenant: globex, body: { from: "/old-home", to: "/pages/elsewhere", status: 302 } })).status).toBe(200);
      expect((await call("/api/redirects", { as: root, tenant: acme })).json.items.map((item: { to: string }) => item.to)).toEqual(["/pages/home"]);
      expect((await call(`/api/redirects/${made.json.id}`, { method: "DELETE", as: root, tenant: globex })).status).toBe(404);
    });

    it("serves each tenant in the theme it chose, and the default where it chose none", async () => {
      // Both themes come with the build (TANSY_THEMES in global-setup.ts). Only the choice is a setting.
      const chose = await call("/api/settings/site", { method: "PUT", as: root, tenant: acme, body: { name: "", logoUrl: "", accentColor: "", theme: "blog" } });
      expect(chose.status, chose.text).toBe(200);
      expect(chose.json.theme).toBe("blog");
      const acmePage = await onHost("acme.example.test", "/pages/home");
      expect(acmePage.status, acmePage.text.slice(0, 300)).toBe(200);
      expect(acmePage.text).toContain('data-theme="blog"');
      expect(acmePage.text).toContain("acme-home-page");
      // Globex chose nothing, so it is served in the build's default theme.
      const globexPage = await onHost("globex.example.test", "/pages/home");
      expect(globexPage.text).toContain('data-theme="blank"');
      expect(globexPage.text).not.toContain('data-theme="blog"');
      // A theme no build installs is stored as none, which serves the default.
      const unknown = await call("/api/settings/site", { method: "PUT", as: root, tenant: acme, body: { name: "", logoUrl: "", accentColor: "", theme: "not-installed" } });
      expect(unknown.status, unknown.text).toBe(200);
      expect(unknown.json.theme).toBe("");
      expect((await onHost("acme.example.test", "/pages/home")).text).toContain('data-theme="blank"');
    });

    it("lets a tenant admin give their tenant's site its own name and colour, and no other's", async () => {
      const saved = await call("/api/settings/site", { method: "PUT", as: ann, tenant: acme, body: { name: "Acme Corp", logoUrl: "", accentColor: "#a1b2c3" } });
      expect(saved.status, saved.text).toBe(200);
      expect((await call("/api/settings/site", { method: "PUT", as: ann, tenant: globex, body: { name: "Not mine", logoUrl: "", accentColor: "" } })).status).toBe(404);
      // An editor in globex writes its records, not its site.
      expect((await call("/api/settings/site", { as: bob, tenant: globex })).status).toBe(403);
      // Instance settings stay out of a tenant admin's reach.
      expect((await call("/api/settings/auth", { as: ann, tenant: acme })).status).toBe(403);
      expect((await onHost("acme.example.test", "/pages/home")).text).toContain("#a1b2c3");
      expect((await onHost("globex.example.test", "/pages/home")).text).not.toContain("#a1b2c3");
    });

    // better-auth gets the same list, but switches its own origin check off under a test runner, so
    // the CMS's CSRF check, which reads the same list, is what this can see.
    it("trusts a verified domain's origin for writes, and no other", async () => {
      const write = (origin: string) => fetch(`${baseUrl}${content()}`, { method: "POST", headers: { origin, cookie: ann.cookie!, "x-cms-tenant": acme, "content-type": "application/json" }, body: JSON.stringify({ status: "published", values: [{ fieldId: titleId, value: `from ${origin}` }] }) });
      expect((await write(`http://acme.example.test:${port}`)).status).toBe(200);
      const refused = await write(`http://unverified.example.test:${port}`);
      expect(refused.status).toBe(403);
      expect((await refused.json()).error.code).toBe("CSRF_REJECTED");
    });

    it("stops routing a domain once it's removed", async () => {
      const removed = await call(`${EXT}/domains/${acmeDomain.id}`, { method: "DELETE", as: root, tenant: acme });
      expect(removed.status, removed.text).toBe(204);
      expect((await onHost("acme.example.test", "/pages/home")).status).toBe(404);
      expect((await call(`${EXT}/domains`, { as: root, tenant: acme })).json.items).toEqual([]);
      // Free again, for whoever proves they control it.
      const claimed = await verified(globex, "acme.example.test");
      expect(claimed.primary).toBe(false);
    });
  });
  /**
   * A tenant with no domain of its own is served under its short name on the instance's own
   * address: /acme/prefix/home. A verified domain still decides for everyone, so a path can
   * never move a visitor off a tenant's domain onto another tenant. The block above leaves
   * acme without a domain and globex with two, which is exactly the pair this needs.
   */
  describe("sites under a tenant's path prefix", () => {
    const instance = new URL(baseUrl).hostname;
    let prefixedId: number;

    beforeAll(async () => {
      root = await signIn("root@example.test");
      const made = await call("/api/collections", { method: "POST", as: root, body: { name: "Prefixed pages", slug: "prefixed-pages", scoped: true, urlPattern: "/prefix/:slug", fields: [{ name: "slug", type: "text", config: { required: true, unique: true } }, { name: "title", type: "text" }] } });
      expect(made.status, made.text).toBe(200);
      prefixedId = made.json.id;
      const field = (name: string) => made.json.fields.find((item: { name: string }) => item.name === name).id;
      expect((await call(`/api/collections/${prefixedId}/rules`, { method: "PUT", as: root, body: { listRule: "", viewRule: "", createRule: null, updateRule: null, deleteRule: null } })).status).toBe(200);
      for (const [tenant, slug, text] of [[acme, "acme-only", "acme-prefixed-page"], [globex, "globex-only", "globex-prefixed-page"]] as const) {
        const page = await call(`/api/collections/${prefixedId}/content`, { method: "POST", as: root, tenant, body: { status: "published", values: [{ fieldId: field("slug"), value: slug }, { fieldId: field("title"), value: text }] } });
        expect(page.status, page.text).toBe(200);
      }
    });

    it("serves each tenant's own pages under its short name, and only its own", async () => {
      const acmePage = await onHost(instance, "/acme/prefix/acme-only");
      expect(acmePage.status, acmePage.text.slice(0, 300)).toBe(200);
      expect(acmePage.text).toContain("acme-prefixed-page");
      expect(acmePage.text).not.toContain("globex-prefixed-page");
      // A tenant keeps its prefix once it has a domain too, so links shared before it don't break.
      const globexPage = await onHost(instance, "/globex/prefix/globex-only");
      expect(globexPage.status).toBe(200);
      expect(globexPage.text).toContain("globex-prefixed-page");
      // An address under the wrong tenant's prefix is as missing as one that never existed.
      expect((await onHost(instance, "/globex/prefix/acme-only")).status).toBe(404);
      expect((await onHost(instance, "/acme/prefix/globex-only")).status).toBe(404);
      // Without a prefix the instance's own address has no tenant, so no scoped page is there.
      expect((await onHost(instance, "/prefix/acme-only")).status).toBe(404);
      // Nor can a prefix name a tenant that doesn't exist.
      expect((await onHost(instance, "/nobody/prefix/acme-only")).status).toBe(404);
    });

    it("never lets a prefix move a visitor off a tenant's verified domain", async () => {
      // globex.example.test is globex's, so the path is read as one of globex's own addresses.
      expect((await onHost("globex.example.test", "/acme/prefix/acme-only")).status).toBe(404);
      const own = await onHost("globex.example.test", "/prefix/globex-only");
      expect(own.status).toBe(200);
      expect(own.text).toContain("globex-prefixed-page");
      // Its own prefix on its own domain is still its own site, never another tenant's.
      const twice = await onHost("globex.example.test", "/globex/prefix/globex-only");
      expect(twice.status).toBe(200);
      expect(twice.text).toContain("globex-prefixed-page");
      expect(twice.text).not.toContain("acme-prefixed-page");
    });

    it("puts the prefix on the addresses the site hands back: redirects and previews", async () => {
      const made = await call("/api/redirects", { method: "POST", as: root, tenant: acme, body: { from: "/prefix/was-here", to: "/prefix/acme-only", status: 301 } });
      expect(made.status, made.text).toBe(200);
      const moved = await onHost(instance, "/acme/prefix/was-here");
      expect([301, 308]).toContain(moved.status);
      expect(moved.location).toBe("/acme/prefix/acme-only");
      // The same address without the prefix belongs to no tenant.
      expect((await onHost(instance, "/prefix/was-here")).status).toBe(404);

      // A preview opens where the record lives, which for acme is under its prefix.
      const page = (await call(`/api/collections/${prefixedId}/content`, { as: root, tenant: acme })).json.items[0];
      const token = await call(`/api/collections/${prefixedId}/content/${page.id}/preview-token`, { method: "POST", as: root, tenant: acme, body: {} });
      expect(token.status, token.text).toBe(200);
      const entered = await onHost(instance, `/api/preview/enter?token=${encodeURIComponent(token.json.token)}`, { headers: { cookie: root.cookie!, "x-cms-tenant": acme } });
      expect(entered.status).toBe(307);
      expect(entered.location).toBe("/acme/prefix/acme-only");
    });

    it("leaves the API unprefixed, for a headless site that routes for itself", async () => {
      const resolved = await call("/api/resolve?path=/prefix/acme-only", { as: root, tenant: acme });
      expect(resolved.status, resolved.text).toBe(200);
      expect(resolved.json).toMatchObject({ type: "record", path: "/prefix/acme-only" });
      expect(resolved.json.record.title).toBe("acme-prefixed-page");
      // The prefix is the site layer's: through the API it is just an address nothing is at.
      expect((await call("/api/resolve?path=/acme/prefix/acme-only", { as: root, tenant: acme })).status).toBe(404);
      // A redirect the API answers with is the stored address, with no prefix on it.
      const moved = await call("/api/resolve?path=/prefix/was-here", { as: root, tenant: acme });
      expect(moved.json).toMatchObject({ type: "redirect", to: "/prefix/acme-only" });
    });
  });

  describe("a tenant's life: limits, suspending, export, import and purge", () => {
    let initech: string;
    let fileId: string;

    const upload = async (name: string, tenant: string) => {
      const response = await fetch(`${baseUrl}/api/files/upload?name=${name}`, { method: "POST", headers: { origin: baseUrl, cookie: root.cookie!, "content-type": "text/plain", "x-cms-tenant": tenant }, body: `bytes of ${name}` });
      const json = await response.json();
      return { status: response.status, json };
    };

    beforeAll(async () => {
      root = await signIn("root@example.test");
      const made = await call(`${EXT}/tenants`, { method: "POST", as: root, body: { name: "Initech", slug: "initech" } });
      expect(made.status, made.text).toBe(200);
      initech = made.json.id;
      for (const text of ["tps-report", "stapler"]) expect((await create(text, root, initech)).status).toBe(200);
      const file = await upload("memo.txt", initech);
      expect(file.status, JSON.stringify(file.json)).toBe(200);
      fileId = file.json.id;
    });

    it("counts what a tenant uses, and holds it to its limits", async () => {
      const plan = await call(`${EXT}/tenants/${initech}/plan`, { as: root });
      expect(plan.status, plan.text).toBe(200);
      expect(plan.json.usage).toMatchObject({ records: 2, files: 1, members: 1 });
      expect(plan.json.limits).toEqual({ records: null, storageBytes: null, members: null, requestsPerMinute: null });
      // Only staff who may change tenants.
      expect((await call(`${EXT}/tenants/${initech}/plan`, { as: ann })).status).toBe(403);
      expect((await call(`${EXT}/tenants/${initech}/limits`, { method: "PUT", as: ann, body: { records: 1, storageBytes: null, members: null, requestsPerMinute: null } })).status).toBe(403);

      const limited = await call(`${EXT}/tenants/${initech}/limits`, { method: "PUT", as: root, body: { records: 3, storageBytes: 10, members: 1, requestsPerMinute: null } });
      expect(limited.status, limited.text).toBe(200);
      expect((await create("third", root, initech)).status).toBe(200);
      const full = await create("fourth", root, initech);
      expect(full.status).toBe(403);
      expect(full.json.error.code).toBe("SCOPE_LIMIT_REACHED");
      // Another tenant isn't held to it.
      expect((await create("acme-fourth", root, acme)).status).toBe(200);
      const big = await upload("big.txt", initech);
      expect(big.status).toBe(403);
      expect(big.json.error.code).toBe("SCOPE_LIMIT_REACHED");
      const invited = await call(`${EXT}/invitations`, { method: "POST", as: root, tenant: initech, body: { email: "someone@example.test", roles: ["multi-tenant-editor"] } });
      expect(invited.status).toBe(403);
      expect(invited.json.error.code).toBe("SCOPE_LIMIT_REACHED");

      expect((await call(`${EXT}/tenants/${initech}/limits`, { method: "PUT", as: root, body: { records: null, storageBytes: null, members: null, requestsPerMinute: 2 } })).status).toBe(200);
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) statuses.push((await call(content(), { as: root, tenant: initech })).status);
      expect(statuses).toEqual([200, 200, 429]);
      expect((await call(content(), { as: root, tenant: acme })).status).toBe(200);
      expect((await call(`${EXT}/tenants/${initech}/limits`, { method: "PUT", as: root, body: { records: null, storageBytes: null, members: null, requestsPerMinute: null } })).status).toBe(200);
      expect((await call(content(), { as: root, tenant: initech })).status).toBe(200);
    });

    it("closes a suspended tenant to everyone, and purges only one that's suspended, after its short name is typed", async () => {
      const early = await call(`${EXT}/tenants/${initech}/purge`, { method: "POST", as: root, body: { confirm: "initech" } });
      expect(early.status).toBe(409);
      expect(early.json.error.code).toBe("NOT_SUSPENDED");
      expect((await call(`${EXT}/tenants/${initech}/suspend`, { method: "POST", as: ann })).status).toBe(403);
      expect((await call(`${EXT}/tenants/${initech}/suspend`, { method: "POST", as: root })).status).toBe(200);
      expect((await call(content(), { as: root, tenant: initech })).status).toBe(404);
      expect((await call(`/api/files/${fileId}`, { as: root, tenant: initech })).status).toBe(404);

      const wrong = await call(`${EXT}/tenants/${initech}/purge`, { method: "POST", as: root, body: { confirm: "acme" } });
      expect(wrong.status).toBe(400);
      expect(wrong.json.error.code).toBe("CONFIRMATION_MISMATCH");
      const asked = await call(`${EXT}/tenants/${initech}/purge`, { method: "POST", as: root, body: { confirm: "initech" } });
      expect(asked.status, asked.text).toBe(200);
      expect(Date.parse(asked.json.purgeAt)).toBeGreaterThan(Date.now() + 6 * 86_400_000);
      expect((await call(`${EXT}/tenants/${initech}/plan`, { as: root })).json.purgeAt).toBe(asked.json.purgeAt);
      // Resuming keeps everything, and calls the purge off.
      expect((await call(`${EXT}/tenants/${initech}/resume`, { method: "POST", as: root })).status).toBe(200);
      expect((await call(`${EXT}/tenants/${initech}/plan`, { as: root })).json.purgeAt).toBeNull();
      expect(titles((await call(content(), { as: root, tenant: initech })).json)).toEqual(["stapler", "third", "tps-report"]);
    });

    it("exports a tenant, and imports it into an empty one, which then serves the same records and files", async () => {
      expect((await call(`${EXT}/tenants/${initech}/export`, { as: ann })).status).toBe(403);
      const exported = await fetch(`${baseUrl}${EXT}/tenants/${initech}/export`, { headers: { origin: baseUrl, cookie: root.cookie! } });
      expect(exported.status).toBe(200);
      expect(exported.headers.get("content-type")).toBe("application/gzip");
      const archive = Buffer.from(await exported.arrayBuffer());
      expect(archive.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));

      const made = await call(`${EXT}/tenants`, { method: "POST", as: root, body: { name: "Initech Two", slug: "initech-two" } });
      expect(made.status, made.text).toBe(200);
      const copy = made.json.id as string;
      const importInto = (tenant: string) => fetch(`${baseUrl}${EXT}/tenants/${tenant}/import`, { method: "POST", headers: { origin: baseUrl, cookie: root.cookie!, "content-type": "application/gzip" }, body: archive });

      // Records and files keep their ids, so the same archive can't go in while the original is here.
      const clash = await importInto(copy);
      expect(clash.status).toBe(409);
      expect((await clash.json()).error.code).toBe("SCOPE_IMPORT_CONFLICT");
      // Nor into a tenant that has data already.
      expect((await importInto(acme)).status).toBe(409);

      // The original goes, as on another instance it never was.
      for (const item of (await call(content(), { as: root, tenant: initech })).json.items as Item[]) {
        expect((await call(content(`/${item.id}`), { method: "DELETE", as: root, tenant: initech })).status).toBeLessThan(300);
      }
      expect((await call(`/api/files/${fileId}`, { method: "DELETE", as: root, tenant: initech })).status).toBeLessThan(300);

      const placed = await importInto(copy);
      const placedJson = await placed.json();
      expect(placed.status, JSON.stringify(placedJson)).toBe(200);
      expect(placedJson).toMatchObject({ records: 3, files: 1 });
      expect(titles((await call(content(), { as: root, tenant: copy })).json)).toEqual(["stapler", "third", "tps-report"]);
      const file = await call(`/api/files/${fileId}`, { as: root, tenant: copy });
      expect(file.status).toBe(200);
      expect(file.text).toBe("bytes of memo.txt");
      // Still its own tenant's only.
      expect((await call(`/api/files/${fileId}`, { as: root, tenant: acme })).status).toBe(404);
      expect(titles((await call(content(), { as: root, tenant: acme })).json)).not.toContain("stapler");
    });
  });

  /**
   * The plugin's agent tools (plugins/multi-tenant/tools.ts), over MCP at /api/mcp, which is how an
   * outside agent reaches them. What each caller is offered is what their permissions allow, and a
   * tool they aren't offered can't be called either.
   */
  describe("tenants over MCP", () => {
    const rpc = async (as: Actor, method: string, params?: unknown, tenant?: string) =>
      (await call("/api/mcp", { method: "POST", as, tenant, body: { jsonrpc: "2.0", id: 1, method, params } })).json;
    const toolNames = async (as: Actor) =>
      ((await rpc(as, "tools/list")).result.tools as Array<{ name: string }>).map((tool) => tool.name).filter((name) => name.startsWith("multi_tenant_")).sort();
    const callTool = (as: Actor, name: string, args: Record<string, unknown> = {}, tenant?: string) => rpc(as, "tools/call", { name, arguments: args }, tenant);
    const text = (answer: { result: { content: Array<{ text: string }>; isError?: boolean } }) => JSON.parse(answer.result.content[0].text);

    let demo: string;
    beforeAll(async () => {
      // Making a tenant and setting its limits are both `fresh` routes, and this block runs late.
      root = await signIn("root@example.test");
      const made = await call(`${EXT}/tenants`, { method: "POST", as: root, body: { name: "MCP Demo", slug: "mcpdemo" } });
      expect(made.status, made.text).toBe(200);
      demo = made.json.id;
    });

    it("offers staff the reading tools, and the tenant's own admin only what is theirs", async () => {
      expect(await toolNames(root)).toEqual([
        "multi_tenant_describe_tenant", "multi_tenant_list_domains", "multi_tenant_list_members",
        "multi_tenant_list_tenants", "multi_tenant_resume_tenant", "multi_tenant_suspend_tenant",
      ]);
      // Ann runs one tenant: members are hers, and nothing that reaches across tenants is.
      expect(await toolNames(ann)).toEqual(["multi_tenant_list_members", "multi_tenant_list_tenants"]);
      // Staff read every tenant, but suspending one is not theirs.
      expect(await toolNames(staff)).toEqual(["multi_tenant_describe_tenant", "multi_tenant_list_tenants"]);
      // A tenant editor manages nobody.
      expect(await toolNames(bob)).toEqual(["multi_tenant_list_tenants"]);
    });

    it("gives each caller their own tenants, and the members of the one they work in", async () => {
      const mine = text(await callTool(ann, "multi_tenant_list_tenants"));
      expect(mine.items.map((item: { id: string }) => item.id)).toEqual([acme]);
      expect(mine.items[0].roles).toEqual(["multi-tenant-admin"]);

      const members = text(await callTool(ann, "multi_tenant_list_members"));
      expect(members.tenant.id).toBe(acme);
      // Root made acme, so better-auth made it the first member, and Ann was invited into it.
      expect(members.items.map((item: { email: string }) => item.email).sort()).toEqual(["mtann@example.test", "root@example.test"]);
      // Root works in no tenant unless it names one, so the same tool has nothing to list.
      const none = await callTool(root, "multi_tenant_list_members");
      expect(none.result.isError).toBe(true);
      expect(none.result.content[0].text).toContain("SCOPE_REQUIRED");
    });

    it("refuses a tool the caller isn't offered, naming no tenant either way", async () => {
      for (const [actor, name, args] of [
        [ann, "multi_tenant_suspend_tenant", { tenant: globex }],
        [ann, "multi_tenant_describe_tenant", { tenant: globex }],
        [staff, "multi_tenant_suspend_tenant", { tenant: acme }],
        [bob, "multi_tenant_list_members", {}],
      ] as Array<[Actor, string, Record<string, unknown>]>) {
        const answer = await callTool(actor, name, args);
        expect(answer.result.isError, `${name} as ${actor.id}`).toBe(true);
        expect(answer.result.content[0].text).toContain("UNKNOWN_TOOL");
      }
      // Still suspended by nobody.
      expect(text(await callTool(root, "multi_tenant_describe_tenant", { tenant: acme })).status).toBe("active");
    });

    it("reports a tenant's limits and what it is using, without its domains", async () => {
      expect((await call(`${EXT}/tenants/${demo}/limits`, { method: "PUT", as: root, body: { records: 50, storageBytes: 4096, members: 2, requestsPerMinute: null } })).status).toBe(200);
      const described = text(await callTool(staff, "multi_tenant_describe_tenant", { tenant: demo }));
      expect(described).toMatchObject({ id: demo, slug: "mcpdemo", status: "active", limits: { records: 50, storageBytes: 4096, members: 2, requestsPerMinute: null } });
      expect(described.usage).toMatchObject({ members: 1 });
      expect(described).not.toHaveProperty("domains");
    });

    it("lists the domains of the tenant being worked in, and never a claim's token", async () => {
      const claimed = await call(`${EXT}/domains`, { method: "POST", as: root, body: { host: "mcpdemo.example" }, tenant: demo });
      expect(claimed.status, claimed.text).toBe(200);
      // The proof the tenant's DNS must hold. A model is never told it, which is what this checks.
      const proof = claimed.json.record.value as string;
      expect(proof.length).toBeGreaterThan(8);

      const answer = await callTool(root, "multi_tenant_list_domains", {}, demo);
      const domains = text(answer);
      expect(domains.tenant.id).toBe(demo);
      expect(domains.items.map((item: { host: string; verified: boolean }) => `${item.host}:${item.verified}`)).toEqual(["mcpdemo.example:false"]);
      // The proof stays out of what a model is told, as it does on the record.
      expect(answer.result.content[0].text).not.toContain(proof);

      // Without a tenant to work in there is nothing to list, rather than another tenant's.
      const none = await callTool(root, "multi_tenant_list_domains");
      expect(none.result.isError).toBe(true);
      expect(none.result.content[0].text).toContain("SCOPE_REQUIRED");
    });

    it("suspends and resumes a tenant, and the audit entry names the tenant and the tool", async () => {
      expect(text(await callTool(root, "multi_tenant_suspend_tenant", { tenant: demo })).status).toBe("suspended");
      // A suspended tenant resolves for nobody, so its own API answers nothing for it.
      expect((await call(`${EXT}/tenant`, { as: root, tenant: demo })).status).toBe(404);

      const entries = (await call(`/api/audit?perPage=100`, { as: root })).json.items as Array<{ action: string; targetType: string; targetId: string }>;
      const entry = entries.find((item) => item.action === "multi_tenant.suspend" && item.targetId === demo);
      expect(entry, entries.map((item) => item.action).join(",")).toBeTruthy();
      // The tenant is the entry's target, and the tool that did it is in the entry too.
      expect(entry!.targetType).toBe("tenant");
      expect(JSON.stringify(entry)).toContain("multi_tenant_suspend_tenant");
      expect(JSON.stringify(entry)).toContain("mcp");

      expect(text(await callTool(root, "multi_tenant_resume_tenant", { tenant: demo })).status).toBe("active");
      expect((await call(`${EXT}/tenant`, { as: root, tenant: demo })).json.slug).toBe("mcpdemo");
    });
  });

});
