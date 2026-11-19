import { baseOf, breakdown, defineAnalyticsProvider, fillDays, num, requestJson, str, type AnalyticsSettings, type ReportRange } from "@tansy/analytics/provider";

export interface MatomoOptions {
  /** Your Matomo's address, self-hosted or in Matomo Cloud, such as https://example.matomo.cloud. */
  url: string;
  /** The site's id in Matomo, until one is saved in the settings. */
  siteId?: string;
  /** For tests: called instead of fetch. */
  fetcher?: typeof fetch;
}

const siteId = (settings: AnalyticsSettings) => str(settings.matomoSiteId);
const token = (settings: AnalyticsSettings) => str(settings.matomoToken);

type Row = Record<string, unknown>;

/** Matomo: open source, self-hosted or in its cloud, and without cookies if you choose. */
export const matomo = ({ url, siteId: defaultId = "", fetcher }: MatomoOptions) => {
  const base = baseOf(url, "Matomo's url");
  const origin = new URL(base).origin;

  /** One Reporting API call. The token goes in the body, never the address, so it stays out of logs. */
  async function call<T>(settings: AnalyticsSettings, method: string, range: ReportRange, period: "day" | "range", extra: Record<string, string> = {}): Promise<T> {
    const answer = await requestJson<T | { result?: string }>(`${base}/index.php`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ module: "API", format: "JSON", method, idSite: siteId(settings), period, date: `${range.from},${range.to}`, token_auth: token(settings), ...extra }),
    }, fetcher);
    if (answer && typeof answer === "object" && (answer as { result?: string }).result === "error") throw new Error(`Matomo refused ${method}.`);
    return answer as T;
  }

  const table = async (settings: AnalyticsSettings, range: ReportRange, method: string, count = "nb_visits", name: (row: Row) => unknown = (row) => row.label) => {
    const rows = await call<Row[]>(settings, method, range, "range", { filter_limit: "10", flat: "1", filter_sort_column: count, filter_sort_order: "desc" });
    return breakdown((Array.isArray(rows) ? rows : []).map((row) => ({ name: name(row), count: row[count] })));
  };

  return defineAnalyticsProvider({
    id: "matomo",
    label: "Matomo",
    messages: {
      ar: {
        settings: {
          matomoSiteId: { label: "معرّف الموقع في Matomo", description: "رقم من Matomo ← المشرف ← المواقع ← الإدارة، مثل 1." },
          matomoCookieless: { label: "دون ملفات تعريف الارتباط", description: "لا يضع Matomo ملفات تعريف ارتباط، فلا حاجة إلى موافقة الزوار في أغلب الحالات. يُعدّ الزائر العائد زائرًا جديدًا أحيانًا." },
          matomoToken: { label: "رمز المصادقة في Matomo", description: "اختياري، لعرض الأرقام هنا. من Matomo ← الإعدادات الشخصية ← الأمان ← رموز المصادقة، لمستخدم له صلاحية العرض." },
        },
      },
    },
    settings: () => [
      { name: "matomoSiteId", type: "text", default: defaultId, maxLength: 10, label: "Matomo site id", description: "A number, from Matomo → Administration → Websites → Manage, such as 1." },
      { name: "matomoCookieless", type: "boolean", default: true, label: "Without cookies", description: "Matomo sets no cookies, so most places need no consent from visitors. A returning visitor sometimes counts as new." },
      { name: "matomoToken", type: "secret", env: "MATOMO_TOKEN", label: "Matomo auth token", description: "Optional, to show the numbers here. From Matomo → Personal → Security → Auth tokens, for a user who may view the site." },
    ],
    ready: (settings) => /^\d{1,10}$/.test(siteId(settings)),
    reportReady: (settings) => Boolean(token(settings)),
    tracker: (settings) => ({
      script: `${base}/matomo.js`,
      stubs: [{ type: "array", name: "_paq" }],
      setup: [
        { fn: "_paq.push", args: [["setTrackerUrl", `${base}/matomo.php`]] },
        { fn: "_paq.push", args: [["setSiteId", siteId(settings)]] },
        ...(settings.matomoCookieless !== false ? [{ fn: "_paq.push", args: [["disableCookies"]] }] : []),
        { fn: "_paq.push", args: [["enableLinkTracking"]] },
      ],
      pageview: [
        { fn: "_paq.push", args: [["setReferrerUrl", "$referrer"]] },
        { fn: "_paq.push", args: [["setCustomUrl", "$url"]] },
        { fn: "_paq.push", args: [["setDocumentTitle", "$title"]] },
        { fn: "_paq.push", args: [["trackPageView"]] },
      ],
    }),
    async report(range, settings) {
      const [visits, actions, pages, referrers, countries, devices, browsers] = await Promise.all([
        call<Record<string, Row | unknown[]>>(settings, "VisitsSummary.get", range, "day"),
        call<Record<string, Row | unknown[]>>(settings, "Actions.get", range, "day"),
        table(settings, range, "Actions.getPageUrls", "nb_hits"),
        table(settings, range, "Referrers.getAll"),
        table(settings, range, "UserCountry.getCountry", "nb_visits", (row) => String(row.code ?? row.label ?? "").toUpperCase()),
        table(settings, range, "DevicesDetection.getType"),
        table(settings, range, "DevicesDetection.getBrowsers"),
      ]);
      // A day without visits is an empty list rather than an object.
      const field = (day: Row | unknown[] | undefined, name: string) => (day && !Array.isArray(day) ? num(day[name]) : 0);
      const days = new Map(Object.keys({ ...visits, ...actions }).map((date) => [date, { views: field(actions[date], "nb_pageviews"), visitors: field(visits[date], "nb_uniq_visitors") || field(visits[date], "nb_visits") }]));
      const series = fillDays(range, days);
      return {
        totals: { views: series.reduce((sum, day) => sum + day.views, 0), visitors: series.reduce((sum, day) => sum + day.visitors, 0) },
        days: series,
        pages,
        referrers,
        countries,
        devices,
        browsers,
      };
    },
    dashboardUrl: (settings) => `${base}/index.php?module=CoreHome&action=index&idSite=${encodeURIComponent(siteId(settings))}&period=day&date=today`,
    csp: { connect: [origin], img: [origin] },
  });
};
