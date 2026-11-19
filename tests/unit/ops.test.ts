import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What an operator sees from outside: liveness, readiness and the metrics. Over an in-memory
 * database, so this covers what each one says, and what it deliberately doesn't.
 */

const db = vi.hoisted(() => ({
  answers: true,
  storageUsable: true,
  scope: null as string | null,
  hooks: [] as Array<{ status: string; _count: { _all: number } }>,
  webhooks: [] as Array<{ status: string; _count: { _all: number } }>,
  reviews: [] as Array<{ state: string; _count: { _all: number } }>,
  schedulesDue: 0,
  schedulesFailed: 0,
  trashed: 0,
  files: { count: 0, bytes: 0 },
  lastPass: null as { at: Date; trigger: string; durationMs: number | null; error: string | null } | null,
  late: { schedules: 0, hooks: 0, webhooks: 0 },
}));

vi.mock("@/lib/prisma", () => ({
  default: {
    $queryRaw: async () => {
      if (!db.answers) throw new Error("the database is down");
      return [{ 1: 1 }];
    },
    hookDelivery: { groupBy: async () => db.hooks },
    webhookDelivery: { groupBy: async () => db.webhooks },
    reviewRequest: { groupBy: async () => db.reviews },
    scheduledAction: { count: async ({ where }: { where: { failedAt?: unknown } }) => (where.failedAt === null ? db.schedulesDue : db.schedulesFailed) },
    trashedRecord: { count: async () => db.trashed },
    storedFile: { aggregate: async () => ({ _count: { _all: db.files.count }, _sum: { size: db.files.bytes } }) },
  },
}));

vi.mock("@/core/storage", () => ({
  assertStorageUsable: () => {
    if (!db.storageUsable) throw new Error("local disk can't be used in production");
  },
}));

vi.mock("@/core/scope/context", () => ({ currentScopeValue: () => db.scope }));

vi.mock("@/core/background/runner", () => ({
  backgroundStatus: async () => ({ mode: "timers", lastPass: db.lastPass, late: db.late }),
}));

const { liveness, readiness } = await import("@/core/ops/health");
const { forgetMetrics, metricsText } = await import("@/core/ops/metrics");

beforeEach(() => {
  db.answers = true;
  db.storageUsable = true;
  db.scope = null;
  db.hooks = [];
  db.webhooks = [];
  db.reviews = [];
  db.schedulesDue = 0;
  db.schedulesFailed = 0;
  db.trashed = 0;
  db.files = { count: 0, bytes: 0 };
  db.lastPass = null;
  db.late = { schedules: 0, hooks: 0, webhooks: 0 };
  forgetMetrics();
});

describe("liveness", () => {
  it("says the server is up, and nothing a stranger could use", () => {
    const answer = liveness();
    expect(answer.status).toBe("ok");
    expect(answer.uptimeSeconds).toBeGreaterThanOrEqual(0);
    // No version: knowing the exact one tells a stranger which of its flaws to try.
    expect(Object.keys(answer).sort()).toEqual(["status", "uptimeSeconds"]);
  });
});

describe("readiness", () => {
  it("is ready when the database answers and storage can be used here", async () => {
    expect(await readiness()).toEqual({ ready: true, checks: { database: true, storage: true } });
  });

  it("is not ready when either fails, and says only which check, never why", async () => {
    db.answers = false;
    expect(await readiness()).toEqual({ ready: false, checks: { database: false, storage: true } });
    db.answers = true;
    db.storageUsable = false;
    const answer = await readiness();
    expect(answer).toEqual({ ready: false, checks: { database: true, storage: false } });
    expect(JSON.stringify(answer)).not.toContain("production");
  });
});

describe("metrics", () => {
  const value = (text: string, name: string) => text.split("\n").find((line) => line.startsWith(name) && !line.startsWith("#"));

  it("are Prometheus text, with help and a type for every metric", async () => {
    const text = await metricsText(new Date());
    for (const name of ["cms_build_info", "cms_uptime_seconds", "cms_background_mode", "cms_hook_deliveries", "cms_trashed_records", "cms_files", "cms_file_bytes"]) {
      expect(text, name).toContain(`# HELP ${name} `);
      expect(text, name).toContain(`# TYPE ${name} gauge`);
    }
    expect(text.endsWith("\n")).toBe(true);
    expect(value(text, "cms_build_info")).toMatch(/^cms_build_info\{version="\d+\.\d+\.\d+"\} 1$/);
  });

  it("count the work that is waiting, by status", async () => {
    db.hooks = [{ status: "pending", _count: { _all: 3 } }, { status: "failed", _count: { _all: 1 } }];
    db.webhooks = [{ status: "delivered", _count: { _all: 9 } }];
    db.reviews = [{ state: "pending", _count: { _all: 2 } }];
    db.schedulesDue = 4;
    db.schedulesFailed = 1;
    db.trashed = 7;
    db.files = { count: 12, bytes: 345 };
    db.late = { schedules: 2, hooks: 0, webhooks: 0 };
    const text = await metricsText(new Date());
    expect(text).toContain('cms_hook_deliveries{status="pending"} 3');
    expect(text).toContain('cms_hook_deliveries{status="failed"} 1');
    expect(text).toContain('cms_webhook_deliveries{status="delivered"} 9');
    expect(text).toContain('cms_reviews{state="pending"} 2');
    expect(text).toContain('cms_scheduled_actions{state="due"} 4');
    expect(text).toContain('cms_scheduled_actions{state="failed"} 1');
    expect(text).toContain('cms_background_late{work="schedules"} 2');
    expect(text).toContain("cms_trashed_records 7");
    expect(text).toContain("cms_files 12");
    expect(text).toContain("cms_file_bytes 345");
  });

  it("report how long ago background work ran, and leave it out until it has", async () => {
    const now = new Date("2026-11-17T12:00:00.000Z");
    // The help and type are always there; without a pass there is no number under them.
    expect(value(await metricsText(now), "cms_background_last_pass_age_seconds")).toBeUndefined();
    forgetMetrics();
    db.lastPass = { at: new Date(now.getTime() - 90_000), trigger: "timers", durationMs: 12, error: "Failed: hooks" };
    const text = await metricsText(now);
    expect(value(text, "cms_background_last_pass_age_seconds")).toBe("cms_background_last_pass_age_seconds 90");
    expect(value(text, "cms_background_last_pass_failed")).toBe("cms_background_last_pass_failed 1");
  });

  it("are held for a few seconds, so scraping often costs one round of counts", async () => {
    const now = new Date("2026-11-17T12:00:00.000Z");
    db.trashed = 1;
    expect(await metricsText(now)).toContain("cms_trashed_records 1");
    db.trashed = 2;
    expect(await metricsText(new Date(now.getTime() + 5_000))).toContain("cms_trashed_records 1");
    expect(await metricsText(new Date(now.getTime() + 11_000))).toContain("cms_trashed_records 2");
  });

  it("are the whole instance's, so a tenant's caller is refused rather than shown them", async () => {
    db.scope = "acme";
    await expect(metricsText(new Date())).rejects.toMatchObject({ status: 403 });
  });
});
