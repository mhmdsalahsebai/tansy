/**
 * The payments plugin, installed the way a site owner would: on in tansy.config.ts, with the
 * Stripe keys entered under Payments → Settings. Runs after auth.test.ts.
 *
 * Nothing here calls Stripe. Webhook events are signed locally with the signing secret,
 * as the Stripe CLI does, and go to better-auth's Stripe plugin at its real address.
 * That covers what core adds for it: secret settings, better-auth plugin tables kept as
 * collections, columns on the user kept beside it, and the plugin's own collections.
 */
import { createHmac } from "node:crypto";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { gated, ungated } from "../../plugins/subscriptions/logic";

const base = inject("baseUrl");
const PASSWORD = "correct-horse-battery-staple-9431";
const WEBHOOK_SECRET = "whsec_integration_test_secret";
const signer = new Stripe("sk_test_integration").webhooks;

interface Actor { id: string; cookie: string; email: string }
let root: Actor, buyer: Actor, other: Actor;

async function call(path: string, { method = "GET", body, as, headers = {} }: { method?: string; body?: unknown; as?: Actor | null; headers?: Record<string, string> } = {}) {
  const response = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: { origin: base, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(as ? { cookie: as.cookie } : {}), ...headers },
    body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
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
  return { id: r.json.user.id, cookie, email };
}

async function user(name: string) {
  const r = await call("/api/users", { method: "POST", as: root, body: { name, email: `${name}@example.test`, password: PASSWORD, role: "user" } });
  expect(r.status, r.text).toBe(200);
  return signIn(`${name}@example.test`);
}

const wait = async (check: () => Promise<boolean>, tries = 60) => { for (let i = 0; i < tries; i++) { if (await check()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
const records = (slug: string, suffix = "") => `/api/collections/${slug}/records${suffix}`;
const ext = (path: string) => `/api/ext/payments${path}`;

async function create(slug: string, body: Record<string, unknown>, as: Actor = root) {
  const r = await call(records(slug), { method: "POST", as, body: { status: "published", ...body } });
  expect(r.status, r.text).toBe(200);
  return r.json;
}

async function collection(slug: string, fields: Array<{ name: string; type: string; config?: Record<string, unknown> }>, rules: Record<string, string | null>) {
  const created = await call("/api/collections", { method: "POST", as: root, body: { name: slug, slug, fields } });
  expect(created.status, created.text).toBe(200);
  const ruled = await call(`/api/collections/${created.json.id}/rules`, { method: "PUT", as: root, body: { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, ...rules } });
  expect(ruled.status, ruled.text).toBe(200);
}

/** Sends a Stripe event the way Stripe does: the raw body, signed with the webhook's secret. */
async function webhook(type: string, object: Record<string, unknown>, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, object: "event", api_version: "2026-09-30.endive", created: Math.floor(Date.now() / 1000), type, data: { object }, livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null } });
  const signature = await signer.generateTestHeaderStringAsync({ payload, secret });
  return call("/api/auth/stripe/webhook", { method: "POST", body: payload, headers: { "stripe-signature": signature } });
}

/** Saves settings the way the dashboard does: every value, with secrets sent back masked unless changed. */
async function saveSettings(changes: Record<string, unknown>) {
  const current = await call("/api/extensions/payments/settings", { as: root });
  expect(current.status, current.text).toBe(200);
  const saved = await call("/api/extensions/payments/settings", { method: "PUT", as: root, body: { values: { ...current.json.values, ...changes } } });
  expect(saved.status, saved.text).toBe(200);
  return saved;
}

/** better-auth is rebuilt within seconds of a settings change. A webhook address answers once its provider is set up. */
const webhookLive = (path: string) => wait(async () => (await call(`/api/auth${path}`, { method: "POST", body: "{}" })).status !== 404);

beforeAll(async () => {
  root = await signIn("root@example.test");
  buyer = await user("paybuyer");
  other = await user("payother");
});

describe("payments plugin: settings", () => {
  it("installs its collections and the plan user field", async () => {
    const slugs = ((await call("/api/collections", { as: root })).json as Array<{ slug: string }>).map((c) => c.slug);
    for (const slug of ["payments-plans", "payments-purchases"]) expect(slugs).toContain(slug);
    const fields = (await call("/api/user-fields", { as: root })).json as Array<{ name: string; selfEditable: boolean }>;
    expect(fields.find((f) => f.name === "payments_plan")).toMatchObject({ selfEditable: false });
    expect(fields.find((f) => f.name === "payments_access")).toMatchObject({ selfEditable: false });
  });

  it("refuses checkout until Stripe is set up", async () => {
    const r = await call(ext("/checkout"), { method: "POST", as: buyer, body: { collection: "payments-plans", id: 1 } });
    expect(r.status).toBe(503);
  });

  it("keeps secret settings out of every response, and keeps them when sent back masked", async () => {
    const saved = await saveSettings({ provider: "stripe", stripeSecretKey: "sk_test_integration", stripeWebhookSecret: WEBHOOK_SECRET, currency: "usd" });
    expect(saved.json.values).toMatchObject({ stripeSecretKey: "********", stripeWebhookSecret: "********", currency: "usd" });
    expect(saved.text).not.toContain("sk_test_integration");
    const read = await call("/api/extensions/payments/settings", { as: root });
    expect(read.json.values.stripeSecretKey).toBe("********");
    expect(read.text).not.toContain(WEBHOOK_SECRET);
    const again = await saveSettings({ currency: "eur" });
    expect(again.json.values).toMatchObject({ stripeSecretKey: "********", stripeWebhookSecret: "********", currency: "eur" });
    await saveSettings({ currency: "usd" });
    // Settings are for staff.
    expect((await call("/api/extensions/payments/settings", { as: buyer })).status).toBe(403);
  });

  it("keeps Stripe's tables as locked collections once the keys are set", async () => {
    const slugs = async () => ((await call("/api/collections", { as: root })).json as Array<{ slug: string }>).map((c) => c.slug);
    // better-auth is rebuilt within seconds of a settings change.
    expect(await wait(async () => (await slugs()).includes("payments-subscription"))).toBe(true);
    expect(await slugs()).toContain("payments-user-data");
    expect((await call(records("payments-subscription"), { as: buyer })).status).toBe(403);
    expect((await call(records("payments-user-data"), { as: buyer })).status).toBe(403);
  });
});

