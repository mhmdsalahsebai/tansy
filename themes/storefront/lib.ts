import type { TemplateProps } from "tansy/theme";

/** Joins class names, skipping the empty ones. */
export const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

export const text = (value: unknown) => (typeof value === "string" ? value : "");
export const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
export const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is number => typeof id === "number") : typeof value === "number" ? [value] : []);
export const fileIds = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);

/** A price in the shop's currency, in the page's language. A currency Intl doesn't know still shows the amount. */
export function money(formatNumber: TemplateProps["formatNumber"], amount: number, currency: string) {
  try {
    return formatNumber(amount, { style: "currency", currency: currency.toUpperCase() });
  } catch {
    return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/** The id of a product's card in a list, which a back arrow returns to. */
export const cardAnchor = (id: number | string) => `sf-item-${id}`;
