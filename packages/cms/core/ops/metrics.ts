import "server-only";
import prisma from "../../lib/prisma";
import { backgroundStatus } from "../background/runner";
import { currentScopeValue } from "../scope/context";
import { forbidden } from "../http/errors";
import { TANSY_VERSION } from "../version";

/**
 * What an operator needs to see from outside: the version, how long this process has been up,
 * and how much work is waiting. In Prometheus's text format, which every monitoring tool reads,
 * so core needs no vendor of its own (docs/guides/operations.md).
 *
 * These are counts of rows, never their contents, and the route that serves them needs
 * `setting:read`. Nothing here is per scope value: the numbers are the whole instance's, so a
 * tenant's caller is refused rather than shown another tenant's totals.
 */

interface Sample {
  labels?: Record<string, string>;
  value: number;
}

interface Metric {
  name: string;
  help: string;
  type: "gauge" | "counter";
  samples: Sample[];
}

/** A scrape every few seconds shouldn't mean a round of counts every few seconds. */
const CACHE_MS = 10_000;
let cached: { text: string; at: number } | null = null;

const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

function render(metrics: Metric[]) {
  const lines: string[] = [];
  for (const metric of metrics) {
    lines.push(`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`);
    for (const sample of metric.samples) {
      const labels = Object.entries(sample.labels ?? {}).map(([key, value]) => `${key}="${escape(value)}"`);
      lines.push(`${metric.name}${labels.length ? `{${labels.join(",")}}` : ""} ${sample.value}`);
    }
  }
  return lines.join("\n") + "\n";
}

const LATE_MINUTES = 10;

async function collect(now: Date): Promise<Metric[]> {
  const [status, hooks, webhooks, schedules, reviews, trashed, files] = await Promise.all([
    backgroundStatus(now),
    prisma.hookDelivery.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.webhookDelivery.groupBy({ by: ["status"], _count: { _all: true } }),
    Promise.all([
      prisma.scheduledAction.count({ where: { at: { lte: now }, failedAt: null } }),
      prisma.scheduledAction.count({ where: { failedAt: { not: null } } }),
    ]),
    prisma.reviewRequest.groupBy({ by: ["state"], _count: { _all: true } }),
    prisma.trashedRecord.count(),
    prisma.storedFile.aggregate({ _count: { _all: true }, _sum: { size: true } }),
  ]);

  const byStatus = (rows: { status: string; _count: { _all: number } }[]) =>
    rows.map((row) => ({ labels: { status: row.status }, value: row._count._all }));

  const lastPass = status.lastPass;
  return [
    { name: "cms_build_info", help: "The running version, as a label on a constant 1.", type: "gauge", samples: [{ labels: { version: TANSY_VERSION }, value: 1 }] },
    { name: "cms_uptime_seconds", help: "How long this process has been running.", type: "gauge", samples: [{ value: Math.round(process.uptime()) }] },
    {
      name: "cms_background_mode",
      help: "How background work runs here, as a label on a constant 1: timers on a server that stays up, or an endpoint a cron service calls.",
      type: "gauge",
      samples: [{ labels: { mode: status.mode }, value: 1 }],
    },
    {
      name: "cms_background_last_pass_age_seconds",
      help: "Since background work last ran. Absent until it has run once, and growing without bound means nothing is calling it.",
      type: "gauge",
      samples: lastPass ? [{ value: Math.max(0, Math.round((now.getTime() - lastPass.at.getTime()) / 1000)) }] : [],
    },
    {
      name: "cms_background_last_pass_failed",
      help: "1 when the last background pass reported a failed step.",
      type: "gauge",
      samples: lastPass ? [{ value: lastPass.error ? 1 : 0 }] : [],
    },
    {
      name: "cms_background_late",
      help: `Work that was due over ${LATE_MINUTES} minutes ago and still hasn't run. Anything above zero for long means background work isn't running.`,
      type: "gauge",
      samples: [
        { labels: { work: "schedules" }, value: status.late.schedules },
        { labels: { work: "hooks" }, value: status.late.hooks },
        { labels: { work: "webhooks" }, value: status.late.webhooks },
      ],
    },
    { name: "cms_hook_deliveries", help: "Record after-hook deliveries by status.", type: "gauge", samples: byStatus(hooks) },
    { name: "cms_webhook_deliveries", help: "Webhook deliveries by status.", type: "gauge", samples: byStatus(webhooks) },
    {
      name: "cms_scheduled_actions",
      help: "Scheduled publishes and unpublishes waiting: due and not yet run, or failed.",
      type: "gauge",
      samples: [
        { labels: { state: "due" }, value: schedules[0] },
        { labels: { state: "failed" }, value: schedules[1] },
      ],
    },
    {
      name: "cms_reviews",
      help: "Records waiting on a reviewer, by state.",
      type: "gauge",
      samples: reviews.map((row) => ({ labels: { state: row.state }, value: row._count._all })),
    },
    { name: "cms_trashed_records", help: "Deleted records still in the trash.", type: "gauge", samples: [{ value: trashed }] },
    { name: "cms_files", help: "Stored files.", type: "gauge", samples: [{ value: files._count._all }] },
    { name: "cms_file_bytes", help: "Bytes of stored files, as the file records report them.", type: "gauge", samples: [{ value: files._sum.size ?? 0 }] },
  ];
}

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/**
 * The instance's metrics. Refused inside a scope value, because the counts are the whole
 * instance's: a tenant's key would otherwise read every tenant's totals.
 */
export async function metricsText(now = new Date()) {
  if (currentScopeValue() !== null) throw forbidden();
  if (cached && now.getTime() - cached.at < CACHE_MS) return cached.text;
  const text = render(await collect(now));
  cached = { text, at: now.getTime() };
  return text;
}

/** Tests, and anything that changes what the numbers would say. */
export const forgetMetrics = () => {
  cached = null;
};
