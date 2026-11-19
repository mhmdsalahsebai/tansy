import "server-only";
import prisma from "../../lib/prisma";
import { runAuthMaintenance } from "../auth/maintenance";
import { getCmsConfig } from "../config";
import { runScheduledActions } from "../content/scheduler";
import { runHookDeliveries } from "../extend/hook-deliveries";
import { runDueJobs } from "../extend/jobs";
import { runWebhookDeliveries } from "../extend/webhooks";
import { unscoped } from "../scope/context";
import { runSearchQueue } from "../search/sync";
import { backgroundMode, type BackgroundMode } from "./mode";

/** Stored in JobRun under these names, which a job's own name can't take. */
const HEARTBEAT = "@background";
const LOCK = "@background-lock";
const MAINTENANCE = "@maintenance";
const MAINTENANCE_EVERY_MS = 3_600_000;

/** Steps aren't started this close to the deadline, and jobs are told to finish this much before it. */
const STEP_MARGIN_MS = 15_000;
const JOB_MARGIN_MS = 10_000;
/** Work this late means nothing is running it. */
const LATE_MS = 10 * 60_000;

type Trigger = "timers" | "endpoint";

/** Notes that background work ran, for the dashboard, which warns when it stops. */
export async function recordHeartbeat(trigger: Trigger, durationMs: number | null = null, error: string | null = null) {
  const data = { lastRunAt: new Date(), status: trigger, error, durationMs };
  await prisma.jobRun.upsert({ where: { name: HEARTBEAT }, create: { name: HEARTBEAT, ...data }, update: data });
}

/**
 * One pass at a time, across every server: two cron calls that overlap would otherwise both
 * pick up the same deliveries. A pass that was cut off frees the lock once its time is up.
 */
async function lock(budgetMs: number): Promise<Date | null> {
  const now = new Date();
  const held = await prisma.jobRun.findUnique({ where: { name: LOCK } });
  if (!held) {
    try {
      await prisma.jobRun.create({ data: { name: LOCK, lastRunAt: now, status: "running", error: null, durationMs: null } });
      return now;
    } catch {
      return null;
    }
  }
  if (held.status === "running" && now.getTime() - held.lastRunAt.getTime() < budgetMs + 60_000) return null;
  const claimed = await prisma.jobRun.updateMany({ where: { name: LOCK, lastRunAt: held.lastRunAt }, data: { lastRunAt: now, status: "running" } });
  return claimed.count ? now : null;
}

/** Housekeeping, at most hourly: the audit log's retention, unattached uploads, rate-limit rows. Passes run one at a time, so no claim is needed. */
async function maintenanceIfDue() {
  const last = await prisma.jobRun.findUnique({ where: { name: MAINTENANCE } });
  if (last && Date.now() - last.lastRunAt.getTime() < MAINTENANCE_EVERY_MS) return;
  const begin = Date.now();
  let error: string | null = null;
  try {
    await runAuthMaintenance();
  } catch (failure) {
    error = (failure instanceof Error ? failure.message : String(failure)).slice(0, 1000);
    throw failure;
  } finally {
    const data = { lastRunAt: new Date(begin), status: error ? "failed" : "success", error, durationMs: Date.now() - begin };
    await prisma.jobRun.upsert({ where: { name: MAINTENANCE }, create: { name: MAINTENANCE, ...data }, update: data });
  }
}

const unlock = (at: Date) => prisma.jobRun.updateMany({ where: { name: LOCK, lastRunAt: at }, data: { status: "idle", durationMs: Date.now() - at.getTime() } });

export type StepResult = "done" | "failed" | "skipped";

export interface BackgroundPass {
  ran: boolean;
  reason?: string;
  steps: Record<string, StepResult>;
  durationMs: number;
}

/**
 * Everything background work does, once, within `budgetMs`: schedules, hook and webhook
 * deliveries, the search queue, then due jobs, which are waited for and told the deadline.
 * What doesn't fit is picked up by the next pass, since all of it is kept in the database.
 */
export function runBackgroundPass({ budgetMs }: { budgetMs: number }): Promise<BackgroundPass> {
  // It acts on records by id across every row scope, as the timers do.
  return unscoped("background pass", async () => {
    const begin = Date.now();
    const deadline = begin + budgetMs;
    const at = await lock(budgetMs);
    if (!at) return { ran: false, reason: "Another pass is still running.", steps: {}, durationMs: 0 };
    const steps: Record<string, StepResult> = {};
    const step = async (name: string, work: () => Promise<unknown>) => {
      if (Date.now() > deadline - STEP_MARGIN_MS) return void (steps[name] = "skipped");
      try {
        await work();
        steps[name] = "done";
      } catch (error) {
        console.error(`[background] ${name}`, error);
        steps[name] = "failed";
      }
    };
    try {
      await step("schedules", () => runScheduledActions());
      await step("hooks", () => runHookDeliveries());
      await step("webhooks", () => runWebhookDeliveries());
      if (getCmsConfig().search) await step("search", () => runSearchQueue());
      await step("maintenance", () => maintenanceIfDue());
      await step("jobs", () => runDueJobs(new Date(), { deadline: deadline - JOB_MARGIN_MS, wait: true }));
    } finally {
      await unlock(at).catch((error) => console.error("[background] could not release the lock", error));
    }
    const failed = Object.keys(steps).filter((name) => steps[name] === "failed");
    const durationMs = Date.now() - begin;
    await recordHeartbeat("endpoint", durationMs, failed.length ? `Failed: ${failed.join(", ")}` : null).catch((error) => console.error("[background]", error));
    return { ran: true, steps, durationMs };
  });
}

export interface BackgroundStatus {
  mode: BackgroundMode;
  lastPass: { at: Date; trigger: string; durationMs: number | null; error: string | null } | null;
  /** Work that should have happened over ten minutes ago and hasn't. */
  late: { schedules: number; hooks: number; webhooks: number };
}

/** For the dashboard: how background work runs here, when it last did, and whether anything is waiting too long. */
export async function backgroundStatus(now = new Date()): Promise<BackgroundStatus> {
  const before = new Date(now.getTime() - LATE_MS);
  const [heartbeat, schedules, hooks, webhooks] = await Promise.all([
    prisma.jobRun.findUnique({ where: { name: HEARTBEAT } }),
    prisma.scheduledAction.count({ where: { at: { lt: before }, failedAt: null } }),
    prisma.hookDelivery.count({ where: { status: "pending", nextAttemptAt: { lt: before } } }),
    prisma.webhookDelivery.count({ where: { status: "pending", nextAttemptAt: { lt: before } } }),
  ]);
  return {
    mode: backgroundMode(),
    lastPass: heartbeat ? { at: heartbeat.lastRunAt, trigger: heartbeat.status, durationMs: heartbeat.durationMs, error: heartbeat.error } : null,
    late: { schedules, hooks, webhooks },
  };
}
