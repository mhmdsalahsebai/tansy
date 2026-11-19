import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, RecordValues } from "tansy/plugin";
import { DOMAINS } from "../../plugins/multi-tenant/domains";
import { expireInvitations, planOf, PLANS, recheckDomains, resumeTenant, runDuePurges, schedulePurge, scopeLimitsOf, setLimits, suspendTenant } from "../../plugins/multi-tenant/lifecycle";
import { findTenant, INVITATIONS, MEMBERS, ORGANIZATIONS } from "../../plugins/multi-tenant/tenants";

const dns = { proof: true };
const hasProof = async () => dns.proof;


/** A records store that understands the few filters the lifecycle writes: `a = "x"`, `a != null`, joined by `||`. */
function fakeContext() {
  const tables = new Map<string, RecordValues[]>();
  let next = 1;
  const rows = (slug: string) => tables.get(slug) ?? tables.set(slug, []).get(slug)!;
  const matches = (row: RecordValues, filter: string) => !filter || filter.split(" || ").some((part) => {
    const [, field, op, raw] = /^(\w+) (=|!=) (null|"[^"]*")$/.exec(part.trim())!;
    const value = raw === "null" ? null : raw.slice(1, -1);
    const have = row[field] ?? null;
    return op === "=" ? have === value : have !== value;
  });
  const purged: string[] = [];
  const forgotten: string[] = [];
  const records = {
    list: async (slug: string, query: { filter?: string; perPage?: number; page?: number }) => {
      const items = rows(slug).filter((row) => matches(row, query.filter ?? ""));
      const perPage = query.perPage ?? 30;
      const page = query.page ?? 1;
      return { items: items.slice((page - 1) * perPage, page * perPage), page, perPage, totalItems: items.length, totalPages: Math.max(1, Math.ceil(items.length / perPage)) };
    },
    create: async (slug: string, data: RecordValues) => {
      const row = { ...data, id: next++ };
      rows(slug).push(row);
      return row;
    },
    update: async (slug: string, id: number, patch: RecordValues) => {
      const row = rows(slug).find((item) => item.id === id)!;
      Object.assign(row, patch);
      return row;
    },
    delete: async (slug: string, id: number) => {
      tables.set(slug, rows(slug).filter((item) => item.id !== id));
    },
  };
  const context = {
    system: { records },
    scope: {
      forgetLimits: async (value: string) => { forgotten.push(value); },
      data: { purge: async (value: string) => { purged.push(value); return { records: 0, files: 0 }; } },
    },
  } as unknown as ExtensionContext;
  const tenant = async (id: string, status: "active" | "suspended" = "active") => {
    await records.create(ORGANIZATIONS, { authId: id, name: id, slug: id, organizationStatus: status });
    return (await findTenant(context, id))!;
  };
  return { context, records, rows, purged, forgotten, tenant };
}

