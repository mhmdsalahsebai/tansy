/** Pure helpers, kept apart from the plugin and its pages so they're easy to test. */

/** Payments' collections and user field that plan access is made of. */
export const ACCESS = "payments-access";
export const PLANS = "payments-plans";
export const ENTITLEMENTS = "payments-entitlements";
export const MEMBERSHIPS = "payments-memberships";
export const ACCESS_FIELD = "payments_access";
/** The "Included in" field Gate adds to a collection. */
export const INCLUDED = "included";
/** Memberships this plugin gives without payment, kept beside the providers' own. */
export const MANUAL = "manual";

export type GateMode = "records" | "collection";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isSlug = (value: unknown): value is string => typeof value === "string" && value.length <= 63 && SLUG.test(value);

/**
 * The condition Gate adds. "records": a record in no access stays as open as before, and one
 * in an access opens only to plans that include it. `included:length = 0` makes the empty case
 * open on purpose: an empty list otherwise compares as "" (docs/plugins/payments.md §8).
 * "collection": every record needs a plan whose access opens the collection.
 */
export function gateCondition(mode: GateMode, slug: string): string {
  if (!isSlug(slug)) throw new Error(`"${slug}" isn't a collection slug.`);
  return mode === "records"
    ? `${INCLUDED}:length = 0 || ${INCLUDED} ?= @request.auth.${ACCESS_FIELD}`
    : `@request.auth.${ACCESS_FIELD} ?= "${slug}"`;
}

/**
 * A list or view rule with the gate added. A locked rule (null) stays locked: only staff read
 * it, and a gate can't open it. An open rule ("") becomes the gate alone. Anything else keeps
 * every condition it had and adds the gate, so the gate can only ever take access away.
 */
export function gated(rule: string | null, mode: GateMode, slug: string): string | null {
  if (rule === null) return null;
  const condition = gateCondition(mode, slug);
  if (rule.trim() === "") return `(${condition})`;
  if (gateOf(rule, slug)) return rule;
  // The newline ends a trailing // comment in the old rule, which would otherwise swallow the gate.
  return `(${rule}\n) && (${condition})`;
}

/** Which gate a rule carries, as `gated` wrote it, or null. */
export function gateOf(rule: string | null, slug: string): GateMode | null {
  if (!rule || !isSlug(slug)) return null;
  for (const mode of ["records", "collection"] as const) {
    const suffix = `(${gateCondition(mode, slug)})`;
    if (rule === suffix || rule.endsWith(`\n) && ${suffix}`)) return mode;
  }
  return null;
}

/** The rule as it was before `gated`, or the same rule when it carries no gate of ours. */
export function ungated(rule: string | null, slug: string): string | null {
  const mode = gateOf(rule, slug);
  if (!rule || !mode) return rule;
  const suffix = `(${gateCondition(mode, slug)})`;
  if (rule === suffix) return "";
  // `gated` wrote "(" + old + "\n) && " + suffix: take exactly those off.
  const inner = rule.slice(0, -`\n) && ${suffix}`.length);
  return inner.startsWith("(") ? inner.slice(1) : inner;
}

/** Plan names as Payments stores them. */
export const PLAN_NAME = /^[a-z0-9][a-z0-9 _.-]{0,59}$/;

/** A manual grant's end, from a date the dashboard sends, or null for no end. Refuses dates in the past. */
export function grantEnd(value: unknown, now = Date.now()): string | null | "invalid" {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return "invalid";
  const time = Date.parse(value);
  if (Number.isNaN(time) || time <= now) return "invalid";
  return new Date(time).toISOString();
}

/** People per plan, from entitlements: each person counts once for each plan they're on. */
export function countByPlan(entitlements: Array<{ plans?: unknown }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of entitlements) {
    for (const plan of Array.isArray(row.plans) ? row.plans : []) {
      if (typeof plan === "string") counts.set(plan, (counts.get(plan) ?? 0) + 1);
    }
  }
  return counts;
}
