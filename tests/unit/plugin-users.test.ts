import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CmsPlugin } from "@/core/extend/define";

interface FieldRow { id: number; name: string; type: string; config: Record<string, unknown>; selfEditable: boolean }

const db = vi.hoisted(() => ({
  users: new Set<string>(),
  fields: [] as FieldRow[],
  profiles: new Map<string, Record<string, unknown>>(),
}));

const mocks = vi.hoisted(() => ({
  audit: vi.fn(async () => {}),
  applySchema: vi.fn(async () => {}),
  plugins: [] as CmsPlugin[],
}));

vi.mock("@/lib/prisma", () => {
  const client = {
    user: { findUnique: async ({ where }: { where: { id: string } }) => (db.users.has(where.id) ? { id: where.id } : null) },
    userField: { findMany: async () => db.fields },
    userProfile: {
      findUnique: async ({ where }: { where: { userId: string } }) => (db.profiles.has(where.userId) ? { userId: where.userId, values: db.profiles.get(where.userId) } : null),
      upsert: async ({ where, create }: { where: { userId: string }; create: { values: Record<string, unknown> } }) => { db.profiles.set(where.userId, create.values); },
    },
    pluginState: { findUnique: async () => null, upsert: async () => ({}) },
    $transaction: async (work: (tx: unknown) => unknown) => work(client),
  };
  return { default: client };
});
vi.mock("@/core/content/locks", async (original) => ({ ...(await original<typeof import("@/core/content/locks")>()), serializeWrites: async () => {} }));
vi.mock("@/core/audit", () => ({ audit: mocks.audit }));
vi.mock("@/core/config", async (original) => ({ ...(await original<typeof import("@/core/config")>()), getCmsConfig: () => ({ plugins: mocks.plugins }) }));
vi.mock("@/core/schema/portable", async (original) => ({ ...(await original<typeof import("@/core/schema/portable")>()), applySchema: mocks.applySchema }));
vi.mock("@/core/extend/events", () => ({ emitEvent: () => {} }));

const { extensionUsers, ownedUserFields } = await import("@/core/extend/users");
const { saveUserFields } = await import("@/core/auth/user-fields");
const { runPluginMigrations } = await import("@/core/extend/lifecycle");

const plugin = (name: string, extra: Partial<CmsPlugin> = {}): CmsPlugin => ({ name, version: "1.0.0", apiVersion: 1, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  db.users = new Set(["u1"]);
  db.fields = [
    { id: 1, name: "lms_courses", type: "json", config: { hidden: true }, selfEditable: false },
    { id: 2, name: "lms_level", type: "number", config: { defaultValue: 1 }, selfEditable: false },
    { id: 3, name: "department", type: "text", config: {}, selfEditable: false },
    { id: 4, name: "lms_nickname", type: "text", config: {}, selfEditable: true },
    { id: 5, name: "my_plugin_tier", type: "text", config: {}, selfEditable: false },
  ];
  db.profiles = new Map([["u1", { 1: [3], 3: "Sales" }]]);
  mocks.plugins = [plugin("lms"), plugin("my-plugin")];
});

describe("which user fields an extension owns", () => {
  it("gives a plugin only the fields named with its prefix", () => {
    const owns = ownedUserFields("plugin:lms");
    expect(owns("lms_courses")).toBe(true);
    expect(owns("department")).toBe(false);
    expect(owns("lmsx_courses")).toBe(false);
    expect(ownedUserFields("plugin:my-plugin")("my_plugin_tier")).toBe(true);
  });

  it("gives a hook file, the owner's own code, every field", () => {
    expect(ownedUserFields("cms_hooks/enroll.ts")("department")).toBe(true);
  });
});

describe("system.users", () => {
  const users = extensionUsers("plugin:lms");

  it("reads only the plugin's own fields, hidden ones and defaults included", async () => {
    expect(await users.getValues("u1")).toEqual({ lms_courses: [3], lms_level: 1, lms_nickname: null });
    expect(await users.getValues("nobody")).toBeNull();
  });

  it("writes the fields named, keeps the rest, and audits names but never values", async () => {
    await users.setValues("u1", { lms_courses: [3, 9], lms_level: null });
    expect(db.profiles.get("u1")).toEqual({ 1: [3, 9], 3: "Sales" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "user.update_fields", actorKind: "system", actorEmail: "plugin:lms", targetId: "u1", metadata: { fields: ["lms_courses", "lms_level"] } }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("9]");
  });

  it("refuses another plugin's field or the owner's, and writes nothing", async () => {
    await expect(users.setValues("u1", { lms_level: 2, department: "Ops" })).rejects.toThrow(/can't set the user field "department"/);
    await expect(users.setValues("u1", { my_plugin_tier: "gold" })).rejects.toThrow(/can't set/);
    expect(db.profiles.get("u1")).toEqual({ 1: [3], 3: "Sales" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("refuses a field users can edit themselves", async () => {
    await expect(users.setValues("u1", { lms_nickname: "Ace" })).rejects.toThrow(/users can edit "lms_nickname" themselves/);
  });

  it("refuses a field that doesn't exist, and a missing user", async () => {
    await expect(users.setValues("u1", { lms_missing: 1 })).rejects.toThrow(/no user field "lms_missing"/);
    await expect(users.setValues("nobody", { lms_level: 2 })).rejects.toMatchObject({ status: 404 });
  });

  it("validates values like the dashboard does", async () => {
    await expect(users.setValues("u1", { lms_level: "high" })).rejects.toMatchObject({ status: 400 });
    expect(db.profiles.get("u1")).toEqual({ 1: [3], 3: "Sales" });
  });

  it("does nothing for an empty change", async () => {
    await users.setValues("u1", {});
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe("defining user fields", () => {
  it("won't let users edit a field a running plugin sets", async () => {
    await expect(saveUserFields([{ name: "lms_courses", type: "text", config: {}, selfEditable: true }], false)).rejects.toMatchObject({
      status: 400,
      details: [{ path: "fields.0.selfEditable", message: "The lms plugin sets this field, so users can't edit it themselves." }],
    });
  });
});

describe("a plugin migration declaring user fields", () => {
  const migrate = (userFields: Array<{ name: string; type: string }>) => {
    mocks.plugins = [plugin("lms", { migrations: [{ id: "001", up: ({ schema }) => schema.apply({ version: 1, collections: [], userFields }) }] })];
    return runPluginMigrations();
  };

  it("applies fields named with the plugin's prefix", async () => {
    await migrate([{ name: "lms_courses", type: "json" }]);
    expect(mocks.applySchema).toHaveBeenCalledOnce();
  });

  it("refuses any other name, and applies nothing", async () => {
    await expect(migrate([{ name: "lms_courses", type: "json" }, { name: "plan", type: "text" }])).rejects.toThrow(/user fields must start with "lms_": plan/);
    expect(mocks.applySchema).not.toHaveBeenCalled();
  });
});
