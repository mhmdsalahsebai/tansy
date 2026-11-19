import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobDefinition } from "@/core/extend/define";

/**
 * A plugin's store and jobs per scope value (C31): the store keeps each value's keys apart from
 * the instance's and from each other, and a `perScope` job runs once outside any value and once
 * in each. With the real store and runner, over an in-memory PluginData and JobRun.
 */

const db = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  runs: new Map<string, { name?: string; lastRunAt?: Date; status: string; error: string | null }>(),
  values: [] as string[],
  provided: true,
  jobs: [] as JobDefinition[],
}));

vi.mock("@/lib/prisma", () => {
  const id = (where: { plugin_key: { plugin: string; key: string } }) => `${where.plugin_key.plugin}|${where.plugin_key.key}`;
  return {
    default: {
      pluginData: {
        findUnique: async ({ where }: { where: { plugin_key: { plugin: string; key: string } } }) => (db.data.has(id(where)) ? { value: db.data.get(id(where)) } : null),
        upsert: async ({ where, create }: { where: { plugin_key: { plugin: string; key: string } }; create: { value: unknown } }) => void db.data.set(id(where), create.value),
        findMany: async ({ where }: { where: { plugin: string; key: { startsWith: string } } }) =>
          [...db.data].filter(([key]) => key.startsWith(`${where.plugin}|${where.key.startsWith}`)).map(([key, value]) => ({ key: key.split("|")[1], value })),
      },
      jobRun: {
        findMany: async () => [...db.runs.values()],
        findUnique: async ({ where }: { where: { name: string } }) => db.runs.get(where.name) ?? null,
        create: async ({ data }: { data: { name: string; lastRunAt: Date; status: string; error: string | null } }) => void db.runs.set(data.name, data),
        updateMany: async ({ where, data }: { where: { name: string; lastRunAt: Date }; data: { lastRunAt: Date; status: string; error: string | null } }) => {
          const row = db.runs.get(where.name);
          if (!row || row.lastRunAt?.getTime() !== where.lastRunAt.getTime()) return { count: 0 };
          db.runs.set(where.name, { ...row, ...data });
          return { count: 1 };
        },
        update: async ({ where, data }: { where: { name: string }; data: { status: string; error: string | null } }) => void db.runs.set(where.name, { ...db.runs.get(where.name)!, ...data }),
      },
    },
  };
});
vi.mock("@/core/extend/registry", () => ({ extensionJobs: () => db.jobs.map((value) => ({ source: "plugin:counter", value })) }));
vi.mock("@/core/backup/job", () => ({ backupJobs: () => [] }));
vi.mock("@/core/scope/provider", () => ({ everyScopeValue: async () => db.values, scopeProvider: () => (db.provided ? { plugin: "tenants", provider: {} } : null) }));
vi.mock("@/core/extend/hooks", async () => {
  const { pluginStore } = await import("@/core/extend/store");
  return { extensionContext: (source: string) => ({ store: pluginStore(source.replace(/^plugin:/, "")) }) };
});

const { pluginStore } = await import("@/core/extend/store");
const { runDueJobs } = await import("@/core/extend/jobs");
const { unscoped, withScope } = await import("@/core/scope/context");

const tick: JobDefinition["handler"] = async ({ store }) => void (await store.set("ticks", Number((await store.get("ticks")) ?? 0) + 1));
const run = async (job: JobDefinition) => {
  db.jobs = [job];
  await unscoped("test runner", () => runDueJobs(new Date("2026-11-16T12:00:00Z"), { wait: true }));
  const { status, error, durationMs } = db.runs.get(job.name) as { status: string; error: string | null; durationMs?: number };
  return { status, error, durationMs };
};

beforeEach(() => {
  db.data.clear();
  db.runs.clear();
  db.values = ["alpha", "beta"];
  db.provided = true;
});

describe("a plugin's store per scope value", () => {
  it("keeps each value's keys apart from the instance's and each other's", async () => {
    const store = pluginStore("counter");
    await store.set("visits", 1);
    await withScope("alpha", () => store.set("visits", 2));
    await withScope("beta", () => store.set("visits", 3));
    expect(await store.get("visits")).toBe(1);
    expect(await withScope("alpha", () => store.get("visits"))).toBe(2);
    expect(await withScope("beta", () => store.list(""))).toEqual([{ key: "visits", value: 3 }]);
    // Trusted work across every value reads the instance's, like work outside any.
    expect(await unscoped("test", () => store.get("visits"))).toBe(1);
    expect([...db.data.keys()].sort()).toEqual(["counter@alpha|visits", "counter@beta|visits", "counter|visits"]);
  });
});

describe("jobs per scope value", () => {
  it("runs a perScope job outside any value, then once in each", async () => {
    expect(await run({ name: "counter-tick", cron: "* * * * *", perScope: true, handler: tick })).toEqual({ status: "success", error: null, durationMs: expect.any(Number) });
    expect(Object.fromEntries(db.data)).toEqual({ "counter|ticks": 1, "counter@alpha|ticks": 1, "counter@beta|ticks": 1 });
  });

  it("runs a perScope job's first run in no value, where a scoped collection stopping it isn't a failure", async () => {
    const { currentScope } = await import("@/core/scope/context");
    const { ScopeError } = await import("@/core/scope/plugin");
    const seen: unknown[] = [];
    const handler: JobDefinition["handler"] = async (context, pass) => {
      seen.push(currentScope());
      if (currentScope()?.kind === "value" && (currentScope() as { value: string | null }).value === null) throw new ScopeError("scoped");
      await tick(context, pass);
    };
    expect((await run({ name: "counter-tick", cron: "* * * * *", perScope: true, handler }))?.status).toBe("success");
    expect(seen[0]).toEqual({ kind: "value", value: null });
    expect(Object.fromEntries(db.data)).toEqual({ "counter@alpha|ticks": 1, "counter@beta|ticks": 1 });
  });

  it("runs a perScope job as any other without a scope provider", async () => {
    db.provided = false;
    db.values = [];
    await run({ name: "counter-tick", cron: "* * * * *", perScope: true, handler: tick });
    expect(Object.fromEntries(db.data)).toEqual({ "counter|ticks": 1 });
  });

  it("runs any other job once, outside every value", async () => {
    await run({ name: "counter-tick", cron: "* * * * *", handler: tick });
    expect(Object.fromEntries(db.data)).toEqual({ "counter|ticks": 1 });
  });

  it("carries on past a value that fails, and fails the run with it", async () => {
    const handler: JobDefinition["handler"] = async (context, pass) => {
      if (await context.store.get("broken")) throw new Error("no luck");
      await tick(context, pass);
    };
    await withScope("alpha", () => pluginStore("counter").set("broken", true));
    const result = await run({ name: "counter-tick", cron: "* * * * *", perScope: true, handler });
    expect(result?.status).toBe("failed");
    expect(result?.error).toBe("In alpha: no luck");
    expect(db.data.get("counter@beta|ticks")).toBe(1);
    expect(db.data.has("counter@alpha|ticks")).toBe(false);
  });
});
