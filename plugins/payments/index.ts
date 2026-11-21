import { z } from "zod";
import { defineField } from "tansy/fields";
import { defineBlock, definePlugin, defineRoute, mergeMessagesByLanguage, type BeforeHookContext, type ExtensionContext, type ExtensionRouteContext, type PluginSettingField } from "tansy/plugin";
import { accessCollectionsProblem, CURRENCY, isSlug, itemName, MAX_PLAN_ACCESS, returnUrl, sitePath, toMinorUnits, toPlanRef } from "./logic";
import type { Buyer, PaymentProvider } from "./provider";
import { COLLECTION_LABELS, FIELD_LABELS, messages } from "./messages";
import {
  ACCESS, ACCESS_FIELD, accessSync, ENTITLEMENTS, forgetOldCheckouts, MEMBERSHIPS, owns, PLAN_DISPLAY_FIELDS, PLAN_FIELD, PLAN_NAME, PLANS, PRICE_TYPE, purchaseOf, PURCHASES, refuse, settingsOf, str,
  type PaymentsSettings,
} from "./shared";

export { ACCESS, ACCESS_FIELD, ENTITLEMENTS, MEMBERSHIPS, PLAN_FIELD, PLANS, PRICE_TYPE, PURCHASES } from "./shared";
export type { PaymentProvider } from "./provider";

export interface PaymentsOptions {
  /** The public site's origin, such as https://example.com. Checkout sends buyers back here. */
  siteUrl: string;
  /** The currency of prices that don't name one, until changed under Payments → Settings. */
  currency?: string;
  /**
   * The providers the site can take money with, each from its own package, such as
   * `stripe()` from @tansy/payments-stripe. Owners choose one under Payments → Settings.
   */
  providers: PaymentProvider[];
  /** Which of them takes the money until changed under Payments → Settings. The first when left out. */
  provider?: string;
}

const PROVIDER_ID = /^[a-z][a-z0-9]{0,19}$/;

const optionsSchema = z.strictObject({
  siteUrl: z.url(),
  currency: z.string().regex(CURRENCY, 'Use a three-letter currency code in lowercase, such as "usd".'),
  providers: z.array(z.object({ id: z.string().regex(PROVIDER_ID, "A provider's id is lowercase letters and digits."), label: z.string().min(1) }).loose()).min(1, "Add at least one provider, such as stripe() from @tansy/payments-stripe."),
  provider: z.string(),
}).superRefine((value, issues) => {
  const ids = value.providers.map((provider) => provider.id);
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice) issues.addIssue({ code: "custom", path: ["providers"], message: `The provider "${twice}" is listed twice.` });
  if (!ids.includes(value.provider)) issues.addIssue({ code: "custom", path: ["provider"], message: `"${value.provider}" isn't one of the providers: ${ids.join(", ")}.` });
});

const LOCKED = { createRule: null, updateRule: null, deleteRule: null };

const notReady = (provider: PaymentProvider | undefined) => refuse(503, "PAYMENTS_NOT_SET_UP", `Payments aren't set up yet. Add the ${provider?.label ?? "provider"} keys under Payments → Settings.`);

/** Errors from a provider's better-auth endpoints, which core has already made into answers meant for the caller. */
const answered = new WeakSet<object>();

/** The route's context, with `auth.call` marking its errors as answers. */
function withAnswers<C extends ExtensionRouteContext>(context: C): C {
  return {
    ...context,
    auth: {
      ...context.auth,
      call: <T>(path: string, input?: Parameters<ExtensionRouteContext["auth"]["call"]>[1]) => context.auth.call<T>(path, input).catch((error: unknown) => {
        if (error && typeof error === "object") answered.add(error);
        throw error;
      }),
    },
  };
}

/** A provider's API failed. What it said stays in the server log, as it can name the site's account. */
function providerFailed(error: unknown, provider: string) {
  if (error && typeof error === "object" && answered.has(error)) throw error;
  console.error(`[payments] ${provider} failed`, error);
  return refuse(502, "PROVIDER_FAILED", "The payment provider couldn't do that just now. Try again in a moment.");
}

