import type { CspAdditions, Messages, PluginSettingField } from "tansy/plugin";
import type { AnalyticsReport, ProviderTracker } from "./tracker";

export type { AnalyticsReport, Breakdown, ProviderTracker, TrackerCall, TrackerStub } from "./tracker";

/**
 * What an analytics provider adapter implements, such as @tansy/analytics-plausible.
 * The analytics plugin keeps what providers share: choosing one, putting its tracker on
 * every page, and showing its numbers on the dashboard. An adapter describes its script
 * and, optionally, how to read its numbers back. See docs/plugins/analytics.md.
 */

/** The analytics plugin's own settings, and each installed provider's, by name. */
export interface AnalyticsSettings {
  /** The id of the outside provider in use, or "none". */
  provider: string;
  [name: string]: unknown;
}

/** An inclusive range of whole days, as YYYY-MM-DD in UTC. */
export interface ReportRange {
  from: string;
  to: string;
}

export interface AnalyticsProvider {
  /** Lowercase letters and digits, such as "plausible". Every setting's name starts with it. */
  id: string;
  label: string;
  /** Its keys on the analytics plugin's settings. */
  settings(): PluginSettingField[];
  /**
   * Its settings' words in other interface languages, by language code, as
   * `{ ar: { settings: { <name>: { label, description } } } }`.
   */
  messages?: Record<string, Messages>;
  /** Whether what the tracker needs is set, such as a site id. */
  ready(settings: AnalyticsSettings): boolean;
  /**
   * What the browser loads and calls on each page view. Public: never a secret. Checked
   * before it reaches a page: an https script on one of the origins in `csp.connect`.
   */
  tracker(settings: AnalyticsSettings): ProviderTracker;
  /** Whether `report` can run, such as when an API key is set. */
  reportReady?(settings: AnalyticsSettings): boolean;
  /** The provider's own numbers for the range, for the dashboard. Leave it out when the provider has no API. */
  report?(range: ReportRange, settings: AnalyticsSettings): Promise<AnalyticsReport>;
  /** The origins its script loads from and sends to, added to the Content Security Policy. */
  csp: CspAdditions;
  /** Where its own dashboard is, for a link next to the numbers. */
  dashboardUrl?(settings: AnalyticsSettings): string | null;
}

/** Types an adapter. */
export const defineAnalyticsProvider = (provider: AnalyticsProvider): AnalyticsProvider => provider;

export const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/** A number from an API that may send numbers as strings. */
export const num = (value: unknown) => {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

/** An origin with no trailing slash, from an option such as a self-hosted instance's address. */
export function originOf(url: string, what: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${what} must be an address such as https://example.com. Got "${url}".`);
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname))) throw new Error(`${what} must use https. Got "${url}".`);
  return parsed.origin;
}

/** An address and the path under it, such as a Matomo installed in a folder. No trailing slash. */
export function baseOf(url: string, what: string): string {
  const origin = originOf(url, what);
  return `${origin}${new URL(url).pathname.replace(/\/+$/, "")}`;
}

const TIMEOUT_MS = 15_000;

/**
 * A JSON request to a provider's API. Redirects, timeouts and error statuses throw with
 * the host and status only: what the provider says may echo a key, so it's never logged.
 */
export async function requestJson<T = unknown>(url: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<T> {
  const host = new URL(url).host;
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new Error(`${host} couldn't be reached.`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${host} answered ${response.status}.`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`${host} didn't answer with JSON.`);
  }
}

/** Every day in the range, oldest first. */
export function daysIn({ from, to }: ReportRange): string[] {
  const days: string[] = [];
  for (let day = new Date(`${from}T00:00:00Z`); day <= new Date(`${to}T00:00:00Z`) && days.length < 400; day.setUTCDate(day.getUTCDate() + 1)) days.push(day.toISOString().slice(0, 10));
  return days;
}

/** Days the provider left out count zero, so every report has one entry a day. */
export function fillDays(range: ReportRange, known: Map<string, { views: number; visitors: number }>) {
  return daysIn(range).map((date) => ({ date, views: known.get(date)?.views ?? 0, visitors: known.get(date)?.visitors ?? 0 }));
}

/** The first `limit` rows, named and counted, most first, without empty names. */
export function breakdown(rows: Array<{ name: unknown; count: unknown }>, limit = 10) {
  return rows
    .map((row) => ({ name: String(row.name ?? "").trim(), count: num(row.count) }))
    .filter((row) => row.name && row.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
