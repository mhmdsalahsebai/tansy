/**
 * The forms plugin, installed the way a site owner would: on in tansy.config.ts and nothing
 * else. Visitors send forms signed out, so this is the suite for anonymous writes. The
 * CAPTCHA plugin is on too, with Turnstile's keys set and its answers checked by the test
 * verifier, which accepts "good-token". Runs after auth.test.ts, which points mail at the
 * test SMTP server.
 */
import net from "node:net";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const base = inject("baseUrl");
const PASSWORD = "correct-horse-battery-staple-9431";

interface Actor { id: string; cookie: string }
let root: Actor, member: Actor;

async function call(path: string, { method = "GET", body, as, ip }: { method?: string; body?: unknown; as?: Actor | null; ip?: string } = {}) {
  const response = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: { origin: base, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(as ? { cookie: as.cookie } : {}), ...(ip ? { "x-forwarded-for": ip } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any -- API responses have many shapes
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, text, headers: response.headers };
}

async function signIn(email: string): Promise<Actor> {
  const r = await call("/api/auth/sign-in/email", { method: "POST", body: { email, password: PASSWORD } });
  expect(r.status, r.text).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).filter((pair) => !pair.endsWith("=")).join("; ");
  return { id: r.json.user.id, cookie };
}

const mailbox = () => new Promise<string[]>((resolve, reject) => {
  let data = "";
  net.connect(2588, "127.0.0.1").on("data", (c) => (data += c)).on("end", () => resolve(JSON.parse(data))).on("error", reject);
});
const decodeMail = (raw: string) => raw.replace(/=\n/g, "").replace(/=3D/g, "=");

