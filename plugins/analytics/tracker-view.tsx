"use client";

import { useEffect, useRef, useState } from "react";
import { apiPath } from "tansy/react";
import { excluded, type ProviderTracker, type TrackerArg, type TrackerCall, type TrackerConfig } from "./tracker";

type Globals = Record<string, unknown>;
const win = () => window as unknown as Globals;

const scripts = new Map<string, Promise<void>>();
const setUp = new Set<string>();
/** The address of the last page view, the referrer of the next one within the site. */
let previous: string | null = null;
let lastSent = { href: "", at: 0 };

/**
 * Loads the provider's script once per page. Trusted through the page's nonce, under
 * 'strict-dynamic', as the CAPTCHA's is.
 */
function load(tracker: ProviderTracker): Promise<void> {
  let loading = scripts.get(tracker.script);
  if (!loading) {
    loading = new Promise<void>((resolve) => {
      const element = document.createElement("script");
      element.src = tracker.script;
      element.async = true;
      for (const [name, value] of Object.entries(tracker.attributes ?? {})) element.setAttribute(name, value);
      element.onload = () => resolve();
      // A blocker stopping the script is the visitor's choice: calls to it are dropped.
      element.onerror = () => resolve();
      document.head.appendChild(element);
    });
    scripts.set(tracker.script, loading);
  }
  return loading;
}

/** Creates the queues the script reads once it loads. */
function stub(tracker: ProviderTracker) {
  const globals = win();
  for (const item of tracker.stubs ?? []) {
    if (item.type === "array") {
      globals[item.name] ??= [];
      continue;
    }
    const [owner, property] = item.into.split(".");
    if (typeof globals[item.name] === "function") continue;
    globals[item.name] = function queue() {
      // eslint-disable-next-line prefer-rest-params -- gtag.js reads the arguments object itself.
      const args = arguments;
      const target = property ? ((globals[owner] as Globals)[property] ??= []) : (globals[owner] ??= []);
      (target as unknown[]).push(args);
    };
  }
}

/** The page's own values for the placeholders. */
function fill(arg: TrackerArg, page: Record<string, string>): unknown {
  if (typeof arg === "string") return arg === "$now" ? new Date() : Object.hasOwn(page, arg) ? page[arg] : arg;
  if (Array.isArray(arg)) return arg.map((item) => fill(item, page));
  if (arg && typeof arg === "object") return Object.fromEntries(Object.entries(arg).map(([name, value]) => [name, fill(value, page)]));
  return arg;
}

function resolve(fn: string): { call: (...args: unknown[]) => unknown; self: unknown } | null {
  const [name, property] = fn.split(".");
  const owner = win()[name];
  const target = property ? (owner as Globals | undefined)?.[property] : owner;
  return typeof target === "function" ? { call: target as (...args: unknown[]) => unknown, self: property ? owner : window } : null;
}

/** Calls now when the function is there, such as a stub, or once the script has loaded. */
async function run(tracker: ProviderTracker, calls: TrackerCall[], page: Record<string, string>) {
  for (const call of calls) {
    let target = resolve(call.fn);
    if (!target) {
      await load(tracker);
      target = resolve(call.fn);
    }
    try {
      target?.call.apply(target.self, (call.args ?? []).map((arg) => fill(arg, page)));
    } catch (error) {
      console.error("[analytics]", error);
    }
  }
}

const optedOut = () => {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string };
  return nav.globalPrivacyControl === true || nav.doNotTrack === "1" || (window as unknown as { doNotTrack?: string }).doNotTrack === "1";
};

function track(config: TrackerConfig, base: string) {
  const { href, pathname, search } = window.location;
  if (excluded(pathname, config.exclude)) return;
  // React runs effects twice while developing, and a page view is one visit.
  if (lastSent.href === href && Date.now() - lastSent.at < 1000) return;
  lastSent = { href, at: Date.now() };
  const referrer = previous ?? document.referrer;
  previous = href;

  if (config.collect) {
    const params = new URLSearchParams(search);
    void fetch(`${base}/ext/analytics/hit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: pathname, referrer: referrer || null, source: params.get("utm_source") ?? params.get("ref"), width: window.screen?.width ?? null }),
      keepalive: true,
      credentials: "omit",
    }).catch(() => {});
  }

  const tracker = config.provider;
  if (!tracker || (config.respectOptOut && optedOut())) return;
  const page = { $url: href, $path: pathname, $title: document.title, $referrer: referrer };
  const first = !setUp.has(tracker.id);
  setUp.add(tracker.id);
  if (first) stub(tracker);
  void (async () => {
    if (first) {
      await run(tracker, tracker.setup ?? [], page);
      void load(tracker);
    }
    await run(tracker, tracker.pageview, page);
  })();
}

export interface AnalyticsTrackerProps {
  /** What the plugin's `everyPage` gave this page. Without it, fetched from `api`. */
  config?: TrackerConfig | null;
  /** The CMS's API, such as https://cms.example.com/api, on a headless site. This app's own when left out. */
  api?: string;
  /** Raise a page view whenever it changes, such as your router's current path. */
  path?: string;
}

/**
 * Reports each page view to the CMS's own count and to the outside service chosen under
 * Analytics → Settings. Every page of a themed site has it already. A headless site puts
 * it in its root layout with `api` and the current `path`.
 */
export function AnalyticsTracker({ config: given, api, path }: AnalyticsTrackerProps) {
  const base = (api ?? apiPath("")).replace(/\/+$/, "");
  const [fetched, setFetched] = useState<TrackerConfig | null>(null);
  const config = given ?? fetched;

  useEffect(() => {
    if (given !== undefined) return;
    let live = true;
    fetch(`${base}/ext/analytics/tracker`, { credentials: "omit" })
      .then((response) => (response.ok ? response.json() : null))
      .then((value: TrackerConfig | null) => { if (live && value) setFetched(value); })
      .catch(() => {});
    return () => { live = false; };
  }, [base, given]);

  // The page's props are a new object on every render. Only a new address is a new page view.
  const latest = useRef(config);
  useEffect(() => { latest.current = config; });
  const ready = config !== null;
  useEffect(() => {
    if (ready && latest.current) track(latest.current, base);
  }, [ready, base, path]);

  return null;
}