describe("payments plugin: one-time purchases", () => {
  let guide: { id: number };
  const session = (id: string) => ({
    id,
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    amount_total: 1250,
    currency: "usd",
    payment_intent: `pi_${id}`,
    metadata: { tansy: "purchase", collection: "pay-guides", recordId: String(guide.id), userId: buyer.id },
  });

  beforeAll(async () => {
    await collection("pay-guides", [{ name: "title", type: "text" }, { name: "price", type: "payments_price" }], { listRule: "", viewRule: "" });
    guide = await create("pay-guides", { title: "The Guide", price: 12.5 });
  });

  it("refuses a bad signature and changes nothing", async () => {
    const r = await webhook("checkout.session.completed", session("cs_forged"), "whsec_wrong");
    expect(r.status).toBe(400);
    expect((await call(records("payments-purchases"), { as: buyer })).json.items).toHaveLength(0);
  });

  it("records a paid checkout once, however often Stripe sends it", async () => {
    const results = await Promise.all([webhook("checkout.session.completed", session("cs_test_1")), webhook("checkout.session.completed", session("cs_test_1"))]);
    for (const r of results) expect(r.status, r.text).toBe(200);
    expect((await webhook("checkout.session.completed", session("cs_test_1"))).status).toBe(200);
    const mine = (await call(records("payments-purchases"), { as: buyer })).json.items;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ buyer: buyer.id, collection: "pay-guides", recordId: guide.id, amount: 12.5, currency: "usd", state: "paid" });
  });

  it("shows a purchase only to its buyer", async () => {
    expect((await call(records("payments-purchases"), { as: other })).json.items).toHaveLength(0);
    expect((await call(ext(`/purchased?collection=pay-guides&id=${guide.id}`), { as: buyer })).json).toEqual({ purchased: true });
    expect((await call(ext(`/purchased?collection=pay-guides&id=${guide.id}`), { as: other })).json).toEqual({ purchased: false });
    // Only the plugin writes purchases.
    expect((await call(records("payments-purchases"), { method: "POST", as: buyer, body: { buyer: buyer.id, collection: "pay-guides", recordId: guide.id, sessionId: "cs_self", state: "paid" } })).status).toBe(403);
  });

  it("refuses a second checkout for something bought once, before calling Stripe", async () => {
    const r = await call(ext("/checkout"), { method: "POST", as: buyer, body: { collection: "pay-guides", id: guide.id } });
    expect(r.status, r.text).toBe(409);
    expect((await call(ext("/checkout"), { method: "POST", as: buyer, body: { collection: "payments-plans", id: 1 } })).status).toBe(400);
    expect((await call(ext("/checkout"), { method: "POST", body: { collection: "pay-guides", id: guide.id } })).status).toBe(401);
  });

  it("confirms a checkout only from Stripe, and only for its own buyer", async () => {
    expect((await call(ext("/confirm"), { method: "POST", body: { sessionId: "cs_test_1" } })).status).toBe(401);
    expect((await call(ext("/confirm"), { method: "POST", as: buyer, body: { sessionId: "not-a-session" } })).status).toBe(400);
    // The test key reaches no Stripe account, so the session can't be read and nothing is recorded.
    expect((await call(ext("/confirm"), { method: "POST", as: buyer, body: { sessionId: "cs_test_unknown" } })).status).toBe(404);
    expect((await call(records("payments-purchases"), { as: buyer })).json.items).toHaveLength(1);
  });

  it("marks a fully refunded purchase refunded", async () => {
    expect((await webhook("charge.refunded", { id: "ch_partial", object: "charge", payment_intent: "pi_cs_test_1", refunded: false })).status).toBe(200);
    expect((await call(records("payments-purchases"), { as: buyer })).json.items[0].state).toBe("paid");
    expect((await webhook("charge.refunded", { id: "ch_full", object: "charge", payment_intent: "pi_cs_test_1", refunded: true })).status).toBe(200);
    expect((await call(records("payments-purchases"), { as: buyer })).json.items[0].state).toBe("refunded");
  });
});

