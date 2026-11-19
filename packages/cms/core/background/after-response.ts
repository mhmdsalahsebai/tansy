import { after } from "next/server";
import type { JobRunInfo } from "../extend/define";
import { backgroundBudgetMs, backgroundMode } from "./mode";

const noLimit: JobRunInfo = { deadline: null, timeLeft: () => Infinity };

/**
 * Starts work that should carry on after the response, such as delivering what a write
 * queued. Where the host stops functions once they answer, as Vercel does, the function is
 * kept running until the work settles (Next.js's `after`, Vercel's `waitUntil`), and `pass`
 * says by when it must stop: whatever is left waits for the next background pass. On a server
 * that stays up the work simply runs, and `pass.deadline` is null. Outside a request, too.
 *
 * Errors are logged under `label`, never thrown.
 */
export function afterResponse(label: string, work: (pass: JobRunInfo) => Promise<unknown>): void {
  let pass = noLimit;
  if (backgroundMode() === "external") {
    const deadline = Date.now() + backgroundBudgetMs();
    pass = { deadline, timeLeft: () => Math.max(0, deadline - Date.now()) };
  }
  const running = Promise.resolve().then(() => work(pass)).catch((error: unknown) => console.error(`[${label}]`, error));
  try {
    after(running);
  } catch {
    // Not in a request, such as a job's or a timer's own write: nothing to keep alive.
  }
}
