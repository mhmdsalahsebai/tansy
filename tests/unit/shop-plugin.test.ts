import { describe, expect, it, vi } from "vitest";
import type { AfterHookContext, BeforeHookContext, CollectionShape, ExtensionContext, RecordValues } from "@/core/extend/define";
import { assertPluginManifest } from "@/core/extend/manifest";
import { schemaDocument } from "@/core/schema/portable";
import { pluginRenderers } from "@/components/stream/StreamField";
import { shop } from "../../plugins/shop/index";
import shopRenderers from "../../plugins/shop/render";
import { CONTRACT, ORDERS, PRODUCTS, PURCHASES, shopSchema, VARIANTS } from "../../plugins/shop/schema";
import { canMove, lineSubtotal, linesOf, mergeItems, orderTitle, shippingCost, shippingCountries, sum, zoneFor, type Zone } from "../../plugins/shop/logic";
import { quote, restock, takeStock } from "../../plugins/shop/service";

describe("shop money and shipping", () => {
  it("adds prices without floating-point drift", () => {
    expect(sum([0.1, 0.2])).toBe(0.3);
    expect(lineSubtotal(19.99, 3)).toBe(59.97);
    expect(sum([59.97, 4.99])).toBe(64.96);
  });

  it("merges the same product and variant into one line", () => {
    expect(mergeItems([{ product: 1, quantity: 2 }, { product: 1, variant: null, quantity: 1 }, { product: 1, variant: 4, quantity: 1 }])).toEqual([
      { product: 1, variant: null, quantity: 3 },
      { product: 1, variant: 4, quantity: 1 },
    ]);
  });

  it("prefers a zone that names the country, and ships free over the threshold", () => {
    const zones: Zone[] = [{ id: 1, name: "World", countries: ["*"], rate: 15, freeOver: null }, { id: 2, name: "North America", countries: ["US", "CA"], rate: 5, freeOver: 50 }];
    expect(zoneFor(zones, "US")?.id).toBe(2);
    expect(zoneFor(zones, "FR")?.id).toBe(1);
    expect(zoneFor(zones.slice(1), "FR")).toBeNull();
    expect(shippingCost(zones[1], 49.99)).toBe(5);
    expect(shippingCost(zones[1], 50)).toBe(0);
    expect(shippingCountries(zones)).toBe("any");
    expect(shippingCountries(zones.slice(1))).toEqual(["CA", "US"]);
  });

  it("moves orders forward only", () => {
    expect(canMove("pending", "paid")).toBe(true);
    expect(canMove("cancelled", "paid")).toBe(true);
    expect(canMove("paid", "shipped")).toBe(true);
    expect(canMove("pending", "shipped")).toBe(false);
    expect(canMove("shipped", "paid")).toBe(false);
    expect(canMove("refunded", "paid")).toBe(false);
    expect(canMove("paid", "made-up")).toBe(false);
  });

  it("reads back stored lines, dropping malformed ones, and names the order", () => {
    const lines = linesOf([{ product: 1, title: "Tee", variantTitle: "M", unitPrice: 10, quantity: 2, shipping: true }, { product: "x" }, { product: 2, title: "Mug", unitPrice: 0, quantity: 1 }, null]);
    expect(lines).toEqual([expect.objectContaining({ product: 1, subtotal: 20, shipping: true })]);
    expect(orderTitle(lines)).toBe("Tee (M) × 2");
  });
});