describe("payments plugin: selling an LMS course", () => {
  type Field = { id: number; name: string; type: string; config: Record<string, unknown> };
  let courses: { id: number; fields: Field[] };
  let course: { id: number; access: string };
  const fields = (list: unknown[]) => call(`/api/collections/${courses.id}/fields`, { method: "PUT", as: root, body: { fields: list, confirm: true } });
  const kept = () => courses.fields.map(({ id, name, type, config }) => ({ id, name, type, config }));
  const enrollments = async () => (await call(records("lms-enrollments", `?filter=${encodeURIComponent(`course = ${course.id}`)}`), { as: root })).json.items as Array<{ student: string; source: string; state: string }>;
  const session = (id: string) => ({
    id,
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    amount_total: 4900,
    currency: "usd",
    payment_intent: `pi_${id}`,
    metadata: { tansy: "purchase", collection: "lms-courses", recordId: String(course.id), userId: buyer.id },
  });

  beforeAll(async () => {
    const { id } = ((await call("/api/collections", { as: root })).json as Array<{ id: number; slug: string }>).find((c) => c.slug === "lms-courses")!;
    courses = (await call(`/api/collections/${id}`, { as: root })).json;
    // The owner makes courses sellable by adding Payments' price field. LMS never adds it.
    const priced = await fields([...kept(), { name: "price", type: "payments_price", config: {} }]);
    expect(priced.status, priced.text).toBe(200);
  });

  afterAll(async () => {
    expect((await fields(kept())).status).toBe(200);
  });

  it("sells only paid courses, each with a price, and refuses free enrollment in them", async () => {
    const bad = async (body: Record<string, unknown>, field: string) => {
      const r = await call(records("lms-courses"), { method: "POST", as: root, body: { status: "published", ...body } });
      expect(r.status, r.text).toBe(400);
      expect(r.text).toContain(field);
    };
    await bad({ title: "No price", access: "paid" }, "price");
    await bad({ title: "Free with a price", access: "free", price: 5 }, "price");
    course = await create("lms-courses", { title: "Paid Rust", access: "paid", price: 49 });
    expect(course.access).toBe("paid");
    expect((await call(`/api/ext/lms/courses/${course.id}/enroll`, { method: "POST", as: buyer })).json.error.code).toBe("PURCHASE_REQUIRED");

    // Made free, a course stops being for sale.
    const switched = await create("lms-courses", { title: "Was paid", access: "paid", price: 20 });
    const freed = await call(records("lms-courses", `/${switched.id}`), { method: "PATCH", as: root, body: { access: "free" } });
    expect(freed.status, freed.text).toBe(200);
    expect(freed.json.price).toBeNull();
    expect((await call(ext(`/offer?collection=lms-courses&id=${switched.id}`))).json.forSale).toBe(false);
  });

  it("offers the price to anyone who can see the course", async () => {
    expect((await call(ext(`/offer?collection=lms-courses&id=${course.id}`))).json).toMatchObject({ forSale: true, amount: 49, currency: "usd", purchased: false });
    const draft = await create("lms-courses", { title: "Hidden Rust", access: "paid", price: 10, status: "draft" });
    expect((await call(ext(`/offer?collection=lms-courses&id=${draft.id}`))).status).toBe(404);
    expect((await call(ext("/offer?collection=lms-enrollments&id=1"))).json.forSale).toBe(false);
  });

  it("enrolls the buyer once when Stripe confirms payment", async () => {
    for (let i = 0; i < 2; i++) expect((await webhook("checkout.session.completed", session("cs_course_1"))).status).toBe(200);
    expect(await wait(async () => (await enrollments()).length > 0)).toBe(true);
    // Durable hooks may still be retrying, so give a repeat a chance to show.
    await new Promise((r) => setTimeout(r, 500));
    expect(await enrollments()).toEqual([expect.objectContaining({ student: buyer.id, source: "purchase", state: "active" })]);
    expect((await call(ext(`/offer?collection=lms-courses&id=${course.id}`), { as: buyer })).json.purchased).toBe(true);
    expect((await call("/api/ext/lms/me/courses", { as: buyer })).json.items.map((item: { course: { id: number } }) => item.course.id)).toContain(course.id);
  });

  it("revokes the enrollment when the purchase is fully refunded", async () => {
    expect((await webhook("charge.refunded", { id: "ch_course", object: "charge", payment_intent: "pi_cs_course_1", refunded: true })).status).toBe(200);
    expect(await wait(async () => (await enrollments())[0]?.state === "revoked")).toBe(true);
    expect((await call("/api/ext/lms/me/courses", { as: buyer })).json.items.map((item: { course: { id: number } }) => item.course.id)).not.toContain(course.id);
  });
});

describe("payments plugin: subscriptions", () => {
  let members: { id: number };
  const subscription = (status: string) => {
    const now = Math.floor(Date.now() / 1000);
    return {
      id: "sub_test_1",
      object: "subscription",
      customer: "cus_test_buyer",
      status,
      metadata: {},
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: null,
      ended_at: null,
      trial_start: null,
      trial_end: null,
      items: { object: "list", data: [{ id: "si_test_1", object: "subscription_item", quantity: 1, current_period_start: now, current_period_end: now + 30 * 86400, price: { id: "price_pro_test", object: "price", lookup_key: null, recurring: { interval: "month" } } }] },
    };
  };

  beforeAll(async () => {
    const plan = await create("payments-plans", { name: "Pro", priceId: "price_pro_test" });
    expect(plan.name).toBe("pro");
    await collection("pay-members", [{ name: "title", type: "text" }], { listRule: '@request.auth.payments_plan = "pro"', viewRule: '@request.auth.payments_plan = "pro"' });
    members = await create("pay-members", { title: "Members only" });
  });

  it("refuses a plan without a Stripe price id", async () => {
    expect((await call(records("payments-plans"), { method: "POST", as: root, body: { status: "published", name: "bad", priceId: "prod_123" } })).status).toBe(400);
  });

  it("finds the user by the Stripe customer kept beside them, stores the subscription as a record, and opens what the plan gates", async () => {
    // The customer id better-auth's Stripe plugin keeps on the user lives in the plugin's collection.
    await create("payments-user-data", { coreId: buyer.id, stripeCustomerId: "cus_test_buyer" });
    expect((await call(records("pay-members", `/${members.id}`), { as: buyer })).status).toBe(404);

    expect((await webhook("customer.subscription.created", subscription("active"))).status).toBe(200);
    expect(await wait(async () => (await call(records("payments-subscription"), { as: root })).json.items.length === 1)).toBe(true);
    const [stored] = (await call(records("payments-subscription"), { as: root })).json.items;
    expect(stored).toMatchObject({ referenceId: buyer.id, plan: "pro", subscriptionStatus: "active", stripeSubscriptionId: "sub_test_1", stripeCustomerId: "cus_test_buyer" });
    expect(typeof stored.authId).toBe("string");

    // The plan field follows through a durable hook.
    expect(await wait(async () => (await call(records("pay-members", `/${members.id}`), { as: buyer })).status === 200)).toBe(true);
    expect((await call(records("pay-members", `/${members.id}`), { as: other })).status).toBe(404);

    // A repeated event creates nothing.
    expect((await webhook("customer.subscription.created", subscription("active"))).status).toBe(200);
    expect((await call(records("payments-subscription"), { as: root })).json.items).toHaveLength(1);
  });

  it("starts subscriptions and billing through its own routes, calling Stripe's plugin as the caller", async () => {
    expect((await call(ext("/subscribe"), { method: "POST", body: { plan: "pro" } })).status).toBe(401);
    expect((await call(ext("/subscribe"), { method: "POST", as: other, body: { plan: "nope" } })).status).toBe(404);
    expect((await call(ext("/subscribe"), { method: "POST", as: other, body: { plan: "pro", annual: true } })).json.error.code).toBe("NO_ANNUAL_PRICE");
    // Stripe's plugin answers for the caller, who has no Stripe customer: proof the call carried their session and no one else's.
    const billing = await call(ext("/billing"), { method: "POST", as: other, body: {} });
    expect(billing.status, billing.text).toBe(404);
    expect(billing.json.error.code).toBe("CUSTOMER_NOT_FOUND");
  });

  it("closes what the plan gates once the subscription ends", async () => {
    expect((await webhook("customer.subscription.deleted", subscription("canceled"))).status).toBe(200);
    expect(await wait(async () => (await call(records("pay-members", `/${members.id}`), { as: buyer })).status === 404)).toBe(true);
    const [stored] = (await call(records("payments-subscription"), { as: root })).json.items;
    expect(stored.subscriptionStatus).toBe("canceled");
  });
});

