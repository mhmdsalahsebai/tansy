import "server-only";
import { readFile } from "node:fs/promises";
import { getCmsConfig } from "../config";
import { syncCoreBlocks, syncPluginBlocks } from "../blocks/service";
import { registerSink } from "../realtime/hub";
import { applySchema, schemaDocument } from "../schema/portable";
import { backfillFieldStorage } from "../schema/service";
import { runFieldUpgrades } from "../fields/upgrades";
import { prepareSearch, runSearchQueue } from "../search/sync";
import { runHookDeliveries } from "./hook-deliveries";
import { runDueJobs } from "./jobs";
import { backgroundMode } from "../background/mode";
import { recordHeartbeat } from "../background/runner";
import { runScheduledActions } from "../content/scheduler";
import { runAuthMaintenance } from "../auth/maintenance";
import { runPluginMigrations, seedTheme } from "./lifecycle";
import { loadHookFiles, watchHookFiles } from "./loader";
import { assertConfiguredExtensions } from "./registry";
import { enqueueWebhooks, runWebhookDeliveries } from "./webhooks";
import { unscoped } from "../scope/context";
import { LOCK, onlyOneServer } from "../content/locks";

/** An operator's file, applied on every boot. Safe to repeat: it only changes what differs, and never loses data. */
async function replaySchemaFile() {
  const file = process.env.TANSY_SCHEMA_FILE;
  if (!file) return;
  const document = schemaDocument.parse(JSON.parse(await readFile(file, "utf8")));
  await applySchema(document, { actorId: null, confirm: false, deleteMissing: false });
  console.info(`[schema] applied ${file}`);
}

const logged = (label: string, work: () => Promise<unknown>) => () => void work().catch((error) => console.error(`[${label}]`, error));

/** A broken plugin, hook file or schema stops startup, so the server never runs with a rule or hook silently missing. */
export async function startExtensions() {
  try {
    assertConfiguredExtensions();
    // Servers starting together would each create the same collections and blocks, and all but one
    // would then fail on what the first made. One runs this; the rest wait and find it done.
    await onlyOneServer(LOCK.startup, async () => {
      await replaySchemaFile();
      await backfillFieldStorage();
      await (await import("../i18n/startup")).prepareLocalization();
      await syncCoreBlocks();
      await syncPluginBlocks((getCmsConfig().plugins ?? []).flatMap((plugin) => (plugin.blocks ?? []).map((block) => ({ ...block, source: plugin.name }))));
      await loadHookFiles({ strict: true });
      await runFieldUpgrades();
      await runPluginMigrations();
      await seedTheme();
    });
  } catch (error) {
    console.error("[extensions] could not start", error);
    process.exit(1);
  }
  watchHookFiles();
  // The write already queued its after-hooks in its own transaction. This only starts delivering them.
  // Sinks run in the writing request's scope. Deliveries act on records by id across scopes, as their timers do.
  registerSink("hooks", () => unscoped("hook deliveries", () => runHookDeliveries()));
  registerSink("webhooks", (event) => unscoped("webhook deliveries", () => enqueueWebhooks(event)));
  // The write queued its search changes in its own transaction. This only starts sending them.
  await prepareSearch().catch((error) => console.error("[search] could not check which engine indexed the records", error));
  if (getCmsConfig().search) registerSink("search", () => unscoped("search queue", () => runSearchQueue()));
  // Otherwise the background endpoint runs all of this when called (core/background).
  if (backgroundMode() === "timers") startTimers();
}

/** Background work on this process's own timers, for a server that stays up. */
function startTimers() {
  if (getCmsConfig().search) {
    const search = logged("search", () => runSearchQueue());
    search();
    setInterval(search, Number(process.env.SEARCH_TICK_MS) || 5_000).unref();
  }
  const jobs = logged("jobs", async () => {
    await recordHeartbeat("timers");
    await runDueJobs();
  });
  jobs();
  setInterval(jobs, Number(process.env.JOB_TICK_MS) || 30_000).unref();
  setInterval(logged("webhooks", () => runWebhookDeliveries()), Number(process.env.WEBHOOK_TICK_MS) || 5_000).unref();
  const hooks = logged("hooks", () => runHookDeliveries());
  hooks();
  setInterval(hooks, Number(process.env.HOOK_TICK_MS) || 5_000).unref();
  setInterval(logged("scheduler", () => runScheduledActions()), Number(process.env.SCHEDULE_TICK_MS) || 30_000).unref();
  setInterval(logged("maintenance", () => runAuthMaintenance()), Number(process.env.MAINTENANCE_TICK_MS) || 3_600_000).unref();
}
