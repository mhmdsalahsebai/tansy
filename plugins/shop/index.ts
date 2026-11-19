import { z } from "zod";
import { definePlugin, defineRoute, wordsIn, type AfterHookContext, type BeforeHookContext, type ExtensionContext, type RecordsApi } from "tansy/plugin";
import { canMove, COUNTRY, CURRENCY, formatMoney, idOf, isUserId, linesOf, orderTitle, slugify, STAMPS, str, toMilli, type OrderLine, type OrderState } from "./logic";
import { ACCOUNT, CART, CATEGORIES, COLLECTIONS, CONTRACT, LANGUAGE_FIELD, ORDERS, PRODUCTS, PURCHASES, shopRoles, shopSchema, STORE, ZONES } from "./schema";
import { siteMessages } from "./site-messages";
import { BLOCK_FIELD_LABELS, COLLECTION_LABELS, FIELD_LABELS, messages } from "./messages";
import { currencyProblem, downloadsFor, listAll, quote, restock, settingsOf, takeStock } from "./service";
import { shopTools } from "./tools";

export { ORDERS, PRODUCTS, VARIANTS, CATEGORIES, ZONES } from "./schema";

export interface ShopOptions {
  /** The public site's origin, such as https://example.com, for links in emails. */
  siteUrl: string;
  /** What prices are in, set on first install. After that, change it on the Shop page and on Orders' total field. */
  currency?: string;
}

const optionsSchema = z.strictObject({
  siteUrl: z.url(),
  currency: z.string().regex(CURRENCY, 'Use a three-letter currency code in lowercase, such as "usd".'),
});

/** Running the shop: settings. Shipping orders is `fulfill`, so staff can pack parcels without changing prices. */
const MANAGE = "ext.shop:manage";
const FULFILL = "ext.shop:fulfill";

const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => Response.json({ error: { code, message }, ...extra }, { status });

/** The field a missing slug is made from, and what to call a record with an empty one. */
const SLUG_SOURCE: Record<string, [string, string]> = { [PRODUCTS]: ["title", "product"], [CATEGORIES]: ["name", "category"] };

/** On an update, `values` holds only what changed, so the stored value fills the rest. */
const currentOf = ({ values, record }: BeforeHookContext) => (name: string) => (Object.hasOwn(values, name) ? values[name] : record?.[name]);

const changes = (context: BeforeHookContext, name: string) =>
  Object.hasOwn(context.values, name) && JSON.stringify(context.values[name] ?? null) !== JSON.stringify(context.record?.[name] ?? null);

async function uniqueSlug(records: RecordsApi, slug: string, base: string, ownId: unknown) {
  for (let attempt = 1; attempt <= 50; attempt++) {
    const candidate = attempt === 1 ? base : `${base.slice(0, 75)}-${attempt}`;
    // slugify only produces letters, digits and hyphens, so the filter can't be broken out of.
    const { items } = await records.list(slug, { filter: `slug = "${candidate}"`, perPage: 2, fields: "id" });
    if (!items.some((item) => item.id !== ownId)) return candidate;
  }
  return `${base.slice(0, 60)}-${Date.now().toString(36)}`;
}

async function fillSlug(context: BeforeHookContext) {
  const [source, fallback] = SLUG_SOURCE[context.collection.slug];
  const current = currentOf(context);
  const fields = new Set((await context.schema.describe(context.collection.slug))?.fields.map((field) => field.name) ?? []);
  if (!fields.has("slug") || str(current("slug"))) return;
  context.values.slug = await uniqueSlug(context.system.records, context.collection.slug, slugify(str(current(source)), fallback), context.record?.id);
}

/** What an order was made from. Prices are fixed when it's made, and a payment is checked against them. */
const FROZEN = ["customer", "lines", "subtotal", "shippingCost", "total", "currency"];

async function prepareOrder(context: BeforeHookContext) {
  const { values } = context;
  if (!isUserId(values.customer) || !(await context.system.users.get(values.customer))) context.reject("There is no user with this id.", "customer");
  // Payment marks an order paid. Staff who take money another way mark it paid afterwards, which runs the same steps.
  values.state = "pending";
}

/** Orders only move forward, and what they were priced at never changes. Applies to staff in the dashboard as much as to the plugin. */
function guardOrder(context: BeforeHookContext) {
  for (const name of FROZEN) if (changes(context, name)) context.reject("An order keeps what it was made with. Cancel it and make another instead.", name);
  if (!Object.hasOwn(context.values, "state")) return;
  const from = context.record?.state;
  const to = context.values.state;
  if (!canMove(from, to)) context.reject(`An order that's ${str(from) || "new"} can't become ${str(to)}.`, "state");
  const stamp = STAMPS[to as OrderState];
  if (stamp && from !== to && !context.values[stamp]) context.values[stamp] = new Date().toISOString();
}