let fake: ReturnType<typeof fakeContext>;
beforeEach(() => {
  fake = fakeContext();
  dns.proof = true;
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("tenant plans", () => {
  it("has no limits until some are set, and forgets core's cached ones when they change", async () => {
    expect(await planOf(fake.context, "t1")).toMatchObject({ id: null, records: null, storageBytes: null, members: null, requestsPerMinute: null, purgeAt: null });
    await setLimits(fake.context, "t1", { records: 10, storageBytes: 2048, members: 3, requestsPerMinute: 60 });
    expect(await scopeLimitsOf(fake.context, "t1")).toEqual({ records: 10, storageBytes: 2048, requestsPerMinute: 60 });
    expect(fake.forgotten).toEqual(["t1"]);
    await setLimits(fake.context, "t1", { records: null, storageBytes: null, members: null, requestsPerMinute: null });
    expect(fake.rows(PLANS)).toHaveLength(1);
    expect(await scopeLimitsOf(fake.context, "t1")).toEqual({ records: null, storageBytes: null, requestsPerMinute: null });
  });

  it("refuses an id that could change the filter", async () => {
    await expect(planOf(fake.context, `x" || organizationId != "`)).rejects.toThrow(/Not a tenant id/);
  });
});

describe("suspending and purging", () => {
  it("resuming a tenant calls off its purge", async () => {
    const tenant = await fake.tenant("t1");
    await suspendTenant(fake.context, tenant);
    expect((await findTenant(fake.context, "t1"))!.status).toBe("suspended");
    await schedulePurge(fake.context, "t1", 7, "staff");
    expect((await planOf(fake.context, "t1")).purgeAt).not.toBeNull();
    await resumeTenant(fake.context, tenant);
    expect((await findTenant(fake.context, "t1"))!.status).toBe("active");
    expect(await planOf(fake.context, "t1")).toMatchObject({ purgeAt: null, purgeRequestedBy: null });
  });

  it("purges only suspended tenants whose date has come, with everything the plugin kept for them", async () => {
    await fake.tenant("due", "suspended");
    await fake.tenant("later", "suspended");
    await fake.tenant("open");
    for (const id of ["due", "later", "open"]) {
      await fake.records.create(MEMBERS, { organizationId: id, userId: "u" });
      await fake.records.create(DOMAINS, { organizationId: id, host: `${id}.example.com` });
    }
    const now = new Date("2026-11-17T00:00:00Z");
    await fake.records.create(PLANS, { organizationId: "due", purgeAt: "2026-11-16T00:00:00.000Z" });
    await fake.records.create(PLANS, { organizationId: "later", purgeAt: "2026-11-20T00:00:00.000Z" });
    await fake.records.create(PLANS, { organizationId: "open", purgeAt: "2026-11-01T00:00:00.000Z" });
    await runDuePurges(fake.context, now);
    expect(fake.purged).toEqual(["due"]);
    expect(fake.rows(ORGANIZATIONS).map((row) => row.authId)).toEqual(["later", "open"]);
    expect(fake.rows(MEMBERS).map((row) => row.organizationId)).toEqual(["later", "open"]);
    expect(fake.rows(DOMAINS).map((row) => row.organizationId)).toEqual(["later", "open"]);
    expect(fake.rows(PLANS).map((row) => row.organizationId)).toEqual(["later", "open"]);
  });
});

describe("the jobs", () => {
  it("marks invitations past their date expired, and leaves the others", async () => {
    await fake.records.create(INVITATIONS, { invitationStatus: "pending", expiresAt: "2026-11-01T00:00:00.000Z" });
    await fake.records.create(INVITATIONS, { invitationStatus: "pending", expiresAt: "2026-12-01T00:00:00.000Z" });
    await expireInvitations(fake.context, new Date("2026-11-17T00:00:00Z"));
    expect(fake.rows(INVITATIONS).map((row) => row.invitationStatus)).toEqual(["expired", "pending"]);
  });

  it("keeps a domain through a short DNS outage, and un-verifies it after three days without proof", async () => {
    await fake.records.create(DOMAINS, { organizationId: "t1", host: "a.example.com", token: "tok", primary: true, verifiedAt: "2026-01-01T00:00:00.000Z" });
    const [domain] = fake.rows(DOMAINS);
    dns.proof = false;
    await recheckDomains(fake.context, "_cms", undefined, new Date("2026-11-10T00:00:00Z"), hasProof);
    expect(domain).toMatchObject({ failingSince: "2026-11-10T00:00:00.000Z", verifiedAt: "2026-01-01T00:00:00.000Z" });
    await recheckDomains(fake.context, "_cms", undefined, new Date("2026-11-12T00:00:00Z"), hasProof);
    expect(domain.verifiedAt).not.toBeNull();
    dns.proof = true;
    await recheckDomains(fake.context, "_cms", undefined, new Date("2026-11-12T01:00:00Z"), hasProof);
    expect(domain.failingSince).toBeNull();
    dns.proof = false;
    await recheckDomains(fake.context, "_cms", undefined, new Date("2026-11-13T00:00:00Z"), hasProof);
    await recheckDomains(fake.context, "_cms", undefined, new Date("2026-11-16T00:00:00Z"), hasProof);
    expect(domain).toMatchObject({ verifiedAt: null, primary: false, failingSince: null });
  });
});
