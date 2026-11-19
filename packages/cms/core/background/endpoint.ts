import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError } from "../http/errors";
import { backgroundBudgetMs, backgroundMode } from "./mode";
import { runBackgroundPass } from "./runner";

/** As long as Vercel asks for. A shorter one could be guessed. */
const MIN_SECRET = 16;

const digest = (text: string) => createHash("sha256").update(text).digest();

/**
 * The background endpoint's own check: `Authorization: Bearer <CRON_SECRET>`, which is what
 * Vercel Cron sends. Compared as hashes, in constant time.
 */
export function assertBackgroundCaller(authorization: string | null, env: Record<string, string | undefined> = process.env) {
  const secret = env.CRON_SECRET ?? "";
  if (secret.length < MIN_SECRET) throw new HttpError(503, "BACKGROUND_NOT_CONFIGURED", `Set CRON_SECRET to a random value of at least ${MIN_SECRET} characters.`);
  const given = /^Bearer (.+)$/.exec(authorization ?? "")?.[1] ?? "";
  if (!timingSafeEqual(digest(given), digest(secret))) throw new HttpError(401, "UNAUTHORIZED", "Send Authorization: Bearer <CRON_SECRET>.");
}

/** One pass of background work, for a cron service or `tansy tick`. */
export async function runFromEndpoint(authorization: string | null) {
  assertBackgroundCaller(authorization);
  // Two runners at once would deliver the same work twice. This server already has one.
  if (backgroundMode() === "timers") throw new HttpError(409, "BACKGROUND_ON_TIMERS", "This server runs background work on its own timers. Set TANSY_BACKGROUND=external on it to have this endpoint run it instead.");
  return runBackgroundPass({ budgetMs: backgroundBudgetMs() });
}
