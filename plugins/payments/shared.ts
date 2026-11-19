import { randomBytes } from "node:crypto";
import type { AfterHookContext, ExtensionContext } from "tansy/plugin";
import { accessOf, ACTIVE_STATES, fromMinorUnits, isSlug, isUserId, membershipState, referenceIds, toPlanRef, type AccessGrant, type PlanRef } from "./logic";

/** What every provider shares: the plugin's collections, settings, and the records it keeps. */

export const PLANS = "payments-plans";
export const PURCHASES = "payments-purchases";
/** Subscriptions with providers whose better-auth plugins keep none (all but Stripe), from their webhooks. */
export const MEMBERSHIPS = "payments-memberships";
/** Kept by better-auth's payment plugins: each user's customer id with the provider. */
export const CUSTOMERS = "payments-user-data";
/** The user field rules gate on, such as `@request.auth.payments_plan = "pro"`. */
export const PLAN_FIELD = "payments_plan";
/** What plans open, kept by the owner: whole collections, and records "Included in" it. */
export const ACCESS = "payments-access";
/** One record per person: their active plans, and the access those include. */
export const ENTITLEMENTS = "payments-entitlements";
/** The user field rules gate access on: `included ?= @request.auth.payments_access`. */
export const ACCESS_FIELD = "payments_access";
export const PRICE_TYPE = "payments_price";

/**
 * What a pricing page shows about a plan. The provider charges the price set with it, so
 * these are for people to read, and never decide what anyone pays.
 */
export const PLAN_DISPLAY_FIELDS = [
  { name: "title", type: "text", config: { maxLength: 80, description: "As a pricing page shows it, such as All courses. Empty shows the name." } },
  { name: "description", type: "text", config: { multiline: true, maxLength: 500, description: "A line or two for a pricing page." } },
  { name: "amount", type: "number", config: { min: 0, description: "The monthly price a pricing page shows. The provider charges the price set with it, so keep them the same." } },
  { name: "annualAmount", type: "number", config: { min: 0, description: "Optional, for a plan with a yearly price." } },
  { name: "currency", type: "text", config: { maxLength: 3, description: "Three letters, such as usd. Empty takes the currency from Payments' settings." } },
  { name: "featured", type: "boolean", config: { description: "A pricing page makes it stand out." } },
];

/** The settings Payments has itself, and each installed provider's, by name. */
export interface PaymentsSettings {
  /** The id of the provider taking the money. */
  provider: string;
  currency: string;
  createCustomerOnSignUp: boolean;
  testMode: boolean;
  [name: string]: unknown;
}

export const settingsOf = async (context: ExtensionContext) => (await context.settings.get()) as unknown as PaymentsSettings;

export const str = (value: unknown) => (typeof value === "string" ? value : "");

export const refuse = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });

/** Plan records as providers that sell plans as products take them. */
export async function loadPlanRefs(context: ExtensionContext): Promise<PlanRef[]> {
  const { items } = await context.system.records.list(PLANS, { filter: 'status = "published"', perPage: 200, fields: "name,priceId,annualPriceId" });
  return items.map(toPlanRef).filter((plan) => plan !== null);
}

/** Has this user already bought this record? */
export async function owns(context: ExtensionContext, buyer: string, collection: string, recordId: number) {
  const { items } = await context.system.records.list(PURCHASES, { filter: `buyer = "${buyer}" && collection = "${collection}" && recordId = ${recordId} && state = "paid"`, perPage: 1, fields: "id" });
  return items.length > 0;
}

/** What Payments sends with every one-time checkout, and reads back from the provider. */
export interface PurchaseMetadata { tansy: "purchase"; collection: string; recordId: string; userId: string; ref?: string }

/** A checkout Payments started, remembered under its reference until the provider confirms it. */
export interface StartedCheckout { id: string; userId: string; collection: string; recordId: number; at: number }

export const newReference = () => `ref_${randomBytes(16).toString("hex")}`;
const checkoutKey = (ref: string) => `checkout:${ref}`;

export const rememberCheckout = (context: ExtensionContext, ref: string, checkout: StartedCheckout) => context.store.set(checkoutKey(ref), checkout);

export async function startedCheckout(context: ExtensionContext, ref: unknown): Promise<StartedCheckout | null> {
  if (typeof ref !== "string" || !ref.startsWith("ref_")) return null;
  const value = (await context.store.get(checkoutKey(ref))) as StartedCheckout | null;
  return value && typeof value.id === "string" && isUserId(value.userId) ? value : null;
}