/** A purchase from Payments is only data to the shop: `buyer`, `collection`, `recordId`, `amount`, `currency` and `state`. */
const purchasedOrder = (record: AfterHookContext["record"]) => (record.collection === ORDERS ? idOf(record.recordId) : null);

/**
 * Marks the order paid. A durable hook may run more than once, and the move applies only
 * from an unpaid state, so a repeat changes nothing. A payment that arrives after the
 * order was cancelled for going unpaid still counts.
 */
async function markPaid(context: AfterHookContext) {
  const id = purchasedOrder(context.record);
  if (id === null || context.record.state !== "paid") return;
  const order = await context.system.records.get(ORDERS, id, { fields: "id,customer,total,currency,flag" }).catch(() => null);
  if (!order) return;
  const flags: string[] = [];
  if (order.customer !== context.record.buyer) flags.push("Paid for by someone other than its customer.");
  const amount = context.record.amount;
  if (typeof amount === "number" && typeof order.total === "number" && (toMilli(amount) !== toMilli(order.total) || str(context.record.currency) !== str(order.currency))) {
    flags.push(`Paid ${formatMoney(amount, str(context.record.currency) || "usd")}, but it came to ${formatMoney(order.total, str(order.currency) || "usd")}.`);
  }
  const values = { state: "paid", ...(flags.length ? { flag: [str(order.flag), ...flags].filter(Boolean).join(" ").slice(0, 500) } : {}) };
  for (const from of ["pending", "cancelled"]) {
    if (await context.system.records.update(ORDERS, id, values, { if: { state: from } })) return;
  }
}

/** A full refund with the provider takes the order back, wherever it had got to. */
async function markRefunded(context: AfterHookContext) {
  const id = purchasedOrder(context.record);
  if (id === null || context.record.state !== "refunded" || context.previous?.state === "refunded") return;
  for (const from of ["paid", "shipped", "delivered"]) {
    if (await context.system.records.update(ORDERS, id, { state: "refunded" }, { if: { state: from } })) return;
  }
}

/** Where customers see their orders, from the Orders page's address. */
/** The orders page, in the customer's language when the site has it. */
async function ordersUrl(context: ExtensionContext, siteUrl: string, locale?: string) {
  const pattern = (await context.schema.describe(ACCOUNT))?.urlPattern;
  const path = pattern && !pattern.includes(":") ? pattern : "/";
  const languages = await context.schema.languages();
  const known = locale && languages.items.length > 1 && languages.items.some((item) => item.code === locale) ? locale : null;
  // A tenant's orders page is on its own domain (core/scope), once it has one.
  return new URL(known ? languages.href(path, known) : path, (await context.scope.siteUrl()) ?? siteUrl).toString();
}

/** The shop's words in the language the order was placed in, English for orders from before it was kept. */
const orderWords = (order: Record<string, unknown>) => {
  const locale = str(order.language) || "en";
  return { locale, ...wordsIn(siteMessages, locale) };
};

async function customerEmail(context: ExtensionContext, order: Record<string, unknown>) {
  if (str(order.email)) return str(order.email);
  return isUserId(order.customer) ? (await context.system.users.get(order.customer))?.email ?? "" : "";
}

const describeLines = (lines: OrderLine[], currency: string, locale?: string) =>
  lines.map((line) => `- ${line.title}${line.variantTitle ? ` (${line.variantTitle})` : ""} × ${line.quantity}: ${formatMoney(line.subtotal, currency, locale)}`).join("\n");

/**
 * Everything that follows payment, however the order got there: from the provider through
 * Payments, or marked paid by staff. Each step is claimed once per order, so the durable
 * hook can run it again safely.
 */
