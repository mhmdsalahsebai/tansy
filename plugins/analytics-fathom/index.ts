import { breakdown, defineAnalyticsProvider, fillDays, num, requestJson, str, type AnalyticsSettings, type ReportRange } from "@tansy/analytics/provider";

export interface FathomOptions {
  /** The site id, until one is saved in the settings. */
  siteId?: string;
  /** For tests: called instead of fetch. */
  fetcher?: typeof fetch;
}

const CDN = "https://cdn.usefathom.com";
const siteId = (settings: AnalyticsSettings) => str(settings.fathomSiteId).toUpperCase();
const apiKey = (settings: AnalyticsSettings) => str(settings.fathomApiKey);

type Row = Record<string, unknown>;

/** Fathom: no cookies, nothing personal. */
export const fathom = ({ siteId: defaultId = "", fetcher }: FathomOptions = {}) => {
  const aggregate = (settings: AnalyticsSettings, range: ReportRange, extra: Record<string, string> = {}) =>
    requestJson<Row[]>(`https://api.usefathom.com/v1/aggregations?${new URLSearchParams({
      entity: "pageview",
      entity_id: siteId(settings),
      aggregates: "pageviews,uniques",
      date_from: `${range.from} 00:00:00`,
      date_to: `${range.to} 23:59:59`,
      timezone: "UTC",
      ...extra,
    })}`, { headers: { authorization: `Bearer ${apiKey(settings)}`, accept: "application/json" } }, fetcher);

  const table = async (settings: AnalyticsSettings, range: ReportRange, field: string, by = "uniques") =>
    breakdown((await aggregate(settings, range, { field_grouping: field, sort_by: `${by}:desc`, limit: "10" })).map((row) => ({ name: row[field], count: row[by] })));

  return defineAnalyticsProvider({
    id: "fathom",
    label: "Fathom",
    messages: {
      ar: {
        settings: {
          fathomSiteId: { label: "معرّف الموقع في Fathom", description: "من Fathom ← الإعدادات ← المواقع. أحرف كبيرة، مثل ABCDEFGH." },
          fathomApiKey: { label: "مفتاح API في Fathom", description: "اختياري، لعرض الأرقام هنا. من Fathom ← الإعدادات ← API، بصلاحية القراءة." },
        },
      },
    },
    settings: () => [
      { name: "fathomSiteId", type: "text", default: defaultId, maxLength: 20, label: "Fathom site id", description: "From Fathom → Settings → Sites. Capital letters, such as ABCDEFGH." },
      { name: "fathomApiKey", type: "secret", env: "FATHOM_API_KEY", label: "Fathom API key", description: "Optional, to show the numbers here. From Fathom → Settings → API, allowed to read." },
    ],
    ready: (settings) => /^[A-Z0-9]{4,20}$/.test(siteId(settings)),
    reportReady: (settings) => Boolean(apiKey(settings)),
    // Automatic tracking off, so a move between pages without a reload counts once, through the tracker.
    tracker: (settings) => ({
      script: `${CDN}/script.js`,
      attributes: { "data-site": siteId(settings), "data-auto": "false" },
      global: "fathom",
      pageview: [{ fn: "fathom.trackPageview", args: [{ url: "$url", referrer: "$referrer" }] }],
    }),
    async report(range, settings) {
      const [totals, daily, pages, referrers, countries, devices, browsers] = await Promise.all([
        aggregate(settings, range),
        aggregate(settings, range, { date_grouping: "day" }),
        table(settings, range, "pathname", "pageviews"),
        table(settings, range, "referrer_hostname"),
        table(settings, range, "country_code"),
        table(settings, range, "device_type"),
        table(settings, range, "browser"),
      ]);
      const days = new Map(daily.map((row) => [String(row.date ?? "").slice(0, 10), { views: num(row.pageviews), visitors: num(row.uniques) }]));
      return {
        totals: { views: num(totals[0]?.pageviews), visitors: num(totals[0]?.uniques) },
        days: fillDays(range, days),
        pages,
        referrers,
        countries,
        devices,
        browsers,
      };
    },
    dashboardUrl: () => "https://app.usefathom.com/",
    csp: { connect: [CDN], img: [CDN] },
  });
};