describe("shop plugin manifest", () => {
  it("passes the manifest checks and validates its options", () => {
    expect(() => assertPluginManifest(shop({ siteUrl: "https://example.com" }))).not.toThrow();
    expect(() => shop({ siteUrl: "https://example.com", currency: "USD" })).toThrow(/currency/);
    expect(() => shop({ siteUrl: "not a url" })).toThrow();
  });

  it("creates a schema that imports, with every contract field and orders only their customer reads", () => {
    const document = schemaDocument.parse(shopSchema("eur"));
    for (const [slug, fields] of Object.entries(CONTRACT)) {
      const collection = document.collections.find((c) => c.slug === slug)!;
      for (const [name, type] of Object.entries(fields)) expect(collection.fields.find((f) => f.name === name)?.type, `${slug}.${name}`).toBe(type);
    }
    const orders = document.collections.find((c) => c.slug === ORDERS)!;
    expect([orders.rules.createRule, orders.rules.updateRule, orders.rules.deleteRule]).toEqual([null, null, null]);
    expect(orders.rules.viewRule).toContain("customer = @request.auth.id");
    // Only orders are for sale through Payments, so nothing skips the cart's stock and shipping.
    expect(document.collections.flatMap((c) => c.fields.filter((f) => f.type === "payments_price").map((f) => `${c.slug}.${f.name}`))).toEqual(["shop-orders.total"]);
    expect(orders.fields.find((f) => f.name === "total")?.config).toMatchObject({ currency: "eur", once: true });
    expect(document.collections.find((c) => c.slug === PRODUCTS)!.fields.find((f) => f.name === "download")?.config.hidden).toBe(true);
  });

  it("renders only its own collections, and reads orders as the viewer", () => {
    expect(() => pluginRenderers("shop", shopRenderers)).not.toThrow();
    expect(Object.keys(shopRenderers.templates!).every((slug) => slug.startsWith("shop-"))).toBe(true);
    for (const queries of Object.values(shopRenderers.queries!)) {
      for (const query of Object.values(queries)) if (query.collection === ORDERS) expect(query.viewer).toBe(true);
    }
  });
});

type Row = RecordValues & { id: number };

/**
 * An in-memory stand-in for the records API, which understands the filters the shop
 * uses: `a = 1`, `a = "x"`, joined by && or ||. `records` sees published records only,
 * as a visitor would. Conditional updates apply only while the record still matches.
 */
function fakeShop(seed: Record<string, Row[]> = {}) {
  const tables = new Map<string, Row[]>(Object.entries(seed).map(([slug, rows]) => [slug, rows.map((row) => ({ status: "published", ...row }))]));
  const store = new Map<string, unknown>();
  const mail = vi.fn(async () => {});
  let next = 1000;
  const rows = (slug: string) => tables.get(slug) ?? tables.set(slug, []).get(slug)!;
  const matches = (row: Row, filter = "") => {
    const clause = (text: string) => {
      const [, field, raw] = /^\s*(\w+)\s*=\s*(.+?)\s*$/.exec(text)!;
      return row[field] === (raw.startsWith('"') ? raw.slice(1, -1) : Number(raw));
    };
    return !filter || filter.split("||").some((any) => any.split("&&").every(clause));
  };
  const api = (published: boolean) => ({
    list: async (slug: string, query: { filter?: string; page?: number } = {}) => {
      const items = (query.page ?? 1) > 1 ? [] : rows(slug).filter((row) => (!published || row.status === "published") && matches(row, query.filter)).map((row) => ({ ...row }));
      return { page: 1, perPage: 200, totalItems: items.length, totalPages: 1, items };
    },
    get: async (slug: string, id: number) => {
      const row = rows(slug).find((candidate) => candidate.id === id && (!published || candidate.status === "published"));
      if (!row) throw Object.assign(new Error("Not found"), { status: 404 });
      return { ...row };
    },
    create: async (slug: string, data: RecordValues) => {
      const row = { id: next++, ...data };
      rows(slug).push(row);
      return { ...row };
    },
    update: async (slug: string, id: number, data: RecordValues, options?: { if: Record<string, unknown> }) => {
      const row = rows(slug).find((candidate) => candidate.id === id)!;
      if (options?.if && Object.entries(options.if).some(([key, value]) => row[key] !== value)) return null;
      return { ...Object.assign(row, data) };
    },
    delete: async () => {},
  });
  const context = {
    records: api(true),
    system: { records: api(false), users: { get: async (id: string) => ({ id, name: "Buyer", email: `${id}@example.test` }) } },
    store: {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: unknown) => { store.set(key, value); },
      claim: async (key: string, value: unknown) => (store.has(key) ? false : (store.set(key, value), true)),
    },
    schema: {
      describe: async (slug: string): Promise<CollectionShape | null> => {
        const collection = shopSchema("usd").collections.find((c) => c.slug === slug);
        return collection ? { slug, name: collection.name, type: "base", urlPattern: collection.urlPattern, fields: collection.fields.map((f) => ({ name: f.name, type: f.type, config: f.config as Record<string, unknown> })) } : null;
      },
      languages: async () => ({ defaultLocale: "en", items: [{ code: "en", label: "English", direction: "ltr" as const }], href: (path: string) => path }),
    },
    settings: { get: async () => ({ notifyCustomers: true, notifyStaff: "", restockOnRefund: true, cancelUnpaidAfterDays: 7 }) },
    mail: { send: mail },
    scope: { value: () => null, bind: <A extends unknown[], R>(work: (...args: A) => R) => work, siteUrl: async () => null },
  } as unknown as ExtensionContext;
  return { context, rows, store, mail };
}

