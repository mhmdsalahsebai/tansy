---
title: "Running it"
description: "What a load balancer, an orchestrator and a monitoring tool need from a running server. For the work that happens outside a request, see background work; for keeping the data, backups."
---

What a load balancer, an orchestrator and a monitoring tool need from a running server. For the
work that happens outside a request, see [background work](/docs/guides/background-work); for keeping the data,
[backups](/docs/guides/backups).

## Is it alive? Is it ready?

Two endpoints, both public, because the thing asking — Docker, Kubernetes, a load balancer, a
platform's health check — can't hold credentials.

| | `GET /api/health` | `GET /api/ready` |
| --- | --- | --- |
| Asks | Is this process alive? | Can it serve requests now? |
| Reads | Nothing | The database, and whether the storage adapter may run here |
| Answers | `200 {"status":"ok","uptimeSeconds":41}` | `200 {"ready":true,"checks":{…}}` or `503` with the same checks |
| Use it for | Restarting a stuck server | Taking a server out of rotation until it recovers |

Keep them apart: a server whose database is down shouldn't be restarted for a fault that isn't its
own, and a server that is starting up shouldn't take traffic. A failing check says only *which*
check failed, never why — the reason is in the server's log.

**What `ready` doesn't check**: the search engine, the mail transport, or a plugin's own outside
service. So a server whose search engine is down still reports ready, and serves reads from the
built-in index. Watch those services where they live, not here.

```yaml
# docker-compose, or any orchestrator that speaks HTTP.
healthcheck:
  test: ["CMD", "wget", "-qO-", "http://localhost:8090/api/ready"]
  interval: 10s
  timeout: 3s
  retries: 3
```

Neither endpoint names the version. Someone who knows the exact version knows which of its flaws to
try; `GET /api/metrics` and `tansy doctor` say it to whoever is entitled to ask.

First-run setup doesn't change either answer: a server waiting to be set up is alive and ready, since
it can already serve its setup page.

## Metrics

`GET /api/metrics` answers in Prometheus's text format, which every monitoring tool reads, so core
needs no vendor of its own. It needs **`setting:read`**, which an API key may hold on its own:

```sh
curl -H "x-api-key: $OPS_KEY" "$SITE/api/metrics"
```

```
cms_build_info{version="0.1.0"} 1
cms_uptime_seconds 1841
cms_background_mode{mode="timers"} 1
cms_background_last_pass_age_seconds 23
cms_background_last_pass_failed 0
cms_background_late{work="schedules"} 0
cms_hook_deliveries{status="pending"} 0
cms_webhook_deliveries{status="failed"} 2
cms_scheduled_actions{state="due"} 0
cms_reviews{state="pending"} 3
cms_trashed_records 11
cms_files 428
cms_file_bytes 91273441
```

What to watch, in order of how much it means:

- **`cms_background_late`** above zero for more than a few minutes: background work isn't running.
  Scheduled posts aren't going out, hooks and webhooks aren't being delivered. On a host that
  stops functions, check whatever calls `/api/background` ([background work](/docs/guides/background-work)).
- **`cms_background_last_pass_age_seconds`** growing without bound: the same fault, seen from the
  other side. It is absent until background work has run once.
- **`cms_webhook_deliveries{status="failed"}`** and **`cms_hook_deliveries{status="failed"}`**:
  deliveries that have given up. Their detail is in the dashboard.
- **`cms_file_bytes`** against what the storage costs.

They are counts of rows, never their contents. Scraping often is cheap: the numbers are counted at
most once every ten seconds and held between scrapes.

With a scope provider such as multi-tenancy, the numbers are the whole
instance's, so a request for one tenant is refused rather than shown another tenant's totals.

### Limits to know

- The search queue's depth isn't a metric yet; a search adapter's own dashboard shows it.
- There are no request counters or latency histograms. Those belong to whatever sits in front of
  the server, and per-request detail is the `request-logs` plugin's
  ([the Request logs plugin](/docs/plugins/request-logs)).
- Audit events are forwarded by a plugin's `onAudit`, not scraped from here: over OpenTelemetry,
  that's [`@tansy/logs-otlp`](/docs/plugins/logs-otlp).
- `/api/ready` reports on the database and the storage adapter only, as above.

Every boundary of this kind, across the whole CMS, is listed in [Limits and boundaries](/docs/guides/limits).

## Putting a CDN in front

Cache the assets, never the pages.

| Path | Cache |
| --- | --- |
| `/_next/static/*` | Freely, forever. The names carry a build hash. |
| `/api/files/*` | By its own headers. Thumbnails and files answer `private, max-age=300`, and a provider's signed URL goes straight to the provider. |
| Everything else | Not at all. Pages answer `Cache-Control: private, no-cache`, and the API answers `no-store`. |

A page can't be shared because it carries a Content Security Policy nonce that belongs to that
one request: a stored copy handed to someone else carries a nonce their policy doesn't list, so
the browser blocks every script on the page. The header says so, rather than leaving it to a
CDN's heuristics — if you override it, you will get blank pages that are hard to trace.

What takes the load off the database instead is the read cache inside the server: a page's reads
are held for `TANSY_SITE_CACHE_SECONDS` (30 by default, 0 turns it off), and a write drops only the
cached reads that touched the collection written. Several servers each keep their own, so one can
disagree with another for up to that long.

## Logs

Two different things, kept apart:

- **The audit log** (`/dashboard/audit`): one row per write, auth event and refused request. In core,
  kept for a year by default. A plugin forwards each entry somewhere else with `onAudit`, such as
  [`@tansy/logs-otlp`](/docs/plugins/logs-otlp) over OpenTelemetry. Repeated refusals from one
  caller at one address within a minute are folded into one entry that counts them.
- **The request log**: one row per API request, which is the `request-logs` plugin, with its own
  destinations.
