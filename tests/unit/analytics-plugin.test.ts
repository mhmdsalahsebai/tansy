import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, ExtensionRoute, PluginStore } from "@/core/extend/define";
import { assertPluginManifest } from "@/core/extend/manifest";
import { pluginRenderers } from "@/components/stream/StreamField";
import { defineCms } from "@/core/auth/extensions";
import { everyPageProps } from "@/core/site/reader";
import { analytics } from "../../plugins/analytics/index";
import { createCounter, dayKey, INDEX_KEY } from "../../plugins/analytics/counter";
import { addHit, browserOf, capTable, cleanPath, countryOf, deviceOf, emptyDay, isBot, lastDays, mergeDay, OTHER, readDay, referrerOf, reportFrom } from "../../plugins/analytics/logic";
import { checkedTracker, excluded, type ProviderTracker, type TrackerConfig } from "../../plugins/analytics/tracker";
import type { AnalyticsProvider } from "../../plugins/analytics/provider";
import analyticsRenderers from "../../plugins/analytics/render";
import { fathom } from "../../plugins/analytics-fathom/index";
import { googleAnalytics, serviceAccountAssertion } from "../../plugins/analytics-google/index";
import { matomo } from "../../plugins/analytics-matomo/index";
import { plausible } from "../../plugins/analytics-plausible/index";
import { umami } from "../../plugins/analytics-umami/index";

vi.mock("@/core/extend/hooks", () => ({ extensionContext: (source: string) => ({ source, settings: { get: async () => ({}) } }) }));

function memoryStore(): PluginStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key) => (data.has(key) ? structuredClone(data.get(key)) : null),
    set: async (key, value) => { data.set(key, structuredClone(value)); },
    claim: async (key, value) => (data.has(key) ? false : (data.set(key, value), true)),
    delete: async (key) => { data.delete(key); },
    list: async (prefix = "") => [...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
    deleteMany: async (prefix: string) => { const gone = [...data.keys()].filter((key) => key.startsWith(prefix)); gone.forEach((key) => data.delete(key)); return gone.length; },
  };
}

const contextWith = (settings: Record<string, unknown>, store = memoryStore()) => ({ settings: { get: async () => settings }, store, scope: { value: () => null, bind: <A extends unknown[], R>(work: (...args: A) => R) => work, siteUrl: async () => null } }) as unknown as ExtensionContext;

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

/** A fetch that records each call and answers from `answer`. */
function recordingFetch(answer: (url: string, body: string) => unknown) {
  const calls: Array<{ url: string; body: string; headers: Headers }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    calls.push({ url: String(url), body, headers: new Headers(init?.headers) });
    return json(answer(String(url), body));
  }) as typeof fetch;
  return { calls, fetcher };
}

const range = { from: "2026-11-01", to: "2026-11-03" };