function buyerOf(context: ExtensionRouteContext): Buyer | null {
  if (context.principal.kind === "anonymous") return null;
  const { id, email, name } = context.principal.user;
  return { id, email, name: name ?? "" };
}

type PriceField = NonNullable<Awaited<ReturnType<ExtensionContext["schema"]["describe"]>>>["fields"][number];

/** The collection's first price field, or null when its records aren't for sale. */
async function priceFieldOf(context: ExtensionContext, collection: string): Promise<PriceField | null> {
  if (!isSlug(collection)) return null;
  return (await context.schema.describe(collection))?.fields.find((candidate) => candidate.type === PRICE_TYPE) ?? null;
}

const NOT_OFFERED = { forSale: false, amount: null, currency: null, once: false, purchased: false };

/** Payments' own settings. Each provider adds its own after them. */
const sharedSettings = (value: { currency: string; provider: string }, providers: PaymentProvider[]): PluginSettingField[] => [
  { name: "provider", type: "select", default: value.provider, label: "Provider", description: "Who takes the money. Fill in that provider's settings below. Records of past purchases stay when you switch.", options: providers.map((provider) => ({ value: provider.id, label: provider.label })) },
  { name: "currency", type: "text", default: value.currency, maxLength: 3, label: "Currency", description: 'For prices that don\'t name one. A three-letter code, such as "usd".' },
  { name: "testMode", type: "boolean", default: false, label: "Test mode", description: "Use the provider's sandbox or test environment, for providers that pick it by setting rather than by key." },
  { name: "createCustomerOnSignUp", type: "boolean", default: false, label: "Create a customer with the provider for every new account", description: "Otherwise one is made the first time someone pays, for providers that support it." },
];

/** Every setting's name starts with its provider's id, so two providers can't claim one. */
function providerSettings(providers: PaymentProvider[], siteUrl: string) {
  const fields = providers.flatMap((provider) => provider.settings(siteUrl).map((field) => {
    if (!field.name.startsWith(provider.id)) throw new Error(`Payments provider "${provider.id}": the setting "${field.name}" must start with "${provider.id}".`);
    return field;
  }));
  return fields;
}

/**
 * Sell anything: subscriptions to plans, and any record with a price field, through the
 * provider adapters a site installs, such as @tansy/payments-stripe. Each provider's
 * better-auth plugin does customers and webhooks. This wires it to the CMS. See
 * docs/plugins/payments.md.
 */
