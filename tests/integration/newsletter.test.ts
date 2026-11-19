/**
 * The newsletter plugin, installed the way a site owner would: on in tansy.config.ts and
 * nothing else. Visitors sign up signed out, confirm and unsubscribe from links in email,
 * and campaigns go to everyone in batches through the real mail path, here the test SMTP
 * server. The CAPTCHA plugin is on, with Turnstile's keys set and answers checked by the
 * test verifier, which accepts "good-token". Runs after auth.test.ts, which sets up mail.
 */
import net from "node:net";
import { beforeAll, describe, expect, inject, it } from "vitest";

const base = inject("baseUrl");
const PASSWORD = "correct-horse-battery-staple-9431";

interface Actor { id: string; cookie: string }
let root: Actor, member: Actor;

async function call(path: string, { method = "GET", body, raw, as, ip, type }: { method?: string; body?: unknown; raw?: string; as?: Actor | null; ip?: string; type?: string } = {}) {
  const response = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: {
      ...(as ? { origin: base, cookie: as.cookie } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : type ? { "content-type": type } : {}),
      ...(ip ? { "x-forwarded-for": ip } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : raw,
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
/** Quoted-printable undone, and folded header lines joined, so links and headers read whole. */
const decodeMail = (raw: string) => raw.replace(/=\n/g, "").replace(/=3D/g, "=").replace(/\n[ \t]+/g, " ");
const mailsTo = async (to: string, match: RegExp) => (await mailbox()).map(decodeMail).filter((m) => new RegExp(`^To: .*${to.replace(/[.+]/g, "\\$&")}`, "im").test(m) && match.test(m));

async function mailTo(to: string, match: RegExp) {
  for (let i = 0; i < 60; i++) {
    const [found] = (await mailsTo(to, match)).reverse();
    if (found) return found;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No mail for ${to} matching ${match}`);
}

const SUBSCRIBERS = "/api/collections/newsletter-subscribers/records";
const CAMPAIGNS = "/api/collections/newsletter-campaigns/records";
const ext = (path: string) => `/api/ext/newsletter${path}`;
const rich = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

let formToken = "";
const subscribe = (body: Record<string, unknown>, ip: string, as?: Actor) => call(ext("/subscribe"), { method: "POST", body: { token: formToken, answer: "good-token", ...body }, ip, as });
const subscriber = async (email: string) => (await call(`${SUBSCRIBERS}?filter=${encodeURIComponent(`email = "${email}"`)}`, { as: root })).json.items[0] as Record<string, unknown> | undefined;
const tokenIn = (mail: string, kind: "confirm" | "unsubscribe") => new RegExp(`#${kind}=([a-z0-9.]+)`).exec(mail)?.[1] ?? "";

async function untilState(id: number, state: string) {
  for (let i = 0; i < 120; i++) {
    const campaign = (await call(`${CAMPAIGNS}/${id}`, { as: root })).json;
    if (campaign.state === state) return campaign;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Campaign ${id} never became ${state}`);
}

beforeAll(async () => {
  root = await signIn("root@example.test");
  const created = await call("/api/users", { method: "POST", as: root, body: { name: "nlmember", email: "nlmember@example.test", password: PASSWORD, role: "user" } });
  expect(created.status, created.text).toBe(200);
  member = await signIn("nlmember@example.test");
  const signup = await call(ext("/signup"));
  expect(signup.status, signup.text).toBe(200);
  expect(signup.json.captcha).toMatchObject({ provider: "turnstile", siteKey: "public-site-key" });
  formToken = signup.json.token;
  // The form refuses anything sent sooner than a person could, so the rest of the suite waits once.
  await new Promise((r) => setTimeout(r, 2100));
});

describe("newsletter: signing up", () => {
  it("installs its collections, its page and its sign-up block", async () => {
    const page = await call("/newsletter");
    expect(page.status, page.text.slice(0, 500)).toBe(200);
    expect(page.text).toContain("Newsletter");
    for (const path of [SUBSCRIBERS, CAMPAIGNS]) expect((await call(path)).status).toBe(403);
  });

  it("refuses a form sent at once, a missing CAPTCHA and an address that isn't one", async () => {
    const fresh = (await call(ext("/signup"))).json.token;
    const early = await call(ext("/subscribe"), { method: "POST", body: { email: "early@example.test", token: fresh, answer: "good-token" }, ip: "198.51.100.1" });
    expect([early.status, early.json.error.code]).toEqual([400, "TOO_FAST"]);
    const noCaptcha = await call(ext("/subscribe"), { method: "POST", body: { email: "ada@example.test", token: formToken }, ip: "198.51.100.1" });
    expect([noCaptcha.status, noCaptcha.json.error.code]).toEqual([400, "CAPTCHA_REQUIRED"]);
    const wrong = await subscribe({ email: "ada@example.test", answer: "wrong" }, "198.51.100.1");
    expect([wrong.status, wrong.json.error.code]).toEqual([403, "CAPTCHA_FAILED"]);
    const bad = await subscribe({ email: "not-an-address" }, "198.51.100.2");
    expect([bad.status, bad.json.error.code]).toEqual([400, "INVALID_EMAIL"]);
    expect(await subscriber("ada@example.test")).toBeUndefined();
  });

  it("answers a filled trap as if it worked, and keeps nothing", async () => {
    const r = await subscribe({ email: "bot@example.test", website: "https://spam.example" }, "198.51.100.3");
    expect(r.status).toBe(200);
    expect(await subscriber("bot@example.test")).toBeUndefined();
  });

  it("keeps a sign-up waiting, emails a link to confirm it, and confirms from that link", async () => {
    const r = await subscribe({ email: "Ada@Example.test", page: "/blog/hello" }, "198.51.100.4");
    expect(r.status, r.text).toBe(200);
    expect(r.json.message).toMatch(/check your inbox/i);
    const saved = await subscriber("ada@example.test");
    expect(saved).toMatchObject({ email: "ada@example.test", state: "pending", source: "/blog/hello" });
    const mail = await mailTo("ada@example.test", /Confirm your subscription/);
    const token = tokenIn(mail, "confirm");
    expect(mail).toContain(`${base}/newsletter#confirm=c${saved!.id}.`);
    // A confirmation email is to one person about their own sign-up, not mail to many.
    expect(mail).not.toMatch(/List-Unsubscribe/i);

    const confirmed = await call(ext("/confirm"), { method: "POST", body: { token } });
    expect(confirmed.status, confirmed.text).toBe(200);
    expect((await subscriber("ada@example.test"))?.state).toBe("confirmed");
  });

  it("answers the same for an address already on the list, and sends it nothing", async () => {
    const before = (await mailsTo("ada@example.test", /Confirm your subscription/)).length;
    const again = await subscribe({ email: "ada@example.test" }, "198.51.100.5");
    expect(again.status).toBe(200);
    expect(again.json.message).toMatch(/check your inbox/i);
    await new Promise((r) => setTimeout(r, 500));
    expect((await mailsTo("ada@example.test", /Confirm your subscription/)).length).toBe(before);
  });

  it("sends a waiting address at most one confirmation an hour", async () => {
    await subscribe({ email: "flooded@example.test" }, "198.51.100.6");
    await subscribe({ email: "flooded@example.test" }, "198.51.100.7");
    await subscribe({ email: "flooded@example.test" }, "198.51.100.8");
    await mailTo("flooded@example.test", /Confirm your subscription/);
    await new Promise((r) => setTimeout(r, 500));
    expect((await mailsTo("flooded@example.test", /Confirm your subscription/)).length).toBe(1);
  });

  it("refuses a forged link, and a link for one thing used for another", async () => {
    const id = (await subscriber("flooded@example.test"))!.id;
    const forged = await call(ext("/confirm"), { method: "POST", body: { token: `c${id}.${Date.now()}.${"0".repeat(64)}` } });
    expect([forged.status, forged.json.error.code]).toEqual([400, "INVALID_LINK"]);
    const mail = await mailTo("flooded@example.test", /Confirm your subscription/);
    const token = tokenIn(mail, "confirm");
    expect((await call(ext(`/unsubscribe/${token}`), { method: "POST" })).status).toBe(400);
    // Another subscriber's id in a good token.
    const other = token.replace(/^c\d+/, `c${(await subscriber("ada@example.test"))!.id}`);
    expect((await call(ext("/confirm"), { method: "POST", body: { token: other } })).status).toBe(400);
    expect((await subscriber("flooded@example.test"))?.state).toBe("pending");
  });

  it("subscribes a signed-in person's own verified address without an email", async () => {
    // The member was made by an administrator, so their address counts as verified only if better-auth says so.
    const me = (await call("/api/auth/get-session", { as: member })).json.user;
    const r = await subscribe({ email: "nlmember@example.test" }, "198.51.100.9", member);
    expect(r.status).toBe(200);
    expect((await subscriber("nlmember@example.test"))?.state).toBe(me.emailVerified ? "confirmed" : "pending");
  });

  it("limits how often one address signs up", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await subscribe({ email: `burst${i}@example.test` }, "198.51.100.40")).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe("newsletter: the dashboard", () => {
  it("serves its routes only to staff with the newsletter's permissions", async () => {
    expect((await call(ext("/status"))).status).toBe(401);
    expect((await call(ext("/status"), { as: member })).status).toBe(403);
    expect((await call(ext("/campaigns"), { as: member })).status).toBe(403);
    expect((await call(ext("/subscribers.csv"), { as: member })).status).toBe(403);
    expect((await call(ext("/subscribers"), { method: "POST", as: member, body: { text: "x@example.test", confirmed: true } })).status).toBe(403);
    const status = await call(ext("/status"), { as: root });
    expect(status.json).toMatchObject({ mail: true, captcha: true, page: "/newsletter" });
    expect(status.json.counts.confirmed).toBeGreaterThanOrEqual(1);
    const page = await call("/dashboard/ext/newsletter", { as: root });
    expect(page.status).toBe(200);
    expect((await call("/dashboard/ext/newsletter/subscribers", { as: root })).status).toBe(200);
  });

  it("imports people who agreed straight in, asks the rest by email, and never brings back someone who left", async () => {
    const leaver = await call(SUBSCRIBERS, { method: "POST", as: root, body: { email: "leaver@example.test", state: "unsubscribed" } });
    expect(leaver.status, leaver.text).toBe(200);
    const agreed = await call(ext("/subscribers"), { method: "POST", as: root, body: { text: "email,name\nGrace Hopper <grace@example.test>\nalan@example.test, Alan Turing\nLEAVER@example.test\nnonsense", confirmed: true } });
    expect(agreed.status, agreed.text).toBe(200);
    expect(agreed.json).toMatchObject({ added: 2, unchanged: 1, invalid: 1 });
    expect(await subscriber("grace@example.test")).toMatchObject({ state: "confirmed", name: "Grace Hopper", source: "import" });
    expect((await subscriber("leaver@example.test"))?.state).toBe("unsubscribed");

    const asked = await call(ext("/subscribers"), { method: "POST", as: root, body: { text: "linus@example.test", confirmed: false } });
    expect(asked.json).toMatchObject({ added: 1 });
    expect((await subscriber("linus@example.test"))?.state).toBe("pending");
    // Sent from the sending job, in a batch.
    await mailTo("linus@example.test", /Confirm your subscription/);
  });

  it("exports the list as CSV, safe to open in a spreadsheet", async () => {
    const csv = await call(ext("/subscribers.csv"), { as: root });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(csv.text.split("\r\n")[0]).toBe("email,name,state,confirmedAt,source");
    expect(csv.text).toContain("grace@example.test,Grace Hopper,confirmed,");
  });
});

describe("newsletter: campaigns", () => {
  let campaign: number;

  it("starts every campaign as a draft, and keeps its progress out of people's hands", async () => {
    const created = await call(CAMPAIGNS, { method: "POST", as: root, body: { subject: "November news", body: rich("Here is what happened."), link: "https://example.test/blog", state: "sent", sent: 500 } });
    expect(created.status, created.text).toBe(200);
    expect(created.json).toMatchObject({ state: "draft" });
    campaign = created.json.id;
    const forced = await call(`${CAMPAIGNS}/${campaign}`, { method: "PATCH", as: root, body: { state: "sending" } });
    expect(forced.status).toBe(400);
    expect(forced.text).toContain("from the Newsletter page");
  });

  it("sends a test only to the person asking", async () => {
    const test = await call(ext(`/campaigns/${campaign}/test`), { method: "POST", as: root });
    expect(test.status, test.text).toBe(200);
    expect(test.json).toEqual({ ok: true, to: "root@example.test" });
    await mailTo("root@example.test", /\[Test\] November news/);
    expect((await call(ext(`/campaigns/${campaign}/test`), { method: "POST", as: member })).status).toBe(403);
  });

  it("sends to every confirmed subscriber, once each, with their own one-click unsubscribe", async () => {
    const confirmed = (await call(`${SUBSCRIBERS}?filter=${encodeURIComponent('state = "confirmed"')}&perPage=200&fields=email`, { as: root })).json.items.map((item: { email: string }) => item.email) as string[];
    expect(confirmed).toEqual(expect.arrayContaining(["ada@example.test", "grace@example.test", "alan@example.test"]));
    const sent = await call(ext(`/campaigns/${campaign}/send`), { method: "POST", as: root, body: {} });
    expect(sent.status, sent.text).toBe(200);
    expect(sent.json.recipients).toBe(confirmed.length);
    const done = await untilState(campaign, "sent");
    expect(done).toMatchObject({ sent: confirmed.length, failed: 0, recipients: confirmed.length });

    const ada = await mailTo("ada@example.test", /Subject: November news/);
    expect(ada).toContain("Here is what happened.");
    expect(ada).toMatch(new RegExp(`List-Unsubscribe: <${base}/api/ext/newsletter/unsubscribe/u\\d+\\.[0-9a-f]{64}>`, "i"));
    expect(ada).toMatch(/List-Unsubscribe-Post: List-Unsubscribe=One-Click/i);
    expect(ada).toContain(`${base}/newsletter#unsubscribe=u`);
    const grace = await mailTo("grace@example.test", /Subject: November news/);
    expect(tokenIn(grace, "unsubscribe")).not.toBe(tokenIn(ada, "unsubscribe"));
    for (const email of confirmed) expect((await mailsTo(email, /Subject: November news/)).length, email).toBe(1);
    // Nobody waiting to confirm, and nobody who left, gets it.
    for (const email of ["flooded@example.test", "linus@example.test", "leaver@example.test"]) expect(await mailsTo(email, /Subject: November news/)).toEqual([]);
  });

  it("unsubscribes with one click from the mail client, and shows the page only a hint of the address", async () => {
    const token = tokenIn(await mailTo("alan@example.test", /Subject: November news/), "unsubscribe");
    const shown = await call(ext(`/unsubscribe/${token}`));
    expect(shown.json).toEqual({ email: "al•••@example.test", unsubscribed: false });
    // What a mail client sends under RFC 8058: a form body, no cookie, no origin.
    const click = await call(ext(`/unsubscribe/${token}`), { method: "POST", raw: "List-Unsubscribe=One-Click", type: "application/x-www-form-urlencoded" });
    expect(click.status, click.text).toBe(200);
    expect((await subscriber("alan@example.test"))?.state).toBe("unsubscribed");
    expect((await call(ext(`/unsubscribe/${token}`))).json.unsubscribed).toBe(true);
    // A changed last character, never the one it already ends in, which would leave the token itself.
    const tampered = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    expect(tampered).not.toBe(token);
    expect((await call(ext(`/unsubscribe/${tampered}`), { method: "POST" })).status).toBe(400);
  });

  it("can't send a campaign twice or rewrite it, and copies it as a new draft", async () => {
    expect((await call(ext(`/campaigns/${campaign}/send`), { method: "POST", as: root, body: {} })).status).toBe(409);
    expect((await call(`${CAMPAIGNS}/${campaign}`, { method: "PATCH", as: root, body: { subject: "Rewritten" } })).status).toBe(400);
    const copy = await call(ext(`/campaigns/${campaign}/copy`), { method: "POST", as: root });
    expect(copy.status, copy.text).toBe(200);
    expect((await call(`${CAMPAIGNS}/${copy.json.id}`, { as: root })).json).toMatchObject({ subject: "November news", state: "draft" });
  });

  it("schedules a campaign, and cancels it before it goes", async () => {
    const created = await call(CAMPAIGNS, { method: "POST", as: root, body: { subject: "Later", body: rich("Soon.") } });
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await call(ext(`/campaigns/${created.json.id}/send`), { method: "POST", as: root, body: { at } });
    expect(scheduled.json).toMatchObject({ state: "scheduled" });
    const cancelled = await call(ext(`/campaigns/${created.json.id}/cancel`), { method: "POST", as: root });
    expect(cancelled.json).toMatchObject({ state: "cancelled" });
    expect((await call(ext("/campaigns"), { as: root })).json.campaigns.map((item: { subject: string }) => item.subject)).toContain("Later");
  });

  it("refuses to send a campaign with nothing in it", async () => {
    const empty = await call(CAMPAIGNS, { method: "POST", as: root, body: { subject: "Empty" } });
    expect((await call(ext(`/campaigns/${empty.json.id}/send`), { method: "POST", as: root, body: {} })).json.error.code).toBe("NOTHING_TO_SEND");
  });

  it("drafts a campaign from a published post, with its title, its excerpt and a link to it", async () => {
    const post = await call("/api/collections/blog-posts/records", { method: "POST", as: root, body: { status: "published", title: "Newsletter-worthy post", excerpt: "A short teaser." } });
    expect(post.status, post.text).toBe(200);
    expect((await call(ext("/sources/blog-posts"), { as: root })).json).toEqual({ eligible: true });
    expect((await call(ext("/sources/newsletter-subscribers"), { as: root })).json).toEqual({ eligible: false });
    const draft = await call(ext("/campaigns/from-record"), { method: "POST", as: root, body: { collection: "blog-posts", id: post.json.id } });
    expect(draft.status, draft.text).toBe(200);
    const made = (await call(`${CAMPAIGNS}/${draft.json.id}`, { as: root })).json;
    expect(made).toMatchObject({ subject: "Newsletter-worthy post", state: "draft", source: `blog-posts/${post.json.id}`, linkLabel: "Read more" });
    expect(made.link).toMatch(new RegExp(`^${base}/blog/newsletter-worthy-post$`));
    expect(JSON.stringify(made.body)).toContain("A short teaser.");

    const hidden = await call("/api/collections/blog-posts/records", { method: "POST", as: root, body: { status: "draft", title: "Not yet" } });
    expect((await call(ext("/campaigns/from-record"), { method: "POST", as: root, body: { collection: "blog-posts", id: hidden.json.id } })).json.error.code).toBe("NOT_PUBLISHED");
    expect((await call(ext("/campaigns/from-record"), { method: "POST", as: member, body: { collection: "blog-posts", id: post.json.id } })).status).toBe(403);
    // The blog's own tests start from an empty blog.
    for (const id of [post.json.id, hidden.json.id]) expect((await call(`/api/collections/blog-posts/records/${id}`, { method: "DELETE", as: root })).status).toBe(204);
  });
});
