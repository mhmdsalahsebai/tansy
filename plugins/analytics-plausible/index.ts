import { breakdown, defineAnalyticsProvider, fillDays, num, originOf, requestJson, str, type AnalyticsSettings, type ReportRange } from "@tansy/analytics/provider";

export interface PlausibleOptions {
  /** A self-hosted Plausible's address. plausible.io when left out. */
  host?: string;
  /** The site's domain as Plausible knows it, until one is saved in the settings. */
  domain?: string;
  /** For tests: called instead of fetch. */
  fetcher?: typeof fetch;
}

const domain = (settings: AnalyticsSettings) => str(settings.plausibleDomain);
const apiKey = (settings: AnalyticsSettings) => str(settings.plausibleApiKey);

interface QueryResult { results?: Array<{ metrics?: unknown[]; dimensions?: unknown[] }> }

/** Plausible: no cookies, nothing personal, and EU-hosted. */
export const plausible = ({ host = "https://plausible.io", domain: defaultDomain = "", fetcher }: PlausibleOptions = {}) => {
  const origin = originOf(host, "Plausible's host");

  /** One query to the Stats API v2. */
  const query = (settings: AnalyticsSettings, range: ReportRange, metrics: string[], dimensions: string[] = [], limit?: number) =>
    requestJson<QueryResult>(`${origin}/api/v2/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey(settings)}`, "content-type": "application/json" },
      body: JSON.stringify({ site_id: domain(settings), metrics, dimensions, date_range: [range.from, range.to], ...(limit ? { order_by: [[metrics[0], "desc"]], pagination: { limit } } : {}) }),
    }, fetcher).then((answer) => answer.results ?? []);

  const rows = (results: QueryResult["results"] & object) => results.map((row) => ({ name: row.dimensions?.[0], count: row.metrics?.[0] }));

  return defineAnalyticsProvider({
    id: "plausible",
    label: "Plausible",
    messages: {
      ar: {
        settings: {
          plausibleDomain: { label: "النطاق في Plausible", description: "نطاق الموقع كما أضفته في Plausible، مثل example.com." },
          plausibleApiKey: { label: "مفتاح Stats API في Plausible", description: "اختياري، لعرض الأرقام هنا. من Plausible ← الإعدادات ← API Keys." },
        },
      },
    },
    settings: () => [
      { name: "plausibleDomain", type: "text", default: defaultDomain, maxLength: 200, label: "Plausible domain", description: "The site's domain as you added it in Plausible, such as example.com." },
      { name: "plausibleApiKey", type: "secret", env: "PLAUSIBLE_API_KEY", label: "Plausible Stats API key", description: "Optional, to show the numbers here. From Plausible → Settings → API Keys." },
    ],
    ready: (settings) => /^[a-z0-9.-]+(\/[\w.-]+)?$/i.test(domain(settings)),
    reportReady: (settings) => Boolean(apiKey(settings)),
    // The manual script, so the tracker reports moves between pages that don't reload.
    tracker: (settings) => ({
      script: `${origin}/js/script.manual.js`,
      attributes: { "data-domain": domain(settings) },
      global: "plausible",
      stubs: [{ type: "queue", name: "plausible", into: "plausible.q" }],
      pageview: [{ fn: "plausible", args: ["pageview", { u: "$url" }] }],
    }),
    async report(range, settings) {
      const [totals, daily, pages, sources, countries, devices, browsers] = await Promise.all([
        query(settings, range, ["pageviews", "visitors"]),
        query(settings, range, ["pageviews", "visitors"], ["time:day"]),
        query(settings, range, ["pageviews"], ["event:page"], 10),
        query(settings, range, ["visitors"], ["visit:source"], 10),
        query(settings, range, ["visitors"], ["visit:country"], 10),
        query(settings, range, ["visitors"], ["visit:device"], 10),
        query(settings, range, ["visitors"], ["visit:browser"], 10),
      ]);
      const days = new Map(daily.map((row) => [String(row.dimensions?.[0] ?? "").slice(0, 10), { views: num(row.metrics?.[0]), visitors: num(row.metrics?.[1]) }]));
      return {
        totals: { views: num(totals[0]?.metrics?.[0]), visitors: num(totals[0]?.metrics?.[1]) },
        days: fillDays(range, days),
        pages: breakdown(rows(pages)),
        referrers: breakdown(rows(sources).filter((row) => row.name !== "Direct / None")),
        countries: breakdown(rows(countries)),
        devices: breakdown(rows(devices)),
        browsers: breakdown(rows(browsers)),
      };
    },
    dashboardUrl: (settings) => `${origin}/${encodeURIComponent(domain(settings))}`,
    csp: { connect: [origin] },
  });
};