describe("analytics counting", () => {
  it("keeps only a site address, without its query", () => {
    expect(cleanPath("/blog/post?utm_source=x#top")).toBe("/blog/post");
    expect(cleanPath("/blog/")).toBe("/blog");
    expect(cleanPath("/")).toBe("/");
    for (const bad of ["blog", "//evil.test/x", "https://evil.test/", "/a b", 5, null]) expect(cleanPath(bad)).toBeNull();
    expect(cleanPath(`/${"x".repeat(500)}`)).toHaveLength(200);
  });

  it("keeps where a visitor came from as a host or a campaign name, never the full address", () => {
    expect(referrerOf("https://www.google.com/search?q=secret", null, "example.com")).toBe("google.com");
    expect(referrerOf("https://example.com/other", null, "www.example.com:3000")).toBeNull();
    expect(referrerOf("javascript:alert(1)", null, null)).toBeNull();
    expect(referrerOf("https://news.ycombinator.com/", "Newsletter<script>", "example.com")).toBe("newsletterscript");
    expect(referrerOf(null, null, null)).toBeNull();
  });

  it("tells programs from people, and names browsers and devices without versions", () => {
    const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
    expect(isBot(chrome)).toBe(false);
    for (const bot of ["Mozilla/5.0 (compatible; Googlebot/2.1)", "curl/8.0", "Mozilla/5.0 HeadlessChrome/120", null, "x"]) expect(isBot(bot)).toBe(true);
    expect(browserOf(chrome)).toBe("Chrome");
    expect(browserOf(`${chrome} Edg/141.0`)).toBe("Edge");
    expect(browserOf("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15")).toBe("Safari");
    expect(browserOf("Mozilla/5.0 Gecko/20100101 Firefox/140.0")).toBe("Firefox");
    expect([deviceOf(390), deviceOf(800), deviceOf(1440), deviceOf(null)]).toEqual(["Mobile", "Tablet", "Desktop", "Unknown"]);
  });

  it("takes the country only from a CDN's header", () => {
    expect(countryOf(new Headers({ "cf-ipcountry": "de" }))).toBe("DE");
    expect(countryOf(new Headers({ "cf-ipcountry": "XX" }))).toBeNull();
    expect(countryOf(new Headers({ "x-vercel-ip-country": "<b>" }))).toBeNull();
    expect(countryOf(new Headers())).toBeNull();
  });

  it("folds the smallest entries into (other) past a table's limit", () => {
    expect(capTable({ a: 5, b: 3, c: 1, d: 1 }, 3)).toEqual({ a: 5, b: 3, [OTHER]: 2 });
    expect(capTable({ a: 5, [OTHER]: 4, b: 1, c: 1 }, 3)).toEqual({ a: 5, b: 1, [OTHER]: 5 });
    expect(capTable({ a: 1 }, 3)).toEqual({ a: 1 });
  });

  it("adds days up, reads stored days defensively, and reports every day of the range", () => {
    const day = emptyDay();
    addHit(day, { path: "/a", referrer: "google.com", country: "DE", device: "Mobile", browser: "Chrome", newVisitor: true });
    addHit(day, { path: "/a", referrer: null, country: null, device: "Mobile", browser: "Chrome", newVisitor: false });
    const merged = mergeDay(day, day);
    expect(merged).toMatchObject({ views: 4, visitors: 2, pages: { "/a": 4 }, referrers: { "google.com": 2 } });
    expect(readDay({ views: "9", visitors: -1, pages: { "/a": 2, "/b": "x" }, __proto__: { views: 1 } })).toMatchObject({ views: 0, visitors: 0, pages: { "/a": 2 } });
    expect(readDay(null)).toEqual(emptyDay());
    const report = reportFrom(range, new Map([["2026-11-02", merged]]));
    expect(report.days).toEqual([{ date: "2026-11-01", views: 0, visitors: 0 }, { date: "2026-11-02", views: 4, visitors: 2 }, { date: "2026-11-03", views: 0, visitors: 0 }]);
    expect(report.totals).toEqual({ views: 4, visitors: 2 });
    expect(report.pages).toEqual([{ name: "/a", count: 4 }]);
    expect(lastDays(7, new Date("2026-11-15T12:00:00Z"))).toEqual({ from: "2026-11-09", to: "2026-11-15" });
  });

  it("counts a visitor once a day, keeps no trace of them, and writes days in batches", async () => {
    const store = memoryStore();
    let now = new Date("2026-11-15T10:00:00Z");
    const counter = createCounter(() => store, () => now);
    const hit = { path: "/a", referrer: null, country: null, device: "Desktop", browser: "Firefox" };
    const alice = { site: "example.com", ip: "203.0.113.5", userAgent: "Firefox" };
    counter.count(hit, alice);
    counter.count({ ...hit, path: "/b" }, alice);
    counter.count(hit, { ...alice, ip: "203.0.113.6" });
    await counter.flush();
    expect(store.data.get(dayKey("2026-11-15"))).toMatchObject({ views: 3, visitors: 2, pages: { "/a": 2, "/b": 1 } });
    expect(store.data.get(INDEX_KEY)).toEqual(["2026-11-15"]);
    // Nothing in the store could identify a visitor.
    expect(JSON.stringify([...store.data])).not.toMatch(/203\.0\.113|Firefox".*ip/);

    now = new Date("2026-11-16T00:01:00Z");
    counter.count(hit, alice);
    await counter.flush();
    expect(store.data.get(dayKey("2026-11-16"))).toMatchObject({ views: 1, visitors: 1 });
    expect(store.data.get(INDEX_KEY)).toEqual(["2026-11-15", "2026-11-16"]);
  });

  it("keeps counts that couldn't be written for the next flush", async () => {
    const store = memoryStore();
    const failing = { ...store, set: vi.fn().mockRejectedValueOnce(new Error("down")).mockImplementation(store.set) };
    const counter = createCounter(() => failing, () => new Date("2026-11-15T10:00:00Z"));
    counter.count({ path: "/a", referrer: null, country: null, device: "Desktop", browser: "Chrome" }, { site: "s", ip: null, userAgent: "ua" });
    await expect(counter.flush()).rejects.toThrow("down");
    await counter.flush();
    expect(store.data.get(dayKey("2026-11-15"))).toMatchObject({ views: 1, visitors: 1 });
  });

  it("writes each scope value's views in that value, whatever runs the flush", async () => {
    // A store per scope value, picked by the value the write runs in, as core's is.
    const stores = new Map<string, ReturnType<typeof memoryStore>>();
    let current = "";
    const storeOf = () => { if (!stores.has(current)) stores.set(current, memoryStore()); return stores.get(current)!; };
    const scopeIn = (value: string) => ({ value: () => value, bind: <A extends unknown[], R>(work: (...args: A) => R) => (...args: A) => { const before = current; current = value; try { return work(...args); } finally { current = before; } }, siteUrl: async () => null, data: {} as never, forgetLimits: async () => {} });
    const counter = createCounter(storeOf, () => new Date("2026-11-15T10:00:00Z"));
    const hit = { path: "/a", referrer: null, country: null, device: "Desktop", browser: "Chrome" };
    counter.count(hit, { site: "a.example", ip: "1", userAgent: "ua" }, scopeIn("a"));
    counter.count(hit, { site: "a.example", ip: "2", userAgent: "ua" }, scopeIn("a"));
    counter.count(hit, { site: "b.example", ip: "1", userAgent: "ua" }, scopeIn("b"));
    await counter.flush();
    expect(stores.get("a")!.data.get(dayKey("2026-11-15"))).toMatchObject({ views: 2 });
    expect(stores.get("b")!.data.get(dayKey("2026-11-15"))).toMatchObject({ views: 1 });
    expect(stores.get("")?.data.size ?? 0).toBe(0);
  });
});

describe("the tracker check", () => {
  const good: ProviderTracker = { script: "https://stats.example.com/s.js", attributes: { "data-site": "AB" }, global: "stats", stubs: [{ type: "queue", name: "q", into: "q.list" }], setup: [{ fn: "q", args: ["init", { cookies: false }] }], pageview: [{ fn: "stats.track", args: ["$url"] }] };

  it("passes a provider's tracker as plain data", () => {
    expect(checkedTracker("x", good, ["https://stats.example.com"])).toEqual({ id: "x", ...good });
  });

  it.each([
    ["a script off its origins", { script: "https://evil.test/s.js" }],
    ["an http script", { script: "http://stats.example.com/s.js" }],
    ["an attribute that isn't data-", { attributes: { onload: "alert(1)" } }],
    ["a call to another global", { pageview: [{ fn: "eval", args: ["alert(1)"] }] }],
    ["a call through a prototype", { pageview: [{ fn: "stats.constructor" }] }],
    ["a deep path", { pageview: [{ fn: "stats.a.b" }] }],
    ["a stub named oddly", { stubs: [{ type: "queue", name: "__proto__", into: "x" }] }],
  ] as Array<[string, Partial<ProviderTracker>]>)("refuses %s", (_, change) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(checkedTracker("x", { ...good, ...change }, ["https://stats.example.com"])).toBeNull();
    spy.mockRestore();
  });

  it("leaves excluded addresses and everything under them out, not their neighbours", () => {
    expect(excluded("/members", ["/members"])).toBe(true);
    expect(excluded("/members/area", ["/members/"])).toBe(true);
    expect(excluded("/membership", ["/members"])).toBe(false);
  });

  it("passes every adapter's tracker", () => {
    const settings = { provider: "x", plausibleDomain: "example.com", umamiWebsiteId: "4fb7fa4c-5b46-438d-94b3-3a8fb9bc2e8b", googleMeasurementId: "G-ABC1234", googleCookieless: true, fathomSiteId: "ABCDEFGH", matomoSiteId: "3" };
    for (const provider of [plausible(), umami(), umami({ host: "https://umami.example.com" }), googleAnalytics(), fathom(), matomo({ url: "https://example.matomo.cloud/" })]) {
      expect(provider.ready(settings)).toBe(true);
      expect(checkedTracker(provider.id, provider.tracker(settings), provider.csp.connect ?? []), provider.id).not.toBeNull();
    }
  });
});

