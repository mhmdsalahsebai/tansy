/**
 * How background work (jobs, schedules, hook and webhook deliveries, the search queue) is
 * started on this server.
 *
 * - "timers": this process runs it on its own timers. Right for a server that stays up.
 * - "external": no timers. Something calls the background endpoint instead: Vercel Cron, any
 *   cron service, `tansy tick`, or one server of the site that runs with "timers".
 *
 * `TANSY_BACKGROUND` picks one. Without it, hosts known to stop functions between requests get
 * "external", and everything else "timers".
 */
export type BackgroundMode = "timers" | "external";

const SERVERLESS = ["VERCEL", "AWS_LAMBDA_FUNCTION_NAME", "NETLIFY", "FUNCTIONS_WORKER_RUNTIME"];

export function backgroundMode(env: Record<string, string | undefined> = process.env): BackgroundMode {
  const chosen = env.TANSY_BACKGROUND?.trim().toLowerCase();
  if (chosen === "timers" || chosen === "external") return chosen;
  if (chosen) throw new Error(`TANSY_BACKGROUND must be "timers" or "external", not "${env.TANSY_BACKGROUND}".`);
  return SERVERLESS.some((name) => env[name]) ? "external" : "timers";
}

/** Four minutes: inside the five that Vercel and most hosts give a function by default. */
const DEFAULT_BUDGET_SECONDS = 240;

/** How long one call to the background endpoint may work. Keep it under the host's function time limit. */
export function backgroundBudgetMs(env: Record<string, string | undefined> = process.env) {
  const seconds = Number(env.TANSY_BACKGROUND_SECONDS);
  return (Number.isFinite(seconds) && seconds >= 10 ? Math.min(seconds, 3600) : DEFAULT_BUDGET_SECONDS) * 1000;
}
