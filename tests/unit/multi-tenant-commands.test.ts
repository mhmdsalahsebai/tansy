import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PluginCommandContext } from "tansy/plugin";
import { tenantCommands } from "../../plugins/multi-tenant/commands";
import { tenantChecks } from "../../plugins/multi-tenant/doctor";

const [tenant] = tenantCommands();
const directory = mkdtempSync(path.join(tmpdir(), "cms-tenant-cli-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

class Failed extends Error {}

/** Stands in for what core gives a command: its own routes, and nothing else. */
function fakeContext(args: string[], flags: Record<string, string | boolean | undefined> = {}) {
  const lines: string[] = [];
  const sent: Array<{ path: string; method: string; body?: unknown; headers?: Record<string, string> }> = [];
  const answers = new Map<string, unknown>();
  const files = new Map<string, Buffer>();

  const context = {
    args,
    flags,
    log: (line: string) => { lines.push(line); },
    fail: (message: string) => { throw new Failed(message); },
    api: {
      url: "http://localhost:3000",
      request: async (target: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
        sent.push({ path: target, method: init.method ?? "GET", body: init.body, headers: init.headers });
        if (!answers.has(target)) throw new Failed(`nothing canned for ${target}`);
        return answers.get(target);
      },
      fetch: async (target: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
        sent.push({ path: target, method: init.method ?? "GET", headers: init.headers });
        const body = files.get(target);
        if (!body) return new Response("no", { status: 404 });
        return new Response(new Blob([body as unknown as BlobPart]).stream(), {
          status: 200,
          headers: { "content-type": "application/gzip", "content-disposition": 'attachment; filename="named-by-server.tar.gz"' },
        });
      },
    },
  } as unknown as PluginCommandContext;

  return { context, lines, sent, answers, files, run: () => tenant.run(context) as Promise<void> };
}

let fake: ReturnType<typeof fakeContext>;
beforeEach(() => { fake = fakeContext([]); });

describe("what cms tenant offers", () => {
  it("says what it is, and names itself for core's dispatch", () => {
    expect(tenant.name).toBe("tenant");
    expect(tenant.usage.startsWith("cms tenant ")).toBe(true);
    expect(tenant.describe.length).toBeGreaterThan(20);
  });

  /**
   * The line the commands are built on, as for the agent tools: a command is the API key's work, so
   * what a route guards with a recent sign-in has no command. The dashboard keeps those.
   */
  it("has no command for making a tenant, its limits or a purge", async () => {
    for (const action of ["create", "limits", "purge", "delete"]) {
      const asked = fakeContext([action, "t_1"]);
      await expect(asked.run()).rejects.toThrow(/Usage: tansy tenant/);
      // The refusal says where that work is done instead, rather than only that it is unknown.
      await expect(asked.run()).rejects.toThrow(/dashboard/);
      expect(asked.sent, action).toEqual([]);
    }
  });

  it("asks for an action rather than guessing one", async () => {
    await expect(fake.run()).rejects.toThrow(/Usage: tansy tenant/);
    expect(fake.sent).toEqual([]);
  });

  it("asks for the tenant's id where a command needs one, before sending anything", async () => {
    for (const action of ["show", "suspend", "resume", "export", "import"]) {
      const asked = fakeContext([action]);
      await expect(asked.run(), action).rejects.toThrow(`Usage: tansy tenant ${action} <tenant id>`);
      expect(asked.sent, action).toEqual([]);
    }
  });
});

describe("reading", () => {
  it("lists tenants as a table", async () => {
    const asked = fakeContext(["list"]);
    asked.answers.set("/tenants", { current: null, items: [
      { id: "t_acme", name: "Acme Supplies", slug: "acme", status: "active" },
      { id: "t_globex", name: "Globex", slug: "globex", status: "suspended" },
    ] });
    await asked.run();
    expect(asked.lines[0]).toMatch(/^ID\s+SHORT NAME\s+NAME\s+STATUS$/);
    expect(asked.lines[1]).toContain("t_acme");
    expect(asked.lines[1]).toContain("Acme Supplies");
    expect(asked.lines[2]).toContain("suspended");
  });

  it("says so plainly when the key sees no tenant", async () => {
    const asked = fakeContext(["list"]);
    asked.answers.set("/tenants", { current: null, items: [] });
    await asked.run();
    expect(asked.lines).toEqual(["This instance has no tenants the key can see."]);
  });

  it("shows one tenant's limits beside what it is using", async () => {
    const asked = fakeContext(["show", "t_acme"]);
    asked.answers.set("/tenants/t_acme/plan", {
      tenant: { id: "t_acme", name: "Acme Supplies", slug: "acme", status: "active" },
      limits: { records: 100, storageBytes: 5 * 1024 ** 2, members: null, requestsPerMinute: 60 },
      usage: { records: 12, storageBytes: 2 * 1024 ** 2, members: 3 },
      purgeAt: null,
    });
    await asked.run();
    const out = asked.lines.join("\n");
    expect(out).toContain("Acme Supplies (acme)");
    expect(out).toMatch(/Records\s+12\s+100/);
    expect(out).toMatch(/Files\s+2\.0 MiB\s+5\.0 MiB/);
    // No limit shows as a dash, not as "null" or "0".
    expect(out).toMatch(/Members\s+3\s+—/);
    expect(out).not.toContain("deleted at");
  });

  it("warns when a purge is waiting", async () => {
    const asked = fakeContext(["show", "t_acme"]);
    asked.answers.set("/tenants/t_acme/plan", {
      tenant: { id: "t_acme", name: "Acme", slug: "acme", status: "suspended" },
      limits: { records: null, storageBytes: null, members: null, requestsPerMinute: null },
      usage: { records: 0, storageBytes: 0, members: 1 },
      purgeAt: "2026-12-01T00:00:00.000Z",
    });
    await asked.run();
    expect(asked.lines.join("\n")).toContain("deleted at 2026-12-01T00:00:00.000Z unless it is resumed");
  });

  it("names the tenant in the header when listing domains, and prints the TXT record still needed", async () => {
    const asked = fakeContext(["domains"], { tenant: "t_acme" });
    asked.answers.set("/domains", { items: [
      { host: "acme.example", verified: true, primary: true, record: { name: "_cms-verification.acme.example", value: "proof-one" } },
      { host: "shop.acme.example", verified: false, primary: false, record: { name: "_cms-verification.shop.acme.example", value: "proof-two" } },
    ] });
    await asked.run();
    expect(asked.sent).toEqual([{ path: "/domains", method: "GET", body: undefined, headers: { "x-cms-tenant": "t_acme" } }]);
    const out = asked.lines.join("\n");
    expect(out).toMatch(/acme\.example\s+verified\s+yes/);
    // The proof is printed only for a claim that still needs it.
    expect(out).toContain("_cms-verification.shop.acme.example = proof-two");
    expect(out).not.toContain("proof-one");
  });

  it("asks which tenant's domains, since the route answers for the one being worked in", async () => {
    await expect(fakeContext(["domains"]).run()).rejects.toThrow(/--tenant <tenant id>/);
  });
});

describe("suspending and resuming", () => {
  it("posts to the tenant's own route and says what changed", async () => {
    const suspend = fakeContext(["suspend", "t_acme"]);
    suspend.answers.set("/tenants/t_acme/suspend", { id: "t_acme", name: "Acme", slug: "acme", status: "suspended" });
    await suspend.run();
    expect(suspend.sent).toEqual([{ path: "/tenants/t_acme/suspend", method: "POST", body: undefined, headers: undefined }]);
    expect(suspend.lines[0]).toContain("Acme is suspended");

    const resume = fakeContext(["resume", "t_acme"]);
    resume.answers.set("/tenants/t_acme/resume", { id: "t_acme", name: "Acme", slug: "acme", status: "active" });
    await resume.run();
    expect(resume.sent[0].path).toBe("/tenants/t_acme/resume");
    expect(resume.lines[0]).toContain("active again");
  });

  it("puts an id with odd characters in the path safely", async () => {
    const asked = fakeContext(["suspend", "a/b c"]);
    asked.answers.set("/tenants/a%2Fb%20c/suspend", { id: "x", name: "X", slug: "x", status: "suspended" });
    await asked.run();
    expect(asked.sent[0].path).toBe("/tenants/a%2Fb%20c/suspend");
  });
});

describe("export and import", () => {
  it("writes the archive under the name the server gave, and says what it holds", async () => {
    const asked = fakeContext(["export", "t_acme"], { out: path.join(directory, "acme.tar.gz") });
    asked.files.set("/tenants/t_acme/export", Buffer.from("archive bytes"));
    await asked.run();
    expect(readFileSync(path.join(directory, "acme.tar.gz"), "utf8")).toBe("archive bytes");
    expect(asked.lines[0]).toContain("acme.tar.gz");
    expect(asked.lines[0]).toContain("keep it as you would a backup");
  });

  it("takes the server's own filename when no --out says otherwise", async () => {
    const asked = fakeContext(["export", "t_acme"]);
    asked.files.set("/tenants/t_acme/export", Buffer.from("bytes"));
    const previous = process.cwd();
    process.chdir(directory);
    try {
      await asked.run();
      expect(statSync(path.join(directory, "named-by-server.tar.gz")).size).toBe(5);
    } finally {
      process.chdir(previous);
    }
  });

  it("reports the server's refusal rather than writing a broken file", async () => {
    const asked = fakeContext(["export", "t_missing"], { out: path.join(directory, "never.tar.gz") });
    await expect(asked.run()).rejects.toThrow(/answered 404/);
    expect(() => statSync(path.join(directory, "never.tar.gz"))).toThrow();
  });

  it("asks for the archive to send, and sends its bytes with a length", async () => {
    await expect(fakeContext(["import", "t_acme"]).run()).rejects.toThrow(/--in <archive>/);

    const archive = path.join(directory, "in.tar.gz");
    writeFileSync(archive, "twelve bytes");
    const asked = fakeContext(["import", "t_acme"], { in: archive });
    asked.files.set("/tenants/t_acme/import", Buffer.from("{}"));
    // The import answers with what it placed, so the fake stands in for that.
    asked.context.api.fetch = (async (target: string, init: { headers?: Record<string, string> } = {}) => {
      asked.sent.push({ path: target, method: "POST", headers: init.headers });
      return new Response(JSON.stringify({ records: 3, files: 1 }), { status: 200 });
    }) as typeof asked.context.api.fetch;
    await asked.run();
    expect(asked.sent[0].headers).toMatchObject({ "content-type": "application/gzip", "content-length": "12" });
    expect(asked.lines[0]).toBe("Placed 3 records and 1 files in t_acme.");
  });
});

describe("what tansy doctor says about tenants", () => {
  const options = { siteUrl: "https://cms.example", scopeNewCollections: true };
  const labels = (checks: Array<{ ok: boolean; label: string }>) => checks.filter((check) => !check.ok).map((check) => check.label);

  it("says nothing when the options are sound", () => {
    expect(labels(tenantChecks(options))).toEqual([]);
  });

  it("warns about a dashboard address nobody else can reach", () => {
    const [check] = tenantChecks({ ...options, siteUrl: "http://localhost:3000" });
    expect(check.ok).toBe(false);
    expect(check.warning).toBe(true);
    expect(check.fix).toContain("invitation emails link there");
  });

  it("fails a DNS server that isn't an address, and warns when it is this machine", () => {
    const bad = tenantChecks({ ...options, dnsServers: ["not a server"] });
    expect(labels(bad)).toContain("its DNS servers are addresses");
    expect(bad.find((check) => check.label === "its DNS servers are addresses")!.warning).toBeUndefined();

    const local = tenantChecks({ ...options, dnsServers: ["127.0.0.1:5353"] });
    expect(labels(local)).toEqual(["its DNS servers aren't this machine"]);
    expect(local.find((check) => check.label === "its DNS servers aren't this machine")!.warning).toBe(true);

    expect(labels(tenantChecks({ ...options, dnsServers: ["10.0.0.2", "10.0.0.3:5353", "[2001:db8::1]:53"] }))).toEqual([]);
  });

  it("warns when a new collection would be shared by every tenant", () => {
    const check = tenantChecks({ ...options, scopeNewCollections: false }).find((one) => one.label.startsWith("new collections"))!;
    expect(check.ok).toBe(false);
    expect(check.warning).toBe(true);
  });

  it("says nothing about DNS when the app set no servers", () => {
    expect(tenantChecks(options).map((check) => check.label).filter((label) => label.includes("DNS"))).toEqual([]);
  });
});
