---
title: "Analytics plugin (`@tansy/analytics`)"
description: "Most sites want to know how many people come, which pages they read and where they came from. Some owners want that without cookies or a consent banner. Others already use a service, most often Google Analytics, and…"
---

## 1. The approach

Most sites want to know how many people come, which pages they read and where they came from. Some owners want that without cookies or a consent banner. Others already use a service, most often Google Analytics, and want it on every page without editing the theme. The plugin does both:

- **The CMS's own count.** Every page reports itself to the CMS, which adds one to that day's counts. No cookies, no IP address, no browser fingerprint is ever stored, so it needs no consent banner in most places. The numbers are on the dashboard.
- **An outside service.** Plausible, Umami, Google Analytics, Fathom or Matomo, one adapter package each, as Email and CAPTCHA do. The plugin puts the service's script on every page and reports page views to it, including moves between pages that don't reload. When the service has an API and you give it a key, its numbers show on the dashboard too.

Both can run at once. A site with no provider packages still gets its own count.

| Package | Service | Tracker needs | Dashboard numbers need |
|---|---|---|---|
| `@tansy/analytics-plausible` | Plausible, cloud or self-hosted (`plausible({ host })`) | The site's domain | A Stats API key (`PLAUSIBLE_API_KEY`) |
| `@tansy/analytics-umami` | Umami Cloud, or self-hosted (`umami({ host })`) | The website id | An API key from Umami Cloud, or a sign-in token from a self-hosted Umami (`UMAMI_API_KEY`) |
| `@tansy/analytics-google` | Google Analytics 4 | The measurement id, `G-…` | The property number, and a service account's JSON key with the Analytics Data API on, added to the property as a Viewer (`GOOGLE_ANALYTICS_CREDENTIALS`) |
| `@tansy/analytics-fathom` | Fathom | The site id | An API key (`FATHOM_API_KEY`) |
| `@tansy/analytics-matomo` | Matomo, self-hosted or Matomo Cloud (`matomo({ url })`, required) | The site id | An auth token (`MATOMO_TOKEN`) |

```ts
// tansy.config.ts
import { analytics } from "@tansy/analytics";
import { googleAnalytics } from "@tansy/analytics-google";
import { plausible } from "@tansy/analytics-plausible";

plugins: [analytics({ providers: [plausible(), googleAnalytics()] })]
```

Then, under **Analytics → Settings**, choose the service and fill in its id, and its API key to see its numbers here. A self-hosted Plausible, Umami or Matomo takes its address in the options rather than the settings, because the Content Security Policy is built with it.

The starter turns it on with `TANSY_PLUGIN_ANALYTICS=true`, with every provider listed and none chosen, and takes `PLAUSIBLE_HOST`, `UMAMI_HOST` and `MATOMO_URL` for self-hosted ones.

## 2. Settings

| Setting | Default | |
|---|---|---|
| Count page views here | On, or `collect` in the options | The CMS's own count |
| Also send page views to | The first provider listed, `provider` in the options, or None | Shown when a provider package is installed |
| Addresses not to count | Empty | One per line. `/members` also covers `/members/…` but not `/membership` |
| Respect visitors who opt out | On | Global Privacy Control or Do Not Track keeps a visitor from the outside service. The CMS's own count identifies nobody, so it still counts them |
| Keep counts for (days) | 730, or `retentionDays` | Older days are deleted each night |
| Each provider's id, and API key | Empty | Keys are `secret` settings: encrypted, never shown again, and overridden by the environment variable above |

Google Analytics also has **Without cookies**, which sets Google's consent mode to denied, so GA sends cookieless pings and models the rest. Matomo's **Without cookies** is on by default.

Pages read the settings at most every 30 seconds, so a change reaches visitors within half a minute. The dashboard always reads them fresh.

## 3. The CMS's own count

The tracker posts `{ path, referrer, source, width }` to `POST /api/ext/analytics/hit` on each page view. The route:

1. drops it when counting is off, the address is excluded, or the user agent is a program (crawlers, link previews, uptime checks, headless browsers);
2. keeps the path without its query, the other site's host (or a campaign's `utm_source` or `ref`) as the referrer, the country only when a CDN in front of the site sends it as a header (`cf-ipcountry`, `x-vercel-ip-country` and others), the device from the screen's width, and the browser's family without its version;
3. tells a new visitor from a returning one by a hash of a random salt, the site's host, the visitor's address and user agent, as Plausible does. The salt and the hashes live only in memory and are replaced each day. Nothing about a visitor is ever written, and once the salt is gone no hash can be traced back to anyone.

Counts are added up in memory and written to the plugin's store every five seconds, one day per key. The CMS runs as one process, so one writer at a time is enough never to lose an update. A crash loses at most a few seconds of counts. A restart forgets who already came that day, so a visitor who comes back after it counts again once.

Each day keeps its 500 biggest pages, 200 referrers and 250 countries, and folds the rest into `(other)`. Visitors add up by day: someone who comes on two days is two visitors in a week's total. The dashboard says so.

## 4. On every page

The tracker is a component on every page of the site, through core's `everyPage` (C22): the plugin's server function returns what the browser needs for this page, and the render module's component of the same name gets it as props. It returns nothing on a preview, so an editor's previews never count.

What reaches the browser is plain data, checked by `checkedTracker` before every page:

- the provider's script, which must be https and on one of the origins the adapter declared in its `csp`;
- `data-` attributes for the script tag;
- stubs, such as `window._paq = []` or a `gtag` that pushes to `dataLayer`, set up before the script loads;
- calls on setup and on each page view, only to the provider's own global or its stubs, with JSON arguments where `"$url"`, `"$path"`, `"$title"`, `"$referrer"` and `"$now"` become the page's.

So a setting gone wrong can't load another script, or call anything else, on every page. No secret ever reaches it: API keys stay on the server, for the dashboard.

The script is trusted through the page's nonce, under `'strict-dynamic'`, as the CAPTCHA's is. Each adapter adds the origins its script sends to, and Google and Fathom's image beacons, to the Content Security Policy.

Each provider's automatic page views are turned off where it has a switch (Plausible's manual script, Umami's `data-auto-track`, Fathom's `data-auto`, GA's `send_page_view`), and the tracker reports each page view itself, so moves between pages without a reload count once, everywhere.

**Headless sites** put the tracker in their root layout. It fetches the same configuration from `GET /api/ext/analytics/tracker`, a public route returning exactly what every page already shows:

```tsx
import { AnalyticsTracker } from "@tansy/analytics/render";

<AnalyticsTracker api="https://cms.example.com/api" path={pathname} />
```

The site's origin must be listed under **Settings → Network → Trusted origins** for the page views to reach the CMS.

## 5. On the dashboard

**Analytics** in the navigation shows page views and visitors for the last 7, 30 or 90 days, a bar a day, and the top pages, referrers, countries, devices and browsers. With a provider whose API key is set, it shows the provider's numbers first, with a tab for the CMS's own while counting. A provider's numbers are cached for five minutes. A provider that can't be read says so, without taking the page down.

A **Visitors** widget on the dashboard's home shows the last seven days. Both need `ext.analytics:read`.

## 6. Routes

| Route | Access | |
|---|---|---|
| `POST /api/ext/analytics/hit` | Public, 60 a minute per address | Adds a page view. Answers 204 whether or not it counted, so it tells a caller nothing about the settings |
| `GET /api/ext/analytics/tracker` | Public | What the tracker loads. Never a key |
| `GET /api/ext/analytics/report?days=7\|30\|90&source=` | `ext.analytics:read` | The numbers, from the CMS's count or the provider |

## 7. Writing an adapter

An adapter is `defineAnalyticsProvider` from `@tansy/analytics/provider`: an `id`, its settings (each name starting with the id), `ready(settings)`, `tracker(settings)` returning the data above, and its `csp`. `report(range, settings)` and `reportReady(settings)` are optional: return totals, one entry a day, and top pages and referrers, with countries, devices and browsers if the API has them. `requestJson` makes requests with a timeout, no redirects, and errors that name the host and status only, never what the provider said, which may echo a key.

## With tenants

With the multi-tenant plugin (or another row scope provider), each tenant keeps its own data. Whether to collect, the provider and its settings, exclusions and opt-out can differ per tenant. Visits are counted and reported per tenant, and pruning runs in each one.
