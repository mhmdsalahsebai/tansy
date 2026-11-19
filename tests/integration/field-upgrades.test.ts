import { beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";
import type { FieldDefinition } from "@/core/fields/define";

let failOnTwo = true;
let prisma: typeof import("@/lib/prisma").default;
let db: typeof import("@/core/content/db").recordsDb;
let run: typeof import("@/core/fields/upgrades").runFieldUpgrades;
let table: typeof import("@/core/schema/names").tableName;
let createCollection: typeof import("@/core/schema/service").createCollectionSchema;

const read = async (slug: string, column: string) => {
  const rows = await db.selectFrom(table(slug)).select(["id", column]).orderBy("id").execute();
  return rows.map((row) => { const value = row[column]; return typeof value === "string" ? JSON.parse(value) : value; });
};
const insert = (slug: string, values: Record<string, unknown>) => db.insertInto(table(slug)).values({ status: "draft", ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === null ? null : JSON.stringify(value)])) }).execute();

beforeAll(async () => {
  process.env.DATABASE_URL = inject("databaseUrl");
  process.env.BETTER_AUTH_SECRET ??= "integration-secret-integration-secret";
  const { defineField } = await import("@/core/fields/define");
  const { provideCmsConfig } = await import("@/core/config");
  const money: FieldDefinition = defineField({
    type: "upg_money",
    admin: { label: "Money", input: "json" },
    config: {},
    value: () => z.strictObject({ amount: z.number() }),
    version: 2,
    upgrade: { 1: (value) => ({ amount: value }) },
    storage: () => ({ sql: "json" }),
  });
  const flaky: FieldDefinition = defineField({
    type: "upg_flaky",
    admin: { label: "Flaky", input: "json" },
    config: {},
    value: () => z.strictObject({ n: z.number() }),
    version: 2,
    upgrade: { 1: (value) => { if (value === 2 && failOnTwo) throw new Error("Step failed."); return { n: value }; } },
    storage: () => ({ sql: "json" }),
  });
  provideCmsConfig({ fields: [money, flaky] } as never);
  prisma = (await import("@/lib/prisma")).default;
  db = (await import("@/core/content/db")).recordsDb;
  run = (await import("@/core/fields/upgrades")).runFieldUpgrades;
  table = (await import("@/core/schema/names")).tableName;
  createCollection = (await import("@/core/schema/service")).createCollectionSchema;
});

describe("upgrading stored field values", () => {
  it("rewrites columns, blocks at any depth and defaults, exactly once, and stops at a failure with its place saved", async () => {
    await prisma.blockType.create({ data: { name: "upg_leaf", label: "Leaf", version: 1, fields: [{ name: "price", type: "upg_money", config: {} }] } });
    await prisma.blockType.create({ data: { name: "upg_box", label: "Box", version: 1, fields: [{ name: "inner", type: "stream", config: {} }] } });
    await createCollection({ name: "Upg money", slug: "upg-money", fields: [{ name: "price", type: "upg_money", config: { defaultValue: { amount: 1 } } }, { name: "body", type: "stream", config: {} }] } as never, null);
    await prisma.field.updateMany({ where: { type: "upg_money" }, data: { config: { defaultValue: 9 } } });
    await createCollection({ name: "Upg flaky", slug: "upg-flaky", fields: [{ name: "n", type: "upg_flaky", config: {} }] } as never, null);

    const leaf = { id: "l", type: "upg_leaf", v: 1, value: { price: 7 } };
    const stale = { id: "s", type: "upg_leaf", v: 99, value: { price: 8 } };
    await insert("upg-money", { price: 5, body: [{ id: "b", type: "upg_box", v: 1, value: { inner: [leaf, stale] } }] });
    await insert("upg-money", { price: null, body: null });
    for (const n of [1, 2, 3]) await insert("upg-flaky", { n });

    await expect(run({ batch: 1 })).rejects.toThrow(/upg_flaky.*could not upgrade record 2 in "upg-flaky" from version 1\. Step failed\./);

    // Types run in order, so the first finished and the second stopped after one record.
    expect(await prisma.fieldValueState.findUnique({ where: { type: "upg_money" } })).toMatchObject({ version: 2, upgradingTo: null });
    const prices = await read("upg-money", "price");
    expect(prices).toEqual([{ amount: 5 }, null]);
    const [body] = await read("upg-money", "body");
    const inner = body[0].value.inner;
    expect(inner[0].value.price).toEqual({ amount: 7 });
    expect(inner[1].value.price).toBe(8);
    expect((await prisma.field.findFirst({ where: { type: "upg_money" } }))!.config).toEqual({ defaultValue: { amount: 9 } });

    expect(await read("upg-flaky", "n")).toEqual([{ n: 1 }, 2, 3]);
    expect(await prisma.fieldValueState.findUnique({ where: { type: "upg_flaky" } })).toMatchObject({ version: 1, upgradingTo: 2, cursorRecord: 1 });

    failOnTwo = false;
    await run({ batch: 1 });
    expect(await read("upg-flaky", "n")).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(await prisma.fieldValueState.findUnique({ where: { type: "upg_flaky" } })).toMatchObject({ version: 2, upgradingTo: null, cursorRecord: 0 });

    await run({ batch: 1 });
    expect(await read("upg-money", "price")).toEqual([{ amount: 5 }, null]);
  });
});
