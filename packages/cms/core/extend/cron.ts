export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const BOUNDS: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function parseField(text: string, [min, max]: [number, number]) {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) throw new Error(`Invalid cron term "${part}".`);
    const step = match[2] === undefined ? 1 : Number(match[2]);
    const [from, to] = match[1] === "*" ? [min, max] : match[1].includes("-") ? match[1].split("-").map(Number) : [Number(match[1]), match[2] === undefined ? Number(match[1]) : max];
    if (step < 1 || from < min || to > max || from > to) throw new Error(`Cron term "${part}" is out of range.`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

/** Five fields, with `*`, lists, ranges and steps. Sunday is 0 or 7. */
export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron expression "${expression}" needs five fields.`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((part, index) => parseField(part, BOUNDS[index]));
  if (dayOfWeek.delete(7)) dayOfWeek.add(0);
  return { minute, hour, dayOfMonth, month, dayOfWeek, domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

/** In UTC. As in standard cron, when both day fields are restricted either one matching is enough. */
export function cronMatches(cron: Cron, date: Date) {
  if (!cron.minute.has(date.getUTCMinutes()) || !cron.hour.has(date.getUTCHours()) || !cron.month.has(date.getUTCMonth() + 1)) return false;
  const dom = cron.dayOfMonth.has(date.getUTCDate());
  const dow = cron.dayOfWeek.has(date.getUTCDay());
  return cron.domAny || cron.dowAny ? dom && dow : dom || dow;
}

const MINUTE = 60_000;
/** How far back a missed run is still made up. Further back than this, the job just waits for its next time. */
export const CATCH_UP_MS = 7 * 86_400_000;

/** The latest minute, at or before `now` and after `since`, that the cron matches. */
export function lastMatch(cron: Cron, now: Date, since: number) {
  const from = Math.max(since, now.getTime() - CATCH_UP_MS);
  for (let minute = Math.floor(now.getTime() / MINUTE) * MINUTE; minute > from; minute -= MINUTE) {
    if (cronMatches(cron, new Date(minute))) return new Date(minute);
  }
  return null;
}

/**
 * Which jobs should start now: those with a matching minute since their last run, so a
 * server or a cron trigger that comes by late still runs each one once. A job with no run
 * yet counts from the start of this minute: it runs if this minute matches, and otherwise
 * waits for its next time.
 */
export function dueJobs<T extends { name: string; cron: string }>(jobs: T[], lastRuns: ReadonlyMap<string, Date>, now: Date) {
  const thisMinute = Math.floor(now.getTime() / MINUTE) * MINUTE;
  return jobs.filter((job) => lastMatch(parseCron(job.cron), now, lastRuns.get(job.name)?.getTime() ?? thisMinute - 1) !== null);
}
