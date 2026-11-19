import { createSign } from "node:crypto";
import { breakdown, defineAnalyticsProvider, fillDays, num, requestJson, str, type AnalyticsSettings, type ReportRange } from "@tansy/analytics/provider";

export interface GoogleAnalyticsOptions {
  /** The web stream's measurement id, such as G-XXXXXXXXXX, until one is saved in the settings. */
  measurementId?: string;
  /** The GA4 property's number, for the dashboard, until one is saved in the settings. */
  propertyId?: string;
  /** For tests: called instead of fetch. */
  fetcher?: typeof fetch;
}

const MEASUREMENT_ID = /^G-[A-Z0-9]{4,20}$/;
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const measurementId = (settings: AnalyticsSettings) => str(settings.googleMeasurementId).toUpperCase();
const propertyId = (settings: AnalyticsSettings) => str(settings.googlePropertyId).replace(/^properties\//, "");

interface ServiceAccount { client_email: string; private_key: string }

/** The service account's key file, as pasted into the setting. Null when it isn't one. */
function serviceAccount(settings: AnalyticsSettings): ServiceAccount | null {
  try {
    const parsed = JSON.parse(str(settings.googleServiceAccount)) as Partial<ServiceAccount>;
    return typeof parsed.client_email === "string" && typeof parsed.private_key === "string" ? { client_email: parsed.client_email, private_key: parsed.private_key } : null;
  } catch {
    return null;
  }
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** A signed request for an access token, as Google's OAuth for service accounts expects. */
export function serviceAccountAssertion(account: ServiceAccount, now = Math.floor(Date.now() / 1000)): string {
  const head = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
  const signature = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(account.private_key);
  return `${head}.${claims}.${base64url(signature)}`;
}

interface ReportRows { rows?: Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }> }

/** Google Analytics 4. It sets cookies unless cookieless is on, so most EU sites need visitors' consent. */
export const googleAnalytics = ({ measurementId: defaultId = "", propertyId: defaultProperty = "", fetcher }: GoogleAnalyticsOptions = {}) => {
  // One token at a time, shared by a report's parallel queries, until a minute before it expires.
  let token: { account: string; value: Promise<string>; expires: number } | null = null;

  function accessToken(account: ServiceAccount): Promise<string> {
    if (token && token.account === account.client_email && token.expires > Date.now() + 60_000) return token.value;
    const value = requestJson<{ access_token?: string; expires_in?: number }>(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: serviceAccountAssertion(account) }),
    }, fetcher).then((answer) => {
      if (!answer.access_token) throw new Error("Google gave no access token.");
      if (token?.value === value) token.expires = Date.now() + (answer.expires_in ?? 3600) * 1000;
      return answer.access_token;
    });
    token = { account: account.client_email, value, expires: Date.now() + 3_000_000 };
    // A failed request isn't kept, so the next report asks again.
    value.catch(() => { if (token?.value === value) token = null; });
    return value;
  }

  async function run(settings: AnalyticsSettings, range: ReportRange, metrics: string[], dimension?: string, limit?: number) {
    const account = serviceAccount(settings);
    if (!account) throw new Error("The service account key isn't a Google key file.");
    const answer = await requestJson<ReportRows>(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId(settings))}:runReport`, {
      method: "POST",
      headers: { authorization: `Bearer ${await accessToken(account)}`, "content-type": "application/json" },
      body: JSON.stringify({
        dateRanges: [{ startDate: range.from, endDate: range.to }],
        metrics: metrics.map((name) => ({ name })),
        ...(dimension ? { dimensions: [{ name: dimension }] } : {}),
        ...(limit ? { limit, orderBys: [{ metric: { metricName: metrics[0] }, desc: true }] } : {}),
      }),
    }, fetcher);
    return (answer.rows ?? []).map((row) => ({ name: row.dimensionValues?.[0]?.value, values: (row.metricValues ?? []).map((value) => num(value.value)) }));
  }

  const table = async (settings: AnalyticsSettings, range: ReportRange, dimension: string, metric = "totalUsers") =>
    breakdown((await run(settings, range, [metric], dimension, 11)).map((row) => ({ name: row.name, count: row.values[0] })));

  return defineAnalyticsProvider({
    id: "google",
    label: "Google Analytics",
    messages: {
      ar: {
        settings: {
          googleMeasurementId: { label: "معرّف القياس في Google Analytics", description: "من Google Analytics ← المشرف ← مصادر البيانات، لمصدر الويب. يبدأ بـ G-." },
          googleCookieless: { label: "دون ملفات تعريف الارتباط", description: "يرسل المشاهدات دون ملفات تعريف ارتباط، ويقدّر Google الباقي. لا حاجة عندها إلى موافقة الزوار في أغلب الحالات، والأرقام أقل دقة." },
          googlePropertyId: { label: "رقم الموقع (Property) في Google Analytics", description: "اختياري، لعرض الأرقام هنا. من المشرف ← إعدادات الموقع، مثل 123456789." },
          googleServiceAccount: { label: "مفتاح حساب الخدمة", description: "اختياري، لعرض الأرقام هنا. ملف JSON لحساب خدمة في Google Cloud مفعّل فيه Analytics Data API، ومضاف كمشاهد (Viewer) للموقع." },
        },
      },
    },
    settings: () => [
      { name: "googleMeasurementId", type: "text", default: defaultId, maxLength: 30, label: "Google Analytics measurement id", description: "From Google Analytics → Admin → Data streams, for the web stream. It starts with G-." },
      { name: "googleCookieless", type: "boolean", default: false, label: "Without cookies", description: "Sends page views without cookies, and Google models the rest. Most places then need no consent from visitors, and the numbers are less exact." },
      { name: "googlePropertyId", type: "text", default: defaultProperty, maxLength: 20, label: "Google Analytics property number", description: "Optional, to show the numbers here. From Admin → Property settings, such as 123456789." },
      { name: "googleServiceAccount", type: "secret", env: "GOOGLE_ANALYTICS_CREDENTIALS", label: "Service account key", description: "Optional, to show the numbers here. The JSON key of a Google Cloud service account with the Analytics Data API turned on, added to the property as a Viewer." },
    ],
    ready: (settings) => MEASUREMENT_ID.test(measurementId(settings)),
    reportReady: (settings) => /^\d{1,20}$/.test(propertyId(settings)) && serviceAccount(settings) !== null,
    tracker: (settings) => {
      const id = measurementId(settings);
      return {
        script: `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`,
        stubs: [{ type: "queue", name: "gtag", into: "dataLayer" }],
        setup: [
          ...(settings.googleCookieless === true ? [{ fn: "gtag", args: ["consent", "default", { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" }] }] : []),
          { fn: "gtag", args: ["js", "$now"] },
          // The tracker sends each page view itself, including moves between pages without a reload. Nothing for ads.
          { fn: "gtag", args: ["config", id, { send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false }] },
        ],
        pageview: [{ fn: "gtag", args: ["event", "page_view", { page_location: "$url", page_title: "$title", page_referrer: "$referrer" }] }],
      };
    },
    async report(range, settings) {
      const [totals, daily, pages, referrers, countries, devices, browsers] = await Promise.all([
        run(settings, range, ["screenPageViews", "totalUsers"]),
        run(settings, range, ["screenPageViews", "totalUsers"], "date"),
        table(settings, range, "pagePath", "screenPageViews"),
        table(settings, range, "sessionSource"),
        table(settings, range, "countryId"),
        table(settings, range, "deviceCategory"),
        table(settings, range, "browser"),
      ]);
      // GA writes days as YYYYMMDD.
      const days = new Map(daily.map((row) => [String(row.name ?? "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"), { views: row.values[0] ?? 0, visitors: row.values[1] ?? 0 }]));
      const known = (rows: typeof pages) => rows.filter((row) => !/^\(.+\)$/.test(row.name)).slice(0, 10);
      return {
        totals: { views: totals[0]?.values[0] ?? 0, visitors: totals[0]?.values[1] ?? 0 },
        days: fillDays(range, days),
        pages: known(pages),
        referrers: known(referrers),
        countries: known(countries),
        devices: known(devices),
        browsers: known(browsers),
      };
    },
    dashboardUrl: (settings) => (propertyId(settings) ? `https://analytics.google.com/analytics/web/#/p${propertyId(settings)}/reports/intelligenthome` : "https://analytics.google.com/"),
    csp: {
      connect: ["https://www.googletagmanager.com", "https://www.google-analytics.com", "https://region1.google-analytics.com", "https://analytics.google.com", "https://region1.analytics.google.com", "https://stats.g.doubleclick.net"],
      img: ["https://www.googletagmanager.com", "https://www.google-analytics.com"],
    },
  });
};