export function payments(options: PaymentsOptions) {
  const value = optionsSchema.parse({ currency: "usd", provider: options.providers?.[0]?.id, ...Object.fromEntries(Object.entries(options).filter(([, option]) => option !== undefined)) });
  const providers = options.providers;
  const siteUrl = value.siteUrl.replace(/\/$/, "");
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const fields = [...sharedSettings(value, providers), ...providerSettings(providers, siteUrl)];
  const currencyOf = (field: PriceField, settings: PaymentsSettings) => str(field.config.currency) || (CURRENCY.test(settings.currency) ? settings.currency : value.currency);
  /** The active provider, or null until its keys are set. */
  const active = async (context: ExtensionContext) => {
    const settings = await settingsOf(context);
    const chosen = byId.get(settings.provider);
    return { settings, chosen, provider: chosen?.ready(settings) ? chosen : null };
  };

  /** Plan names are stored in lowercase, as Stripe's plugin compares them that way, and each id must suit the provider. */
  async function normalizePlan(context: BeforeHookContext) {
    if (context.collection.slug === ACCESS) {
      const problem = accessCollectionsProblem(context.values.collections);
      if (problem) context.reject(problem, "collections");
      return;
    }
    if (context.collection.slug !== PLANS) return;
    if (typeof context.values.name === "string") context.values.name = context.values.name.trim().toLowerCase();
    const settings = await settingsOf(context);
    // A price shown on a pricing page is in the site's currency unless the plan names its own.
    if (typeof context.values.currency === "string") context.values.currency = context.values.currency.trim().toLowerCase() || null;
    if (context.values.currency && !CURRENCY.test(String(context.values.currency))) context.reject("Use a three-letter currency code, such as usd.", "currency");
    const shown = (name: string) => (Object.hasOwn(context.values, name) ? context.values[name] : context.record?.[name]);
    if ((typeof shown("amount") === "number" || typeof shown("annualAmount") === "number") && !shown("currency") && (await context.schema.describe(PLANS))?.fields.some((field) => field.name === "currency")) {
      context.values.currency = settings.currency;
    }
    const chosen = byId.get(settings.provider);
    for (const field of ["priceId", "annualPriceId"]) {
      const id = context.values[field];
      const problem = chosen && typeof id === "string" && id.trim() ? chosen.planIdProblem(id.trim()) : null;
      if (problem) context.reject(problem, field);
    }
  }

  const syncAccess = accessSync(providers.flatMap((provider) => (provider.subscriptionRecords ? [provider.subscriptionRecords] : [])));

  return definePlugin({
    name: "payments",
    messages: mergeMessagesByLanguage(messages, ...providers.map((provider) => provider.messages?.(siteUrl))),
    version: "0.1.1",
    apiVersion: 1,
    requires: { cms: "^0.1.1" },
    admin: { render: "@tansy/payments/render" },
    options: { schema: optionsSchema, value },
    settings: { fields },
    contract: {
      [PLANS]: { name: "text", priceId: "text", annualPriceId: "text", trialDays: "number", limits: "json", group: "text", includes: "reference" },
      [PURCHASES]: { buyer: "text", collection: "text", recordId: "number", amount: "number", currency: "text", sessionId: "text", paymentIntent: "text", state: "text" },
      [MEMBERSHIPS]: { provider: "text", subscriptionId: "text", user: "text", plan: "text", state: "text" },
      [ACCESS]: { name: "text", description: "text", collections: "json" },
      [ENTITLEMENTS]: { user: "text", plans: "json", access: "json" },
    },
    fields: [
      defineField({
        type: PRICE_TYPE,
        admin: { label: "Price", description: "Makes a record something people can buy", input: "number" },
        config: {
          currency: z.string().regex(CURRENCY).optional().describe("Leave empty for the currency under Payments → Settings."),
          once: z.boolean().optional().describe("Each person can buy it once, such as a course or a download. On by default."),
        },
        value: () => z.number().min(0).max(1_000_000),
        storage: () => ({ sql: "real" }),
      }),
    ],
    blocks: [
      defineBlock({
        name: "payments_buy",
        label: "Buy button",
        labels: { ar: "زر الشراء" },
        category: "Payments",
        fields: [
          { name: "collection", type: "text", config: { required: true, maxLength: 63, description: "The collection of the record to sell, such as blog-posts. It needs a Price field.", labels: { ar: "المجموعة" }, descriptions: { ar: "مجموعة السجل المعروض للبيع، مثل blog-posts. تحتاج إلى حقل سعر." } } },
          { name: "record", type: "number", config: { required: true, description: "The record's id.", labels: { ar: "السجل" }, descriptions: { ar: "معرّف السجل." } } },
          { name: "label", type: "text", config: { maxLength: 60, labels: { ar: "نص الزر" } } },
        ],
      }),
      defineBlock({
        name: "payments_subscribe",
        label: "Subscribe button",
        labels: { ar: "زر الاشتراك" },
        category: "Payments",
        fields: [
          { name: "plan", type: "text", config: { required: true, maxLength: 60, description: "A plan's name from Payments → Plans.", labels: { ar: "الخطة" }, descriptions: { ar: "اسم خطة من المدفوعات ← الخطط." } } },
          { name: "annual", type: "boolean", config: { description: "Bill yearly, at the plan's annual price.", labels: { ar: "سنوي" }, descriptions: { ar: "الفوترة سنويًا، بالسعر السنوي للخطة." } } },
          { name: "label", type: "text", config: { maxLength: 60, labels: { ar: "نص الزر" } } },
        ],
      }),
      defineBlock({ name: "payments_billing", label: "Manage billing", labels: { ar: "إدارة الفوترة" }, category: "Payments", fields: [{ name: "label", type: "text", config: { maxLength: 60, labels: { ar: "نص الزر" } } }] }),
    ],
    auth: {
      plugins: async (_auth, context) => {
        const { settings, provider } = await active(context);
        return provider ? provider.authPlugins(settings, context, siteUrl) : [];
      },
      serverOnlyPaths: [...new Set(providers.flatMap((provider) => provider.serverOnlyPaths ?? []))],
    },
    hooks: {
      "record.beforeCreate": normalizePlan,
      "record.beforeUpdate": normalizePlan,
      "record.afterCreate": syncAccess,
      "record.afterUpdate": syncAccess,
      "record.afterDelete": syncAccess,
    },
    jobs: [{ name: "payments-forget-checkouts", cron: "17 4 * * *", handler: forgetOldCheckouts }],
    routes: [
      defineRoute({
        method: "POST",
        path: "/checkout",
        access: "authenticated",
        audit: "payments.checkout",
        rateLimit: { window: 60, max: 20 },
        body: z.strictObject({ collection: z.string().max(63), id: z.number().int().positive(), returnPath: z.string().max(500).optional() }),
        handler: async (context) => {
          const buyer = buyerOf(context);
          if (!buyer) return refuse(401, "UNAUTHENTICATED", "Sign in to buy.");
          const { settings, chosen, provider } = await active(context);
          if (!provider) return notReady(chosen);
          const { collection, id, returnPath } = context.body;
          const field = await priceFieldOf(context, collection);
          if (!field) return refuse(400, "NOT_FOR_SALE", "This isn't for sale.");
          // As the caller, so a record they can't see reads as missing, and the price comes from what's stored.
          const record = await context.records.get(collection, id);
          const currency = currencyOf(field, settings);
          const amount = toMinorUnits(record[field.name], currency);
          if (amount === null) return refuse(400, "NOT_FOR_SALE", "This has no price yet.");
          if (field.config.once !== false && (await owns(context, buyer.id, collection, id))) return refuse(409, "ALREADY_PURCHASED", "You already bought this.");
          try {
            const problem = await provider.currencyProblem?.(settings, currency);
            if (problem) return refuse(400, "NOT_FOR_SALE", problem);
            const url = await provider.checkout({
              context: withAnswers(context), settings, buyer, collection, recordId: id, name: itemName(record, `${collection} ${id}`), amount, currency,
              successUrl: returnUrl(siteUrl, returnPath ?? "/", "purchase", "success"),
              cancelUrl: returnUrl(siteUrl, returnPath ?? "/", "purchase", "canceled"),
            });
            context.auditTarget("record", `${collection}/${id}`, { provider: provider.id });
            return { url };
          } catch (error) {
            return providerFailed(error, provider.label);
          }
        },
      }),
      defineRoute({
        method: "POST",
        path: "/confirm",
        access: "authenticated",
        audit: "payments.confirm",
        rateLimit: { window: 60, max: 20 },
        // The provider's checkout id, or the reference Payments put in the return address.
        body: z.strictObject({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,255}$/) }),
        handler: async (context) => {
          const buyer = buyerOf(context);
          if (!buyer) return refuse(401, "UNAUTHENTICATED", "Sign in first.");
          const { settings, chosen, provider } = await active(context);
          if (!provider) return notReady(chosen);
          const { sessionId } = context.body;
          if (!provider.isReference(sessionId)) return refuse(400, "VALIDATION_FAILED", "That isn't a checkout reference.");
          // Already recorded, by the webhook or an earlier visit.
          const known = await purchaseOf(context, sessionId, buyer.id);
          if (known) return { paid: known.state === "paid" };
          // Read from the provider with the site's key, so nothing the browser sends is trusted but the reference.
          const confirmed = await provider.confirm(context, settings, sessionId, buyer).catch((error) => {
            console.error(`[payments] ${provider.label} confirm failed`, error);
            return null;
          });
          // Someone else's checkout reads as missing.
          return confirmed ?? refuse(404, "NOT_FOUND", "There's no such checkout.");
        },
      }),
      defineRoute({
        method: "GET",
        path: "/offer",
        access: "public",
        reason: "A price is part of the record it's on. The record is read as the caller, so one they can't see reads as missing, and only the caller's own purchase is reported.",
        rateLimit: { window: 60, max: 120 },
        query: z.object({ collection: z.string().max(63), id: z.coerce.number().int().positive() }),
        handler: async (context) => {
          const { collection, id } = context.query;
          const field = await priceFieldOf(context, collection);
          if (!field) return NOT_OFFERED;
          const record = await context.records.get(collection, id, { fields: field.name });
          const { settings, provider } = await active(context);
          const currency = currencyOf(field, settings);
          // Without keys nothing can be bought, so nothing is offered.
          if (!provider || toMinorUnits(record[field.name], currency) === null) return NOT_OFFERED;
          const once = field.config.once !== false;
          const purchased = once && context.principal.kind !== "anonymous" && (await owns(context, context.principal.user.id, collection, id));
          return { forSale: true, amount: record[field.name] as number, currency, once, purchased };
        },
      }),
      defineRoute({
        method: "GET",
        path: "/purchased",
        access: "authenticated",
        query: z.object({ collection: z.string().max(63), id: z.coerce.number().int().positive() }),
        handler: async (context) => {
          if (context.principal.kind === "anonymous" || !isSlug(context.query.collection)) return { purchased: false };
          return { purchased: await owns(context, context.principal.user.id, context.query.collection, context.query.id) };
        },
      }),
      defineRoute({
        method: "POST",
        path: "/subscribe",
        access: "authenticated",
        audit: "payments.subscribe",
        rateLimit: { window: 60, max: 20 },
        body: z.strictObject({ plan: z.string().max(60), annual: z.boolean().optional(), returnPath: z.string().max(500).optional() }),
        handler: async (context) => {
          const buyer = buyerOf(context);
          if (!buyer) return refuse(401, "UNAUTHENTICATED", "Sign in to subscribe.");
          const { settings, chosen, provider } = await active(context);
          if (!provider) return notReady(chosen);
          const name = context.body.plan.trim().toLowerCase();
          const { items } = PLAN_NAME.test(name) ? await context.system.records.list(PLANS, { filter: `status = "published" && name = "${name}"`, perPage: 1, fields: "name,priceId,annualPriceId" }) : { items: [] };
          const plan = items[0] ? toPlanRef(items[0]) : null;
          if (!plan) return refuse(404, "NOT_FOUND", "There's no such plan.");
          const annual = context.body.annual === true;
          if (annual && !plan.annualProductId && !provider.yearlyFromSamePlan) return refuse(400, "NO_ANNUAL_PRICE", "This plan has no yearly price.");
          const path = sitePath(context.body.returnPath ?? "/");
          try {
            const url = await provider.subscribe({
              context: withAnswers(context), settings, buyer, plan, annual,
              successUrl: returnUrl(siteUrl, path, "subscription", "success"),
              cancelUrl: new URL(path, siteUrl).toString(),
            });
            context.auditTarget("plan", plan.name, { provider: provider.id, annual });
            return { url };
          } catch (error) {
            return providerFailed(error, provider.label);
          }
        },
      }),
      defineRoute({
        method: "POST",
        path: "/billing",
        access: "authenticated",
        audit: "payments.billing",
        rateLimit: { window: 60, max: 20 },
        body: z.strictObject({ returnPath: z.string().max(500).optional() }),
        handler: async (context) => {
          const buyer = buyerOf(context);
          if (!buyer) return refuse(401, "UNAUTHENTICATED", "Sign in first.");
          const { settings, chosen, provider } = await active(context);
          if (!provider) return notReady(chosen);
          try {
            const url = await provider.billing(withAnswers(context), settings, buyer, new URL(sitePath(context.body.returnPath ?? "/"), siteUrl).toString());
            context.auditTarget("user", buyer.id, { provider: provider.id });
            return { url };
          } catch (error) {
            return providerFailed(error, provider.label);
          }
        },
      }),
    ],
    migrations: [
      {
        id: "001-collections",
        up: async ({ schema }) => {
          for (const slug of [PLANS, PURCHASES]) {
            if (await schema.describe(slug)) throw new Error(`A collection called "${slug}" already exists, and the payments plugin didn't create it. Rename it under Dashboard → Collections, then start again.`);
          }
          await schema.apply({
            version: 1,
            collections: [
              {
                slug: PLANS,
                name: "Plans",
                description: "What people can subscribe to. Each needs a recurring price or product with your provider. Changes apply to new subscriptions.",
                // Anyone may see published plans, for a pricing page.
                rules: { listRule: 'status = "published"', viewRule: 'status = "published"', ...LOCKED },
                fields: [
                  { name: "name", type: "text", config: { required: true, unique: true, maxLength: 60, description: "Lowercase, such as pro. Rules check it: @request.auth.payments_plan = \"pro\"." } },
                  { name: "priceId", type: "text", config: { required: true, maxLength: 100, description: "The provider's id: a Stripe price (price_…), a Polar product, a Dodo Payments product (pdt_…), a Creem product (prod_…) or a Commet plan." } },
                  { name: "annualPriceId", type: "text", config: { maxLength: 100, description: "Optional yearly price or product. Commet bills the same plan yearly instead." } },
                  { name: "trialDays", type: "number", config: { description: "Free days before the first payment, with Stripe. Other providers set trials on the product." } },
                  { name: "limits", type: "json", config: { description: "Optional numbers your site reads, such as {\"projects\": 5}." } },
                  { name: "group", type: "text", config: { maxLength: 60 } },
                ],
              },
              {
                slug: PURCHASES,
                name: "Purchases",
                description: "One-time purchases, recorded when the provider confirms payment. Refund the whole payment with the provider and the purchase is marked refunded.",
                // Each buyer sees their own. Only the plugin writes them.
                rules: { listRule: "buyer = @request.auth.id", viewRule: "buyer = @request.auth.id", ...LOCKED },
                fields: [
                  { name: "buyer", type: "text", config: { required: true, maxLength: 64 } },
                  { name: "collection", type: "text", config: { required: true, maxLength: 63 } },
                  { name: "recordId", type: "number", config: { required: true } },
                  { name: "amount", type: "number", config: {} },
                  { name: "currency", type: "text", config: { maxLength: 3 } },
                  { name: "sessionId", type: "text", config: { required: true, unique: true, maxLength: 255 } },
                  { name: "paymentIntent", type: "text", config: { maxLength: 255 } },
                  { name: "state", type: "text", config: { required: true, maxLength: 20, description: "paid or refunded." } },
                ],
              },
            ],
            userFields: [{ name: PLAN_FIELD, type: "text", config: { hidden: true, label: "Plan", description: "Set by Payments from the user's subscription. Rules read it." }, selfEditable: false }],
          });
        },
      },
      {
        id: "002-providers",
        up: async ({ schema }) => {
          if (await schema.describe(MEMBERSHIPS)) throw new Error(`A collection called "${MEMBERSHIPS}" already exists, and the payments plugin didn't create it. Rename it under Dashboard → Collections, then start again.`);
          await schema.addFields(PURCHASES, [{ name: "provider", type: "text", config: { maxLength: 20, description: "Who took the payment. Empty for purchases from before Payments had more than Stripe." } }]);
          await schema.apply({
            version: 1,
            collections: [{
              slug: MEMBERSHIPS,
              name: "Memberships",
              description: "Subscriptions with Polar, Dodo Payments, Creem or Commet, kept from their webhooks. Stripe's are under Subscription. Each person sees their own.",
              rules: { listRule: "user = @request.auth.id", viewRule: "user = @request.auth.id", ...LOCKED },
              fields: [
                { name: "provider", type: "text", config: { required: true, maxLength: 20 } },
                { name: "subscriptionId", type: "text", config: { required: true, unique: true, maxLength: 255 } },
                { name: "user", type: "text", config: { required: true, maxLength: 64 } },
                { name: "plan", type: "text", config: { maxLength: 60, description: "The plan's name from Plans, matched by the provider's product or plan id." } },
                { name: "state", type: "text", config: { required: true, maxLength: 20, description: "active, trialing, past_due, paused, canceled, expired or pending." } },
                { name: "periodEnd", type: "datetime", config: {} },
                { name: "eventAt", type: "number", config: { description: "When the provider's latest event about it happened, so older ones don't overwrite it." } },
              ],
            }],
          });
        },
      },
      {
        id: "003-access",
        up: async ({ schema }) => {
          for (const slug of [ACCESS, ENTITLEMENTS]) {
            if (await schema.describe(slug)) throw new Error(`A collection called "${slug}" already exists, and the payments plugin didn't create it. Rename it under Dashboard → Collections, then start again.`);
          }
          await schema.apply({
            version: 1,
            collections: [
              {
                slug: ACCESS,
                name: "Access",
                description: "What plans open. Put records in an access with a Reference field to Access, or open whole collections. Plans list the access they include.",
                // Anyone may see published access, for a pricing page.
                rules: { listRule: 'status = "published"', viewRule: 'status = "published"', ...LOCKED },
                fields: [
                  { name: "name", type: "text", config: { required: true, unique: true, maxLength: 80, description: "Such as All courses or Premium posts." } },
                  { name: "description", type: "text", config: { maxLength: 500 } },
                  { name: "collections", type: "json", config: { description: 'Collections it opens whole, by slug, such as ["lms-courses"]. Rules check them: @request.auth.payments_access ?= "lms-courses".' } },
                ],
              },
              {
                slug: ENTITLEMENTS,
                name: "Entitlements",
                description: "Each person's active plans and the access they include, kept by Payments from their subscriptions. Each person sees their own.",
                rules: { listRule: "user = @request.auth.id", viewRule: "user = @request.auth.id", ...LOCKED },
                fields: [
                  { name: "user", type: "text", config: { required: true, unique: true, maxLength: 64 } },
                  { name: "plans", type: "json", config: { description: "Names of the plans their active subscriptions are on." } },
                  { name: "access", type: "json", config: { description: "Ids of the access those plans include, then the collections they open whole." } },
                ],
              },
            ],
            userFields: [{ name: ACCESS_FIELD, type: "json", config: { hidden: true, label: "Access", description: "Set by Payments from the user's plans. Rules read it." }, selfEditable: false }],
          });
          await schema.addFields(PLANS, [{ name: "includes", type: "reference", config: { collection: ACCESS, displayField: "name", allowMultiple: true, maxSelect: MAX_PLAN_ACCESS, description: "What subscribers to this plan may open." } }]);
        },
      },
      {
        id: "004-names-in-languages",
        up: async ({ schema }) => {
          for (const [slug, labels] of Object.entries(COLLECTION_LABELS)) await schema.addLabels(slug, labels);
        },
      },
      {
        id: "005-field-names-in-languages",
        up: async ({ schema }) => {
          for (const [slug, fields] of Object.entries(FIELD_LABELS)) await schema.addFieldLabels(slug, fields);
        },
      },
      {
        // What a pricing page shows. The provider still holds the price it charges.
        id: "006-plans-on-pricing-pages",
        up: async ({ schema }) => {
          if (!(await schema.describe(PLANS))) return;
          await schema.addFields(PLANS, PLAN_DISPLAY_FIELDS);
          await schema.addFieldLabels(PLANS, FIELD_LABELS[PLANS]);
        },
      },
    ],
  });
}