describe("payments plugin: plan access", () => {
  let premium: { id: number }, everything: { id: number }, plan: { id: number };
  let post: { id: number }, open: { id: number }, book: { id: number };
  const subscription = (status: string) => {
    const now = Math.floor(Date.now() / 1000);
    return {
      id: "sub_test_access",
      object: "subscription",
      customer: "cus_test_buyer",
      status,
      metadata: {},
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: null,
      ended_at: null,
      trial_start: null,
      trial_end: null,
      items: { object: "list", data: [{ id: "si_test_access", object: "subscription_item", quantity: 1, current_period_start: now, current_period_end: now + 30 * 86400, price: { id: "price_learn_test", object: "price", lookup_key: null, recurring: { interval: "month" } } }] },
    };
  };
  const status = async (slug: string, id: number, as: Actor | null) => (await call(records(slug, `/${id}`), { as })).status;
  const listed = async (slug: string, as: Actor | null) => ((await call(records(slug), { as })).json?.items ?? []).map((item: { id: number }) => item.id);

  beforeAll(async () => {
    premium = await create("payments-access", { name: "Premium posts", collections: [] });
    everything = await create("payments-access", { name: "The library", collections: ["pay-library"] });
    plan = await create("payments-plans", { name: "Learn", priceId: "price_learn_test", includes: [premium.id] });
    const accessId = ((await call("/api/collections", { as: root })).json as Array<{ id: number; slug: string }>).find((c) => c.slug === "payments-access")!.id;
    const gate = "(included:length > 0 && included ?= @request.auth.payments_access)";
    await collection("pay-posts", [{ name: "title", type: "text" }, { name: "included", type: "reference", config: { collection: accessId, allowMultiple: true } }], { listRule: gate, viewRule: gate });
    await collection("pay-library", [{ name: "title", type: "text" }], { listRule: '@request.auth.payments_access ?= "pay-library"', viewRule: '@request.auth.payments_access ?= "pay-library"' });
    post = await create("pay-posts", { title: "Premium", included: [premium.id] });
    open = await create("pay-posts", { title: "In no access", included: [] });
    book = await create("pay-library", { title: "A book" });
  });

  it("takes only collection slugs in an access", async () => {
    expect((await call(records("payments-access"), { method: "POST", as: root, body: { status: "published", name: "Bad", collections: ['x" || true'] } })).status).toBe(400);
    expect((await call(records("payments-access"), { method: "POST", as: buyer, body: { status: "published", name: "Mine" } })).status).toBe(403);
  });

  it("opens nothing gated to a visitor or to someone with no plan, including records in no access", async () => {
    for (const as of [null, buyer, other]) {
      for (const id of [post.id, open.id]) expect(await status("pay-posts", id, as)).toBe(404);
      expect(await status("pay-library", book.id, as)).toBe(404);
      expect(await listed("pay-posts", as)).toEqual([]);
    }
  });

  it("opens records in the access a plan includes once the subscription starts", async () => {
    expect((await webhook("customer.subscription.created", subscription("active"))).status).toBe(200);
    expect(await wait(async () => (await status("pay-posts", post.id, buyer)) === 200)).toBe(true);
    expect(await listed("pay-posts", buyer)).toEqual([post.id]);
    expect(await status("pay-posts", open.id, buyer)).toBe(404);
    expect(await status("pay-library", book.id, buyer)).toBe(404);
    expect(await status("pay-posts", post.id, other)).toBe(404);
  });

  it("keeps each person's entitlements, which only they see and only Payments writes", async () => {
    const mine = (await call(records("payments-entitlements"), { as: buyer })).json.items;
    expect(mine).toEqual([expect.objectContaining({ user: buyer.id, plans: ["learn"], access: [premium.id] })]);
    expect((await call(records("payments-entitlements"), { as: other })).json.items).toEqual([]);
    expect((await call(records("payments-entitlements", `/${mine[0].id}`), { method: "PATCH", as: buyer, body: { access: [everything.id] } })).status).toBe(403);
  });

  it("gives subscribers what the owner adds to their plan", async () => {
    const r = await call(records("payments-plans", `/${plan.id}`), { method: "PATCH", as: root, body: { includes: [premium.id, everything.id] } });
    expect(r.status, r.text).toBe(200);
    expect(await wait(async () => (await status("pay-library", book.id, buyer)) === 200)).toBe(true);
    expect(await status("pay-library", book.id, other)).toBe(404);
  });

  it("closes all of it when the subscription ends", async () => {
    expect((await webhook("customer.subscription.deleted", subscription("canceled"))).status).toBe(200);
    expect(await wait(async () => (await status("pay-posts", post.id, buyer)) === 404)).toBe(true);
    expect(await status("pay-library", book.id, buyer)).toBe(404);
    expect((await call(records("payments-entitlements"), { as: buyer })).json.items).toEqual([expect.objectContaining({ plans: [], access: [] })]);
  });
});

