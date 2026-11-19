import type { ExtensionContext, RecordsApi, RecordValues } from "tansy/plugin";
import {
  COUNTRY, CURRENCY, idOf, lineSubtotal, mergeItems, priceOf, shippingCost, shippingCountries, stockOf, str, sum, zoneFor, zoneOf,
  type CartItem, type OrderLine, type Zone,
} from "./logic";
import { PRICE_TYPE, PRODUCTS, STORE, VARIANTS, ZONES } from "./schema";

/** The shop's settings, as saved under Shop → Settings. */
export interface ShopSettings { restockOnRefund: boolean; cancelUnpaidAfterDays: number; notifyCustomers: boolean; notifyStaff: string }

export const settingsOf = async (context: ExtensionContext) => (await context.settings.get()) as unknown as ShopSettings;

/** Up to `limit` records, a page at a time. */
export async function listAll(records: RecordsApi, slug: string, query: Record<string, unknown>, limit = 2000) {
  const rows: RecordValues[] = [];
  for (let page = 1; rows.length < limit; page++) {
    const result = await records.list(slug, { ...query, page, perPage: 200 });
    rows.push(...result.items);
    if (page >= result.totalPages) break;
  }
  return rows;
}

/** Ids joined into a filter. They're numbers, so nothing can break out of it. */
const anyOf = (field: string, ids: number[]) => [...new Set(ids)].map((id) => `${field} = ${id}`).join(" || ");

/** The currency prices are in, from the shop page, which anyone may read. */
export async function storeCurrency(context: ExtensionContext) {
  const { items } = await context.system.records.list(STORE, { perPage: 1, fields: "currency" });
  const currency = str(items[0]?.currency).toLowerCase();
  return CURRENCY.test(currency) ? currency : null;
}

/**
 * What Payments will charge an order in: its total field's currency. Null when that's the
 * shop's currency, or a sentence for staff when they differ, as an order priced in one
 * currency must not be charged in another.
 */
export async function currencyProblem(context: ExtensionContext, currency: string | null, ordersSlug: string) {
  if (!currency) return 'The shop has no currency. Set one on the Shop page, such as "usd".';
  const total = (await context.schema.describe(ordersSlug))?.fields.find((field) => field.type === PRICE_TYPE);
  if (!total) return "Orders have no Price field, so they can't be paid. Is the Payments plugin installed?";
  const charged = str(total.config.currency);
  if (charged && charged !== currency) return `Prices are in ${currency.toUpperCase()} and orders are charged in ${charged.toUpperCase()}. Set the same currency on the Shop page and on Orders' ${total.name} field.`;
  return null;
}

export const loadZones = async (context: ExtensionContext): Promise<Zone[]> =>
  (await listAll(context.system.records, ZONES, { fields: "id,name,countries,rate,freeOver" }, 500)).map(zoneOf).filter((zone) => zone !== null);

/** Why something can't be bought, as a key under `shop.issues` in the shop's site words, so the cart shows it in the shopper's language. */
export interface Issue { code: string; values?: Record<string, number> }

export interface QuoteLine extends OrderLine {
  /** Whether it can be bought as asked. */
  available: boolean;
  /** In English, for API callers. */
  problem: string | null;
  issue: Issue | null;
  href: string | null;
  image: string | null;
}

export interface Quote {
  currency: string | null;
  lines: QuoteLine[];
  subtotal: number;
  needsShipping: boolean;
  country: string | null;
  /** Null until a country is known, or when it can't be shipped to. */
  shipping: number | null;
  total: number | null;
  countries: string[] | "any";
  /** Why it can't be ordered yet, for the whole cart, in English. `issues` says the same as keys. */
  problems: string[];
  issues: Issue[];
  ready: boolean;
}

/** The English for each issue. The cart shows the shop's site words instead. */
const ENGLISH: Record<string, string> = {
  missing: "This is no longer for sale.",
  chooseOption: "Choose an option.",
  soldOut: "Sold out.",
  onlyLeft: "Only {count} left.",
  noZones: "The shop doesn't send parcels anywhere yet.",
  chooseCountry: "Choose where to send it.",
  noZone: "The shop doesn't send parcels there.",
  empty: "Your cart is empty.",
  unavailable: "Remove or change what can't be bought.",
  closed: "The shop isn't open yet.",
};
const english = ({ code, values }: Issue) => ENGLISH[code].replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? ""));

/**
 * Prices a cart from what's stored, never from the request. Products and variants are read
 * through `records`, so in a route as the caller: a draft reads as missing. Stock is
 * checked as it stands now. It's taken only once the order is paid.
 */
