import { breakdown, defineAnalyticsProvider, fillDays, num, originOf, requestJson, str, type AnalyticsSettings, type ReportRange } from "@tansy/analytics/provider";

export interface UmamiOptions {
  /** A self-hosted Umami's address. Umami Cloud when left out. */
  host?: string;
  /** The website's id, until one is saved in the settings. */
  websiteId?: string;
  /** For tests: called instead of fetch. */
  fetcher?: typeof fetch;
}

const CLOUD = "https://cloud.umami.is";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const websiteId = (settings: AnalyticsSettings) => str(settings.umamiWebsiteId);
const apiKey = (settings: AnalyticsSettings) => str(settings.umamiApiKey);

type Value = number | { value?: unknown } | undefined;
const valueOf = (value: Value) => num(typeof value === "object" ? value?.value : value);

/** Umami: no cookies, open source, in its cloud or self-hosted. */
export const umami = ({ host = CLOUD, websiteId: defaultId = "", fetcher }: UmamiOptions = {}) => {
  const origin = originOf(host, "Umami's host");
  const cloud = origin === CLOUD;
  // Umami Cloud's API is on its own host and takes an API key. A self-hosted one takes a token.
  const api = cloud ? "https://api.umami.is/v1" : `${origin}/api`;

  const get = <T,>(settings: AnalyticsSettings, path: string, range: ReportRange, extra: Record<string, string> = {}) => {
    const query = new URLSearchParams({ startAt: String(Date.parse(`${range.from}T00:00:00Z`)), endAt: String(Date.parse(`${range.to}T23:59:59.999Z`)), ...extra });
    return requestJson<T>(`${api}/websites/${encodeURIComponent(websiteId(settings))}${path}?${query}`, {
      headers: { accept: "application/json", ...(cloud ? { "x-umami-api-key": apiKey(settings) } : { authorization: `Bearer ${apiKey(settings)}` }) },
    }, fetcher);
  };

  type Metric = Array<{ x?: unknown; y?: unknown }>;
  const metric = (settings: AnalyticsSettings, range: ReportRange, type: string) =>
    get<Metric>(settings, "/metrics", range, { type, limit: "10" }).then((rows) => breakdown(rows.map((row) => ({ name: row.x, count: row.y }))));

  return defineAnalyticsProvider({
    id: "umami",
    label: "Umami",
    messages: {
      ar: {
        settings: {
          umamiWebsiteId: { label: "معرّف الموقع في Umami", description: "من Umami ← الإعدادات ← المواقع ← تعديل. يشبه 4fb7fa4c-5b46-438d-94b3-3a8fb9bc2e8b." },
          umamiApiKey: { label: "مفتاح API في Umami", description: "اختياري، لعرض الأرقام هنا. مفتاح API من Umami Cloud، أو رمز دخول من Umami مستضاف ذاتيًا." },
        },
      },
    },
    settings: () => [
      { name: "umamiWebsiteId", type: "text", default: defaultId, maxLength: 36, label: "Umami website id", description: "From Umami → Settings → Websites → Edit. It looks like 4fb7fa4c-5b46-438d-94b3-3a8fb9bc2e8b." },
      { name: "umamiApiKey", type: "secret", env: "UMAMI_API_KEY", label: "Umami API key", description: "Optional, to show the numbers here. An API key from Umami Cloud, or a sign-in token from a self-hosted Umami." },
    ],
    ready: (settings) => UUID.test(websiteId(settings)),
    reportReady: (settings) => Boolean(apiKey(settings)),
    // Automatic tracking off, so a move between pages without a reload counts once, through the tracker.
    tracker: (settings) => ({
      script: `${origin}/script.js`,
      attributes: { "data-website-id": websiteId(settings), "data-auto-track": "false" },
      global: "umami",
      pageview: [{ fn: "umami.track" }],
    }),
    async report(range, settings) {
      const [stats, series, pages, referrers, countries, devices, browsers] = await Promise.all([
        get<{ pageviews?: Value; visitors?: Value }>(settings, "/stats", range),
        get<{ pageviews?: Array<{ x?: unknown; y?: unknown }>; sessions?: Array<{ x?: unknown; y?: unknown }> }>(settings, "/pageviews", range, { unit: "day", timezone: "UTC" }),
        // Umami 2 calls an address "url", later versions "path".
        metric(settings, range, "url").catch(() => metric(settings, range, "path")),
        metric(settings, range, "referrer"),
        metric(settings, range, "country"),
        metric(settings, range, "device"),
        metric(settings, range, "browser"),
      ]);
      const days = new Map<string, { views: number; visitors: number }>();
      const add = (rows: Array<{ x?: unknown; y?: unknown }> | undefined, field: "views" | "visitors") => {
        for (const row of rows ?? []) {
          const date = String(row.x ?? "").slice(0, 10);
          const day = days.get(date) ?? { views: 0, visitors: 0 };
          day[field] = num(row.y);
          days.set(date, day);
        }
      };
      add(series.pageviews, "views");
      add(series.sessions, "visitors");
      return {
        totals: { views: valueOf(stats.pageviews), visitors: valueOf(stats.visitors) },
        days: fillDays(range, days),
        pages,
        referrers,
        countries,
        devices,
        browsers,
      };
    },
    dashboardUrl: (settings) => `${origin}/websites/${encodeURIComponent(websiteId(settings))}`,
    csp: { connect: cloud ? [origin, "https://api-gateway.umami.dev"] : [origin] },
  });
};