describe("subscriptions plugin", () => {
  const sub = (path: string) => `/api/ext/subscriptions${path}`;
  let gatedPost: number;
  // Its own person, so free plans given here don't show up in other tests' memberships.
  let member: Actor;
  const postStatus = async (id: number, as: Actor | null) => (await call(records("pay-posts", `/${id}`), { as })).status;

  beforeAll(async () => {
    member = await user("paymember");
    gatedPost = ((await call(records("pay-posts"), { as: root })).json.items as Array<{ id: number; title: string }>).find((post) => post.title === "Premium")!.id;
  });

  it("is only for people who manage subscriptions", async () => {
    expect((await call(sub("/members"), { as: buyer })).status).toBe(403);
    expect((await call(sub("/members"))).status).toBe(401);
    expect((await call(sub("/grant"), { method: "POST", as: buyer, body: { email: buyer.email, plan: "learn" } })).status).toBe(403);
    const roles = (await call("/api/roles", { as: root })).json.roles as Array<{ name: string; permissions: string[] }>;
    expect(roles.find((role) => role.name === "subscriptions-manager")?.permissions).toContain("ext.subscriptions:manage");
  });

  it("gives a plan for free, which opens what the plan opens until it's ended", async () => {
    expect(await postStatus(gatedPost, member)).toBe(404);
    expect((await call(sub("/grant"), { method: "POST", as: root, body: { email: "nobody@example.test", plan: "learn" } })).status).toBe(404);
    expect((await call(sub("/grant"), { method: "POST", as: root, body: { email: member.email, plan: "nope" } })).status).toBe(404);
    expect((await call(sub("/grant"), { method: "POST", as: root, body: { email: member.email, plan: "learn", until: "2020-01-01T00:00:00Z" } })).status).toBe(400);

    const given = await call(sub("/grant"), { method: "POST", as: root, body: { email: member.email, plan: "learn" } });
    expect(given.status, given.text).toBe(200);
    expect(await wait(async () => (await postStatus(gatedPost, member)) === 200)).toBe(true);
    const listed = (await call(sub("/members"), { as: root })).json.members.find((m: { email: string }) => m.email === member.email);
    expect(listed).toMatchObject({ plans: ["learn"], grants: [expect.objectContaining({ id: given.json.grant.id, plan: "learn", state: "active" })] });

    // Only grants given here can be ended here.
    const stripeOnes = (await call(records("payments-memberships"), { as: root })).json.items.filter((m: { provider: string }) => m.provider !== "manual");
    for (const membership of stripeOnes) expect((await call(sub(`/grants/${membership.id}/end`), { method: "POST", as: root })).status).toBe(404);

    expect((await call(sub(`/grants/${given.json.grant.id}/end`), { method: "POST", as: root })).status).toBe(200);
    expect(await wait(async () => (await postStatus(gatedPost, member)) === 404)).toBe(true);
  });

  it("gates a collection through core's own API, and removes the gate exactly", async () => {
    await collection("sub-notes", [{ name: "title", type: "text" }], { listRule: 'status = "published"', viewRule: 'status = "published"' });
    const all = (await call("/api/collections", { as: root })).json as Array<{ id: number; slug: string; fields: Array<{ id: number; name: string; type: string; config: unknown }>; listRule: string; viewRule: string }>;
    const notes = all.find((c) => c.slug === "sub-notes")!;
    const accessId = all.find((c) => c.slug === "payments-access")!.id;
    const premium = ((await call(records("payments-access"), { as: root })).json.items as Array<{ id: number; name: string }>).find((a) => a.name === "Premium posts")!.id;

    // What the Access page does.
    const fields = await call(`/api/collections/${notes.id}/fields`, { method: "PUT", as: root, body: { fields: [...notes.fields.map(({ id, name, type, config }) => ({ id, name, type, config })), { name: "included", type: "reference", config: { collection: accessId, allowMultiple: true } }] } });
    expect(fields.status, fields.text).toBe(200);
    const rules = { listRule: gated(notes.listRule, "records", "sub-notes"), viewRule: gated(notes.viewRule, "records", "sub-notes"), createRule: null, updateRule: null, deleteRule: null };
    expect((await call(`/api/collections/${notes.id}/rules`, { method: "PUT", as: root, body: rules })).status).toBe(200);

    const free = await create("sub-notes", { title: "Free", included: [] });
    const kept = await create("sub-notes", { title: "Kept", included: [premium] });
    for (const as of [null, buyer, member]) {
      expect((await call(records("sub-notes"), { as })).json.items.map((n: { id: number }) => n.id)).toEqual([free.id]);
      expect((await call(records("sub-notes", `/${kept.id}`), { as })).status).toBe(404);
    }
    // A plan that includes Premium posts opens it.
    const given = await call(sub("/grant"), { method: "POST", as: root, body: { email: member.email, plan: "learn" } });
    expect(await wait(async () => (await call(records("sub-notes", `/${kept.id}`), { as: member })).status === 200)).toBe(true);
    await call(sub(`/grants/${given.json.grant.id}/end`), { method: "POST", as: root });

    const back = { listRule: ungated(rules.listRule, "sub-notes"), viewRule: ungated(rules.viewRule, "sub-notes"), createRule: null, updateRule: null, deleteRule: null };
    expect(back.listRule).toBe('status = "published"');
    expect((await call(`/api/collections/${notes.id}/rules`, { method: "PUT", as: root, body: back })).status).toBe(200);
    expect((await call(records("sub-notes", `/${kept.id}`))).status).toBe(200);
  });
});