/** Checkouts nobody finished are forgotten after this. Bank payments can take days, so it's generous. */
const CHECKOUT_TTL = 30 * 24 * 3600 * 1000;

export async function forgetOldCheckouts(context: ExtensionContext) {
  for (const { key, value } of await context.store.list("checkout:")) {
    if (Date.now() - ((value as StartedCheckout | null)?.at ?? 0) > CHECKOUT_TTL) await context.store.delete(key);
  }
}

const isDuplicate = (error: unknown) => {
  const { code, details } = error as { code?: string; details?: Array<{ path?: string }> };
  return code === "VALIDATION_FAILED" && Array.isArray(details) && details.some((detail) => detail.path === "sessionId");
};

const safeId = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "");

export interface PaidCheckout {
  provider: string;
  /** Unique per checkout: Stripe's session id, or the reference Payments made for the others. */
  sessionId: string;
  /** The provider's id for the payment, which its refunds name. */
  paymentRef: string | null;
  metadata: Record<string, unknown> | null | undefined;
  /** In the currency's smallest unit. */
  amount: number;
  currency: string;
  /**
   * Only for a provider whose better-auth plugin can't create one-time checkouts, so every
   * checkout with Payments' metadata was created by Payments with the secret key, as with
   * Stripe. Otherwise the checkout must be one Payments started and remembered.
   */
  metadataTrusted?: boolean;
}

/**
 * Records a paid checkout. Providers may send the event more than once, and the session id
 * is unique, so a repeat changes nothing. The checkout must be one Payments started for
 * this buyer and record, as most providers' better-auth plugins can create checkouts with
 * metadata of the caller's choosing, so metadata alone proves nothing.
 */
export async function recordPurchase(context: ExtensionContext, paid: PaidCheckout) {
  const meta = paid.metadata ?? {};
  if (meta.tansy !== "purchase" || !isSlug(meta.collection) || !isUserId(meta.userId)) return false;
  const recordId = Number(meta.recordId);
  if (!Number.isSafeInteger(recordId) || recordId <= 0) return false;
  if (!paid.metadataTrusted) {
    const started = await startedCheckout(context, meta.ref);
    if (!started || started.userId !== meta.userId || started.collection !== meta.collection || started.recordId !== recordId || paid.sessionId !== meta.ref) return false;
  }
  const { items } = await context.system.records.list(PURCHASES, { filter: `sessionId = "${safeId(paid.sessionId)}"`, perPage: 1, fields: "id" });
  if (items.length) return true;
  const currency = paid.currency.toLowerCase();
  const buyer = await context.system.users.get(meta.userId);
  try {
    await context.system.records.create(PURCHASES, {
      status: "published",
      buyer: meta.userId,
      collection: meta.collection,
      recordId,
      amount: fromMinorUnits(paid.amount, currency),
      currency,
      sessionId: paid.sessionId,
      paymentIntent: paid.paymentRef,
      state: "paid",
      provider: paid.provider,
    }, buyer ? { owner: buyer.id } : undefined);
  } catch (error) {
    if (!isDuplicate(error)) throw error;
  }
  return true;
}

/** A full refund takes the purchase back. Partial refunds leave it, as the buyer still paid for it. */
export async function recordRefund(context: ExtensionContext, by: { sessionId?: string | null; paymentRef?: string | null }) {
  const filters = [
    ...(by.sessionId ? [`sessionId = "${safeId(by.sessionId)}"`] : []),
    ...(by.paymentRef ? [`paymentIntent = "${safeId(by.paymentRef)}"`] : []),
  ];
  if (!filters.length) return;
  const { items } = await context.system.records.list(PURCHASES, { filter: filters.join(" || "), perPage: 10, fields: "id,state" });
  for (const purchase of items) if (purchase.state !== "refunded") await context.system.records.update(PURCHASES, purchase.id as number, { state: "refunded" });
}

/** The purchase of a checkout, for one buyer. */
export async function purchaseOf(context: ExtensionContext, sessionId: string, buyer: string) {
  const { items } = await context.system.records.list(PURCHASES, { filter: `sessionId = "${safeId(sessionId)}" && buyer = "${buyer}"`, perPage: 1, fields: "id,state,collection,recordId" });
  return items[0] ?? null;
}

export interface MembershipUpdate {
  provider: string;
  subscriptionId: string;
  user: string | null;
  /** The provider's product or plan id, matched against the plans collection. */
  productId: string | null;
  status: string;
  periodEnd?: string | Date | null;
  /** When the provider says this happened. An older event never overwrites a newer one. */
  at: number;
}

