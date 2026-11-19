/** Pure helpers, kept apart from the plugin so they're easy to test. */

/** User ids are safe to write inside a filter's quotes. */
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isUserId = (value: unknown): value is string => typeof value === "string" && USER_ID.test(value);

export const COUNTRY = /^[A-Z]{2}$/;

/** ISO 3166-1 country codes, for a zone that ships everywhere. */
export const COUNTRY_CODES = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ " +
  "DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ " +
  "OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ " +
  "UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");
export const CURRENCY = /^[a-z]{3}$/;

export const str = (value: unknown) => (typeof value === "string" ? value : "");
export const idOf = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);

/**
 * Prices are stored as owners type them, such as 19.99. Sums are done in thousandths, which
 * every currency's smallest unit divides, so 0.1 + 0.2 is 0.3 and not 0.30000000000000004.
 */
const MILLI = 1000;
export const toMilli = (amount: number) => Math.round(amount * MILLI);
export const fromMilli = (milli: number) => milli / MILLI;

/** A price that can be charged: a finite number above zero. */
export const priceOf = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

/** A stock count, or null when it isn't counted. */
export const stockOf = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null);

export function slugify(value: string, fallback: string) {
  const slug = value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
  return slug || fallback;
}

export interface CartItem { product: number; variant?: number | null; quantity: number }

/** The same product and variant twice becomes one line, so a stock check sees the whole quantity. */
export function mergeItems(items: CartItem[]): CartItem[] {
  const merged = new Map<string, CartItem>();
  for (const item of items) {
    const key = `${item.product}:${item.variant ?? ""}`;
    const found = merged.get(key);
    if (found) found.quantity += item.quantity;
    else merged.set(key, { product: item.product, variant: item.variant ?? null, quantity: item.quantity });
  }
  return [...merged.values()];
}

export interface Zone { id: number; name: string; countries: string[]; rate: number; freeOver: number | null }

export function zoneOf(value: Record<string, unknown>): Zone | null {
  const id = idOf(value.id);
  const rate = typeof value.rate === "number" && value.rate >= 0 ? value.rate : null;
  if (id === null || rate === null) return null;
  const countries = Array.isArray(value.countries) ? value.countries.filter((code): code is string => typeof code === "string").map((code) => code.trim().toUpperCase()) : [];
  return { id, name: str(value.name), countries, rate, freeOver: priceOf(value.freeOver) };
}

/** A zone that names the country wins over one that covers everywhere else with "*". */
export function zoneFor(zones: Zone[], country: string) {
  return zones.find((zone) => zone.countries.includes(country)) ?? zones.find((zone) => zone.countries.includes("*")) ?? null;
}

/** Every country some zone names, for the cart's country list. "*" means any, so the list is then every country. */
export function shippingCountries(zones: Zone[]): string[] | "any" {
  if (zones.some((zone) => zone.countries.includes("*"))) return "any";
  return [...new Set(zones.flatMap((zone) => zone.countries).filter((code) => COUNTRY.test(code)))].sort();
}

export const shippingCost = (zone: Zone, subtotal: number) => (zone.freeOver !== null && toMilli(subtotal) >= toMilli(zone.freeOver) ? 0 : zone.rate);

/** One line of an order, as stored on it: what was bought and at what price, whatever happens to the product later. */
export interface OrderLine {
  product: number;
  variant: number | null;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  unitPrice: number;
  quantity: number;
  subtotal: number;
  shipping: boolean;
}

export const lineSubtotal = (unitPrice: number, quantity: number) => fromMilli(toMilli(unitPrice) * quantity);
export const sum = (amounts: number[]) => fromMilli(amounts.reduce((total, amount) => total + toMilli(amount), 0));

/** Lines read back from an order. Anything malformed is dropped, as staff may have edited the JSON. */
export function linesOf(value: unknown): OrderLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((line) => {
    const row = (line ?? {}) as Record<string, unknown>;
    const product = idOf(row.product);
    const quantity = typeof row.quantity === "number" && Number.isSafeInteger(row.quantity) && row.quantity > 0 ? row.quantity : null;
    const unitPrice = priceOf(row.unitPrice);
    if (product === null || quantity === null || unitPrice === null) return [];
    return [{
      product,
      variant: idOf(row.variant),
      title: str(row.title),
      variantTitle: str(row.variantTitle) || null,
      sku: str(row.sku) || null,
      unitPrice,
      quantity,
      subtotal: lineSubtotal(unitPrice, quantity),
      shipping: row.shipping === true,
    }];
  });
}

/** What the payment provider's checkout calls an order, such as "T-shirt (Medium) × 2, Mug". */
export function orderTitle(lines: OrderLine[]) {
  const named = lines.map((line) => `${line.title}${line.variantTitle ? ` (${line.variantTitle})` : ""}${line.quantity > 1 ? ` × ${line.quantity}` : ""}`).join(", ");
  return named.length > 250 ? `${named.slice(0, 247)}…` : named || "Order";
}

export type OrderState = "pending" | "paid" | "shipped" | "delivered" | "cancelled" | "refunded";

/**
 * Where an order may go from each state. Forward only: a payment that arrives after an
 * unpaid order was cancelled still counts, and refunds come from the payment provider.
 */
export const NEXT_STATES: Record<OrderState, OrderState[]> = {
  pending: ["paid", "cancelled"],
  cancelled: ["paid"],
  paid: ["shipped", "delivered", "refunded"],
  shipped: ["delivered", "refunded"],
  delivered: ["refunded"],
  refunded: [],
};

export const isOrderState = (value: unknown): value is OrderState => typeof value === "string" && Object.hasOwn(NEXT_STATES, value);

export function canMove(from: unknown, to: unknown) {
  if (from === to) return true;
  return isOrderState(from) && isOrderState(to) && NEXT_STATES[from].includes(to);
}

/** When each state was reached, set by the move into it. */
export const STAMPS: Partial<Record<OrderState, string>> = { paid: "paidAt", shipped: "shippedAt", delivered: "deliveredAt" };

export interface Address { name: string; line1: string; line2?: string; city: string; region?: string; postalCode: string; country: string; phone?: string }

/** A money amount as people read it, such as $19.99. A fixed locale by default, so the server and the browser agree. */
export function formatMoney(amount: number, currency: string, locale = "en-US") {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase() }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
  }
}
