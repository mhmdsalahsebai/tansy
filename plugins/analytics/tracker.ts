/**
 * What reaches the browser, and the checks it passes first. No server imports: the
 * tracker component and headless sites use these types too.
 */

/** JSON. Strings "$url", "$path", "$title" and "$referrer" become the page's, and "$now" a Date. */
export type TrackerArg = string | number | boolean | null | TrackerArg[] | { [key: string]: TrackerArg };

/** A call to a function the provider's script or a stub defines, such as `{ fn: "plausible", args: ["pageview"] }` or `{ fn: "_paq.push", args: [["trackPageView"]] }`. */
export interface TrackerCall {
  fn: string;
  args?: TrackerArg[];
}

/**
 * Set up before the script loads, so calls made meanwhile wait in a queue the script reads:
 * an array (`window._paq = []`), or a function pushing its arguments to one
 * (`window.gtag = function () { dataLayer.push(arguments) }`).
 */
export type TrackerStub = { type: "array"; name: string } | { type: "queue"; name: string; into: string };

export interface ProviderTracker {
  /** An https script on one of the provider's own origins. */
  script: string;
  /** `data-` attributes on the script tag, such as data-domain. */
  attributes?: Record<string, string>;
  /** The global the script defines. Calls to it wait until it's there. */
  global?: string;
  stubs?: TrackerStub[];
  /** Calls made once, before the first page view. */
  setup?: TrackerCall[];
  /** Calls made on each page view, including moves between pages without a reload. */
  pageview: TrackerCall[];
}

/** What every page's tracker gets. */
export interface TrackerConfig {
  /** Whether page views go to the CMS's own count. */
  collect: boolean;
  /** The outside provider in use and ready, if any. */
  provider: (ProviderTracker & { id: string }) | null;
  /** Addresses starting with any of these aren't counted. */
  exclude: string[];
  /** Whether visitors whose browser sends Global Privacy Control or Do Not Track are kept from the outside provider. */
  respectOptOut: boolean;
}

export type Breakdown = Array<{ name: string; count: number }>;

/** One provider's numbers, or the CMS's own, in the same shape. */
export interface AnalyticsReport {
  totals: { views: number; visitors: number };
  /** One entry a day, oldest first. */
  days: Array<{ date: string; views: number; visitors: number }>;
  pages: Breakdown;
  referrers: Breakdown;
  countries?: Breakdown;
  devices?: Breakdown;
  browsers?: Breakdown;
}

const NAME = /^[A-Za-z_$][\w$]{0,39}$/;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
const ATTRIBUTE = /^data-[a-z][a-z0-9-]{0,40}$/;
const MAX_ARGS_BYTES = 4096;

const globalName = (value: unknown): value is string => typeof value === "string" && NAME.test(value) && !FORBIDDEN.has(value);

/** A global or one property of it, such as "umami.track". */
const path = (value: unknown) => typeof value === "string" && value.split(".").length <= 2 && value.split(".").every(globalName);

/**
 * The provider's tracker as the browser may get it, or null with the reason logged. The
 * script must be https on one of `origins`, attributes plain `data-` text, and calls
 * only to the provider's own global or its stubs, with JSON arguments. So a setting gone
 * wrong can't load another script or call anything else on every page.
 */
export function checkedTracker(id: string, tracker: ProviderTracker, origins: string[]): (ProviderTracker & { id: string }) | null {
  const fail = (problem: string) => {
    console.error(`[analytics] ${id}: ${problem}, so the tracker is left off.`);
    return null;
  };
  let script: URL;
  try {
    script = new URL(tracker.script);
  } catch {
    return fail("the script isn't an address");
  }
  const local = script.protocol === "http:" && ["localhost", "127.0.0.1"].includes(script.hostname);
  if ((script.protocol !== "https:" && !local) || !origins.includes(script.origin)) return fail(`the script isn't on one of its origins (${origins.join(", ")})`);
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(tracker.attributes ?? {})) {
    if (!ATTRIBUTE.test(name) || typeof value !== "string" || value.length > 500 || /[\u0000-\u001f]/.test(value)) return fail(`the attribute "${name}" isn't plain data`);
    attributes[name] = value;
  }
  const stubs = tracker.stubs ?? [];
  for (const stub of stubs) {
    if (!globalName(stub.name) || (stub.type === "queue" ? !path(stub.into) : stub.type !== "array")) return fail("a stub isn't a plain global");
  }
  if (tracker.global !== undefined && !globalName(tracker.global)) return fail("its global isn't a plain name");
  const callable = new Set([...stubs.map((stub) => stub.name), ...(tracker.global ? [tracker.global] : [])]);
  const calls = [...(tracker.setup ?? []), ...tracker.pageview];
  for (const call of calls) {
    if (!path(call.fn) || !callable.has(call.fn.split(".")[0])) return fail(`"${String(call.fn)}" isn't its global or one of its stubs`);
    if (call.args !== undefined && !Array.isArray(call.args)) return fail("arguments must be a list");
  }
  const text = JSON.stringify(calls.map((call) => call.args ?? []));
  if (text === undefined || text.length > MAX_ARGS_BYTES) return fail("its arguments aren't small JSON");
  const copy = (list: TrackerCall[] | undefined) => (list ?? []).map((call) => ({ fn: call.fn, args: JSON.parse(JSON.stringify(call.args ?? [])) as TrackerArg[] }));
  return {
    id,
    script: script.toString(),
    attributes,
    ...(tracker.global ? { global: tracker.global } : {}),
    stubs: stubs.map((stub) => (stub.type === "queue" ? { type: "queue", name: stub.name, into: stub.into } : { type: "array", name: stub.name })),
    setup: copy(tracker.setup),
    pageview: copy(tracker.pageview),
  };
}

/** Whether an address is one the owner chose not to count. */
export const excluded = (path: string, exclude: string[]) => exclude.some((prefix) => prefix && (path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)));