const catalogue = () => ({
  "shop-store": [{ id: 1, title: "Shop", currency: "usd" }],
  "shop-shipping-zones": [{ id: 1, name: "North America", countries: ["US", "CA"], rate: 5, freeOver: 50 }, { id: 2, name: "World", countries: ["*"], rate: 15 }],
  [PRODUCTS]: [
    { id: 1, title: "Tee", price: 10, stock: 5, shipping: true },
    { id: 2, title: "Secret", price: 99, status: "draft", shipping: true },
    { id: 3, title: "Hoodie", price: 12, shipping: true },
    { id: 4, title: "E-book", price: 5, shipping: false, download: "file_ebook" },
  ],
  [VARIANTS]: [
    { id: 31, product: 3, title: "Large", price: 25, stock: 0 },
    { id: 32, product: 3, title: "Small", price: null, stock: null },
    { id: 33, product: 3, title: "Unreleased", price: 30, status: "draft" },
  ],
});

describe("shop pricing", () => {
  it("prices a cart from stored products, adding shipping for the country", async () => {
    const { context } = fakeShop(catalogue());
    const priced = await quote(context, context.records, [{ product: 1, quantity: 2 }, { product: 1, quantity: 1 }], "US");
    expect(priced).toMatchObject({ currency: "usd", subtotal: 30, shipping: 5, total: 35, needsShipping: true, ready: true });
    expect(priced.lines).toEqual([expect.objectContaining({ product: 1, quantity: 3, unitPrice: 10, subtotal: 30, available: true })]);
    expect((await quote(context, context.records, [{ product: 1, quantity: 5 }, { product: 3, variant: 32, quantity: 1 }], "FR")).shipping).toBe(15);
    expect((await quote(context, context.records, [{ product: 1, quantity: 5 }, { product: 3, variant: 32, quantity: 1 }], "CA")).shipping).toBe(0);
  });

  it("refuses drafts, sold-out variants, too many, and a product with variants bought without one", async () => {
    const { context } = fakeShop(catalogue());
    const problem = async (item: { product: number; variant?: number; quantity: number }) => (await quote(context, context.records, [item], "US")).lines[0].problem;
    expect(await problem({ product: 2, quantity: 1 })).toMatch(/no longer for sale/);
    expect(await problem({ product: 3, variant: 33, quantity: 1 })).toMatch(/no longer for sale/);
    expect(await problem({ product: 3, quantity: 1 })).toBe("Choose an option.");
    expect(await problem({ product: 3, variant: 31, quantity: 1 })).toBe("Sold out.");
    expect(await problem({ product: 1, quantity: 6 })).toBe("Only 5 left.");
    // A variant without its own price takes the product's.
    const small = await quote(context, context.records, [{ product: 3, variant: 32, quantity: 2 }], "US");
    expect(small.lines[0]).toMatchObject({ unitPrice: 12, subtotal: 24, variantTitle: "Small", available: true });
    expect((await quote(context, context.records, [{ product: 2, quantity: 1 }], "US")).ready).toBe(false);
  });

  it("says so when there's nowhere to ship to, and installs a free zone for everywhere once", async () => {
    const { context } = fakeShop({ ...catalogue(), "shop-shipping-zones": [] });
    const priced = await quote(context, context.records, [{ product: 1, quantity: 1 }], null);
    expect(priced.ready).toBe(false);
    expect(priced.problems).toContain("The shop doesn't send parcels anywhere yet.");
    const migration = shop({ siteUrl: "https://shop.example" }).migrations!.find((m) => m.id === "002-default-zone")!;
    for (let i = 0; i < 2; i++) await migration.up(context as never);
    const zoned = await quote(context, context.records, [{ product: 1, quantity: 1 }], "EG");
    expect(zoned).toMatchObject({ shipping: 0, total: 10, ready: true, countries: "any" });
  });

  it("needs a country only for things that ship", async () => {
    const { context } = fakeShop(catalogue());
    expect(await quote(context, context.records, [{ product: 4, quantity: 1 }], null)).toMatchObject({ needsShipping: false, shipping: 0, total: 5, ready: true });
    const tee = await quote(context, context.records, [{ product: 1, quantity: 1 }], null);
    expect(tee).toMatchObject({ needsShipping: true, shipping: null, total: null, ready: false });
    expect(tee.problems).toContain("Choose where to send it.");
  });
});

