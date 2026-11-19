# Request logs plugin (`@tansy/request-logs`)

## What it does

It keeps one entry for every API request: when, the method, the path, the answer's status, how long it took, who made it, and the IP address and browser. It never keeps the query string, the body or any other header, because those can carry tokens.

Entries can go to one or more places at once:

| Where | How | Read on the dashboard |
|---|---|---|
| The database | On unless switched off under Settings | Yes, under **Request logs** |
| S3, R2, B2, MinIO, or any storage the CMS supports | `storageDestination(s3Storage({ ... }))` | No. One file of JSON lines a write, under `request-logs/YYYY/MM/DD/` |
| A log service: Axiom, Better Stack, Datadog, a Loki gateway, your own endpoint | `httpDestination({ url, headers })` | No. POSTed as JSON lines, or a JSON array with `format: "json"` |
| The server's output | `consoleDestination()` | No. One JSON line an entry, for Vercel, Fly, Docker or Kubernetes to collect |
| OpenTelemetry: Grafana, Honeycomb, Datadog, Axiom, a Collector | `otlpDestination()` from [`@tansy/logs-otlp`](logs-otlp.md) | No. OTLP log records over HTTP |
| Anything else | An object with `name`, `label` and `write(entries)` | No |

The audit log is separate and stays in core, always on. See the security model.

## Setting it up

```ts
import { consoleDestination, httpDestination, requestLogs, storageDestination } from "@tansy/request-logs";
import { s3Storage } from "tansy/storage";

requestLogs({
  destinations: [
    storageDestination(s3Storage({ name: "request-logs", endpoint, bucket: "my-logs", accessKeyId, secretAccessKey }), { label: "S3 (my-logs)" }),
    httpDestination({ url: "https://api.axiom.co/v1/datasets/requests/ingest", headers: { authorization: `Bearer ${process.env.AXIOM_TOKEN}` } }),
    consoleDestination(),
  ],
  database: true,     // the default for the setting below
  which: "all",       // or "writes", or "errors"
  retentionDays: 7,
});
```

The starter turns it on with `TANSY_PLUGIN_REQUEST_LOGS=true`. `REQUEST_LOGS_S3_BUCKET` adds a bucket, using the `S3_*` credentials unless `REQUEST_LOGS_S3_*` are set. `REQUEST_LOGS_HTTP_URL` and `REQUEST_LOGS_HTTP_TOKEN` add a log service, `REQUEST_LOGS_CONSOLE=true` adds the server's output, and `REQUEST_LOGS_OTLP=true` adds OpenTelemetry at the `OTEL_EXPORTER_OTLP_*` address.

## Settings

Under **Request logs → Settings**, without a rebuild:

- **Log API requests.** Off records nothing anywhere.
- **Which requests.** All of them, changes and errors, or errors only. Reads that worked are most requests and the least useful.
- **Keep them in the database.** Off sends them only to the destinations, and the dashboard page says so.
- **Also send them outside.** Shown when the code lists destinations.
- **Keep IP addresses.** Off leaves them out, in the database and in what's sent to destinations.
- **Keep browsers.** The user agent each request sent. Off leaves it out the same way. A site that turned off the old "Keep IP addresses and browsers" keeps neither until it changes this one.
- **Addresses not to log.** One path prefix a line. `/api/realtime` by default.
- **Keep entries here for (days).** 1 to 365, 7 by default. A job deletes older ones each night. Destinations keep theirs as long as they're set to.

## How it works

- Core calls the plugin's `onRequest` after every API response, with the entry and the plugin's context. The plugin only adds it to a queue in memory and returns, so logging never slows a request.
- Every 2 seconds, on each server, the queue is written: to the plugin's store in batches of up to 64 KB, keyed by time, and to each destination. A destination that fails keeps its entries for the next write. More than 5,000 waiting are dropped and counted in the server log.
- The dashboard reads batches newest first, a page at a time, filtered by method, path and status.
- Reading needs `ext.request-logs:read`. Superadmins have it. Give it to other roles under Roles. The old core permission `log:read` is gone, and the table `RequestLog` is dropped with its entries when you upgrade.
