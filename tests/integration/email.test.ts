/**
 * The email plugin, installed the way a site owner would: on in tansy.config.ts, with a
 * provider's key entered under Email → Settings. Runs after auth.test.ts, whose every
 * email went through SMTP with this plugin installed but not set up yet.
 *
 * Nothing here reaches a provider with a real key. With a made-up Resend key the provider
 * refuses the message, or can't be reached, which is what the log and the test route are
 * checked against.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const base = inject("baseUrl");
const PASSWORD = "correct-horse-battery-staple-9431";

interface Actor { id: string; cookie: string; email: string }
let root: Actor, member: Actor;

async function call(path: string, { method = "GET", body, as }: { method?: string; body?: unknown; as?: Actor | null } = {}) {
  const response = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: { origin: base, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(as ? { cookie: as.cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any -- API responses have many shapes
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, text };
}

async function signIn(email: string): Promise<Actor> {
  const response = await fetch(`${base}/api/auth/sign-in/email`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie().map((c) => c.split(";")[0]).filter((pair) => !pair.endsWith("=")).join("; ");
  return { id: (await response.json()).user.id, cookie, email };
}

const MESSAGES = "/api/collections/email-messages/records";
const SETTINGS = "/api/extensions/email/settings";

async function saveSettings(changes: Record<string, unknown>) {
  const current = await call(SETTINGS, { as: root });
  expect(current.status, current.text).toBe(200);
  const saved = await call(SETTINGS, { method: "PUT", as: root, body: { values: { ...current.json.values, ...changes } } });
  expect(saved.status, saved.text).toBe(200);
  return saved;
}

beforeAll(async () => {
  root = await signIn("root@example.test");
  const created = await call("/api/users", { method: "POST", as: root, body: { name: "mailreader", email: "mailreader@example.test", password: PASSWORD, role: "user" } });
  expect(created.status, created.text).toBe(200);
  member = await signIn("mailreader@example.test");
});

afterAll(async () => {
  // Back to SMTP, for any suite after this one.
  if (root) await saveSettings({ resendApiKey: "" });
});

describe("email plugin", () => {
  it("leaves mail to SMTP until a provider is set up", async () => {
    const settings = await call("/api/settings/auth", { as: root });
    expect(settings.json.mail.active).toBeNull();
    expect((await call("/api/settings/auth/test-email", { method: "POST", as: root })).status).toBe(204);
    expect((await call(`${MESSAGES}?perPage=200`, { as: root })).json.items).toEqual([]);
  });

  it("keeps its log from everyone without record permissions", async () => {
    expect((await call(MESSAGES)).status).toBeGreaterThanOrEqual(400);
    const listed = await call(MESSAGES, { as: member });
    expect(listed.status === 403 || (listed.status === 200 && listed.json.items.length === 0), listed.text).toBe(true);
    // Locked, so only staff holding record permissions could write it, as with every plugin's locked collection.
    expect((await call(MESSAGES, { method: "POST", as: member, body: { recipient: "x@example.test", state: "sent" } })).status).toBe(403);
  });

  it("never shows a provider key once saved", async () => {
    await saveSettings({ provider: "resend", resendApiKey: "re_integration_not_a_real_key", fromAddress: "cms@example.test" });
    const read = await call(SETTINGS, { as: root });
    expect(read.text).not.toContain("re_integration_not_a_real_key");
    expect(read.json.values.resendApiKey).not.toBe("");
  });

  it("sends through the provider once set up, and logs a refusal by its status alone", async () => {
    expect((await call("/api/settings/auth", { as: root })).json.mail.active).toBe("email");
    const sent = await call("/api/settings/auth/test-email", { method: "POST", as: root });
    expect(sent.status).toBe(502);
    expect(sent.text).not.toContain("re_integration");
    const { items } = (await call(`${MESSAGES}?perPage=200&sort=-createdAt`, { as: root })).json;
    expect(items[0]).toMatchObject({ recipient: "root@example.test", kind: "test", provider: "resend", state: "failed" });
    expect(items[0].error).toMatch(/^(HTTP \d{3}|unreachable)$/);
    expect(JSON.stringify(items[0])).not.toContain("working");
  });

  it("goes back to SMTP when the key is cleared", async () => {
    await saveSettings({ resendApiKey: "" });
    expect((await call("/api/settings/auth", { as: root })).json.mail.active).toBeNull();
    expect((await call("/api/settings/auth/test-email", { method: "POST", as: root })).status).toBe(204);
  });
});
