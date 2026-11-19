import { invalidateSiteCache } from "../site/cache";
import type { LifecycleData, LifecycleEvent } from "./define";
import { hooksFor } from "./registry";

/**
 * Tells hooks something has happened, after it has been committed. Never fails and
 * never waits, so a plugin can't slow or break what caused the event. Loaded lazily
 * because the hook runner reaches record code that imports these services.
 */
export function emitEvent<E extends LifecycleEvent>(event: E, data: LifecycleData[E]): void {
  if (event.startsWith("schema.")) invalidateSiteCache();
  try {
    if (!hooksFor(event).length) return;
  } catch (error) {
    console.error(`[hooks] ${event}`, error);
    return;
  }
  void import("./hooks")
    .then(({ runLifecycleHooks }) => runLifecycleHooks(event, data))
    .catch((error) => console.error(`[hooks] ${event}`, error));
}
