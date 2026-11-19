import { defineTheme, type ThemeQuery } from "tansy/theme";
import { z } from "zod";
import schema from "./schema.json";

export interface StorefrontOptions {
  /** Replaces the words under the front page's heading. Owners can also change them per language under Languages → Site text. */
  tagline?: string;
  /** The product search box on the front page. It searches products through the records API, as a visitor. */
  search: boolean;
  /** An orders button in the header, for shops whose customers sign in to see their orders. */
  accountLinks: boolean;
  /** "auto" follows the visitor's light or dark setting. "light" always shows the light colours. */
  colorScheme: "auto" | "light";
}

const options = z.object({
  tagline: z.string().max(300).optional(),
  search: z.boolean(),
  accountLinks: z.boolean(),
  colorScheme: z.enum(["auto", "light"]),
});

/** What a card shows. Kept short, as every list here is read on every visit. */
const CARD_FIELDS = "id,title,summary,price,compareAtPrice,images,stock,categories";
const CARD = { collection: "shop-products", sort: "-createdAt", fields: CARD_FIELDS, urls: "1" } as const satisfies ThemeQuery;
const CATEGORIES: ThemeQuery = { collection: "shop-categories", sort: "name", perPage: 50, fields: "id,name", urls: "1" };
/** The Shop page, for its currency and its address. Replaces the plugin's `store`, which reads the currency alone. */
const STORE: ThemeQuery = { collection: "shop-store", perPage: 1, fields: "id,currency", urls: "1" };
const PER_PAGE = 12;

/** The front page, at the site's root and at the shop's own address. `products` replaces the shop plugin's list of the same name, to add summaries and categories. */
const FRONT: Record<string, ThemeQuery> = {
  store: STORE,
  products: { ...CARD, perPage: PER_PAGE, paged: true },
  categories: CATEGORIES,
};

/**
 * A storefront look for the shop plugin: soft rounded product cards, a product page with an
 * image stage, option chips and a quantity stepper, and a two-column cart. Checkout, orders
 * and the cart itself are the plugin's parts, so they behave as on the plugin's own pages.
 */
export const storefront = ({ tagline, search = true, accountLinks = true, colorScheme = "auto" }: Partial<StorefrontOptions> = {}) => defineTheme<StorefrontOptions>({
  name: "storefront",
  version: "0.1.0",
  apiVersion: 1,
  render: "@tansy/theme-storefront/render",
  requires: { plugins: ["shop"] },
  options: { schema: options, value: { tagline, search, accountLinks, colorScheme } },
  schema,
  tokens: {
    color: {
      page: "#ffffff",
      surface: "#f2f3f2",
      text: "#121413",
      muted: "#6a706d",
      border: "#e6e8e7",
      accent: "#3d8a6e",
      "on-accent": "#ffffff",
    },
    font: { body: "var(--storefront-font), system-ui, sans-serif" },
    size: { measure: "46rem", wide: "80rem" },
    space: { gutter: "1.25rem", gap: "1.5rem", section: "4.5rem" },
    radius: { card: "2rem", control: "999px" },
    shadow: { card: "0 18px 48px rgba(18, 20, 19, 0.08)" },
  },
  singletons: ["site-menu"],
  queries: {
    home: FRONT,
    "shop-store": FRONT,
    "shop-categories": {
      store: STORE,
      products: { ...CARD, filter: "categories ?= @record.id", perPage: PER_PAGE, paged: true },
      categories: CATEGORIES,
    },
    // Beside the plugin's own `variants`, which the buy box reads.
    "shop-products": {
      store: STORE,
      related: { ...CARD, filter: "categories ?= @record.categories && id != @record.id", perPage: 4 },
      latest: { ...CARD, filter: "id != @record.id", perPage: 4 },
      categories: CATEGORIES,
    },
  },
});