describe("analytics plugin", () => {
  afterEach(() => vi.restoreAllMocks());

  it("validates its options and its providers' setting names", () => {
    expect(() => analytics({ providers: [plausible(), plausible()] })).toThrow(/listed twice/);
    expect(() => analytics({ providers: [plausible()], provider: "umami" })).toThrow(/isn't one of the providers/);
    expect(() => analytics({ retentionDays: 5 })).toThrow();
    const sloppy = { ...fathom(), settings: () => [{ name: "key", type: "secret" as const, label: "Key" }] } as AnalyticsProvider;
    expect(() => analytics({ providers: [sloppy] })).toThrow(/must start with "fathom"/);
    expect(() => assertPluginManifest(analytics({ providers: [plausible(), umami(), googleAnalytics(), fathom(), matomo({ url: "https://m.example.com" })] }))).not.toThrow();
    expect(() => pluginRenderers("analytics", analyticsRenderers)).not.toThrow();
    expect(() => matomo({ url: "ftp://m.example.com" })).toThrow(/must use https/);
  });

  it("lets the Content Security Policy reach every installed provider", () => {
    const plugin = analytics({ providers: [plausible({ host: "https://p.example.com" }), googleAnalytics()] });
    expect(plugin.csp?.connect).toEqual(expect.arrayContaining(["https://p.example.com", "https://www.google-analytics.com"]));
    expect(plugin.csp?.img).toContain("https://www.google-analytics.com");
  });

  const tracker = (plugin: ReturnType<typeof analytics>, settings: Record<string, unknown>, preview = false) =>
    plugin.everyPage!["analytics-tracker"]({ ...contextWith(settings), page: { path: "/", collection: null, recordId: null, locale: null, preview } }) as Promise<TrackerConfig | null>;

  it("puts the tracker on pages, but not on previews or when nothing is on", async () => {
    const plugin = analytics({ providers: [plausible()] });
    expect(await tracker(plugin, { collect: true, provider: "none", exclude: "/members\n\nnot-a-path", respectOptOut: true })).toEqual({ collect: true, provider: null, exclude: ["/members"], respectOptOut: true });
    expect(await tracker(analytics(), { collect: true }, true)).toBeNull();
    expect(await tracker(analytics(), { collect: false })).toBeNull();
  });

  it("sends to the provider only once its settings are complete", async () => {
    expect((await tracker(analytics({ providers: [plausible()] }), { collect: false, provider: "plausible", plausibleDomain: "" }))).toBeNull();
    const config = await tracker(analytics({ providers: [plausible()] }), { collect: false, provider: "plausible", plausibleDomain: "example.com" });
    expect(config?.provider).toMatchObject({ id: "plausible", script: "https://plausible.io/js/script.manual.js", attributes: { "data-domain": "example.com" } });
  });

  it("gives the browser no secret", async () => {
    const config = await tracker(analytics({ providers: [plausible()] }), { collect: true, provider: "plausible", plausibleDomain: "example.com", plausibleApiKey: "sk-secret" });
    expect(JSON.stringify(config)).not.toContain("sk-secret");
  });

  const route = (plugin: ReturnType<typeof analytics>, method: string, path: string) => plugin.routes!.find((candidate) => candidate.method === method && candidate.path === path) as ExtensionRoute;

  it("declares who may call each route", () => {
    const plugin = analytics();
    expect(route(plugin, "POST", "/hit")).toMatchObject({ access: "public", rateLimit: { window: 60, max: 60 } });
    expect(route(plugin, "GET", "/tracker")).toMatchObject({ access: "public" });
    expect(route(plugin, "GET", "/report")).toMatchObject({ access: "permission", permission: "ext.analytics:read" });
  });

  it("counts a visitor's page view, and nothing from programs, excluded pages or with counting off", async () => {
    const plugin = analytics();
    const store = memoryStore();
    const hit = (body: Record<string, unknown>, settings: Record<string, unknown> = { collect: true, exclude: "/private" }, agent = "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0") =>
      route(plugin, "POST", "/hit").handler({ ...contextWith(settings, store), body: { referrer: null, source: null, width: 1200, ...body }, ip: "198.51.100.1", request: new Request("https://example.com/api/ext/analytics/hit", { method: "POST", headers: { "user-agent": agent, host: "example.com", "cf-ipcountry": "FR" } }) } as never) as Promise<Response>;
    expect((await hit({ path: "/a?x=1", referrer: "https://duckduckgo.com/?q=a" })).status).toBe(204);
    await hit({ path: "/private/page" });
    await hit({ path: "/a" }, undefined, "Googlebot/2.1 (+http://www.google.com/bot.html)");
    const report = await route(plugin, "GET", "/report").handler({ ...contextWith({ collect: true }, store), query: { days: "7" } } as never) as { report: { totals: unknown; pages: unknown; referrers: unknown; countries: unknown; browsers: unknown }; source: string };
    expect(report.source).toBe("cms");
    expect(report.report).toMatchObject({ totals: { views: 1, visitors: 1 }, pages: [{ name: "/a", count: 1 }], referrers: [{ name: "duckduckgo.com", count: 1 }], countries: [{ name: "FR", count: 1 }], browsers: [{ name: "Firefox", count: 1 }] });
  });

  it("reports from the provider when its API key is set, and from the CMS's own count too while counting", async () => {
    const { fetcher } = recordingFetch(() => ({ results: [{ metrics: [10, 4], dimensions: [] }] }));
    const plugin = analytics({ providers: [plausible({ fetcher })] });
    const ask = (settings: Record<string, unknown>, source?: string) => route(plugin, "GET", "/report").handler({ ...contextWith(settings), query: { days: "7", source } } as never) as Promise<{ sources: Array<{ id: string }>; source: string; failed: boolean }>;
    const both = await ask({ collect: true, provider: "plausible", plausibleDomain: "example.com", plausibleApiKey: "k" });
    expect(both.sources.map((source) => source.id)).toEqual(["plausible", "cms"]);
    expect(both).toMatchObject({ source: "plausible", failed: false });
    expect(await ask({ collect: true, provider: "plausible", plausibleDomain: "example.com", plausibleApiKey: "k" }, "cms")).toMatchObject({ source: "cms" });
    expect((await ask({ collect: false, provider: "plausible", plausibleDomain: "example.com" })).sources.map((source) => source.id)).toEqual(["cms"]);
  });

  it("says a provider failed rather than failing the dashboard", async () => {
    const fetcher = (async () => new Response("no", { status: 401 })) as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const plugin = analytics({ providers: [fathom({ fetcher })] });
    const answer = await route(plugin, "GET", "/report").handler({ ...contextWith({ provider: "fathom", fathomSiteId: "ABCDEFGH", fathomApiKey: "k" }), query: { days: "30" } } as never);
    expect(answer).toMatchObject({ source: "fathom", failed: true, report: null });
  });

  it("deletes days older than it keeps", async () => {
    const store = memoryStore();
    const old = lastDays(400).from;
    const recent = lastDays(2).from;
    store.data.set(dayKey(old), { views: 1 });
    store.data.set(dayKey(recent), { views: 1 });
    store.data.set(INDEX_KEY, [old, recent]);
    await analytics().jobs!.find((job) => job.name === "analytics.prune")!.handler(contextWith({ retentionDays: 30 }, store), { deadline: null, timeLeft: () => Infinity });
    expect(store.data.has(dayKey(old))).toBe(false);
    expect(store.data.get(INDEX_KEY)).toEqual([recent]);
  });
});

describe("every-page props in the site reader", () => {
  const page = { path: "/", collection: null, recordId: null, locale: null, preview: false };
  const config = (everyPage: Record<string, () => unknown>) => defineCms({ plugins: [{ name: "acme", version: "1.0.0", apiVersion: 1, everyPage }] });

  it("copies props through JSON, and leaves off a part that throws, is too big or returns null", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const props = await everyPageProps(config({
      "acme-a": () => ({ when: new Date("2026-01-01T00:00:00Z"), drop: () => 1 }),
      "acme-b": () => { throw new Error("no"); },
      "acme-c": () => ({ big: "x".repeat(20_000) }),
      "acme-d": () => null,
    }), page);
    expect(props).toEqual({ "acme-a": { when: "2026-01-01T00:00:00.000Z" } });
  });

  it("gives each function the page", async () => {
    const seen = vi.fn(() => ({}));
    await everyPageProps(config({ "acme-a": seen }), { ...page, path: "/x" });
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ page: expect.objectContaining({ path: "/x" }) }));
  });
});

