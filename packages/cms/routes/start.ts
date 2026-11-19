import type { CmsConfig } from "../core/auth/extensions";
import { provideCmsConfig } from "../core/config";

/**
 * Called once from the app's instrumentation.ts. Startup and the background work it schedules
 * (jobs, schedules, deliveries; see core/background) act on records by id across every row scope, so they run
 * unscoped (core/scope). Requests never do.
 */
export async function startCms(config: CmsConfig) {
  provideCmsConfig(config);
  const [{ unscoped }, { ensureScopeRegistry }, { scopeProvider }] = await Promise.all([import("../core/scope/context"), import("../core/scope/registry"), import("../core/scope/provider")]);
  // Throws when two plugins provide row scopes.
  scopeProvider();
  // Before anything reads a record table, which the scope plugin refuses until it knows which are scoped.
  await ensureScopeRegistry();
  await unscoped("startup and background work", () => start());
}

async function start() {
  const [{ announceSetup }, { prepareRecordsDb }, { exitIfStorageUnusable }, { startExtensions }, { backgroundMode }] = await Promise.all([
    import("../core/auth/setup"),
    import("../core/content/db"),
    import("../core/storage"),
    import("../core/extend/start"),
    import("../core/background/mode"),
  ]);
  try {
    console.info(`[background] ${backgroundMode() === "timers" ? "running on this server's timers" : "waiting for the background endpoint to be called (TANSY_BACKGROUND=external)"}`);
  } catch (error) {
    console.error(`[background] refusing to start: ${(error as Error).message}`);
    process.exit(1);
  }
  exitIfStorageUnusable();
  (await import("../core/backup/job")).exitIfBackupsUnusable();
  await prepareRecordsDb().catch((error) => console.error("[database] could not open the database", error));
  await import("../core/search").then(({ ensureSearchIndex }) => ensureSearchIndex()).catch((error) => console.error("[search] could not prepare the index", error));
  await startExtensions();
  await announceSetup().catch((error) => console.error("[setup] could not check first-run state", error));
}