async function fulfilPaid(context: AfterHookContext, siteUrl: string) {
  const order = context.record;
  const id = order.id as number;
  const lines = linesOf(order.lines);
  const short = await takeStock(context, id, lines);
  const downloads = await downloadsFor(context, lines);
  const values: Record<string, unknown> = {};
  if (short.length) values.flag = [str(order.flag), `Stock ran out after payment: ${short.join("; ")}.`].filter(Boolean).join(" ").slice(0, 500);
  if (downloads.length) values.downloads = downloads;
  // Nothing to post, so nothing to wait for.
  if (order.needsShipping !== true) {
    await context.system.records.update(ORDERS, id, { ...values, state: "delivered" }, { if: { state: "paid" } });
  } else if (Object.keys(values).length) {
    await context.system.records.update(ORDERS, id, values);
  }

  const settings = await settingsOf(context);
  const currency = str(order.currency) || "usd";
  const summary = `${describeLines(lines, currency)}\n\nShipping: ${formatMoney(Number(order.shippingCost) || 0, currency)}\nTotal: ${formatMoney(Number(order.total) || 0, currency)}`;
  const to = await customerEmail(context, order);
  if (settings.notifyCustomers && to && (await context.store.claim(`mail:paid:${id}`, { at: Date.now() }))) {
    // In the language they shopped in.
    const { t, locale } = orderWords(order);
    const money = (amount: unknown) => formatMoney(Number(amount) || 0, currency, locale);
    const theirs = `${describeLines(lines, currency, locale)}\n\n${t("shop.mail.shippingLine", { amount: money(order.shippingCost) })}\n${t("shop.mail.totalLine", { amount: money(order.total) })}`;
    await context.mail.send({
      to,
      locale,
      subject: t("shop.mail.paidSubject", { id }),
      body: `${t("shop.mail.paidBody", { id })}\n\n${theirs}\n\n${order.needsShipping === true ? t("shop.mail.willShip") : downloads.length ? t("shop.mail.downloads") : ""}`.trim(),
      action: { label: t("shop.mail.seeOrder"), url: await ordersUrl(context, siteUrl, locale) },
    });
  }
  const staff = str(settings.notifyStaff).trim();
  if (staff && (await context.store.claim(`mail:staff:${id}`, { at: Date.now() }))) {
    await context.mail.send({ to: staff, subject: `New order #${id}: ${formatMoney(Number(order.total) || 0, currency)}`, body: `${summary}\n\n${short.length ? `Stock ran out after payment: ${short.join("; ")}.\n\n` : ""}${order.needsShipping === true ? "Ship it from the Shop section of the dashboard." : "Nothing to ship."}` });
  }
}

async function notifyShipped(context: AfterHookContext, siteUrl: string) {
  const order = context.record;
  const id = order.id as number;
  const to = await customerEmail(context, order);
  if (!to || !(await settingsOf(context)).notifyCustomers || !(await context.store.claim(`mail:shipped:${id}`, { at: Date.now() }))) return;
  const tracking = str(order.trackingUrl);
  const { t, locale } = orderWords(order);
  await context.mail.send({
    to,
    locale,
    subject: t("shop.mail.shippedSubject", { id }),
    body: `${t("shop.mail.shippedBody", { id })}${tracking ? `\n\n${t("shop.mail.followTracking")}` : ""}`,
    action: tracking && /^https?:\/\//.test(tracking) ? { label: t("shop.mail.track"), url: tracking } : { label: t("shop.mail.seeOrder"), url: await ordersUrl(context, siteUrl, locale) },
  });
}

/** Refunded: stock goes back when the setting says so, and the downloads go with the money. */
async function takeBack(context: AfterHookContext) {
  const order = context.record;
  const id = order.id as number;
  if ((await settingsOf(context)).restockOnRefund) await restock(context, id, linesOf(order.lines));
  if (Array.isArray(order.downloads) && order.downloads.length) await context.system.records.update(ORDERS, id, { downloads: [] });
}

const item = z.strictObject({
  product: z.number().int().positive(),
  variant: z.number().int().positive().nullable().optional(),
  quantity: z.number().int().min(1).max(99),
});
const items = z.array(item).max(50);
const country = z.string().regex(COUNTRY, "Use a two-letter country code, such as US.");
/** The site language the shopper is reading, on a site with more than one: products are priced and named in it, and their emails written in it. */
const locale = z.string().min(2).max(35).optional();
const address = z.strictObject({
  name: z.string().trim().min(1, "Add a name.").max(200),
  line1: z.string().trim().min(1, "Add the street address.").max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1, "Add the city.").max(120),
  region: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().min(1, "Add the postal code.").max(20),
  phone: z.string().trim().max(40).optional(),
});

