import "server-only";
import prisma from "../../lib/prisma";
import { backupJobs } from "../backup/job";
import { dueJobs } from "./cron";
import { extensionContext } from "./hooks";
import { extensionJobs } from "./registry";
import type { JobDefinition, JobRunInfo } from "./define";
import type { Registered } from "./registry";
import { withScope } from "../scope/context";
import { everyScopeValue, scopeProvider } from "../scope/provider";
import { ScopeError } from "../scope/plugin";

const running = new Set<string>();

/** A run marked running this long ago was cut off, by a crash or a host's time limit, and no longer holds its job. */
const ABANDONED_MS = 30 * 60_000;

/** Core's own jobs, beside the plugins'. */
export function systemJobs(): Array<Registered<JobDefinition>> {
  return backupJobs();
}

const noLimit = { deadline: null, timeLeft: () => Infinity } satisfies JobRunInfo;
const runInfo = (deadline: number | null): JobRunInfo => (deadline === null ? noLimit : { deadline, timeLeft: () => Math.max(0, deadline - Date.now()) });

export interface RunDueJobsOptions {
  /** When this pass must be done. Handlers see it, so a long job can stop in time and carry on in its next run. */
  deadline?: number | null;
  /** Resolve once the jobs started here have finished, as a host that stops the function after the response needs. */
  wait?: boolean;
}

/**
 * Starts each job that has come due since its last run, once, even if several of its times
 * went by. A job still running isn't started again, on this server or another: each claims
 * its run by moving its stored last run on from the value it read, and only one can.
 */
export async function runDueJobs(now = new Date(), options: RunDueJobsOptions = {}) {
  const registered = [...extensionJobs(), ...systemJobs()];
  const sourceOf = new Map(registered.map(({ source, value }) => [value.name, source]));
  const jobs = registered.map(({ value }) => value).filter((job) => !running.has(job.name));
  if (!jobs.length) return;
  const stored = new Map((await prisma.jobRun.findMany({ where: { name: { in: jobs.map((job) => job.name) } } })).map((run) => [run.name, run]));
  // A job seen for the first time is written down now, so a trigger that comes by after its time still finds the run it missed.
  const startOfMinute = new Date(Math.floor(now.getTime() / 60_000) * 60_000 - 1);
  for (const job of jobs.filter((entry) => !stored.has(entry.name))) {
    const row = { name: job.name, lastRunAt: startOfMinute, status: "waiting", error: null, durationMs: null };
    try {
      await prisma.jobRun.create({ data: row });
      stored.set(job.name, row);
    } catch {
      // Another server wrote it first.
      const written = await prisma.jobRun.findUnique({ where: { name: job.name } });
      if (written) stored.set(job.name, written);
    }
  }
  const free = jobs.filter((job) => {
    const run = stored.get(job.name);
    return run && !(run.status === "running" && now.getTime() - run.lastRunAt.getTime() < ABANDONED_MS);
  });
  const due = dueJobs(free, new Map([...stored].map(([name, run]) => [name, run.lastRunAt])), now);
  const info = runInfo(options.deadline ?? null);
  const started: Array<Promise<void>> = [];
  for (const job of due) {
    // Recorded before it starts, so a crash mid-run can't repeat it for the same time.
    const claimed = await prisma.jobRun.updateMany({ where: { name: job.name, lastRunAt: stored.get(job.name)!.lastRunAt }, data: { lastRunAt: now, status: "running", error: null, durationMs: null } });
    if (!claimed.count) continue;
    running.add(job.name);
    started.push(execute(job, sourceOf.get(job.name) ?? "system", info).finally(() => running.delete(job.name)));
  }
  if (options.wait) await Promise.allSettled(started);
}

async function execute(job: JobDefinition, source: string, info: JobRunInfo) {
  const begin = Date.now();
  let result: { status: string; error: string | null };
  try {
    await runJob(job, source, info);
    result = { status: "success", error: null };
  } catch (error) {
    console.error(`[jobs] ${job.name}`, error);
    result = { status: "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) };
  }
  await prisma.jobRun.update({ where: { name: job.name }, data: { ...result, durationMs: Date.now() - begin } }).catch((error) => console.error(`[jobs] ${job.name}`, error));
}

/**
 * Once in the runner's own context, then, for a `perScope` job, once in each scope value. One
 * value failing doesn't stop the others. The run fails with the first error.
 *
 * With a scope provider, a `perScope` job's first run is in no value rather than across every
 * one, so it never handles a value's records with the instance's settings before that value's
 * own run. There a scoped collection has no records: a handler stopped by one (SCOPE_REQUIRED)
 * has nothing more to do, which isn't a failure.
 */
/** Every pass starts with the next value, so with a deadline the same one isn't always first. */
const rotate = <T>(list: T[], by: number) => (list.length ? [...list.slice(by % list.length), ...list.slice(0, by % list.length)] : list);

/** The least a value is given, so a long job can still get something done in it. */
const MIN_SHARE_MS = 90_000;

/**
 * One value's part of a pass with a deadline: an even share of what's left among the values
 * still to run, so one value's long work can't use up the pass. What a value doesn't use
 * goes to those after it.
 */
export function shareOf(info: JobRunInfo, remaining: number, now = Date.now()): JobRunInfo {
  if (info.deadline === null || remaining <= 1) return info;
  const left = Math.max(0, info.deadline - now);
  const deadline = now + Math.min(left, Math.max(left / remaining, MIN_SHARE_MS));
  return { deadline, timeLeft: () => Math.max(0, deadline - Date.now()) };
}

async function runJob(job: JobDefinition, source: string, info: JobRunInfo) {
  if (!job.perScope || !scopeProvider()) {
    await job.handler(extensionContext(source), info);
    if (!job.perScope) return;
  } else {
    try {
      await withScope(null, () => job.handler(extensionContext(source), info));
    } catch (error) {
      if (!(error instanceof ScopeError)) throw error;
    }
  }
  let first: unknown = null;
  const values = rotate(await everyScopeValue(), Math.floor(Date.now() / 60_000));
  for (const [index, value] of values.entries()) {
    try {
      await withScope(value, () => job.handler(extensionContext(source), shareOf(info, values.length - index)));
    } catch (error) {
      console.error(`[jobs] ${job.name} in ${value}`, error);
      first ??= error instanceof Error ? new Error(`In ${value}: ${error.message}`) : error;
    }
  }
  if (first) throw first;
}

export const listJobRuns = () => prisma.jobRun.findMany();
