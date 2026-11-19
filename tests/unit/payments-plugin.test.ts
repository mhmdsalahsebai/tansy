import { describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { stripe } from "@better-auth/stripe";
import type { BetterAuthPlugin } from "better-auth";
import type { PluginMigrationContext } from "@/core/extend/define";
import { assertPluginManifest } from "@/core/extend/manifest";
import { resolveSettings, settingsProblem, settingsSchema } from "@/core/extend/settings-schema";
import { schemaDocument } from "@/core/schema/portable";
import { columnFor, planPluginModels } from "@/core/auth/plugin-models";
import { MEMBERSHIPS, payments, PLAN_FIELD, PLANS, PURCHASES } from "../../plugins/payments/index";
import { ACTIVE_STATES, fromMinorUnits, itemName, membershipState, planNamed, productSlugs, REFERENCE, returnUrl, sitePath, toMinorUnits, toPlanRef } from "../../plugins/payments/logic";
import { definePaymentProvider, newReference, type PaymentProvider } from "../../plugins/payments/provider";
import { commet } from "../../plugins/payments-commet/index";
import { creem } from "../../plugins/payments-creem/index";
import { dodo } from "../../plugins/payments-dodo/index";
import { polar } from "../../plugins/payments-polar/index";
import { stripe as stripeProvider, toStripePlan } from "../../plugins/payments-stripe/index";

const PROVIDER = { stripe: stripeProvider(), polar: polar(), dodo: dodo(), creem: creem(), commet: commet() };
const PROVIDERS = Object.keys(PROVIDER);
const all = () => Object.values(PROVIDER);

const core = new Map([
  ["user", new Set(["id", "name", "email", "emailVerified", "image", "createdAt", "updatedAt", "role", "banned", "banReason", "banExpires", "twoFactorEnabled"])],
  ["session", new Set(["id", "userId", "token", "expiresAt"])],
]);

const stripePlugin = () => stripe({ stripeClient: new Stripe("sk_test_unit"), stripeWebhookSecret: "whsec_unit", subscription: { enabled: true, plans: [] } }) as unknown as BetterAuthPlugin;

describe("better-auth plugin models", () => {
  it("keeps a plugin's own tables and its columns on core tables in the plugin's collections", () => {
    const plans = planPluginModels([{ name: "payments", plugins: [stripePlugin()] }], core);
    const subscription = plans.find((plan) => plan.model === "subscription")!;
    expect(subscription).toMatchObject({ plugin: "payments", slug: "payments-subscription", kind: "model" });
    expect(subscription.fields.map((field) => field.name)).toEqual(expect.arrayContaining(["plan", "referenceId", "status", "periodEnd", "cancelAtPeriodEnd"]));
    // Records reserve `status`, so it gets the model's name in front.
    expect(subscription.fields.find((field) => field.name === "status")?.column).toBe("subscriptionStatus");
    expect(subscription.fields.find((field) => field.name === "plan")?.column).toBe("plan");

    const user = plans.find((plan) => plan.model === "user")!;
    expect(user).toMatchObject({ slug: "payments-user-data", kind: "fields" });
    expect(user.fields.map((field) => field.name)).toEqual(["stripeCustomerId"]);
  });

  it("leaves alone what core's tables already have", () => {
    const plugin = { id: "known", schema: { user: { fields: { role: { type: "string" } } }, session: { fields: { token: { type: "string" } } } } } as unknown as BetterAuthPlugin;
    expect(planPluginModels([{ name: "known", plugins: [plugin] }], core)).toEqual([]);
  });

  it("names collection fields so they can't pass for system fields", () => {
    expect(columnFor("subscription", "id")).toBe("authId");
    expect(columnFor("subscription", "createdAt")).toBe("subscriptionCreatedAt");
    expect(columnFor("subscription", "plan")).toBe("plan");
  });

  it("refuses what it couldn't store faithfully", () => {
    const clash = { id: "clash", schema: { thing: { fields: { status: { type: "string" }, thingStatus: { type: "string" } } } } } as unknown as BetterAuthPlugin;
    expect(() => planPluginModels([{ name: "clash", plugins: [clash] }], core)).toThrow(/thingStatus/);
    const renamed = { id: "renamed", schema: { thing: { fields: { label: { type: "string", fieldName: "title" } } } } } as unknown as BetterAuthPlugin;
    expect(() => planPluginModels([{ name: "renamed", plugins: [renamed] }], core)).toThrow(/renaming/);
    const twice = (name: string) => ({ name, plugins: [{ id: name, schema: { shared: { fields: { a: { type: "string" } } } } } as unknown as BetterAuthPlugin] });
    expect(() => planPluginModels([twice("one"), twice("two")], core)).toThrow(/already declared by plugin "one"/);
  });
});

describe("secret plugin settings", () => {
  const field = { name: "apiKey", type: "secret" as const, env: "SOME_API_KEY", label: "API key" };

  it("accepts a secret, and starts unset", () => {
    expect(settingsProblem([field])).toBeNull();
    expect(resolveSettings([field], {})).toEqual({ apiKey: "" });
    expect(settingsSchema([field]).safeParse({ apiKey: "sk_live_x" }).success).toBe(true);
  });

  it("refuses a default or a bad variable name", () => {
    expect(settingsProblem([{ ...field, default: "x" } as never])).toMatch(/can't have a default/);
    expect(settingsProblem([{ ...field, env: "not a name" }])).toMatch(/environment variable/);
  });
});

describe("payments logic", () => {
  it("charges in each currency's smallest unit", () => {
    expect(toMinorUnits(19.99, "usd")).toBe(1999);
    expect(toMinorUnits(500, "JPY")).toBe(500);
    expect(toMinorUnits(1.5, "kwd")).toBe(1500);
    expect(fromMinorUnits(1999, "usd")).toBe(19.99);
    for (const bad of [0, -1, Number.NaN, "10", null, 0.001]) expect(toMinorUnits(bad, "usd")).toBeNull();
  });

  it("only ever sends buyers back to this site", () => {
    expect(sitePath("/courses/intro?x=1")).toBe("/courses/intro?x=1");
    for (const bad of ["https://evil.test", "//evil.test", "/\\evil.test", "courses", "/a\nb", 7]) expect(sitePath(bad)).toBe("/");
    expect(returnUrl("https://example.com", "//evil.test", "purchase", "success")).toBe("https://example.com/?purchase=success");
    expect(returnUrl("https://example.com", "/post?a=1", "purchase", "canceled")).toBe("https://example.com/post?a=1&purchase=canceled");
  });

  it("names the item from the record", () => {
    expect(itemName({ title: "  Intro  " }, "x")).toBe("Intro");
    expect(itemName({ name: "Mug" }, "x")).toBe("Mug");
    expect(itemName({}, "blog-posts 4")).toBe("blog-posts 4");
  });

  it("turns plan records into Stripe plans, skipping incomplete ones", () => {
    expect(toStripePlan({ name: " Pro ", priceId: "price_1", annualPriceId: "price_2", trialDays: 14, limits: { projects: 5 } })).toEqual({
      name: "pro", priceId: "price_1", annualDiscountPriceId: "price_2", limits: { projects: 5 }, freeTrial: { days: 14 },
    });
    expect(toStripePlan({ name: "pro" })).toBeNull();
    expect(toStripePlan({ name: "basic", priceId: "price_3", trialDays: 0, limits: [1] })).toEqual({ name: "basic", priceId: "price_3" });
  });
});

describe("payments plugin manifest", () => {
  it("is valid, and checks its options", () => {
    expect(() => assertPluginManifest(payments({ providers: all(), siteUrl: "https://example.com" }))).not.toThrow();
    expect(() => assertPluginManifest(payments({ providers: all(), siteUrl: "not a url" }))).toThrow();
    expect(() => assertPluginManifest(payments({ providers: all(), siteUrl: "https://example.com", currency: "USD" }))).toThrow(/currency/);
  });

  it("creates its collections and the plan user field, locked for writes", async () => {
    const apply = vi.fn(async () => {});
    const context = { schema: { describe: async () => null, apply } } as unknown as PluginMigrationContext;
    await payments({ providers: all(), siteUrl: "https://example.com" }).migrations![0].up(context);
    const document = schemaDocument.parse((apply.mock.calls[0] as unknown[])[0]);
    expect(document.collections.map((collection) => collection.slug)).toEqual([PLANS, PURCHASES]);
    for (const collection of document.collections) expect([collection.rules.createRule, collection.rules.updateRule, collection.rules.deleteRule]).toEqual([null, null, null]);
    expect(document.collections[1].rules.viewRule).toBe("buyer = @request.auth.id");
    expect(document.userFields).toEqual([expect.objectContaining({ name: PLAN_FIELD, selfEditable: false })]);
  });

  it("adds no better-auth plugin until both Stripe keys are set", async () => {
    const plugin = payments({ providers: all(), siteUrl: "https://example.com" });
    const context = (values: Record<string, unknown>) => ({ settings: { get: async () => ({ provider: "stripe", currency: "usd", createCustomerOnSignUp: false, ...values }) } }) as never;
    expect(await plugin.auth!.plugins!({} as never, context({ stripeSecretKey: "", stripeWebhookSecret: "" }), {} as never)).toEqual([]);
    expect(await plugin.auth!.plugins!({} as never, context({ stripeSecretKey: "sk_test_x", stripeWebhookSecret: "" }), {} as never)).toEqual([]);
    const [built] = await plugin.auth!.plugins!({} as never, context({ stripeSecretKey: "sk_test_x", stripeWebhookSecret: "whsec_x" }), {} as never);
    expect(built.id).toBe("stripe");
  });

  it("adds the chosen provider's better-auth plugin, and only once its keys are set", async () => {
    const plugin = payments({ providers: all(), siteUrl: "https://example.com" });
    const keys = {
      polar: { polarAccessToken: "polar_oat_x", polarWebhookSecret: "polar_whs_x" },
      dodo: { dodoApiKey: "dodo_x", dodoWebhookSecret: "whsec_x" },
      creem: { creemApiKey: "creem_test_x", creemWebhookSecret: "whsec_x" },
      commet: { commetApiKey: "ck_x", commetWebhookSecret: "whsec_x" },
    };
    const ids = { polar: "polar", dodo: "dodopayments", creem: "creem", commet: "commet" };
    for (const [provider, values] of Object.entries(keys) as Array<[keyof typeof keys, Record<string, string>]>) {
      const context = (extra: Record<string, unknown>) => ({ settings: { get: async () => ({ provider, currency: "usd", testMode: true, createCustomerOnSignUp: false, ...extra }) }, system: {}, store: {} }) as never;
      expect(await plugin.auth!.plugins!({} as never, context({}), {} as never)).toEqual([]);
      // Stripe's keys don't set up another provider.
      expect(await plugin.auth!.plugins!({} as never, context({ stripeSecretKey: "sk_test_x", stripeWebhookSecret: "whsec_x" }), {} as never)).toEqual([]);
      const built = await plugin.auth!.plugins!({} as never, context(values), {} as never);
      expect(built.map((one) => one.id)).toEqual([ids[provider]]);
    }
  });

  it("closes the providers' endpoints that trust what the caller sends", () => {
    const closed = payments({ providers: all(), siteUrl: "https://example.com" }).auth!.serverOnlyPaths!;
    for (const path of ["/checkout", "/dodopayments/checkout-session", "/creem/create-checkout", "/creem/create-portal", "/creem/retrieve-subscription", "/creem/search-transactions"]) expect(closed).toContain(path);
    // Webhooks and the caller's own billing pages stay open.
    for (const path of ["/stripe/webhook", "/polar/webhooks", "/dodopayments/webhooks", "/creem/webhook", "/commet/webhooks", "/customer/portal", "/subscription/upgrade"]) expect(closed).not.toContain(path);
  });

  it("needs at least one provider, each once, and a default among them", () => {
    expect(() => payments({ providers: [], siteUrl: "https://example.com" })).toThrow(/at least one provider/);
    expect(() => payments({ providers: [stripeProvider(), stripeProvider()], siteUrl: "https://example.com" })).toThrow(/listed twice/);
    expect(() => payments({ providers: [polar()], provider: "stripe", siteUrl: "https://example.com" })).toThrow(/isn't one of the providers/);
    expect(payments({ providers: [polar(), creem()], siteUrl: "https://example.com" }).settings!.fields.find((field) => field.name === "provider")).toMatchObject({ default: "polar" });
  });

  it("shows only the installed providers' settings", () => {
    const names = payments({ providers: [polar()], siteUrl: "https://example.com" }).settings!.fields.map((field) => field.name);
    expect(names).toContain("polarAccessToken");
    expect(names.some((name) => name.startsWith("stripe") || name.startsWith("creem"))).toBe(false);
  });

  it("refuses a provider whose setting another could claim", () => {
    const rogue: PaymentProvider = definePaymentProvider({ ...polar(), id: "rogue", settings: () => [{ name: "stripeSecretKey", type: "secret", label: "Mine" }] });
    expect(() => payments({ providers: [stripeProvider(), rogue], siteUrl: "https://example.com" })).toThrow(/must start with "rogue"/);
  });

  it("offers every provider in its settings, with Stripe first", () => {
    const fields = payments({ providers: all(), siteUrl: "https://example.com" }).settings!.fields;
    expect(settingsProblem(fields)).toBeNull();
    const provider = fields.find((field) => field.name === "provider");
    expect(provider).toMatchObject({ type: "select", default: "stripe" });
    expect((provider as { options: Array<{ value: string }> }).options.map((option) => option.value)).toEqual([...PROVIDERS]);
    for (const field of fields.filter((one) => /Key|Token|Secret/.test(one.name))) expect(field.type).toBe("secret");
    expect(payments({ providers: all(), siteUrl: "https://example.com", provider: "creem" }).settings!.fields.find((field) => field.name === "provider")).toMatchObject({ default: "creem" });
  });

  it("adds the memberships collection and the purchase's provider in a second migration", async () => {
    const apply = vi.fn(async () => {});
    const addFields = vi.fn(async () => true);
    const context = { schema: { describe: async () => null, apply, addFields } } as unknown as PluginMigrationContext;
    const migration = payments({ providers: all(), siteUrl: "https://example.com" }).migrations![1];
    expect(migration.id).toBe("002-providers");
    await migration.up(context);
    expect(addFields).toHaveBeenCalledWith(PURCHASES, [expect.objectContaining({ name: "provider" })]);
    const document = schemaDocument.parse((apply.mock.calls[0] as unknown[])[0]);
    expect(document.collections.map((collection) => collection.slug)).toEqual([MEMBERSHIPS]);
    expect(document.collections[0].rules).toMatchObject({ viewRule: "user = @request.auth.id", createRule: null, updateRule: null, deleteRule: null });
  });
});

describe("payments providers", () => {
  it("checks a plan's id against the provider it's for", () => {
    const problem = (id: keyof typeof PROVIDER, value: string) => PROVIDER[id].planIdProblem(value);
    expect(problem("stripe", "price_1")).toBeNull();
    expect(problem("stripe", "prod_1")).toMatch(/price_/);
    expect(problem("polar", "1c4e2f6a-0b1c-4d2e-8f3a-123456789abc")).toBeNull();
    expect(problem("polar", "price_1")).toMatch(/Polar/);
    expect(problem("dodo", "pdt_abc")).toBeNull();
    expect(problem("dodo", "prod_abc")).toMatch(/pdt_/);
    expect(problem("creem", "prod_abc")).toBeNull();
    expect(problem("creem", "pdt_abc")).toMatch(/prod_/);
    expect(problem("commet", "plan_pro")).toBeNull();
    expect(problem("commet", "has spaces")).toMatch(/Commet/);
  });

  it("names each provider's settings after it", () => {
    for (const provider of all()) for (const field of provider.settings("https://example.com")) expect(field.name.startsWith(provider.id)).toBe(true);
  });

  it("reads every provider's subscription status the same way", () => {
    for (const status of ["active", "trialing", "paid", "scheduled_cancel"]) expect(ACTIVE_STATES.has(membershipState(status))).toBe(true);
    for (const status of ["canceled", "cancelled", "expired", "failed", "on_hold", "unpaid", "past_due", "paused", "pending_payment", "incomplete", "something new", null]) expect(ACTIVE_STATES.has(membershipState(status))).toBe(false);
    expect(membershipState("cancelled")).toBe("canceled");
    expect(membershipState("ON_HOLD")).toBe("past_due");
  });

  it("names products after plans, and finds the plan of a product", () => {
    const plans = [toPlanRef({ name: " Pro ", priceId: "pdt_m", annualPriceId: "pdt_y" })!, toPlanRef({ name: "basic", priceId: "pdt_b" })!];
    expect(toPlanRef({ name: "x" })).toBeNull();
    expect(productSlugs(plans)).toEqual([{ productId: "pdt_m", slug: "pro" }, { productId: "pdt_y", slug: "pro-annual" }, { productId: "pdt_b", slug: "basic" }]);
    expect(planNamed(plans, "pdt_y")).toBe("pro");
    expect(planNamed(plans, "pdt_b")).toBe("basic");
    expect(planNamed(plans, "pdt_other")).toBeNull();
  });

  it("tells each provider's return reference apart", () => {
    expect(PROVIDER.stripe.isReference("cs_test_1")).toBe(true);
    expect(PROVIDER.stripe.isReference("ref_0123456789abcdef0123456789abcdef")).toBe(false);
    for (const id of ["polar", "dodo", "creem", "commet"] as const) {
      expect(PROVIDER[id].isReference("ref_0123456789abcdef0123456789abcdef")).toBe(true);
      expect(PROVIDER[id].isReference("cs_test_1")).toBe(false);
    }
    expect(REFERENCE.test(newReference())).toBe(true);
    expect(newReference()).not.toBe(newReference());
  });

  it("keeps each provider's better-auth tables and user columns in Payments' collections", () => {
    const settings = { provider: "creem", currency: "usd", creemApiKey: "creem_test_x", creemWebhookSecret: "whsec_x", dodoApiKey: "dodo_x", dodoWebhookSecret: "whsec_x", testMode: true, createCustomerOnSignUp: false };
    const context = { settings: {}, system: {}, store: {} } as never;
    const creem = planPluginModels([{ name: "payments", plugins: PROVIDER.creem.authPlugins(settings, context, "https://example.com") }], core);
    expect(creem.find((plan) => plan.model === "creem_subscription")).toMatchObject({ slug: "payments-creem-subscription", kind: "model" });
    expect(creem.find((plan) => plan.model === "user")?.fields.map((field) => field.name)).toEqual(expect.arrayContaining(["creemCustomerId"]));
    const dodo = planPluginModels([{ name: "payments", plugins: PROVIDER.dodo.authPlugins(settings, context, "https://example.com") }], core);
    expect(dodo).toEqual([expect.objectContaining({ slug: "payments-user-data", fields: [expect.objectContaining({ name: "dodoCustomerId" })] })]);
  });
});
