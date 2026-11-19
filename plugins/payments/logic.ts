/** Pure helpers, kept apart from the plugin so they're easy to test. */

/** User ids are safe to write inside a filter's quotes. */
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isUserId = (value: unknown): value is string => typeof value === "string" && USER_ID.test(value);

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isSlug = (value: unknown): value is string => typeof value === "string" && value.length <= 63 && SLUG.test(value);

// Stripe's lists: https://docs.stripe.com/currencies#zero-decimal and #three-decimal
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

const decimalsOf = (currency: string) => (ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2);

/** A price as owners type it, such as 19.99, in the smallest unit Stripe charges in, such as 1999 cents. Null when it can't be charged. */
export function toMinorUnits(amount: unknown, currency: string): number | null {
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  const minor = Math.round(amount * 10 ** decimalsOf(currency.toLowerCase()));
  return minor > 0 && Number.isSafeInteger(minor) ? minor : null;
}

/** Back from Stripe's smallest unit to the amount owners see. */
export const fromMinorUnits = (minor: number, currency: string) => minor / 10 ** decimalsOf(currency.toLowerCase());

export const CURRENCY = /^[a-z]{3}$/;

/** A path on this site to come back to, never somewhere else. */
export function sitePath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) return "/";
  return value.slice(0, 500);
}

/** The site address with a path and one more query parameter. */
export function returnUrl(siteUrl: string, path: string, key: string, value: string) {
  const url = new URL(sitePath(path), siteUrl);
  url.searchParams.set(key, value);
  return url.toString();
}

/** What a record is called on the checkout page. */
export function itemName(record: Record<string, unknown>, fallback: string) {
  for (const key of ["title", "name", "label"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 250);
  }
  return fallback;
}

/** Subscriptions that give access now. */
export const ACTIVE_STATES = new Set(["active", "trialing"]);

/**
 * A provider's subscription status in the words Stripe uses, so `ACTIVE_STATES` and the
 * dashboard read the same for every provider. Anything unknown counts as not active.
 */
const STATES: Record<string, string> = {
  active: "active",
  trialing: "trialing",
  past_due: "past_due",
  unpaid: "past_due",
  on_hold: "past_due",
  paused: "paused",
  canceled: "canceled",
  cancelled: "canceled",
  expired: "expired",
  failed: "expired",
  incomplete_expired: "expired",
  incomplete: "pending",
  pending: "pending",
  pending_payment: "pending",
  draft: "pending",
  // Creem: paid for the period, or cancelled from its end, so still on until then.
  paid: "active",
  scheduled_cancel: "active",
};

export const membershipState = (status: unknown) => (typeof status === "string" && STATES[status.toLowerCase()]) || "expired";

/** The reference in a return address that Payments made itself, for providers whose own ids can't go there. */
export const REFERENCE = /^ref_[a-f0-9]{32}$/;

export interface PlanRef { name: string; productId: string; annualProductId?: string }

/** Plan records that name a product, for providers that sell plans as products. */
export function toPlanRef(plan: PlanRecord): PlanRef | null {
  const name = typeof plan.name === "string" ? plan.name.trim().toLowerCase() : "";
  const productId = typeof plan.priceId === "string" ? plan.priceId.trim() : "";
  if (!name || !productId) return null;
  const annual = typeof plan.annualPriceId === "string" && plan.annualPriceId.trim() ? plan.annualPriceId.trim() : undefined;
  return { name, productId, ...(annual ? { annualProductId: annual } : {}) };
}

/** The slugs better-auth's Polar and Dodo plugins pick products by: the plan's name, and name-annual for the yearly one. */
export const productSlugs = (plans: PlanRef[]) => plans.flatMap((plan) => [
  { productId: plan.productId, slug: plan.name },
  ...(plan.annualProductId ? [{ productId: plan.annualProductId, slug: `${plan.name}-annual` }] : []),
]);

/** The plan a provider's product or plan id belongs to, monthly or yearly. */
export const planNamed = (plans: PlanRef[], productId: unknown) =>
  typeof productId === "string" ? plans.find((plan) => plan.productId === productId || plan.annualProductId === productId)?.name ?? null : null;

export interface PlanRecord { name?: unknown; priceId?: unknown; annualPriceId?: unknown; trialDays?: unknown; limits?: unknown; group?: unknown }

/** At most this many collections in one access, and this many access in one plan. */
export const MAX_ACCESS_COLLECTIONS = 50;
export const MAX_PLAN_ACCESS = 50;

/** What's wrong with an access's `collections`, or null. A list of collection slugs. */
export function accessCollectionsProblem(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return 'List collection slugs, such as ["lms-courses"].';
  if (value.length > MAX_ACCESS_COLLECTIONS) return `List at most ${MAX_ACCESS_COLLECTIONS} collections.`;
  const wrong = value.find((slug) => !isSlug(slug));
  if (wrong !== undefined) return `"${String(wrong)}" isn't a collection slug. Use lowercase words joined by hyphens, such as lms-courses.`;
  return null;
}

/** The record ids in a reference field's value, which holds one id or a list. */
export function referenceIds(value: unknown): number[] {
  const list = Array.isArray(value) ? value : [value];
  return list.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0);
}

export interface PlanAccess { name: string; includes: number[] }
export interface AccessGrant { id: number; collections: string[] }

/**
 * What a person on these plans may open: the ids of every access their plans include, then
 * the slugs of the collections those open whole. Sorted, so the same plans always give the
 * same list. Rules compare record fields with it: ids match "Included in" references, and
 * slugs match a rule's `@request.auth.payments_access ?= "lms-courses"`.
 */
export function accessOf(active: string[], plans: PlanAccess[], grants: AccessGrant[]): Array<number | string> {
  const names = new Set(active);
  const ids = new Set(plans.filter((plan) => names.has(plan.name)).flatMap((plan) => plan.includes));
  const granted = grants.filter((grant) => ids.has(grant.id));
  // An access that was deleted grants nothing, even if a plan still names it.
  const kept = [...new Set(granted.map((grant) => grant.id))].sort((a, b) => a - b);
  const slugs = [...new Set(granted.flatMap((grant) => grant.collections.filter(isSlug)))].sort();
  return [...kept, ...slugs];
}
