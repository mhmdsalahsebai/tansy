import { breakdown, daysIn, type ReportRange } from "./provider";
import type { AnalyticsReport } from "./tracker";

/**
 * The CMS's own count, as pure functions. Nothing here keeps an address, a browser's full
 * name or anything else that could pick a person out: a page view becomes counts by day.
 */

/** One day's counts, as stored. Each table keeps its biggest entries and folds the rest into "(other)". */
export interface DayStats {
  views: number;
  visitors: number;
  pages: Record<string, number>;
  referrers: Record<string, number>;
  countries: Record<string, number>;
  devices: Record<string, number>;
  browsers: Record<string, number>;
}

export type Table = Exclude<keyof DayStats, "views" | "visitors">;
export const TABLES: Table[] = ["pages", "referrers", "countries", "devices", "browsers"];

/** Enough for the pages anyone looks at, small enough to keep a day under the store's limit. */
export const TABLE_LIMITS: Record<Table, number> = { pages: 500, referrers: 200, countries: 250, devices: 10, browsers: 20 };
export const OTHER = "(other)";

export const emptyDay = (): DayStats => ({ views: 0, visitors: 0, pages: {}, referrers: {}, countries: {}, devices: {}, browsers: {} });

/** What one page view adds. Null fields add nothing to their table. */
export interface Hit {
  path: string;
  referrer: string | null;
  country: string | null;
  device: string;
  browser: string;
  /** The visitor's first page view today. */
  newVisitor: boolean;
}

const bump = (table: Record<string, number>, key: string, by = 1) => {
  table[key] = (Object.hasOwn(table, key) ? table[key] : 0) + by;
};

export function addHit(day: DayStats, hit: Hit) {
  day.views += 1;
  if (hit.newVisitor) day.visitors += 1;
  bump(day.pages, hit.path);
  if (hit.referrer) bump(day.referrers, hit.referrer);
  if (hit.country) bump(day.countries, hit.country);
  bump(day.devices, hit.device);
  bump(day.browsers, hit.browser);
}

/** Keeps the biggest `limit` entries, and adds the rest to "(other)". */
export function capTable(table: Record<string, number>, limit: number): Record<string, number> {
  const entries = Object.entries(table);
  if (entries.length <= limit) return table;
  entries.sort((a, b) => (a[0] === OTHER ? 1 : b[0] === OTHER ? -1 : b[1] - a[1]));
  const kept = Object.fromEntries(entries.slice(0, limit - 1).filter(([name]) => name !== OTHER));
  const rest = entries.filter(([name]) => !Object.hasOwn(kept, name)).reduce((sum, [, count]) => sum + count, 0);
  if (rest) kept[OTHER] = rest;
  return kept;
}

/** A stored day, read defensively: anything that isn't a count is left out. */
export function readDay(value: unknown): DayStats {
  const day = emptyDay();
  if (!value || typeof value !== "object") return day;
  const source = value as Record<string, unknown>;
  const count = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0);
  day.views = count(source.views);
  day.visitors = count(source.visitors);
  for (const table of TABLES) {
    const raw = source[table];
    if (!raw || typeof raw !== "object") continue;
    for (const [name, value] of Object.entries(raw)) if (count(value)) day[table][name] = count(value);
  }
  return day;
}

/** Adds `delta` to `day`, capping each table. */
export function mergeDay(day: DayStats, delta: DayStats): DayStats {
  const merged = emptyDay();
  merged.views = day.views + delta.views;
  merged.visitors = day.visitors + delta.visitors;
  for (const table of TABLES) {
    const sum = { ...day[table] };
    for (const [name, count] of Object.entries(delta[table])) bump(sum, name, count);
    merged[table] = capTable(sum, TABLE_LIMITS[table]);
  }
  return merged;
}