/** Turns the CMS into an online shop that takes payment through the Payments plugin. See docs/plugins/shop.md. */
export function shop(options: ShopOptions) {
  const value = optionsSchema.parse({ currency: "usd", ...Object.fromEntries(Object.entries(options).filter(([, option]) => option !== undefined)) });
  const siteUrl = value.siteUrl.replace(/\/$/, "");

  return definePlugin({
    name: "shop",
    messages,
    version: "0.1.0",
    apiVersion: 1,
    requires: { cms: "^0.1.0" },
    admin: { server: "@tansy/shop/admin", client: "@tansy/shop/client", render: "@tansy/shop/render" },
    options: { schema: optionsSchema, value },
    settings: {
      permission: MANAGE,
      fields: [
        { name: "notifyCustomers", type: "boolean", perScope: true, default: true, label: "Email customers", description: "When their order is paid, and when it ships." },
        { name: "notifyStaff", type: "text", perScope: true, default: "", maxLength: 320, label: "Email new orders to", description: "An address that hears about every paid order. Empty for none." },
        { name: "restockOnRefund", type: "boolean", perScope: true, default: true, label: "Restock refunded orders", description: "Put the stock of a fully refunded order back." },
        { name: "cancelUnpaidAfterDays", type: "number", perScope: true, integer: true, min: 1, max: 90, default: 7, label: "Cancel unpaid orders after (days)", description: "Orders nobody paid for are cancelled after this long. A payment that arrives later still counts." },
      ],
    },
    permissions: { "ext.shop": ["fulfill", "manage"] },
    contract: CONTRACT,
    tools: shopTools,
    hooks: {
      "record.beforeCreate": async (context) => {
        if (SLUG_SOURCE[context.collection.slug]) await fillSlug(context);
        else if (context.collection.slug === ORDERS) await prepareOrder(context);
      },
      "record.beforeUpdate": async (context) => {
        if (SLUG_SOURCE[context.collection.slug]) await fillSlug(context);
        else if (context.collection.slug === ORDERS) guardOrder(context);
      },
      "record.afterCreate": async (context) => {
        if (context.collection.slug === PURCHASES) await markPaid(context);
      },
      "record.afterUpdate": async (context) => {
        if (context.collection.slug === PURCHASES) return markRefunded(context);
        if (context.collection.slug !== ORDERS || context.previous?.state === context.record.state) return;
        if (context.record.state === "paid") await fulfilPaid(context, siteUrl);
        else if (context.record.state === "shipped") await notifyShipped(context, siteUrl);
        else if (context.record.state === "refunded") await takeBack(context);
      },
    },
    jobs: [{
      name: "shop-cancel-unpaid",
      cron: "23 * * * *",
      // Each tenant's orders, by its own setting.
      perScope: true,
      handler: async (context) => {
        const cutoff = Date.now() - (await settingsOf(context)).cancelUnpaidAfterDays * 24 * 3600 * 1000;
        const pending = await listAll(context.system.records, ORDERS, { filter: 'state = "pending"', fields: "id,createdAt" }, 5000);
        for (const order of pending) {
          if (Date.parse(str(order.createdAt)) < cutoff) await context.system.records.update(ORDERS, order.id as number, { state: "cancelled" }, { if: { state: "pending" } });
        }
      },
    }],
    routes: [
      defineRoute({
        method: "POST",
        path: "/quote",
        access: "public",
        reason: "Prices a cart before sign-in. Products and variants are read as the caller, so drafts read as missing, and only their public fields and the shipping zones' rates come back.",
        rateLimit: { window: 60, max: 120 },
        body: z.strictObject({ items, country: country.optional(), locale }),
        handler: async (context) => quote(context, context.records, context.body.items, context.body.country ?? null, context.body.locale),
      }),
      defineRoute({
        method: "POST",
        path: "/orders",
        access: "authenticated",
        audit: "shop.order_create",
        rateLimit: { window: 60, max: 20 },
        body: z.strictObject({ items: items.min(1), country: country.optional(), address: address.optional(), locale }),
        handler: async (context) => {
          if (context.principal.kind === "anonymous") return refuse(401, "UNAUTHENTICATED", "Sign in to check out.");
          const { id: customer, email } = context.principal.user;
          // Priced from what's stored, as the caller, whatever the browser thought the prices were.
          const priced = await quote(context, context.records, context.body.items, context.body.country ?? null, context.body.locale);
          if (!priced.ready) return refuse(409, "CART_NOT_READY", priced.problems[0], { quote: priced });
          const problem = await currencyProblem(context, priced.currency, ORDERS);
          if (problem) {
            console.error(`[shop] can't take orders: ${problem}`);
            return refuse(503, "SHOP_NOT_SET_UP", "The shop can't take orders just now. Try again later.");
          }
          if (priced.needsShipping && !context.body.address) return refuse(400, "ADDRESS_REQUIRED", "Add the address to send it to.");
          const lines: OrderLine[] = priced.lines.map((line) => ({
            product: line.product, variant: line.variant, title: line.title, variantTitle: line.variantTitle, sku: line.sku,
            unitPrice: line.unitPrice, quantity: line.quantity, subtotal: line.subtotal, shipping: line.shipping,
          }));
          // One unpaid order at a time: this one replaces any before it. Paying an old one late still counts.
          const unpaid = await listAll(context.system.records, ORDERS, { filter: `customer = "${customer}" && state = "pending"`, fields: "id" }, 200);
          for (const order of unpaid) await context.system.records.update(ORDERS, order.id as number, { state: "cancelled" }, { if: { state: "pending" } });
          const order = await context.system.records.create(ORDERS, {
            status: "published",
            title: orderTitle(lines),
            customer,
            email,
            ...(context.body.locale ? { language: context.body.locale } : {}),
            state: "pending",
            lines,
            subtotal: priced.subtotal,
            shippingCost: priced.shipping,
            total: priced.total,
            currency: priced.currency,
            needsShipping: priced.needsShipping,
            country: priced.needsShipping ? priced.country : null,
            address: priced.needsShipping ? { ...context.body.address, country: priced.country } : null,
          }, { owner: customer });
          context.auditTarget("order", String(order.id), { total: priced.total, currency: priced.currency, lines: lines.length });
          return { order: { id: order.id, total: priced.total, currency: priced.currency } };
        },
      }),
      defineRoute({
        method: "POST",
        path: "/orders/:id/status",
        access: "permission",
        permission: FULFILL,
        audit: "shop.order_status",
        body: z.strictObject({ state: z.enum(["shipped", "delivered"]), trackingUrl: z.url({ protocol: /^https?$/ }).max(2048).optional() }),
        handler: async (context) => {
          const id = /^[1-9]\d{0,15}$/.test(context.params.id ?? "") ? Number(context.params.id) : null;
          const order = id === null ? null : await context.system.records.get(ORDERS, id, { fields: "id,state" }).catch(() => null);
          if (!order) return refuse(404, "NOT_FOUND", "There's no such order.");
          const { state, trackingUrl } = context.body;
          if (order.state === state || !canMove(order.state, state)) return refuse(409, "INVALID_STATE", `An order that's ${str(order.state)} can't be marked ${state}.`);
          const updated = await context.system.records.update(ORDERS, id!, { state, ...(trackingUrl ? { trackingUrl } : {}) }, { if: { state: str(order.state) } });
          if (!updated) return refuse(409, "CHANGED", "The order changed meanwhile. Reload it and try again.");
          context.auditTarget("order", String(id), { from: order.state, to: state });
          return { order: { id, state } };
        },
      }),
    ],
    migrations: [{
      id: "001-collections",
      up: async ({ schema, system, roles }) => {
        if (!(await schema.describe(PURCHASES))) throw new Error("The shop takes payment through the Payments plugin. Add payments() before shop() in tansy.config.ts, then start again.");
        for (const slug of COLLECTIONS) {
          if (await schema.describe(slug)) throw new Error(`A collection called "${slug}" already exists, and the shop plugin didn't create it. Rename it under Dashboard → Collections, then start again.`);
        }
        await schema.apply(shopSchema(value.currency));
        await system.records.create(STORE, { status: "published", title: "Shop", currency: value.currency });
        await system.records.create(CART, { status: "published", title: "Your cart" });
        await system.records.create(ACCOUNT, { status: "published", title: "Your orders" });
        for (const role of shopRoles()) await roles.ensure(role);
      },
    }, {
      // A new shop sends parcels anywhere, free, until the owner changes or replaces this zone.
      id: "002-default-zone",
      up: async ({ schema, system }) => {
        if (!(await schema.describe(ZONES))) return;
        const { totalItems } = await system.records.list(ZONES, { perPage: 1, fields: "id" });
        if (!totalItems) await system.records.create(ZONES, { status: "published", name: "Everywhere", countries: ["*"], rate: 0 });
      },
    }, {
      id: "003-names-in-languages",
      up: async ({ schema }) => {
        for (const [slug, labels] of Object.entries(COLLECTION_LABELS)) await schema.addLabels(slug, labels);
      },
    }, {
      id: "004-field-names-in-languages",
      up: async ({ schema }) => {
        for (const [slug, fields] of Object.entries(FIELD_LABELS)) await schema.addFieldLabels(slug, fields);
        for (const [block, fields] of Object.entries(BLOCK_FIELD_LABELS)) await schema.addBlockFieldLabels(block, fields);
      },
    }, {
      id: "005-order-language",
      up: async ({ schema }) => {
        if (!(await schema.describe(ORDERS))) return;
        await schema.addFields(ORDERS, [LANGUAGE_FIELD]);
        await schema.addFieldLabels(ORDERS, { language: FIELD_LABELS[ORDERS].language });
      },
    }],
  });
}