describe("analytics providers' reports", () => {
  it("Plausible queries the Stats API v2 with its key, and leaves direct visits out of referrers", async () => {
    const { calls, fetcher } = recordingFetch((_, body) => {
      const query = JSON.parse(body) as { dimensions: string[] };
      if (!query.dimensions.length) return { results: [{ metrics: [30, 12], dimensions: [] }] };
      if (query.dimensions[0] === "time:day") return { results: [{ metrics: [5, 2], dimensions: ["2026-11-02"] }] };
      if (query.dimensions[0] === "visit:source") return { results: [{ metrics: [7], dimensions: ["Direct / None"] }, { metrics: [3], dimensions: ["Google"] }] };
      return { results: [{ metrics: [9], dimensions: ["/a"] }] };
    });
    const report = await plausible({ fetcher }).report!(range, { provider: "plausible", plausibleDomain: "example.com", plausibleApiKey: "key" });
    expect(calls[0].url).toBe("https://plausible.io/api/v2/query");
    expect(calls[0].headers.get("authorization")).toBe("Bearer key");
    expect(JSON.parse(calls[0].body)).toMatchObject({ site_id: "example.com", date_range: ["2026-11-01", "2026-11-03"] });
    expect(report.totals).toEqual({ views: 30, visitors: 12 });
    expect(report.days[1]).toEqual({ date: "2026-11-02", views: 5, visitors: 2 });
    expect(report.referrers).toEqual([{ name: "Google", count: 3 }]);
  });

  it("Umami uses an API key in its cloud and a token when self-hosted, and either version's numbers", async () => {
    const answer = (url: string) => {
      if (url.includes("/stats")) return { pageviews: { value: 20 }, visitors: 8 };
      if (url.includes("/pageviews")) return { pageviews: [{ x: "2026-11-03 00:00:00", y: 6 }], sessions: [{ x: "2026-11-03 00:00:00", y: 3 }] };
      return [{ x: "/a", y: 4 }];
    };
    const cloud = recordingFetch(answer);
    const settings = { provider: "umami", umamiWebsiteId: "4fb7fa4c-5b46-438d-94b3-3a8fb9bc2e8b", umamiApiKey: "key" };
    const report = await umami({ fetcher: cloud.fetcher }).report!(range, settings);
    expect(cloud.calls[0].url).toMatch(/^https:\/\/api\.umami\.is\/v1\/websites\/4fb7fa4c-5b46-438d-94b3-3a8fb9bc2e8b\/stats\?startAt=\d+&endAt=\d+$/);
    expect(cloud.calls[0].headers.get("x-umami-api-key")).toBe("key");
    expect(report).toMatchObject({ totals: { views: 20, visitors: 8 }, pages: [{ name: "/a", count: 4 }] });
    expect(report.days[2]).toEqual({ date: "2026-11-03", views: 6, visitors: 3 });
    const own = recordingFetch(answer);
    await umami({ host: "https://umami.example.com", fetcher: own.fetcher }).report!(range, settings);
    expect(own.calls[0].url).toMatch(/^https:\/\/umami\.example\.com\/api\/websites\//);
    expect(own.calls[0].headers.get("authorization")).toBe("Bearer key");
  });

  it("Google signs a service account's token request and reads the Data API", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const account = JSON.stringify({ client_email: "cms@project.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
    const { calls, fetcher } = recordingFetch((url, body) => {
      if (url.includes("oauth2")) return { access_token: "tok", expires_in: 3600 };
      const request = JSON.parse(body) as { dimensions?: Array<{ name: string }> };
      const dimension = request.dimensions?.[0]?.name;
      if (!dimension) return { rows: [{ metricValues: [{ value: "40" }, { value: "11" }] }] };
      if (dimension === "date") return { rows: [{ dimensionValues: [{ value: "20261101" }], metricValues: [{ value: "4" }, { value: "2" }] }] };
      return { rows: [{ dimensionValues: [{ value: "(not set)" }], metricValues: [{ value: "9" }] }, { dimensionValues: [{ value: "/a" }], metricValues: [{ value: "3" }] }] };
    });
    const provider = googleAnalytics({ fetcher });
    const settings = { provider: "google", googleMeasurementId: "G-ABC1234", googlePropertyId: "123456", googleServiceAccount: account };
    expect(provider.reportReady!(settings)).toBe(true);
    expect(provider.reportReady!({ ...settings, googleServiceAccount: "{}" })).toBe(false);
    const report = await provider.report!(range, settings);
    expect(new URLSearchParams(calls[0].body).get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(calls.filter((call) => call.url.includes("oauth2"))).toHaveLength(1);
    expect(calls[1].url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/123456:runReport");
    expect(calls[1].headers.get("authorization")).toBe("Bearer tok");
    expect(report.totals).toEqual({ views: 40, visitors: 11 });
    expect(report.days[0]).toEqual({ date: "2026-11-01", views: 4, visitors: 2 });
    expect(report.pages).toEqual([{ name: "/a", count: 3 }]);
    const [, claims] = serviceAccountAssertion(JSON.parse(account) as never, 1000).split(".");
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toMatchObject({ iss: "cms@project.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/analytics.readonly", exp: 4600 });
  });

  it("Fathom reads its aggregations", async () => {
    const { calls, fetcher } = recordingFetch((url) => {
      const query = new URL(url).searchParams;
      if (query.get("date_grouping")) return [{ date: "2026-11-01 00:00:00", pageviews: "3", uniques: "2" }];
      if (query.get("field_grouping") === "pathname") return [{ pathname: "/a", pageviews: "3" }];
      if (query.get("field_grouping")) return [];
      return [{ pageviews: "3", uniques: "2" }];
    });
    const report = await fathom({ fetcher }).report!(range, { provider: "fathom", fathomSiteId: "abcdefgh", fathomApiKey: "key" });
    expect(new URL(calls[0].url).searchParams.get("entity_id")).toBe("ABCDEFGH");
    expect(calls[0].headers.get("authorization")).toBe("Bearer key");
    expect(report).toMatchObject({ totals: { views: 3, visitors: 2 }, pages: [{ name: "/a", count: 3 }] });
    expect(report.days[0]).toEqual({ date: "2026-11-01", views: 3, visitors: 2 });
  });

  it("Matomo sends its token in the body, never the address, and treats a refusal as a failure", async () => {
    const { calls, fetcher } = recordingFetch((_, body) => {
      const method = new URLSearchParams(body).get("method");
      if (method === "VisitsSummary.get") return { "2026-11-01": { nb_uniq_visitors: 2, nb_visits: 3 }, "2026-11-02": [] };
      if (method === "Actions.get") return { "2026-11-01": { nb_pageviews: 7 }, "2026-11-02": [] };
      if (method === "UserCountry.getCountry") return [{ label: "Germany", code: "de", nb_visits: 2 }];
      return [{ label: "/a", nb_hits: 7, nb_visits: 3 }];
    });
    const report = await matomo({ url: "https://stats.example.com/matomo/", fetcher }).report!(range, { provider: "matomo", matomoSiteId: "1", matomoToken: "secret-token" });
    expect(calls[0].url).toBe("https://stats.example.com/matomo/index.php");
    expect(calls.every((call) => !call.url.includes("secret-token") && new URLSearchParams(call.body).get("token_auth") === "secret-token")).toBe(true);
    expect(report).toMatchObject({ totals: { views: 7, visitors: 2 }, countries: [{ name: "DE", count: 2 }] });
    const refusing = matomo({ url: "https://stats.example.com", fetcher: recordingFetch(() => ({ result: "error", message: "token secret-token is wrong" })).fetcher });
    await expect(refusing.report!(range, { provider: "matomo", matomoSiteId: "1", matomoToken: "secret-token" })).rejects.toThrow(/^Matomo refused [\w.]+\.$/);
  });
});
