---
title: "OpenTelemetry logs plugin (`@tansy/logs-otlp`)"
description: "Sends a copy of the audit log, and if you want it the request log, over OpenTelemetry: OTLP over HTTP, with JSON. Grafana Cloud, Honeycomb, New Relic, SigNoz, Datadog, Axiom, Better Stack and any OpenTelemetry…"
---

Sends a copy of the audit log, and if you want it the request log, over OpenTelemetry: OTLP over
HTTP, with JSON. Grafana Cloud, Honeycomb, New Relic, SigNoz, Datadog, Axiom, Better Stack and any
OpenTelemetry Collector take it, and a Collector can pass it on to S3, Loki, Elasticsearch or a SIEM.

The database keeps its own copy of the audit log whatever this plugin does. The audit log can't be
turned off or moved out of the database, so nobody who can change settings can stop it. This plugin
only adds a copy outside.

## Setting it up

```ts
// tansy.config.ts
import { logsOtlp, otlpDestination } from "@tansy/logs-otlp";
import { requestLogs } from "@tansy/request-logs";

plugins: [
  // The audit log.
  logsOtlp({
    endpoint: "https://otlp-gateway-prod-eu-west-2.grafana.net/otlp",
    headers: { authorization: `Basic ${process.env.GRAFANA_OTLP_TOKEN}` },
    serviceName: "my-site",
  }),
  // The request log, as one of the request-logs plugin's destinations.
  requestLogs({ destinations: [otlpDestination()] }),
]
```

Every option can come from OpenTelemetry's own variables instead, so leaving them out works on a
host that already sets them:

| Option | Variable | |
|---|---|---|
| `endpoint` | `OTEL_EXPORTER_OTLP_ENDPOINT` | The base address. Logs go to its `/v1/logs`. `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is the full logs address and wins over the base one, as in OpenTelemetry. |
| `headers` | `OTEL_EXPORTER_OTLP_HEADERS` | `name=value,name=value`, values percent-encoded. For the backend's key. |
| `serviceName` | `OTEL_SERVICE_NAME` | `tansy` when neither is set. |
| `timeoutMs` | | 10 seconds a request. |

The address must use `http` or `https` and can't hold a user, password or query: keys go in
headers. Without an address the server doesn't start, rather than run with nothing being sent.

The starter turns it on with `TANSY_PLUGIN_LOGS_OTLP=true` for the audit log and
`REQUEST_LOGS_OTLP=true` for the request log (with `TANSY_PLUGIN_REQUEST_LOGS=true`), both reading
the `OTEL_*` variables.

## What is sent

Each entry is one OpenTelemetry log record, with the attribute names OpenTelemetry uses where there
is one:

| | Audit log | Request log |
|---|---|---|
| Time | When it was recorded | When the request came in |
| Body | The action, such as `settings.update` | `POST /api/records 201` |
| Severity | `INFO` for success, `WARN` for a failure or refusal | `INFO`, `WARN` from 400, `ERROR` from 500 |
| Attributes | `log.name` = `audit`, `event.name`, `tansy.audit.id`, `tansy.audit.outcome`, `tansy.scope`, `enduser.id`, `tansy.actor.email`, `tansy.actor.kind`, `tansy.target.type`, `tansy.target.id`, `client.address`, `user_agent.original`, `tansy.audit.metadata` (JSON) | `log.name` = `request`, `http.request.method`, `url.path`, `http.response.status_code`, `tansy.duration_ms`, `enduser.id`, `client.address`, `user_agent.original` |

Audit metadata arrives already sanitized by core, as it's stored: no key that looks like a password,
secret, token, code, key or cookie, and long strings cut short. The request log never holds a query
string, a body or any header but the user agent, and the request-logs plugin's switches for IP
addresses and browsers apply before anything is sent.

`tansy.audit.id` is unique for each entry and the same on every retry, so a backend that can drop
repeats will.

## Delivery

- **Audit log:** core hands each entry to the plugin after storing it, in the background, so a slow
  or failing backend never holds up a request. The plugin sends a batch every 2 seconds. While the
  backend is down it keeps the entries in memory and tries again after 5 seconds, then 30, 2 minutes
  and every 10 minutes, and logs the failure from the third one in a row. More than 10,000 waiting
  drops the oldest, counted in the server log. A restart during an outage loses what was waiting
  here; the database still has it.
- **Request log:** the request-logs plugin batches, retries and drops as described in
  [its page](/docs/plugins/request-logs).
- A refusal is reported by its status only, never by what the backend said back, which can quote
  the key. Redirects are refused.

## Limits to know

- One backend for the audit log. A Collector can fan it out to several.
- The audit log in memory is per server. Each server sends its own entries.
- Nothing is read back from the backend: the dashboard shows the audit log from the database, as
  before.