describe("LMS: courses in plans (payments P7)", () => {
  const sub = (path: string) => `/api/ext/subscriptions${path}`;
  const enroll = (course: number, as: Actor) => call(`/api/ext/lms/courses/${course}/enroll`, { method: "POST", as });
  const lessonStatus = async (id: number, as: Actor | null) => (await call(records("lms-lessons", `/${id}`), { as })).status;
  const planEnrollments = async (course: number) => (await call(records("lms-enrollments", `?filter=${encodeURIComponent(`course = ${course} && student = "${learner.id}"`)}`), { as: root })).json.items as Array<{ id: number; state: string; source: string }>;
  const grant = async (plan: string) => {
    const r = await call(sub("/grant"), { method: "POST", as: root, body: { email: learner.email, plan } });
    expect(r.status, r.text).toBe(200);
    return r.json.grant.id as number;
  };
  const end = (id: number) => call(sub(`/grants/${id}/end`), { method: "POST", as: root });
  let learner: Actor;
  let some: { id: number }, picked: { id: number }, other: { id: number }, pickedLesson: { id: number }, otherLesson: { id: number };

  beforeAll(async () => {
    learner = await user("planlearner");
    // Payments is listed before the LMS, so the LMS gave courses their "Included in" field.
    const courses = ((await call("/api/collections", { as: root })).json as Array<{ slug: string; fields: Array<{ name: string; type: string }> }>).find((c) => c.slug === "lms-courses")!;
    expect(courses.fields.find((field) => field.name === "included")?.type).toBe("reference");
    some = await create("payments-access", { name: "Some courses" });
    const every = await create("payments-access", { name: "Every course", collections: ["lms-courses"] });
    await create("payments-plans", { name: "somecourses", priceId: "price_some_test", includes: [some.id], amount: 9 });
    await create("payments-plans", { name: "everycourse", priceId: "price_every_test", includes: [every.id], amount: 29 });
    // Staff enroll learners in both, unless a plan covers them.
    picked = await create("lms-courses", { title: "Picked for a plan", access: "enrollment", included: [some.id] });
    other = await create("lms-courses", { title: "In no plan", access: "enrollment" });
    pickedLesson = await create("lms-lessons", { title: "Picked lesson", course: picked.id });
    otherLesson = await create("lms-lessons", { title: "Other lesson", course: other.id });
  });

  it("shows a plan's price in the site's currency on a pricing page", async () => {
    const plans = (await call(records("payments-plans", `?filter=${encodeURIComponent('name = "somecourses"')}`))).json.items;
    expect(plans[0]).toMatchObject({ amount: 9, currency: "usd" });
  });

  it("enrolls a subscriber in the courses their plan covers, and nobody else", async () => {
    expect((await enroll(picked.id, learner)).json.error.code).toBe("ENROLLMENT_REQUIRED");
    expect(await lessonStatus(pickedLesson.id, learner)).toBe(404);

    const given = await grant("somecourses");
    expect(await wait(async () => (await enroll(picked.id, learner)).status === 200)).toBe(true);
    expect((await planEnrollments(picked.id))).toEqual([expect.objectContaining({ source: "plan", state: "active" })]);
    expect(await lessonStatus(pickedLesson.id, learner)).toBe(200);
    // Coverage is read from what's stored: a course outside the plan stays closed, and a visitor gets nothing.
    expect((await enroll(other.id, learner)).json.error.code).toBe("ENROLLMENT_REQUIRED");
    expect(await lessonStatus(otherLesson.id, learner)).toBe(404);
    expect(await lessonStatus(pickedLesson.id, null)).toBe(404);

    // The plan ends: the enrollment lapses and its lessons close on the next request.
    await end(given);
    expect(await wait(async () => (await lessonStatus(pickedLesson.id, learner)) === 404)).toBe(true);
    expect(await planEnrollments(picked.id)).toEqual([expect.objectContaining({ source: "plan", state: "lapsed" })]);
    expect((await call(records("lms-enrollments"), { as: learner })).json.items).toEqual([expect.objectContaining({ state: "lapsed" })]);
  });

  it("opens a lapsed course again, in the same enrollment, and every course with a plan that opens them all", async () => {
    const [lapsed] = await planEnrollments(picked.id);
    const given = await grant("everycourse");
    expect(await wait(async () => (await lessonStatus(pickedLesson.id, learner)) === 200)).toBe(true);
    expect(await planEnrollments(picked.id)).toEqual([expect.objectContaining({ id: lapsed.id, state: "active" })]);
    expect((await enroll(other.id, learner)).json).toMatchObject({ source: "plan", created: true });
    expect(await lessonStatus(otherLesson.id, learner)).toBe(200);
    await end(given);
    expect(await wait(async () => (await lessonStatus(otherLesson.id, learner)) === 404)).toBe(true);
    expect(await lessonStatus(pickedLesson.id, learner)).toBe(404);
  });

  it("follows a course taken out of a plan, and keeps a course the learner bought or was given by staff", async () => {
    const given = await grant("somecourses");
    expect(await wait(async () => (await lessonStatus(pickedLesson.id, learner)) === 200)).toBe(true);
    // Staff enroll them in it too, so it no longer depends on the plan.
    const staff = await call("/api/ext/lms/enrollments", { method: "POST", as: root, body: { course: picked.id, emails: [learner.email] } });
    expect(staff.status, staff.text).toBe(200);
    expect(await planEnrollments(picked.id)).toEqual([expect.objectContaining({ source: "staff", state: "active" })]);
    const taken = await call(records("lms-courses", `/${picked.id}`), { method: "PATCH", as: root, body: { included: [] } });
    expect(taken.status, taken.text).toBe(200);
    await end(given);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await lessonStatus(pickedLesson.id, learner)).toBe(200);

    // A course taken out of the plan lapses for those who joined through it.
    const back = await call(records("lms-courses", `/${other.id}`), { method: "PATCH", as: root, body: { included: [some.id] } });
    expect(back.status, back.text).toBe(200);
    const again = await grant("somecourses");
    expect(await wait(async () => (await lessonStatus(otherLesson.id, learner)) === 200)).toBe(true);
    const out = await call(records("lms-courses", `/${other.id}`), { method: "PATCH", as: root, body: { included: [] } });
    expect(out.status, out.text).toBe(200);
    expect(await wait(async () => (await lessonStatus(otherLesson.id, learner)) === 404)).toBe(true);
    await end(again);
  });
});

