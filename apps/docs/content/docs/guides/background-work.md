---
title: "Background work"
description: "Some work happens outside any request: scheduled publishing, after-hooks, webhook deliveries, the search queue, backups, housekeeping, and plugins' jobs, such as newsletter sending and AI workflows. All of it is kept…"
---

Some work happens outside any request: scheduled publishing, after-hooks, webhook deliveries, the search queue, backups, housekeeping, and plugins' jobs, such as newsletter sending and AI workflows. All of it is kept in the database, so nothing is lost when a server stops. What changes from host to host is what starts it.

## On a server that stays up

Docker, a VPS, Railway, Render, Fly: nothing to set up. The server runs background work on its own timers.

Several servers behind a load balancer each run it too. Jobs and schedules are claimed in the database, so each runs once. To keep that work off the servers that answer visitors, set `TANSY_BACKGROUND=external` on those, and leave one server, which takes no traffic, on its timers.

## On Vercel, Netlify or Lambda

These stop a function once it has answered, so timers never fire. The CMS detects them and waits to be called instead. Background work then runs each time something calls `GET /api/background` with `Authorization: Bearer <CRON_SECRET>`. One call works for up to `TANSY_BACKGROUND_SECONDS`, 240 by default, then stops, and the next call carries on.

1. Set `CRON_SECRET` to a random value of at least 16 characters, such as the output of `openssl rand -base64 32`. `tansy init` writes one into a new `.env`.
2. Have something call the endpoint. Every few minutes is best: work waits until the next call, so a post scheduled for 9:00 goes out at the first call after 9:00.

### Vercel Cron

The starter's `vercel.json` already has one:

```json
{ "crons": [{ "path": "/api/background", "schedule": "0 5 * * *" }] }
```

Vercel sends `CRON_SECRET` itself. The Hobby plan runs a cron once a day at most, and refuses to deploy a more frequent one. On Pro, change the schedule to `* * * * *`. On Hobby, add one of the services below for anything that shouldn't wait a day.

### Any cron service

cron-job.org, EasyCron, Upstash QStash schedules, GitHub Actions and the like work the same way: a GET to `https://your-site/api/background` with the header `Authorization: Bearer <CRON_SECRET>`, every minute or every few. GitHub Actions runs schedules every five minutes at best, and sometimes later.

### `tansy tick`

Calls the endpoint from anywhere Node runs, such as a small container or a systemd timer:

```sh
CRON_SECRET=... npx tansy tick --url https://your-site --every 60
```

Without `--every` it calls once and exits, for the host's own cron.

## Long work

One call has a deadline, so long work goes in passes:

- Jobs see it as the handler's second argument. `deadline` is null on a server that stays up. Elsewhere, a job does what fits in `timeLeft()` and leaves the rest for its next run.
- AI workflows start no task with less than a minute left, cut a model call short at the deadline, and leave unfinished tasks for the next pass. A task cut off five times fails, because one call needs longer than the host allows. Raise `TANSY_BACKGROUND_SECONDS`, and the host's function limit with it.
- A job that missed its time runs once at the next call, up to seven days late.
- With a row scope provider, such as multi-tenant, a `perScope` job's pass is shared: each tenant gets an even part of what's left, at least 90 seconds, and the tenant that goes first changes every minute. One tenant's long run can't hold up the others.

## Right after a write

What a write queues, its after-hooks, webhooks and search changes, starts going out straight away rather than waiting for the next call. On Vercel the function stays up until it's done, through Next.js's `after`. A plugin does the same for its own work with `afterResponse` from `tansy/plugin`:

```ts
import { afterResponse } from "tansy/plugin";

afterResponse("my-plugin", async (pass) => {
  // pass.deadline: when to stop on a host with a time limit, or null.
});
```

The AI plugin starts a workflow run this way, and the newsletter a send.

## Settings

| Variable | |
|---|---|
| `TANSY_BACKGROUND` | `timers` or `external`. Detected when unset: `external` on Vercel, Netlify, Lambda and Azure Functions, `timers` elsewhere. |
| `CRON_SECRET` | What a caller of `/api/background` must send. The endpoint answers 503 without it. |
| `TANSY_BACKGROUND_SECONDS` | How long one call may work. Keep it under the host's function limit, which is 300 seconds by default on Vercel. |

On a server running its own timers, the endpoint answers 409, so two runners never deliver the same work twice.

## Is it running?

**Dashboard → Extensions** shows how background work runs here, when it last ran, and what has waited over ten minutes. It warns when the endpoint has never been called, or when work is falling behind.