export async function quote(context: ExtensionContext, records: RecordsApi, items: CartItem[], country: string | null, locale?: string): Promise<Quote> {
  // Names in the shopper's language. An unknown language is refused as the records API refuses it.
  const inLanguage = locale ? { locale } : {};
  const wanted = mergeItems(items);
  const productIds = wanted.map((item) => item.product);
  const [currency, zones, products, variants] = await Promise.all([
    storeCurrency(context),
    loadZones(context),
    productIds.length ? records.list(PRODUCTS, { filter: anyOf("id", productIds), perPage: 200, fields: "id,title,price,sku,stock,shipping,images", urls: "1", ...inLanguage }).then((r) => r.items) : [],
    // Every published variant of these products, so a product that has some is bought by variant.
    productIds.length ? listAll(records, VARIANTS, { filter: anyOf("product", productIds), fields: "id,product,title,sku,price,stock,image", ...inLanguage }, 1000) : [],
  ]);
  const byId = new Map(products.map((product) => [product.id as number, product]));

  const lines: QuoteLine[] = wanted.map((item) => {
    const product = byId.get(item.product);
    const own = variants.filter((variant) => variant.product === item.product);
    const variant = item.variant ? own.find((candidate) => candidate.id === item.variant) : undefined;
    const images = Array.isArray(product?.images) ? product.images.filter((id): id is string => typeof id === "string") : [];
    const base = {
      product: item.product,
      variant: variant ? (variant.id as number) : null,
      title: str(product?.title) || `Product ${item.product}`,
      variantTitle: variant ? str(variant.title) : null,
      sku: str(variant?.sku) || str(product?.sku) || null,
      quantity: item.quantity,
      shipping: product?.shipping !== false,
      href: str(product?.recordPath) || null,
      image: str(variant?.image) || images[0] || null,
    };
    const unitPrice = priceOf(variant?.price) ?? priceOf(product?.price);
    const fail = (issue: Issue): QuoteLine => ({ ...base, unitPrice: unitPrice ?? 0, subtotal: lineSubtotal(unitPrice ?? 0, item.quantity), available: false, problem: english(issue), issue });
    if (!product || (item.variant && !variant)) return fail({ code: "missing" });
    if (own.length && !variant) return fail({ code: "chooseOption" });
    if (unitPrice === null) return fail({ code: "missing" });
    const stock = stockOf(variant ? variant.stock : product.stock);
    if (stock !== null && stock < item.quantity) return fail(stock === 0 ? { code: "soldOut" } : { code: "onlyLeft", values: { count: stock } });
    return { ...base, unitPrice, subtotal: lineSubtotal(unitPrice, item.quantity), available: true, problem: null, issue: null };
  });

  const subtotal = sum(lines.filter((line) => line.available).map((line) => line.subtotal));
  const needsShipping = lines.some((line) => line.available && line.shipping);
  const issues: Issue[] = [];
  let shipping: number | null = needsShipping ? null : 0;
  const place = country && COUNTRY.test(country) ? country : null;
  if (needsShipping) {
    const zone = place ? zoneFor(zones, place) : null;
    if (!zones.length) issues.push({ code: "noZones" });
    else if (!place) issues.push({ code: "chooseCountry" });
    else if (!zone) issues.push({ code: "noZone" });
    else shipping = shippingCost(zone, subtotal);
  }
  if (!lines.length) issues.push({ code: "empty" });
  if (lines.some((line) => !line.available)) issues.push({ code: "unavailable" });
  if (!currency) issues.push({ code: "closed" });
  return {
    currency,
    lines,
    subtotal,
    needsShipping,
    country: place,
    shipping,
    total: shipping === null ? null : sum([subtotal, shipping]),
    countries: shippingCountries(zones),
    problems: issues.map(english),
    issues,
    ready: issues.length === 0,
  };
}

/** The target of a line's stock: its variant, or the product when it has none. */
const stockTarget = (line: OrderLine) => (line.variant ? { slug: VARIANTS, id: line.variant } : { slug: PRODUCTS, id: line.product });

/**
 * Changes a stock count by `delta` without losing a concurrent change: each write applies
 * only while the count is still what was read. Uncounted stock is left alone. Returns how
 * many it couldn't take, as payment can't be undone when stock has run out meanwhile.
 */
export async function adjustStock(context: ExtensionContext, slug: string, id: number, delta: number): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const record = await context.system.records.get(slug, id, { fields: "stock" }).catch(() => null);
    const stock = record ? stockOf(record.stock) : null;
    if (stock === null || typeof record?.stock !== "number") return 0;
    const next = Math.max(0, stock + delta);
    const written = await context.system.records.update(slug, id, { stock: next }, { if: { stock: record.stock } });
    if (written) return stock + delta < 0 ? -(stock + delta) : 0;
  }
  throw new Error(`Stock of ${slug} ${id} kept changing. Retrying.`);
}

/**
 * Takes each line's stock for a paid order. A durable hook may run this again, so each
 * line is claimed first and taken once. Returns what ran short, for staff.
 */
export async function takeStock(context: ExtensionContext, orderId: number, lines: OrderLine[]) {
  const short: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!(await context.store.claim(`stock:${orderId}:${index}`, { at: Date.now() }))) continue;
    const { slug, id } = stockTarget(line);
    const missing = await adjustStock(context, slug, id, -line.quantity);
    if (missing) short.push(`${line.title}${line.variantTitle ? ` (${line.variantTitle})` : ""}: ${missing} short`);
  }
  return short;
}

/** Puts back the stock a refunded order took. Only lines whose stock was taken, and each once. */
export async function restock(context: ExtensionContext, orderId: number, lines: OrderLine[]) {
  for (const [index, line] of lines.entries()) {
    if (!(await context.store.get(`stock:${orderId}:${index}`))) continue;
    if (!(await context.store.claim(`restock:${orderId}:${index}`, { at: Date.now() }))) continue;
    const { slug, id } = stockTarget(line);
    await adjustStock(context, slug, id, line.quantity);
  }
}

/** The files buyers get: each bought product's download, read past the rule that hides it. */
export async function downloadsFor(context: ExtensionContext, lines: OrderLine[]) {
  const ids = [...new Set(lines.map((line) => line.product))];
  if (!ids.length) return [];
  const fields = new Set((await context.schema.describe(PRODUCTS))?.fields.map((field) => field.name) ?? []);
  if (!fields.has("download")) return [];
  const { items } = await context.system.records.list(PRODUCTS, { filter: anyOf("id", ids), perPage: 200, fields: "id,download" });
  return [...new Set(items.map((item) => str(item.download)).filter(Boolean))];
}

export { idOf };
