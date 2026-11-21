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
  /**
   * The members' library: a Library tab and header link, for shops that sell memberships through
   * Payments whose members read digital editions free. Its page is at /library.
   */
  library: boolean;
  /** "auto" follows the visitor's light or dark setting. "light" always shows the light colours. */
  colorScheme: "auto" | "light";
}

const options = z.object({
  tagline: z.string().max(300).optional(),
  search: z.boolean(),
  accountLinks: z.boolean(),
  library: z.boolean(),
  colorScheme: z.enum(["auto", "light"]),
});

/** What a card shows. Kept short, as every list here is read on every visit. */
const CARD_FIELDS = "id,title,summary,price,compareAtPrice,images,stock,categories,format,membership";
const CARD = { collection: "shop-products", sort: "-createdAt", fields: CARD_FIELDS, urls: "1" } as const satisfies ThemeQuery;
const CATEGORIES: ThemeQuery = { collection: "shop-categories", sort: "name", perPage: 50, fields: "id,name", urls: "1" };
/** The Shop page, for its currency and its address. Replaces the plugin's `store`, which reads the currency alone. */
const STORE: ThemeQuery = { collection: "shop-store", perPage: 1, fields: "id,currency", urls: "1" };
const PER_PAGE = 12;

/**
 * Memberships, from Payments: what each access is called, and the published plans that sell it.
 * Both are public, for a pricing page. Only the library files themselves are for members.
 */
const ACCESS: ThemeQuery = { collection: "payments-access", perPage: 50, fields: "id,name,description" };
const PLANS: ThemeQuery = { collection: "payments-plans", filter: 'status = "published"', sort: "amount", perPage: 12, fields: "id,name,title,description,amount,annualAmount,currency,featured,includes" };
/** The library files the signed-in visitor's membership opens, read as them, so the rule decides. Empty for everyone else. */
const OPEN_FILES: ThemeQuery = { collection: "library-files", perPage: 200, fields: "id,product,label,file", viewer: true };

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
export const storefront = ({ tagline, search = true, accountLinks = true, library = false, colorScheme = "auto" }: Partial<StorefrontOptions> = {}) => defineTheme<StorefrontOptions>({
  name: "storefront",
  version: "0.1.0",
  apiVersion: 1,
  render: "@tansy/theme-storefront/render",
  requires: { plugins: ["shop"] },
  options: { schema: options, value: { tagline, search, accountLinks, library, colorScheme } },
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
      access: ACCESS,
      plans: PLANS,
      files: { ...OPEN_FILES, filter: "product = @record.id" },
      related: { ...CARD, filter: "categories ?= @record.categories && id != @record.id", perPage: 4 },
      latest: { ...CARD, filter: "id != @record.id", perPage: 4 },
      categories: CATEGORIES,
    },
    // The members' library: every product in a membership, the plans, and what the visitor may open.
    library: {
      store: STORE,
      books: { ...CARD, filter: "membership:length > 0", perPage: 48 },
      access: ACCESS,
      plans: PLANS,
      files: OPEN_FILES,
      categories: CATEGORIES,
    },
  },
});