/** Keeps one record per subscription with a provider other than Stripe. Webhooks repeat and arrive out of order, so this is idempotent and ignores stale events. */
export async function upsertMembership(context: ExtensionContext, update: MembershipUpdate, plans: PlanRef[]) {
  if (!update.subscriptionId) return;
  const id = safeId(update.subscriptionId);
  const { items } = await context.system.records.list(MEMBERSHIPS, { filter: `subscriptionId = "${id}"`, perPage: 1, fields: "id,user,eventAt,plan" });
  const existing = items[0];
  if (existing && typeof existing.eventAt === "number" && existing.eventAt > update.at) return;
  const user = isUserId(update.user) ? update.user : str(existing?.user);
  // A subscription nobody here can be matched to changes no one's plan.
  if (!user || !(await context.system.users.get(user))) return;
  const named = update.productId ? plans.find((plan) => plan.productId === update.productId || plan.annualProductId === update.productId)?.name : undefined;
  const periodEnd = update.periodEnd ? new Date(update.periodEnd) : null;
  const values = {
    provider: update.provider,
    user,
    plan: named ?? str(existing?.plan),
    state: membershipState(update.status),
    periodEnd: periodEnd && !Number.isNaN(periodEnd.getTime()) ? periodEnd.toISOString() : null,
    eventAt: update.at,
  };
  if (existing) {
    await context.system.records.update(MEMBERSHIPS, existing.id as number, values);
    return;
  }
  try {
    await context.system.records.create(MEMBERSHIPS, { status: "published", subscriptionId: update.subscriptionId, ...values });
  } catch (error) {
    const { code, details } = error as { code?: string; details?: Array<{ path?: string }> };
    // Another delivery created it first: apply this one on top, still newest-wins.
    if (code === "VALIDATION_FAILED" && details?.some((detail) => detail.path === "subscriptionId")) return upsertMembership(context, update, plans);
    throw error;
  }
}

/**
 * Where a provider's better-auth plugin keeps subscriptions itself, as Stripe's does, in the
 * collection core makes for its table. Field names are the collection's.
 */
export interface SubscriptionRecords { collection: string; user: string; plan: string; state: string }

/** Payments' own memberships, kept for providers whose plugins keep none. */
const OWN: SubscriptionRecords = { collection: MEMBERSHIPS, user: "user", plan: "plan", state: "state" };

/** Plan names are lowercase words, so they're safe inside a filter's quotes. */
export const PLAN_NAME = /^[a-z0-9][a-z0-9 _.-]{0,59}$/;

const anyOf = (field: string, values: Array<string | number>) => values.map((value) => `${field} = ${typeof value === "number" ? value : `"${value}"`}`).join(" || ");

async function listAll(context: ExtensionContext, slug: string, query: { filter?: string; fields?: string }) {
  const items: Array<Record<string, unknown>> = [];
  for (let page = 1; ; page++) {
    const result = await context.system.records.list(slug, { ...query, page, perPage: 200 });
    items.push(...result.items);
    if (page >= (result.totalPages ?? 1) || !result.items.length) return items;
  }
}

/** Lists of up to 50, so a filter stays short. */
const chunks = <T>(list: T[], size = 50) => Array.from({ length: Math.ceil(list.length / size) }, (_, index) => list.slice(index * size, (index + 1) * size));

/**
 * Keeps each person's plans and access in step with their subscriptions, with any installed
 * provider, so rules can gate on them: `payments_plan` and `payments_access` on the user, and
 * their `payments-entitlements` record, which other plugins' hooks can follow. Runs as a
 * durable hook, so a failure is retried. Changing a plan or an access updates everyone it
 * reaches.
 */
export function accessSync(kept: SubscriptionRecords[]) {
  const sources = [OWN, ...kept];
  return async (context: AfterHookContext) => {
    const slug = context.collection.slug;
    const source = sources.find((candidate) => candidate.collection === slug);
    let users: Set<unknown>;
    if (source) users = new Set([context.record[source.user], context.previous?.[source.user]]);
    else if (slug === PLANS) users = await subscribersOf(context, sources, [context.record.name, context.previous?.name]);
    else if (slug === ACCESS) users = await reachedByAccess(context, sources, context.record.id);
    else return;
    for (const userId of users) {
      // A subscription can belong to an organization instead, which has no user fields.
      if (!isUserId(userId) || !(await context.system.users.get(userId))) continue;
      await syncUser(context, sources, userId);
    }
  };
}

