import { describe, expect, it } from "vitest";
import type { AfterHookContext, ExtensionContext } from "@/core/extend/define";
import { accessCollectionsProblem, accessOf } from "../../plugins/payments/logic";
import { ACCESS, ACCESS_FIELD, accessSync, ENTITLEMENTS, MEMBERSHIPS, PLAN_FIELD, PLANS, PURCHASES, recordPurchase, recordRefund, rememberCheckout, upsertMembership } from "../../plugins/payments/shared";

/**
 * Payments' shared records against an in-memory stand-in for the records API, which
 * understands the few filters they use: `a = "x"`, `a = 1` and `a ?= 1`, joined by && or ||.
 */
function fakeContext(users = ["u_buyer", "u_other"]) {
  const tables = new Map<string, Array<Record<string, unknown>>>();
  const store = new Map<string, unknown>();
  const values = new Map<string, Record<string, unknown>>();
  let next = 1;
  const rows = (slug: string) => tables.get(slug) ?? tables.set(slug, []).get(slug)!;
  const matches = (row: Record<string, unknown>, filter = "") => {
    const clause = (text: string) => {
      const [, field, any, raw] = /^\s*(\w+)\s*(\?)?=\s*(.+?)\s*$/.exec(text)!;
      const value = raw.startsWith('"') ? raw.slice(1, -1) : Number(raw);
      return any ? Array.isArray(row[field]) && (row[field] as unknown[]).includes(value) : row[field] === value;
    };
    return !filter || filter.split("||").some((any) => any.split("&&").every(clause));
  };
  const records = {
    list: async (slug: string, options: { filter?: string } = {}) => ({ items: rows(slug).filter((row) => matches(row, options.filter)), totalPages: 1 }),
    create: async (slug: string, data: Record<string, unknown>) => {
      if (slug === PURCHASES && rows(slug).some((row) => row.sessionId === data.sessionId)) throw Object.assign(new Error("dup"), { code: "VALIDATION_FAILED", details: [{ path: "sessionId" }] });
      const row = { id: next++, ...data };
      rows(slug).push(row);
      return row;
    },
    update: async (slug: string, id: number, data: Record<string, unknown>) => Object.assign(rows(slug).find((row) => row.id === id)!, data),
  };
  const context = {
    system: {
      records,
      users: {
        get: async (id: string) => (users.includes(id) ? { id } : null),
        setValues: async (id: string, change: Record<string, unknown>) => { values.set(id, { ...values.get(id), ...change }); },
      },
    },
    store: { get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: unknown) => { store.set(key, value); } },
  } as unknown as ExtensionContext;
  return { context, rows, values };
}

const metadata = (ref: string, recordId = 7, userId = "u_buyer") => ({ tansy: "purchase", collection: "guides", recordId: String(recordId), userId, ref });
const paid = (ref: string, extra: Record<string, unknown> = {}) => ({ provider: "polar", sessionId: ref, paymentRef: `order_${ref}`, metadata: metadata(ref), amount: 1250, currency: "usd", ...extra });

describe("recording purchases", () => {
  it("records a checkout Payments started, once", async () => {
    const { context, rows } = fakeContext();
    await rememberCheckout(context, "ref_a", { id: "chk_1", userId: "u_buyer", collection: "guides", recordId: 7, at: Date.now() });
    expect(await recordPurchase(context, paid("ref_a"))).toBe(true);
    expect(await recordPurchase(context, paid("ref_a"))).toBe(true);
    expect(rows(PURCHASES)).toEqual([expect.objectContaining({ buyer: "u_buyer", collection: "guides", recordId: 7, amount: 12.5, state: "paid", provider: "polar", sessionId: "ref_a" })]);
  });

  it("refuses metadata that doesn't match a checkout Payments started", async () => {
    const { context, rows } = fakeContext();
    // A checkout made around Payments, such as with a provider's own endpoint, claiming a purchase.
    expect(await recordPurchase(context, paid("ref_forged"))).toBe(false);
    await rememberCheckout(context, "ref_b", { id: "chk_2", userId: "u_buyer", collection: "guides", recordId: 7, at: Date.now() });
    // Started for one record, claimed for another, for someone else, or under another session.
    expect(await recordPurchase(context, paid("ref_b", { metadata: metadata("ref_b", 99) }))).toBe(false);
    expect(await recordPurchase(context, paid("ref_b", { metadata: metadata("ref_b", 7, "u_other") }))).toBe(false);
    expect(await recordPurchase(context, paid("ref_b", { sessionId: "ref_other" }))).toBe(false);
    expect(rows(PURCHASES)).toHaveLength(0);
  });

  it("trusts metadata only when the provider says no one else can set it", async () => {
    const { context, rows } = fakeContext();
    expect(await recordPurchase(context, { ...paid("cs_1"), provider: "stripe", metadataTrusted: true, metadata: { tansy: "purchase", collection: "guides", recordId: "7", userId: "u_buyer" } })).toBe(true);
    expect(rows(PURCHASES)).toHaveLength(1);
  });

  it("marks a purchase refunded by its session or its payment", async () => {
    const { context, rows } = fakeContext();
    for (const ref of ["ref_c", "ref_d"]) {
      await rememberCheckout(context, ref, { id: ref, userId: "u_buyer", collection: "guides", recordId: 7, at: Date.now() });
      await recordPurchase(context, paid(ref));
    }
    await recordRefund(context, { sessionId: "ref_c" });
    await recordRefund(context, { paymentRef: "order_ref_d" });
    expect(rows(PURCHASES).map((row) => row.state)).toEqual(["refunded", "refunded"]);
  });
});