describe("payments plugin: other providers", () => {
  const CREEM_SECRET = "creem_whsec_integration";
  let gated: { id: number };

  /** Sends a Creem event the way Creem does: the raw body, with its HMAC-SHA256 in creem-signature. */
  async function creemWebhook(eventType: string, object: Record<string, unknown>, secret = CREEM_SECRET) {
    const payload = JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, eventType, created_at: Date.now(), object });
    return call("/api/auth/creem/webhook", { method: "POST", body: payload, headers: { "creem-signature": createHmac("sha256", secret).update(payload).digest("hex") } });
  }

  const subscription = (status: string) => ({
    id: "sub_creem_1",
    object: "subscription",
    status,
    product: { id: "prod_creem_pro", object: "product" },
    customer: { id: "cust_creem_1", object: "customer" },
    metadata: { referenceId: buyer.id },
    current_period_end_date: new Date(Date.now() + 30 * 86400_000).toISOString(),
  });

  beforeAll(async () => {
    await collection("pay-creem", [{ name: "title", type: "text" }], { listRule: '@request.auth.payments_plan = "studio"', viewRule: '@request.auth.payments_plan = "studio"' });
    gated = await create("pay-creem", { title: "Studio only" });
  });

  afterAll(async () => {
    await saveSettings({ provider: "stripe" });
  });

  it("takes plan ids in the chosen provider's form", async () => {
    await saveSettings({ provider: "creem", creemApiKey: "creem_test_integration", creemWebhookSecret: CREEM_SECRET, testMode: true });
    expect((await call(records("payments-plans"), { method: "POST", as: root, body: { status: "published", name: "bad-creem", priceId: "price_123" } })).status).toBe(400);
    expect((await create("payments-plans", { name: "Studio", priceId: "prod_creem_pro" })).name).toBe("studio");
  });

  it("switches to Creem, keeping its tables as collections and closing its endpoints that trust the caller", async () => {
    expect(await webhookLive("/creem/webhook")).toBe(true);
    // Stripe's plugin is gone with it.
    expect((await call("/api/auth/stripe/webhook", { method: "POST", body: "{}" })).status).toBe(404);
    const slugs = ((await call("/api/collections", { as: root })).json as Array<{ slug: string }>).map((c) => c.slug);
    expect(slugs).toContain("payments-creem-subscription");
    for (const path of ["/creem/create-checkout", "/creem/create-portal", "/creem/retrieve-subscription", "/creem/search-transactions", "/creem/cancel-subscription"]) {
      expect((await call(`/api/auth${path}`, { method: "POST", as: buyer, body: { customerId: "cust_someone_else", productId: "prod_creem_pro" } })).status, path).toBe(404);
    }
  });

  it("refuses an unsigned event, and a purchase Payments never started", async () => {
    // Creem's plugin answers a bad signature with 200 and {"error":"Invalid signature"}, as better-auth drops the 400 it asks for. It still changes nothing.
    const unsigned = await creemWebhook("subscription.active", { ...subscription("active"), id: "sub_creem_unsigned" }, "wrong");
    expect(unsigned.json).toEqual({ error: "Invalid signature" });
    await new Promise((r) => setTimeout(r, 500));
    expect((await call(records("payments-memberships"), { as: buyer })).json.items).toHaveLength(0);
    const forged = await creemWebhook("checkout.completed", {
      id: "ch_forged", object: "checkout", status: "completed", product: "prod_cheap",
      order: { id: "ord_forged", object: "order", amount: 100, currency: "USD", status: "paid" },
      metadata: { tansy: "purchase", collection: "pay-guides", recordId: "1", userId: other.id, ref: "ref_0123456789abcdef0123456789abcdef" },
    });
    expect(forged.status, forged.text).toBe(200);
    expect((await call(records("payments-purchases"), { as: other })).json.items).toHaveLength(0);
  });

  it("keeps a Creem subscription as a membership, and opens what its plan gates", async () => {
    expect((await call(records("pay-creem", `/${gated.id}`), { as: buyer })).status).toBe(404);
    for (let i = 0; i < 2; i++) expect((await creemWebhook("subscription.active", subscription("active"))).status).toBe(200);
    expect(await wait(async () => (await call(records("pay-creem", `/${gated.id}`), { as: buyer })).status === 200)).toBe(true);
    const mine = (await call(records("payments-memberships"), { as: buyer })).json.items;
    expect(mine).toEqual([expect.objectContaining({ provider: "creem", subscriptionId: "sub_creem_1", user: buyer.id, plan: "studio", state: "active" })]);
    // Each person sees only their own, and only Payments writes them.
    expect((await call(records("payments-memberships"), { as: other })).json.items).toHaveLength(0);
    expect((await call(records("payments-memberships"), { method: "POST", as: buyer, body: { provider: "creem", subscriptionId: "x", user: buyer.id, state: "active" } })).status).toBe(403);
  });

  it("closes it again when the subscription expires", async () => {
    expect((await creemWebhook("subscription.expired", subscription("expired"))).status).toBe(200);
    expect(await wait(async () => (await call(records("pay-creem", `/${gated.id}`), { as: buyer })).status === 404)).toBe(true);
  });

  it("sets up Polar, Dodo Payments and Commet the same way, each closing what it must", async () => {
    await saveSettings({ provider: "polar", polarAccessToken: "polar_oat_integration", polarWebhookSecret: "polar_whs_integration" });
    expect(await webhookLive("/polar/webhooks")).toBe(true);
    expect((await call("/api/auth/polar/webhooks", { method: "POST", body: "{}", headers: { "webhook-id": "x", "webhook-timestamp": "1", "webhook-signature": "v1,bad" } })).status).toBeGreaterThanOrEqual(400);
    expect((await call("/api/auth/checkout", { method: "POST", as: buyer, body: { products: ["any"], metadata: { tansy: "purchase" } } })).status).toBe(404);

    await saveSettings({ provider: "dodo", dodoApiKey: "dodo_integration", dodoWebhookSecret: "whsec_ZG9kb19pbnRlZ3JhdGlvbg==" });
    expect(await webhookLive("/dodopayments/webhooks")).toBe(true);
    for (const path of ["/dodopayments/checkout", "/dodopayments/checkout-session"]) expect((await call(`/api/auth${path}`, { method: "POST", as: buyer, body: {} })).status, path).toBe(404);

    await saveSettings({ provider: "commet", commetApiKey: "ck_integration", commetWebhookSecret: "whsec_integration" });
    expect(await webhookLive("/commet/webhooks")).toBe(true);
    // Payments' own routes need the keys of the provider chosen, and then go through it.
    expect((await call(ext("/subscribe"), { method: "POST", as: buyer, body: { plan: "nope" } })).status).toBe(404);
  });
});

