import { z } from "zod";
import { definePlugin, defineRoute, mergeMessagesByLanguage, type CspAdditions, type ExtensionContext, type PluginSettingField, type PluginStore } from "tansy/plugin";
import { createCounter, dayKey, INDEX_KEY } from "./counter";
import { browserOf, cleanPath, countryOf, deviceOf, isBot, lastDays, readDay, referrerOf, reportFrom, today, type DayStats } from "./logic";
import { messages } from "./messages";
import type { AnalyticsProvider, AnalyticsSettings, ReportRange } from "./provider";
import { checkedTracker, excluded, type AnalyticsReport, type TrackerConfig } from "./tracker";

export type { AnalyticsProvider } from "./provider";
export type { AnalyticsReport, TrackerConfig } from "./tracker";

export interface AnalyticsOptions {
  /**
   * Outside services the site can send page views to, each from its own package, such as
   * `plausible()` from @tansy/analytics-plausible. Owners choose one under Analytics →
   * Settings. Without any, the CMS counts page views itself.
   */
  providers?: AnalyticsProvider[];
  /** Which of them is used until changed in the settings. The first when left out, "none" without any. */
  provider?: string;
  /** Whether the CMS counts page views itself until changed in the settings. On when left out. */
  collect?: boolean;
  /** How many days of the CMS's own counts to keep until changed in the settings. Two years when left out. */
  retentionDays?: number;
}

const PROVIDER_ID = /^[a-z][a-z0-9]{0,19}$/;
const PERMISSION = "ext.analytics:read";
const RANGES = [7, 30, 90] as const;
/** The CMS's own count, as a report source. */
const OWN = "cms";

const optionsSchema = z.strictObject({
  providers: z.array(z.object({ id: z.string().regex(PROVIDER_ID, "A provider's id is lowercase letters and digits."), label: z.string().min(1) }).loose()),
  provider: z.string(),
  collect: z.boolean(),
  retentionDays: z.number().int().min(30).max(3650),
}).superRefine((value, issues) => {
  const ids = value.providers.map((provider) => provider.id);
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice) issues.addIssue({ code: "custom", path: ["providers"], message: `The provider "${twice}" is listed twice.` });
  if (ids.includes(OWN) || ids.includes("none")) issues.addIssue({ code: "custom", path: ["providers"], message: `A provider can't be called "${OWN}" or "none".` });
  if (value.provider !== "none" && !ids.includes(value.provider)) issues.addIssue({ code: "custom", path: ["provider"], message: `"${value.provider}" isn't one of the providers listed.` });
});

/**
 * Every setting's name starts with its provider's id, so two providers can't claim one. Each
 * tenant, with a scope provider, has its own site at the service, so they're per scope value
 * unless the provider says otherwise.
 */
function providerSettings(providers: AnalyticsProvider[]) {
  return providers.flatMap((provider) => provider.settings().map((field) => {
    if (!field.name.startsWith(provider.id)) throw new Error(`Analytics provider "${provider.id}": the setting "${field.name}" must start with "${provider.id}".`);
    return { ...field, perScope: field.perScope ?? true };
  }));
}

/** Every installed provider's origins, as the provider can change without a rebuild. */
function cspOf(providers: AnalyticsProvider[]): CspAdditions {
  const all = (key: keyof CspAdditions) => [...new Set(providers.flatMap((provider) => provider.csp[key] ?? []))];
  return { frame: all("frame"), connect: all("connect"), img: all("img") };
}

const sharedSettings = (value: z.output<typeof optionsSchema>, providers: AnalyticsProvider[]): PluginSettingField[] => [
  { name: "collect", type: "boolean", default: value.collect, perScope: true, label: "Count page views here", description: "Counts views, visitors, pages and where visitors came from, with no cookies and nothing that could identify anyone. Shown on the dashboard." },
  ...(providers.length ? [{ name: "provider", type: "select" as const, default: value.provider, perScope: true, label: "Also send page views to", description: "An analytics service of your own. Fill in its settings below. Until they're set, nothing is sent to it.", options: [{ value: "none", label: "None" }, ...providers.map((provider) => ({ value: provider.id, label: provider.label }))] }] : []),
  { name: "exclude", type: "text", default: "", perScope: true, multiline: true, maxLength: 2000, label: "Addresses not to count", description: "One per line, such as /members. Each counts with everything under it." },
  { name: "respectOptOut", type: "boolean", default: true, perScope: true, label: "Respect visitors who opt out", description: "Visitors whose browser sends Global Privacy Control or Do Not Track aren't sent to the outside service. The count here identifies no one, so it still counts them." },
  { name: "retentionDays", type: "number", default: value.retentionDays, min: 30, max: 3650, integer: true, label: "Keep counts for (days)", description: "Older days are deleted each night." },
];