describe("memberships", () => {
  const plans = [{ name: "pro", productId: "prod_m", annualProductId: "prod_y" }];
  const update = (status: string, at: number, extra: Record<string, unknown> = {}) => ({ provider: "creem", subscriptionId: "sub_1", user: "u_buyer", productId: "prod_y", status, at, ...extra });

  it("keeps one record per subscription, newest event winning", async () => {
    const { context, rows } = fakeContext();
    await upsertMembership(context, update("active", 2000), plans);
    // Delivered late: an older event changes nothing.
    await upsertMembership(context, update("pending", 1000), plans);
    expect(rows(MEMBERSHIPS)).toEqual([expect.objectContaining({ subscriptionId: "sub_1", user: "u_buyer", plan: "pro", state: "active", eventAt: 2000 })]);
    // A later event without the user still finds whose it is.
    await upsertMembership(context, update("canceled", 3000, { user: null }), plans);
    expect(rows(MEMBERSHIPS)).toEqual([expect.objectContaining({ user: "u_buyer", state: "canceled" })]);
  });

  it("ignores a subscription no one here can be matched to", async () => {
    const { context, rows } = fakeContext();
    await upsertMembership(context, update("active", 1, { user: "u_stranger" }), plans);
    await upsertMembership(context, update("active", 1, { user: null, subscriptionId: "sub_2" }), plans);
    expect(rows(MEMBERSHIPS)).toHaveLength(0);
  });
});