/** Days' counts as a report. Visitors add up per day, so one person on two days counts twice. */
export function reportFrom(range: ReportRange, days: Map<string, DayStats>): AnalyticsReport {
  const series = daysIn(range).map((date) => ({ date, views: days.get(date)?.views ?? 0, visitors: days.get(date)?.visitors ?? 0 }));
  const sum = (table: Table) => {
    const total: Record<string, number> = {};
    for (const day of days.values()) for (const [name, count] of Object.entries(day[table])) bump(total, name, count);
    return breakdown(Object.entries(total).map(([name, count]) => ({ name, count })));
  };
  return {
    totals: { views: series.reduce((n, day) => n + day.views, 0), visitors: series.reduce((n, day) => n + day.visitors, 0) },
    days: series,
    pages: sum("pages"),
    referrers: sum("referrers"),
    countries: sum("countries"),
    devices: sum("devices"),
    browsers: sum("browsers"),
  };
}

const BOT = /bot|crawl|spider|slurp|scrape|fetch|curl|wget|python|java\/|go-http|axios|node|headless|phantom|puppeteer|playwright|selenium|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|preview|facebookexternalhit|embedly|whatsapp|telegram|discord|slack|vercel|semrush|ahrefs|bingpreview/i;

/** Whether a page view comes from a program rather than a person. A missing browser name counts as a program. */
export const isBot = (userAgent: string | null) => !userAgent || userAgent.length < 10 || BOT.test(userAgent);

/** The browser's family, never its version. */
export function browserOf(userAgent: string): string {
  if (/Edg(e|A|iOS)?\//.test(userAgent)) return "Edge";
  if (/OPR\/|Opera/.test(userAgent)) return "Opera";
  if (/SamsungBrowser\//.test(userAgent)) return "Samsung Internet";
  if (/Firefox\/|FxiOS\//.test(userAgent)) return "Firefox";
  if (/Chrome\/|CriOS\//.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent)) return "Safari";
  return "Other";
}

/** From the screen's width, as Plausible does: it says nothing about the person. */
export function deviceOf(width: number | null | undefined): string {
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return "Unknown";
  if (width < 576) return "Mobile";
  if (width < 992) return "Tablet";
  return "Desktop";
}

const COUNTRY_HEADERS = ["cf-ipcountry", "x-vercel-ip-country", "cloudfront-viewer-country", "x-country-code", "fly-client-country"];

/** The country a CDN in front of the site says the visitor is in, when one does. The address itself is never looked at. */
export function countryOf(headers: Headers): string | null {
  for (const name of COUNTRY_HEADERS) {
    const value = headers.get(name)?.trim().toUpperCase();
    if (value && /^[A-Z]{2}$/.test(value) && value !== "XX" && value !== "T1") return value;
  }
  return null;
}

/** Where the visitor came from: a campaign's `utm_source` or `ref`, or the other site's host. Links within the site count as none. */
export function referrerOf(referrer: string | null | undefined, source: string | null | undefined, ownHost: string | null): string | null {
  const named = source?.trim().toLowerCase().replace(/[^\w .-]/g, "").slice(0, 60);
  if (named) return named;
  if (!referrer) return null;
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const own = ownHost?.toLowerCase().replace(/:\d+$/, "").replace(/^www\./, "");
  return host && host !== own ? host.slice(0, 100) : null;
}

const MAX_PATH = 200;

/** The address without its query or fragment, or null for anything that isn't a site address. */
export function cleanPath(path: unknown): string | null {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return null;
  const bare = path.split(/[?#]/)[0];
  if (/[\u0000-\u001f\s]/.test(bare)) return null;
  const trimmed = bare.length > 1 ? bare.replace(/\/+$/, "") || "/" : bare;
  return trimmed.slice(0, MAX_PATH);
}

/** Today in UTC, as YYYY-MM-DD. */
export const today = (now = new Date()) => now.toISOString().slice(0, 10);

/** The last `days` days up to today, inclusive. */
export function lastDays(days: number, now = new Date()): ReportRange {
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: today(from), to: today(now) };
}