const SETTINGS_TTL_MS = 30_000;
const REPORT_TTL_MS = 5 * 60_000;

/**
 * Page views, counted by the CMS with no cookies and nothing personal kept, or sent to
 * Plausible, Umami, Google Analytics, Fathom or Matomo through adapter packages, with the
 * numbers on the dashboard. See docs/plugins/analytics.md.
 */
export function analytics(options: AnalyticsOptions = {}) {
  const providers = options.providers ?? [];
  const value = optionsSchema.parse({ providers, provider: providers[0]?.id ?? "none", collect: true, retentionDays: 730, ...Object.fromEntries(Object.entries(options).filter(([, option]) => option !== undefined)) });
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const csp = cspOf(providers);

  // The store the counter writes to: the plugin's own, from whichever context last ran.
  let store: PluginStore | null = null;
  const counter = createCounter(() => {
    if (!store) throw new Error("[analytics] No store yet.");
    return store;
  });

  // Read on every page and page view, so kept for a little while there: a change reaches pages
  // within half a minute. The dashboard reads them fresh. One entry per scope value, as each
  // tenant can have its own.
  const cached = new Map<string, { at: number; settings: AnalyticsSettings }>();
  async function settingsOf(context: ExtensionContext, { fresh = false } = {}): Promise<AnalyticsSettings> {
    store = context.store;
    const key = context.scope.value() ?? "";
    const hit = cached.get(key);
    if (!fresh && hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.settings;
    const settings = { provider: "none", ...(await context.settings.get()) } as AnalyticsSettings;
    if (cached.size > 1000) cached.clear();
    cached.set(key, { at: Date.now(), settings });
    return settings;
  }

  const excludeOf = (settings: AnalyticsSettings) => String(settings.exclude ?? "").split(/\r?\n/).map((line) => cleanPath(line.trim())).filter((path): path is string => path !== null && path !== "/");

  /** The outside provider in use, once its settings are complete. */
  const activeProvider = (settings: AnalyticsSettings) => {
    const provider = byId.get(settings.provider);
    return provider?.ready(settings) ? provider : null;
  };

  async function trackerConfig(context: ExtensionContext): Promise<TrackerConfig | null> {
    const settings = await settingsOf(context);
    const provider = activeProvider(settings);
    let tracker: TrackerConfig["provider"] = null;
    if (provider) {
      try {
        tracker = checkedTracker(provider.id, provider.tracker(settings), provider.csp.connect ?? []);
      } catch (error) {
        console.error(`[analytics] ${provider.id}: tracker failed`, error);
      }
    }
    const collect = settings.collect === true;
    if (!collect && !tracker) return null;
    return { collect, provider: tracker, exclude: excludeOf(settings), respectOptOut: settings.respectOptOut !== false };
  }

  /** The CMS's own days in the range, with what's still in memory written first. */
  async function ownReport(context: ExtensionContext, range: ReportRange): Promise<AnalyticsReport> {
    store = context.store;
    await counter.flush().catch((error: unknown) => console.error("[analytics] counts couldn't be saved", error));
    const days = new Map<string, DayStats>();
    const dates = reportFrom(range, new Map()).days.map((day) => day.date);
    const stored = await Promise.all(dates.map((date) => context.store.get(dayKey(date))));
    dates.forEach((date, index) => { if (stored[index] !== null) days.set(date, readDay(stored[index])); });
    return reportFrom(range, days);
  }

  const reports = new Map<string, { at: number; report: AnalyticsReport }>();
  async function providerReport(provider: AnalyticsProvider, settings: AnalyticsSettings, range: ReportRange, scope: string): Promise<AnalyticsReport> {
    const key = `${scope}:${provider.id}:${range.from}:${range.to}`;
    const hit = reports.get(key);
    if (hit && Date.now() - hit.at < REPORT_TTL_MS) return hit.report;
    const report = await provider.report!(range, settings);
    if (reports.size > 50) reports.clear();
    reports.set(key, { at: Date.now(), report });
    return report;
  }

  /** Where the dashboard can read numbers from: the CMS's own count, and the provider when it has an API and a key. */
  function sourcesOf(settings: AnalyticsSettings) {
    const sources: Array<{ id: string; label: string; dashboardUrl: string | null }> = [];
    const provider = byId.get(settings.provider);
    if (provider?.report && provider.ready(settings) && (provider.reportReady?.(settings) ?? true)) sources.push({ id: provider.id, label: provider.label, dashboardUrl: provider.dashboardUrl?.(settings) ?? null });
    if (settings.collect === true || !sources.length) sources.push({ id: OWN, label: "", dashboardUrl: null });
    return sources;
  }

  return definePlugin({
    name: "analytics",
    version: "0.1.1",
    apiVersion: 1,
    requires: { cms: "^0.1.1" },
    admin: { server: "@tansy/analytics/admin", render: "@tansy/analytics/render" },
    options: { schema: optionsSchema, value },
    messages: mergeMessagesByLanguage(messages, ...providers.map((provider) => provider.messages)),
    permissions: { "ext.analytics": ["read"] },
    settings: { fields: [...sharedSettings(value, providers), ...providerSettings(providers)] },
    csp,
    everyPage: {
      // Editors' previews of unpublished content aren't visits.
      "analytics-tracker": async (context) => (context.page.preview ? null : trackerConfig(context)),
    },
    routes: [
      defineRoute({
        method: "POST",
        path: "/hit",
        access: "public",
        reason: "Every visitor's browser reports the page it opened, signed out. It adds one to the day's counts and keeps nothing about the visitor.",
        // A person opens a few pages a minute. A page reloaded on a loop gets cut off.
        rateLimit: { window: 60, max: 60 },
        body: z.object({ path: z.string().max(1000), referrer: z.string().max(2000).nullish(), source: z.string().max(100).nullish(), width: z.number().int().min(0).max(100_000).nullish() }),
        handler: async (context) => {
          const { body, request, ip } = context;
          const settings = await settingsOf(context);
          const done = new Response(null, { status: 204 });
          if (settings.collect !== true) return done;
          const userAgent = request.headers.get("user-agent");
          const path = cleanPath(body.path);
          if (isBot(userAgent) || !path || excluded(path, excludeOf(settings))) return done;
          const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
          counter.count(
            { path, referrer: referrerOf(body.referrer, body.source, host), country: countryOf(request.headers), device: deviceOf(body.width), browser: browserOf(userAgent!) },
            { site: host ?? "", ip, userAgent: userAgent! },
            context.scope,
          );
          return done;
        },
      }),
      defineRoute({
        method: "GET",
        path: "/tracker",
        access: "public",
        reason: "A headless site's pages load the tracker signed out. It's what every page already shows: the provider's public site id and script, never a key.",
        handler: async (context) => (await trackerConfig(context)) ?? { collect: false, provider: null, exclude: [], respectOptOut: true },
      }),
      defineRoute({
        method: "GET",
        path: "/report",
        access: "permission",
        permission: PERMISSION,
        query: z.object({ days: z.enum(RANGES.map(String) as ["7", "30", "90"]).default("30"), source: z.string().max(40).optional() }),
        handler: async (context) => {
          const settings = await settingsOf(context, { fresh: true });
          const sources = sourcesOf(settings);
          const source = sources.find((candidate) => candidate.id === context.query.source) ?? sources[0];
          const range = lastDays(Number(context.query.days));
          const provider = byId.get(source.id);
          let report: AnalyticsReport | null = null;
          let failed = false;
          try {
            report = provider ? await providerReport(provider, settings, range, context.scope.value() ?? "") : await ownReport(context, range);
          } catch (error) {
            console.error(`[analytics] ${source.id}: report failed`, error instanceof Error ? error.message : error);
            failed = true;
          }
          return { sources, source: source.id, range, report, failed, collecting: settings.collect === true, tracking: activeProvider(settings)?.label ?? null };
        },
      }),
    ],
    jobs: [
      {
        name: "analytics.flush",
        cron: "* * * * *",
        handler: async (context) => {
          store = context.store;
          await counter.flush();
        },
      },
      {
        name: "analytics.prune",
        cron: "17 3 * * *",
        // Each tenant keeps its own days, so each is pruned.
        perScope: true,
        handler: async (context) => {
          const settings = await settingsOf(context, { fresh: true });
          const keep = Math.max(30, Number(settings.retentionDays) || value.retentionDays);
          const cutoff = lastDays(keep).from;
          const index = await context.store.get(INDEX_KEY);
          const days = Array.isArray(index) ? index.filter((day): day is string => typeof day === "string") : [];
          const old = days.filter((day) => day < cutoff);
          if (!old.length) return;
          for (const day of old) await context.store.delete(dayKey(day));
          await context.store.set(INDEX_KEY, days.filter((day) => day >= cutoff || day === today()));
        },
      },
    ],
  });
}