describe("shop plugin: an order paid through Payments", () => {
  const shop = (path: string) => `/api/ext/shop${path}`;
  const address = { name: "Pat Buyer", line1: "1 Main St", city: "Springfield", postalCode: "12345" };
  let tee: { id: number }, guide: { id: number };
  const session = (id: string, order: number, amount: number) => ({
    id,
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    amount_total: amount,
    currency: "usd",
    payment_intent: `pi_${id}`,
    metadata: { tansy: "purchase", collection: "shop-orders", recordId: String(order), userId: buyer.id },
  });
  const stockOf = async (id: number) => (await call(records("shop-products", `/${id}`), { as: root })).json.stock;
  const orderOf = async (id: number, as: Actor = root) => (await call(records("shop-orders", `/${id}`), { as })).json;

  beforeAll(async () => {
    await saveSettings({ provider: "stripe" });
    expect(await webhookLive("/stripe/webhook")).toBe(true);
    tee = await create("shop-products", { title: "Shop Tee", price: 10, stock: 3, shipping: true });
    guide = await create("shop-products", { title: "Shop Guide", price: 5, shipping: false });
    // A new shop ships everywhere for free. Replace that with one zone, as an owner would, so somewhere is out of reach.
    for (const zone of (await call(records("shop-shipping-zones"), { as: root })).json.items) {
      expect((await call(records("shop-shipping-zones", `/${zone.id}`), { method: "DELETE", as: root })).status).toBe(204);
    }
    await create("shop-shipping-zones", { name: "Home", countries: ["US"], rate: 5 });
  });

  it("installs its collections, pages and a slug from the title", async () => {
    const slugs = ((await call("/api/collections", { as: root })).json as Array<{ slug: string }>).map((c) => c.slug);
    for (const slug of ["shop-products", "shop-variants", "shop-orders", "shop-store", "shop-cart", "shop-account"]) expect(slugs).toContain(slug);
    expect((await call(records("shop-products", `/${tee.id}`))).json.slug).toBe("shop-tee");
  });

  it("prices a cart before sign-in, from stored prices", async () => {
    const priced = (await call(shop("/quote"), { method: "POST", body: { items: [{ product: tee.id, quantity: 2 }], country: "US" } })).json;
    expect(priced).toMatchObject({ currency: "usd", subtotal: 20, shipping: 5, total: 25, ready: true });
    expect((await call(shop("/quote"), { method: "POST", body: { items: [{ product: tee.id, quantity: 2, unitPrice: 0.01 }] } })).status).toBe(400);
    expect((await call(shop("/quote"), { method: "POST", body: { items: [{ product: tee.id, quantity: 9 }], country: "US" } })).json.lines[0].problem).toBe("Only 3 left.");
  });

  let order: number;
  it("makes an order only for a signed-in customer, which only they can read and nobody can rewrite", async () => {
    const body = { items: [{ product: tee.id, quantity: 2 }], country: "US", address };
    expect((await call(shop("/orders"), { method: "POST", body })).status).toBe(401);
    expect((await call(shop("/orders"), { method: "POST", as: buyer, body: { ...body, address: undefined } })).status).toBe(400);
    expect((await call(shop("/orders"), { method: "POST", as: buyer, body: { ...body, country: "FR" } })).status).toBe(409);
    const made = await call(shop("/orders"), { method: "POST", as: buyer, body });
    expect(made.status, made.text).toBe(200);
    order = made.json.order.id;
    expect(made.json.order).toMatchObject({ total: 25, currency: "usd" });
    expect(await orderOf(order, buyer)).toMatchObject({ customer: buyer.id, state: "pending", total: 25, address: expect.objectContaining({ country: "US" }) });
    expect((await call(records("shop-orders", `/${order}`), { as: other })).status).toBe(404);
    expect((await call(records("shop-orders"), { as: other })).json.items).toHaveLength(0);
    expect((await call(records("shop-orders", `/${order}`), { method: "PATCH", as: buyer, body: { total: 1 } })).status).toBe(403);
    // Someone else can't pay for it, as Payments reads the order as them.
    expect((await call(ext("/checkout"), { method: "POST", as: other, body: { collection: "shop-orders", id: order } })).status).toBe(404);
    // Even staff can't change what it was priced at.
    expect((await call(records("shop-orders", `/${order}`), { method: "PATCH", as: root, body: { total: 1 } })).status).toBe(400);
  });

  it("is paid once when Stripe confirms it, taking stock once", async () => {
    for (let i = 0; i < 2; i++) expect((await webhook("checkout.session.completed", session("cs_shop_1", order, 2500))).status).toBe(200);
    expect(await wait(async () => (await orderOf(order)).state === "paid")).toBe(true);
    expect(await wait(async () => (await stockOf(tee.id)) === 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(await stockOf(tee.id)).toBe(1);
    expect((await orderOf(order)).paidAt).toEqual(expect.any(String));
  });

  it("ships only for staff who fulfil orders, and only forward", async () => {
    expect((await call(shop(`/orders/${order}/status`), { method: "POST", as: buyer, body: { state: "shipped" } })).status).toBe(403);
    const shipped = await call(shop(`/orders/${order}/status`), { method: "POST", as: root, body: { state: "shipped", trackingUrl: "https://track.example/1" } });
    expect(shipped.status, shipped.text).toBe(200);
    expect(await orderOf(order, buyer)).toMatchObject({ state: "shipped", trackingUrl: "https://track.example/1", shippedAt: expect.any(String) });
    expect((await call(shop(`/orders/${order}/status`), { method: "POST", as: root, body: { state: "shipped" } })).status).toBe(409);
    expect((await call(records("shop-orders", `/${order}`), { method: "PATCH", as: root, body: { state: "pending" } })).status).toBe(400);
  });

  it("is taken back and restocked when the payment is refunded", async () => {
    expect((await webhook("charge.refunded", { id: "ch_shop", object: "charge", payment_intent: "pi_cs_shop_1", refunded: true })).status).toBe(200);
    expect(await wait(async () => (await orderOf(order)).state === "refunded")).toBe(true);
    expect(await wait(async () => (await stockOf(tee.id)) === 3)).toBe(true);
  });

  it("delivers a download-only order as soon as it's paid", async () => {
    const made = await call(shop("/orders"), { method: "POST", as: buyer, body: { items: [{ product: guide.id, quantity: 1 }] } });
    expect(made.status, made.text).toBe(200);
    const id = made.json.order.id;
    expect(await orderOf(id, buyer)).toMatchObject({ needsShipping: false, total: 5 });
    expect((await webhook("checkout.session.completed", session("cs_shop_2", id, 500))).status).toBe(200);
    expect(await wait(async () => (await orderOf(id)).state === "delivered")).toBe(true);
  });
});