describe("shop stock", () => {
  const lines = [{ product: 1, variant: null, title: "Tee", variantTitle: null, sku: null, unitPrice: 10, quantity: 2, subtotal: 20, shipping: true }];

  it("takes stock once per order however often the hook runs, and reports what ran short", async () => {
    const { context, rows } = fakeShop(catalogue());
    expect(await takeStock(context, 7, lines)).toEqual([]);
    expect(await takeStock(context, 7, lines)).toEqual([]);
    expect(rows(PRODUCTS).find((p) => p.id === 1)!.stock).toBe(3);
    expect(await takeStock(context, 8, [{ ...lines[0], quantity: 4 }])).toEqual(["Tee: 1 short"]);
    expect(rows(PRODUCTS).find((p) => p.id === 1)!.stock).toBe(0);
  });

  it("puts back only stock that was taken, once", async () => {
    const { context, rows } = fakeShop(catalogue());
    await restock(context, 9, lines);
    expect(rows(PRODUCTS).find((p) => p.id === 1)!.stock).toBe(5);
    await takeStock(context, 9, lines);
    await restock(context, 9, lines);
    await restock(context, 9, lines);
    expect(rows(PRODUCTS).find((p) => p.id === 1)!.stock).toBe(5);
  });
});

describe("shop order hooks", () => {
  const plugin = shop({ siteUrl: "https://shop.example" });
  const hooks = plugin.hooks!;
  const order = (extra: RecordValues = {}): Row => ({
    id: 50, title: "Tee × 2", customer: "u_buyer", state: "pending", total: 25, subtotal: 20, shippingCost: 5, currency: "usd", needsShipping: true,
    lines: [{ product: 1, title: "Tee", unitPrice: 10, quantity: 2, shipping: true }], ...extra,
  });
  const before = (context: ExtensionContext, record: RecordValues, values: RecordValues) => ({
    ...context, event: "record.beforeUpdate", collection: { id: 1, slug: ORDERS, name: "Orders" }, userId: "staff", can: () => true, values, record,
    reject: (message: string): never => { throw new Error(message); },
  }) as unknown as BeforeHookContext;
  const after = (context: ExtensionContext, slug: string, event: string, record: RecordValues, previous?: RecordValues) =>
    ({ ...context, event, collection: { id: 2, slug, name: slug }, record, previous }) as unknown as AfterHookContext;

  it("keep what an order was priced at, and move it forward only, stamping when", async () => {
    const { context } = fakeShop();
    await expect(hooks["record.beforeUpdate"]!(before(context, order(), { total: 1 }))).rejects.toThrow(/keeps what it was made with/);
    await expect(hooks["record.beforeUpdate"]!(before(context, order(), { state: "shipped" }))).rejects.toThrow(/pending can't become shipped/);
    const paying = before(context, order(), { state: "paid" });
    await hooks["record.beforeUpdate"]!(paying);
    expect(paying.values.paidAt).toEqual(expect.any(String));
  });

  it("mark an order paid when Payments records its purchase, even after it was cancelled, and flag a wrong amount", async () => {
    const { context, rows } = fakeShop({ [ORDERS]: [order(), order({ id: 51, state: "cancelled" }), order({ id: 52, state: "shipped" })] });
    const purchase = (recordId: number, amount = 25) => ({ collection: ORDERS, recordId, buyer: "u_buyer", amount, currency: "usd", state: "paid" });
    for (const id of [50, 51, 52]) await hooks["record.afterCreate"]!(after(context, PURCHASES, "record.afterCreate", purchase(id)));
    expect(rows(ORDERS).map((row) => row.state)).toEqual(["paid", "paid", "shipped"]);
    const { context: other, rows: otherRows } = fakeShop({ [ORDERS]: [order()] });
    await hooks["record.afterCreate"]!(after(other, PURCHASES, "record.afterCreate", purchase(50, 1)));
    expect(otherRows(ORDERS)[0]).toMatchObject({ state: "paid", flag: expect.stringContaining("came to $25.00") });
    // Purchases of anything else are someone else's business.
    await hooks["record.afterCreate"]!(after(other, PURCHASES, "record.afterCreate", { ...purchase(50), collection: "lms-courses" }));
  });

  it("take stock, hand over downloads and email the buyer once when an order is paid", async () => {
    const seed = catalogue();
    const digital = order({ needsShipping: false, state: "paid", lines: [{ product: 4, title: "E-book", unitPrice: 5, quantity: 1, shipping: false }] });
    const { context, rows, mail } = fakeShop({ ...seed, [ORDERS]: [digital] });
    for (let i = 0; i < 2; i++) await hooks["record.afterUpdate"]!(after(context, ORDERS, "record.afterUpdate", digital, { ...digital, state: "pending" }));
    expect(rows(ORDERS)[0]).toMatchObject({ state: "delivered", downloads: ["file_ebook"] });
    expect(mail).toHaveBeenCalledTimes(1);
    expect(mail).toHaveBeenCalledWith(expect.objectContaining({ to: "u_buyer@example.test", subject: "Thank you for your order #50" }));
  });

  it("take an order back when its purchase is refunded, restocking it", async () => {
    const paid = order({ state: "paid" });
    const { context, rows } = fakeShop({ ...catalogue(), [ORDERS]: [paid] });
    await hooks["record.afterUpdate"]!(after(context, ORDERS, "record.afterUpdate", paid, { ...paid, state: "pending" }));
    expect(rows(PRODUCTS).find((p) => p.id === 1)!.stock).toBe(3);
    const refunded = { collection: ORDERS, recordId: 50, buyer: "u_buyer", state: "refunded" };
    await hooks["record.afterUpdate"]!(after(context, PURCHASES, "record.afterUpdate", refunded, { ...refunded, state: "paid" }));
    expect(rows(ORDERS)[0].state).toBe("refunded");
    await hooks["record.afterUpdate"]!(after(context, ORDERS, "record.afterUpdate", { ...rows(ORDERS)[0] }, paid));
    expect(rows(PRODUCTS).find((p) => p.id === 1)!.stock).toBe(5);
  });
});