/** Everyone subscribed to these plans, in any state, and everyone whose access still names them. */
async function subscribersOf(context: ExtensionContext, sources: SubscriptionRecords[], names: unknown[]) {
  const plans = [...new Set(names.filter((name): name is string => typeof name === "string" && PLAN_NAME.test(name)))];
  const users = new Set<unknown>();
  if (!plans.length) return users;
  for (const source of sources) {
    // A provider that isn't set up yet has no collection.
    const items = await listAll(context, source.collection, { filter: anyOf(source.plan, plans), fields: source.user }).catch(() => []);
    for (const item of items) users.add(item[source.user]);
  }
  for (const plan of plans) {
    for (const item of await listAll(context, ENTITLEMENTS, { filter: `plans ?= "${plan}"`, fields: "user" })) users.add(item.user);
  }
  return users;
}

/** Everyone on a plan that includes this access, and everyone who still has it, such as after it was deleted. */
async function reachedByAccess(context: ExtensionContext, sources: SubscriptionRecords[], id: unknown) {
  if (typeof id !== "number") return new Set<unknown>();
  const plans = await listAll(context, PLANS, { filter: `includes ?= ${id}`, fields: "name" });
  const users = await subscribersOf(context, sources, plans.map((plan) => plan.name));
  for (const item of await listAll(context, ENTITLEMENTS, { filter: `access ?= ${id}`, fields: "user" })) users.add(item.user);
  return users;
}

/** The names of every plan this person's active subscriptions are on, in the order the sources list them. */
async function activePlans(context: ExtensionContext, sources: SubscriptionRecords[], userId: string) {
  const lists = await Promise.all(sources.map((source) => context.system.records
    .list(source.collection, { filter: `${source.user} = "${userId}"`, perPage: 50, fields: `${source.plan},${source.state}` })
    .then(({ items }) => items.map((item) => ({ plan: item[source.plan], state: item[source.state] })))
    // A provider that isn't set up yet has no collection.
    .catch(() => [])));
  const names = lists.flat().filter((subscription) => ACTIVE_STATES.has(str(subscription.state)) && PLAN_NAME.test(str(subscription.plan))).map((subscription) => str(subscription.plan));
  return [...new Set(names)].slice(0, 20);
}

/** Works out one person's plans and access from their subscriptions as they are now, and stores them. */
async function syncUser(context: ExtensionContext, sources: SubscriptionRecords[], userId: string) {
  const plans = await activePlans(context, sources, userId);
  // Every plan with the name, published or not: someone still paying for a plan taken off the pricing page keeps what it includes.
  const planRecords = plans.length ? await listAll(context, PLANS, { filter: anyOf("name", plans), fields: "name,includes" }) : [];
  const included = planRecords.map((plan) => ({ name: str(plan.name), includes: referenceIds(plan.includes) }));
  const ids = [...new Set(included.flatMap((plan) => plan.includes))];
  const grants: AccessGrant[] = [];
  for (const chunk of chunks(ids)) {
    for (const item of await listAll(context, ACCESS, { filter: anyOf("id", chunk), fields: "id,collections" })) {
      grants.push({ id: item.id as number, collections: Array.isArray(item.collections) ? item.collections.filter(isSlug) : [] });
    }
  }
  const access = accessOf(plans, included, grants);
  await keepEntitlements(context, userId, plans, access);
  await context.system.users.setValues(userId, { [PLAN_FIELD]: plans[0] ?? null, [ACCESS_FIELD]: access });
}

/** One record per person, written only when it changes, so hooks following it see real changes only. */
async function keepEntitlements(context: ExtensionContext, userId: string, plans: string[], access: Array<number | string>): Promise<void> {
  const { items } = await context.system.records.list(ENTITLEMENTS, { filter: `user = "${userId}"`, perPage: 1, fields: "id,plans,access" });
  const existing = items[0];
  if (existing) {
    if (JSON.stringify(existing.plans) === JSON.stringify(plans) && JSON.stringify(existing.access) === JSON.stringify(access)) return;
    await context.system.records.update(ENTITLEMENTS, existing.id as number, { plans, access });
    return;
  }
  // Nothing to keep for someone who never had a plan.
  if (!plans.length && !access.length) return;
  const user = await context.system.users.get(userId);
  try {
    await context.system.records.create(ENTITLEMENTS, { status: "published", user: userId, plans, access }, user ? { owner: user.id } : undefined);
  } catch (error) {
    const { code, details } = error as { code?: string; details?: Array<{ path?: string }> };
    // Another delivery made it first: write this one over it.
    if (code === "VALIDATION_FAILED" && details?.some((detail) => detail.path === "user")) return keepEntitlements(context, userId, plans, access);
    throw error;
  }
}