describe("plan sync", () => {
  const sync = accessSync([{ collection: "payments-subscription", user: "referenceId", plan: "plan", state: "subscriptionStatus" }]);
  const hookOn = (context: ExtensionContext) => (slug: string, record: Record<string, unknown>, previous?: Record<string, unknown>) =>
    sync({ ...context, collection: { id: 1, slug, name: slug }, record, previous } as unknown as AfterHookContext);

  it("sets the plan field from memberships and from a provider's own subscriptions", async () => {
    const { context, rows, values } = fakeContext();
    const hook = hookOn(context);

    rows("payments-subscription").push({ id: 50, referenceId: "u_buyer", plan: "team", subscriptionStatus: "canceled" });
    rows(MEMBERSHIPS).push({ id: 51, user: "u_buyer", plan: "pro", state: "active" });
    await hook(MEMBERSHIPS, rows(MEMBERSHIPS)[0]);
    expect(values.get("u_buyer")).toEqual({ [PLAN_FIELD]: "pro", [ACCESS_FIELD]: [] });

    rows(MEMBERSHIPS)[0].state = "expired";
    await hook(MEMBERSHIPS, rows(MEMBERSHIPS)[0]);
    expect(values.get("u_buyer")).toEqual({ [PLAN_FIELD]: null, [ACCESS_FIELD]: [] });

    rows("payments-subscription")[0].subscriptionStatus = "trialing";
    await hook("payments-subscription", rows("payments-subscription")[0]);
    expect(values.get("u_buyer")).toEqual({ [PLAN_FIELD]: "team", [ACCESS_FIELD]: [] });

    // Other collections are none of its business.
    await hook("blog-posts", { user: "u_other" });
    expect(values.has("u_other")).toBe(false);
  });

  it("gives a person on two plans the access of both, and takes back only what one plan gave", async () => {
    const { context, rows, values } = fakeContext();
    const hook = hookOn(context);
    rows(ACCESS).push({ id: 100, name: "All courses", collections: ["lms-courses"] }, { id: 101, name: "Premium posts", collections: [] }, { id: 102, name: "Club", collections: null });
    rows(PLANS).push({ id: 110, name: "learn", includes: [100] }, { id: 111, name: "read", includes: [101, 102] });
    rows("payments-subscription").push({ id: 120, referenceId: "u_buyer", plan: "learn", subscriptionStatus: "active" });
    rows(MEMBERSHIPS).push({ id: 121, user: "u_buyer", plan: "read", state: "active" });

    await hook(MEMBERSHIPS, rows(MEMBERSHIPS)[0]);
    expect(values.get("u_buyer")?.[ACCESS_FIELD]).toEqual([100, 101, 102, "lms-courses"]);
    expect(rows(ENTITLEMENTS)).toEqual([expect.objectContaining({ user: "u_buyer", plans: ["read", "learn"], access: [100, 101, 102, "lms-courses"] })]);

    rows(MEMBERSHIPS)[0].state = "canceled";
    await hook(MEMBERSHIPS, rows(MEMBERSHIPS)[0]);
    expect(values.get("u_buyer")).toEqual({ [PLAN_FIELD]: "learn", [ACCESS_FIELD]: [100, "lms-courses"] });
    expect(rows(ENTITLEMENTS)).toHaveLength(1);
  });

  it("updates everyone a plan or an access reaches when either changes", async () => {
    const { context, rows, values } = fakeContext();
    const hook = hookOn(context);
    rows(ACCESS).push({ id: 200, name: "Premium", collections: [] });
    rows(PLANS).push({ id: 210, name: "pro", includes: [] });
    rows(MEMBERSHIPS).push({ id: 220, user: "u_buyer", plan: "pro", state: "active" }, { id: 221, user: "u_other", plan: "basic", state: "active" });
    await hook(MEMBERSHIPS, rows(MEMBERSHIPS)[0]);
    expect(values.get("u_buyer")?.[ACCESS_FIELD]).toEqual([]);

    // The owner adds Premium to Pro: its subscribers get it, and no one else.
    rows(PLANS)[0].includes = [200];
    await hook(PLANS, rows(PLANS)[0], { ...rows(PLANS)[0], includes: [] });
    expect(values.get("u_buyer")?.[ACCESS_FIELD]).toEqual([200]);
    expect(values.get("u_other")).toBeUndefined();

    // Premium now also opens a collection.
    rows(ACCESS)[0].collections = ["blog-posts"];
    await hook(ACCESS, rows(ACCESS)[0]);
    expect(values.get("u_buyer")?.[ACCESS_FIELD]).toEqual([200, "blog-posts"]);

    // Deleting it, which clears it from plans, takes it from everyone who had it.
    const [deleted] = rows(ACCESS).splice(0, 1);
    rows(PLANS)[0].includes = [];
    await hook(ACCESS, deleted);
    expect(values.get("u_buyer")?.[ACCESS_FIELD]).toEqual([]);
  });
});

describe("access", () => {
  it("lists ids then collection slugs, once each, from active plans only", () => {
    const plans = [{ name: "a", includes: [3, 1] }, { name: "b", includes: [1, 2] }, { name: "c", includes: [4] }];
    const grants = [{ id: 1, collections: ["lms-courses"] }, { id: 2, collections: ["blog-posts", "lms-courses"] }, { id: 3, collections: [] }, { id: 4, collections: ["shop-products"] }];
    expect(accessOf(["a", "b"], plans, grants)).toEqual([1, 2, 3, "blog-posts", "lms-courses"]);
    // An access a plan still names after it was deleted grants nothing.
    expect(accessOf(["a"], plans, grants.slice(1))).toEqual([3]);
    expect(accessOf([], plans, grants)).toEqual([]);
  });

  it("takes only collection slugs", () => {
    expect(accessCollectionsProblem(["lms-courses", "blog-posts"])).toBeNull();
    expect(accessCollectionsProblem(null)).toBeNull();
    expect(accessCollectionsProblem("lms-courses")).not.toBeNull();
    expect(accessCollectionsProblem(['x" || true'])).not.toBeNull();
    expect(accessCollectionsProblem(Array.from({ length: 51 }, (_, i) => `c-${i}`))).not.toBeNull();
  });
});