async function mailTo(to: string, match: RegExp) {
  for (let i = 0; i < 40; i++) {
    const found = (await mailbox()).map(decodeMail).reverse().find((m) => m.includes(to) && match.test(m));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No mail for ${to} matching ${match}`);
}

const FORMS = "/api/collections/forms-forms/records";
const SUBMISSIONS = "/api/collections/forms-submissions/records";
const SETTINGS = "/api/extensions/forms/settings";
const NOTIFY = "forms-owner@example.test";

const field = (type: string, value: Record<string, unknown>) => ({ id: `f-${String(value.name)}`, type, v: 1, value });
const FIELDS = [
  field("forms_text", { name: "name", label: "Your name", required: true }),
  field("forms_email", { name: "email", label: "Email", required: true }),
  field("forms_select", { name: "topic", label: "Topic", options: "Sales\nSupport" }),
  field("forms_textarea", { name: "message", label: "Message", required: true }),
];

async function createForm(values: Record<string, unknown>) {
  const r = await call(FORMS, { method: "POST", as: root, body: { status: "published", title: "Contact us", fields: FIELDS, notify: NOTIFY, ...values } });
  expect(r.status, r.text).toBe(200);
  return r.json.id as number;
}

async function saveSettings(changes: Record<string, unknown>) {
  const current = await call(SETTINGS, { as: root });
  expect(current.status, current.text).toBe(200);
  const saved = await call(SETTINGS, { method: "PUT", as: root, body: { values: { ...current.json.values, ...changes } } });
  expect(saved.status, saved.text).toBe(200);
}

const open = (id: number, ip?: string) => call(`/api/ext/forms/forms/${id}`, { ip });
const submit = (id: number, body: Record<string, unknown>, ip: string) => call(`/api/ext/forms/forms/${id}/submit`, { method: "POST", body, ip });
const answers = { name: "Ada Visitor", email: "ada.visitor@example.test", topic: "Support", message: "Hello.\nCan you help?" };
const submissionsOf = async (form: number) => (await call(`${SUBMISSIONS}?filter=${encodeURIComponent(`form = ${form}`)}&perPage=50`, { as: root })).json.items as Array<Record<string, unknown>>;

let guarded: number, plain: number;

beforeAll(async () => {
  root = await signIn("root@example.test");
  const created = await call("/api/users", { method: "POST", as: root, body: { name: "formsmember", email: "formsmember@example.test", password: PASSWORD, role: "user" } });
  expect(created.status, created.text).toBe(200);
  member = await signIn("formsmember@example.test");
  guarded = await createForm({ title: "Contact us", captcha: true, successMessage: "Thanks, we'll be in touch." });
  plain = await createForm({ title: "Feedback", captcha: false });
});

afterAll(async () => {
  if (root) await saveSettings({ minSeconds: 3 });
});

describe("forms plugin: reading a form", () => {
  it("serves a published form to visitors, without its private fields", async () => {
    const form = await open(guarded);
    expect(form.status, form.text).toBe(200);
    expect(form.json).toMatchObject({ id: guarded, title: "Contact us", submitLabel: "Send" });
    expect(form.json.fields.map((f: { name: string }) => f.name)).toEqual(["name", "email", "topic", "message"]);
    expect(form.json.captcha).toMatchObject({ provider: "turnstile", siteKey: "public-site-key" });
    expect(form.json.token).toMatch(/^\d{13}\.[0-9a-f]{64}$/);
    expect(form.text).not.toContain(NOTIFY);
    expect(form.text).not.toContain("captcha-secret-value");
    expect(form.headers.get("cache-control")).toBe("no-store");
    expect((await open(plain)).json.captcha).toBeNull();
  });

  it("hides drafts and missing forms alike, and never lists forms or submissions to visitors", async () => {
    const draft = await createForm({ status: "draft", title: "Secret survey" });
    const [hidden, missing] = await Promise.all([open(draft), open(999_999)]);
    expect([hidden.status, missing.status]).toEqual([404, 404]);
    expect(hidden.text).toBe(missing.text);
    expect((await call(FORMS)).status).toBe(403);
    expect((await call(SUBMISSIONS)).status).toBe(403);
    expect((await call(SUBMISSIONS, { as: member })).status).toBe(403);
    expect((await call(`/api/ext/forms/forms/${draft}/submit`, { method: "POST", body: { values: answers, token: "x" }, ip: "203.0.113.50" })).status).toBe(404);
  });

  it("refuses a form whose fields share a name", async () => {
    const r = await call(FORMS, { method: "POST", as: root, body: { status: "published", title: "Twice", fields: [...FIELDS, field("forms_text", { name: "email", label: "Again" })].map((item, index) => ({ ...item, id: `t${index}` })) } });
    expect(r.status).toBe(400);
    expect(r.text).toContain('Two fields are named \\"email\\"');
  });
});

describe("forms plugin: sending", () => {
  it("refuses a form sent faster than a person could fill it in, and a token that isn't ours", async () => {
    const { json } = await open(guarded);
    const fast = await submit(guarded, { values: answers, token: json.token, answer: "good-token" }, "203.0.113.10");
    expect([fast.status, fast.json.error.code]).toEqual([400, "TOO_FAST"]);
    const forged = await submit(guarded, { values: answers, token: `${Date.now() - 60_000}.${"0".repeat(64)}`, answer: "good-token" }, "203.0.113.11");
    expect(forged.json.error.code).toBe("FORM_EXPIRED");
    // The rest of the suite doesn't wait.
    await saveSettings({ minSeconds: 0 });
  });

  it("asks for the CAPTCHA's answer and checks it with the provider", async () => {
    const { json } = await open(guarded);
    const missing = await submit(guarded, { values: answers, token: json.token }, "203.0.113.12");
    expect([missing.status, missing.json.error.code]).toEqual([400, "CAPTCHA_REQUIRED"]);
    const wrong = await submit(guarded, { values: answers, token: json.token, answer: "wrong" }, "203.0.113.12");
    expect([wrong.status, wrong.json.error.code]).toEqual([403, "CAPTCHA_FAILED"]);
    expect(await submissionsOf(guarded)).toEqual([]);
  });

  it("keeps what was sent, only the fields the form asks, and emails the owner with the visitor as reply-to", async () => {
    const { json } = await open(guarded);
    const sent = await submit(guarded, { values: { ...answers, isAdmin: true, state: "done" }, token: json.token, answer: "good-token", page: "/contact" }, "203.0.113.13");
    expect(sent.status, sent.text).toBe(200);
    expect(sent.json).toEqual({ ok: true, message: "Thanks, we'll be in touch." });
    const [saved] = await submissionsOf(guarded);
    expect(saved).toMatchObject({ form: guarded, email: "ada.visitor@example.test", page: "/contact", state: "new", data: { name: "Ada Visitor", email: "ada.visitor@example.test", topic: "Support", message: "Hello.\nCan you help?" } });
    expect(saved.data).not.toHaveProperty("isAdmin");
    const mail = await mailTo(NOTIFY, /New submission: Contact us/);
    expect(mail).toMatch(/Reply-To: ada\.visitor@example\.test/i);
    expect(mail).toContain("Your name");
    expect(mail).toContain("Ada Visitor");
    // The visitor is never sent anything, so a form can't be used to email strangers.
    expect((await mailbox()).some((m) => /^To: .*ada\.visitor@example\.test/im.test(decodeMail(m)))).toBe(false);
  });

  it("says which answers to fix, and keeps nothing", async () => {
    const { json } = await open(plain);
    const r = await submit(plain, { values: { name: "", email: "nope", topic: "Hacking", message: "Hi" }, token: json.token }, "203.0.113.20");
    expect([r.status, r.json.error.code]).toEqual([400, "INVALID_ANSWERS"]);
    expect(r.json.fields).toEqual({ name: "Fill in this field.", email: "Enter an email address.", topic: "Choose one of the options." });
    expect((await submit(plain, { values: { name: { $gt: "" } }, token: json.token }, "203.0.113.20")).status).toBe(400);
    expect(await submissionsOf(plain)).toEqual([]);
  });

  it("answers a filled trap field as if it worked, and keeps nothing", async () => {
    const { json } = await open(plain);
    const r = await submit(plain, { values: answers, token: json.token, website: "https://spam.example" }, "203.0.113.21");
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(await submissionsOf(plain)).toEqual([]);
  });

  it("limits how often one address sends a form", async () => {
    const { json } = await open(plain);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await submit(plain, { values: { ...answers, message: `Try ${i}` }, token: json.token }, "203.0.113.30")).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    // Another address isn't held up by it.
    expect((await submit(plain, { values: answers, token: json.token }, "203.0.113.31")).status).toBe(200);
    expect(await submissionsOf(plain)).toHaveLength(6);
  });
});

describe("forms plugin: dashboard", () => {
  it("tells staff whether email and a CAPTCHA are set up, and nobody else", async () => {
    const status = await call("/api/ext/forms/status", { as: root });
    expect(status.json).toEqual({ mail: true, captcha: true });
    expect((await call("/api/ext/forms/status", { as: member })).status).toBe(403);
    expect((await call("/api/ext/forms/status")).status).toBe(401);
    const page = await call("/dashboard/ext/forms", { as: root });
    expect(page.status).toBe(200);
    expect(page.text).toContain("Contact us");
  });

  it("names its fields and blocks' fields in Arabic, through its migration and in its code", async () => {
    type Field = { name: string; config?: { labels?: Record<string, string>; options?: Array<{ value: string; labels?: Record<string, string> }> } };
    const collections = (await call("/api/collections", { as: root })).json as Array<{ slug: string; fields: Field[] }>;
    const fields = collections.find((collection) => collection.slug === "forms-forms")!.fields;
    expect(fields.find((f) => f.name === "title")?.config?.labels?.ar).toBeTruthy();
    const blocks = (await call("/api/block-types", { as: root })).json as Array<{ name: string; version: number; fields: Field[] }>;
    // A block the migration applied, and one the plugin defines in code.
    expect(blocks.find((b) => b.name === "forms_embed")?.fields.find((f) => f.name === "form")?.config?.labels?.ar).toBe("النموذج");
    const text = blocks.find((b) => b.name === "forms_text")!;
    expect(text.fields.find((f) => f.name === "label")?.config?.labels?.ar).toBe("التسمية");
    // Words don't change what a stored block holds, so they don't start a new version.
    expect(text.version).toBe(1);
  });
});
