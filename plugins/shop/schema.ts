import type { PluginRole } from "tansy/plugin";

/** The collections the shop creates on first install. Owners can change all of it afterwards. */

export const PRODUCTS = "shop-products";
export const VARIANTS = "shop-variants";
export const CATEGORIES = "shop-categories";
export const ZONES = "shop-shipping-zones";
export const ORDERS = "shop-orders";
/** Singletons: the shop's front page, the cart page and the customer's orders page. */
export const STORE = "shop-store";
export const CART = "shop-cart";
export const ACCOUNT = "shop-account";

export const COLLECTIONS = [PRODUCTS, VARIANTS, CATEGORIES, ZONES, ORDERS, STORE, CART, ACCOUNT] as const;

/** Payments' price field type and purchases. The shop reads them as data and never imports Payments. */
export const PRICE_TYPE = "payments_price";
export const PURCHASES = "payments-purchases";

export const ORDER_STATES = [
  { label: "Awaiting payment", value: "pending" },
  { label: "Paid", value: "paid" },
  { label: "Shipped", value: "shipped" },
  { label: "Delivered", value: "delivered" },
  { label: "Cancelled", value: "cancelled" },
  { label: "Refunded", value: "refunded" },
];

/** The language the customer shopped in, so their emails are in it. Added to existing shops by migration 005. */
export const LANGUAGE_FIELD = { name: "language", type: "text", config: { maxLength: 35, description: "The language the customer shopped in. Their emails about the order are in it." } };

/** A field the plugin's code reads or writes, by collection: the contract Extensions checks. */
export const CONTRACT = {
  [PRODUCTS]: { title: "text", slug: "text", price: "number", compareAtPrice: "number", sku: "text", stock: "number", shipping: "boolean", images: "gallery", categories: "reference", download: "file" },
  [VARIANTS]: { product: "reference", title: "text", sku: "text", price: "number", stock: "number" },
  [CATEGORIES]: { name: "text", slug: "text" },
  [ZONES]: { name: "text", countries: "json", rate: "number", freeOver: "number" },
  [ORDERS]: { title: "text", customer: "text", email: "email", language: "text", lines: "json", subtotal: "number", shippingCost: "number", total: PRICE_TYPE, currency: "text", country: "text", address: "json", needsShipping: "boolean", state: "radio", trackingUrl: "url", paidAt: "datetime", shippedAt: "datetime", deliveredAt: "datetime", downloads: "gallery", flag: "text" },
  [STORE]: { title: "text", currency: "text" },
};

const LOCKED = { createRule: null, updateRule: null, deleteRule: null };
const PUBLIC = { listRule: "", viewRule: "", ...LOCKED };
const PUBLISHED = { listRule: 'status = "published"', viewRule: 'status = "published"', ...LOCKED };
/** Only the customer reads their orders. Nobody but staff and the plugin writes them. */
const OWN = 'customer = @request.auth.id && @request.auth.id != ""';

/** Filled from the title or name when left empty, so it isn't required. */
const SLUG_FIELD = {
  name: "slug",
  type: "text",
  config: { unique: true, maxLength: 80, pattern: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$", patternError: "Use lowercase letters, numbers and hyphens, starting and ending with a letter or number." },
};

const money = (name: string, description: string, required = false) => ({ name, type: "number", config: { min: 0, max: 1_000_000, required, description } });
const stock = { name: "stock", type: "number", config: { format: "integer", min: 0, description: "How many are left. Empty means it isn't counted and never runs out." } };

/** Who runs the shop. Created once, then owners change it under Roles like any other. */
export function shopRoles(): PluginRole[] {
  const editable = [PRODUCTS, VARIANTS, CATEGORIES, ZONES, STORE, CART, ACCOUNT];
  return [{
    name: "shop-manager",
    label: "Shop manager",
    description: "Edits products, stock, categories and shipping, ships orders and changes the shop's settings. Refunds stay with the payment provider.",
    permissions: ["dashboard:access", "collection:read", "file:list", "file:read", "file:create", "file:delete", "ext.shop:fulfill", "ext.shop:manage"],
    records: { ...Object.fromEntries(editable.map((slug) => [slug, ["list", "read", "create", "update", "delete"]])), [ORDERS]: ["list", "read", "update"] },
  }];
}

export function shopSchema(currency: string) {
  return {
    version: 1,
    collections: [
      {
        slug: PRODUCTS,
        name: "Products",
        description: "What the shop sells. Give a product variants for sizes or colours, each with its own price and stock.",
        urlPattern: "/shop/:slug",
        rules: PUBLISHED,
        fields: [
          { name: "title", type: "text", config: { required: true, maxLength: 200, searchable: true } },
          SLUG_FIELD,
          { name: "summary", type: "text", config: { multiline: true, maxLength: 500, searchable: true } },
          { name: "images", type: "gallery", config: { allowedTypes: ["image/*"], maxItems: 20, description: "The first one is the product's picture in lists." } },
          money("price", "In the shop's currency, as people pay it, such as 19.99.", true),
          money("compareAtPrice", "A higher, earlier price, shown struck through."),
          { name: "sku", type: "text", config: { maxLength: 64 } },
          stock,
          { name: "categories", type: "reference", config: { collection: CATEGORIES, displayField: "name", allowMultiple: true } },
          { name: "shipping", type: "boolean", config: { defaultValue: true, description: "It's sent by post. Leave off for downloads and services." } },
          { name: "weightGrams", type: "number", config: { format: "integer", min: 0 } },
          { name: "download", type: "file", config: { hidden: true, description: "Given to buyers once they've paid. Hidden from everyone else." } },
          { name: "description", type: "stream", config: {} },
        ],
      },
      {
        slug: VARIANTS,
        name: "Variants",
        description: "One kind of a product, such as Medium / Blue. A product with published variants is bought by variant.",
        urlPattern: null,
        rules: PUBLISHED,
        fields: [
          { name: "product", type: "reference", config: { collection: PRODUCTS, displayField: "title", required: true } },
          { name: "title", type: "text", config: { required: true, maxLength: 120, description: "What buyers choose, such as Medium / Blue." } },
          { name: "sku", type: "text", config: { maxLength: 64 } },
          money("price", "Empty for the product's price."),
          stock,
          { name: "image", type: "image", config: {} },
          { name: "position", type: "number", config: { format: "integer", min: 0, description: "Lower comes first." } },
        ],
      },
      {
        slug: CATEGORIES,
        name: "Categories",
        description: "Groups of products, each with its own page.",
        urlPattern: "/shop/category/:slug",
        rules: PUBLISHED,
        fields: [
          { name: "name", type: "text", config: { required: true, maxLength: 120 } },
          SLUG_FIELD,
          { name: "description", type: "text", config: { multiline: true, maxLength: 1000 } },
          { name: "image", type: "image", config: {} },
        ],
      },
      {
        slug: ZONES,
        name: "Shipping zones",
        description: "Where the shop sends parcels, and what it costs. A country in no zone can't order things that ship.",
        urlPattern: null,
        rules: PUBLIC,
        fields: [
          { name: "name", type: "text", config: { required: true, maxLength: 120 } },
          { name: "countries", type: "json", config: { description: 'Two-letter country codes, such as ["US", "CA"]. ["*"] is everywhere no other zone covers.' } },
          money("rate", "What shipping an order costs.", true),
          money("freeOver", "Shipping is free when the items come to at least this. Empty for never."),
        ],
      },
      {
        slug: ORDERS,
        name: "Orders",
        description: "Made at checkout, priced from the products as they were then. Payment marks them paid. Ship them from the Shop section. Refunds happen with the payment provider and show here.",
        urlPattern: null,
        rules: { listRule: OWN, viewRule: OWN, ...LOCKED },
        fields: [
          { name: "title", type: "text", config: { required: true, maxLength: 250, description: "What the checkout page calls it." } },
          { name: "customer", type: "text", config: { required: true, maxLength: 64, label: "Customer (user id)" } },
          { name: "email", type: "email", config: {} },
          LANGUAGE_FIELD,
          { name: "state", type: "radio", config: { options: ORDER_STATES, defaultValue: "pending" } },
          { name: "lines", type: "json", config: { description: "What was ordered, at the prices it was ordered at." } },
          money("subtotal", "The items."),
          money("shippingCost", "Shipping."),
          { name: "total", type: PRICE_TYPE, config: { currency, once: true, description: "What the customer pays. Payments charges this." } },
          { name: "currency", type: "text", config: { maxLength: 3 } },
          { name: "needsShipping", type: "boolean", config: {} },
          { name: "country", type: "text", config: { maxLength: 2 } },
          { name: "address", type: "json", config: {} },
          { name: "trackingUrl", type: "url", config: { allowedProtocols: ["https", "http"] } },
          { name: "downloads", type: "gallery", config: { layout: "list", description: "Files the customer gets, from the products' downloads, once paid." } },
          { name: "paidAt", type: "datetime", config: {} },
          { name: "shippedAt", type: "datetime", config: {} },
          { name: "deliveredAt", type: "datetime", config: {} },
          { name: "flag", type: "text", config: { maxLength: 500, description: "Something staff should look at, such as stock running out after payment." } },
          { name: "staffNotes", type: "text", config: { multiline: true, maxLength: 5000, hidden: true } },
        ],
      },
      {
        slug: STORE,
        name: "Shop page",
        description: "The shop's front page, listing its products. Its currency is the one prices are in.",
        type: "singleton",
        urlPattern: "/shop",
        rules: PUBLIC,
        fields: [
          { name: "title", type: "text", config: { required: true, maxLength: 120 } },
          { name: "intro", type: "rich_text", config: {} },
          { name: "currency", type: "text", config: { required: true, maxLength: 3, pattern: "^[a-z]{3}$", patternError: 'A three-letter code in lowercase, such as "usd".', description: "What prices are in. Orders' total field must use the same currency." } },
        ],
      },
      {
        slug: CART,
        name: "Cart page",
        description: "Where people see their cart, choose where it goes, and check out.",
        type: "singleton",
        urlPattern: "/cart",
        rules: PUBLIC,
        fields: [
          { name: "title", type: "text", config: { required: true, maxLength: 120 } },
          { name: "intro", type: "rich_text", config: {} },
        ],
      },
      {
        slug: ACCOUNT,
        name: "Orders page",
        description: "Where signed-in customers see their orders, tracking and downloads.",
        type: "singleton",
        urlPattern: "/orders",
        rules: PUBLIC,
        fields: [
          { name: "title", type: "text", config: { required: true, maxLength: 120 } },
          { name: "intro", type: "rich_text", config: {} },
        ],
      },
    ],
    // Here rather than in the plugin's blocks, because they link to collections this document creates.
    blocks: [
      {
        name: "shop_products",
        label: "Products",
        labels: { ar: "المنتجات" },
        icon: null,
        fields: [
          { name: "title", type: "text", config: { maxLength: 120 } },
          { name: "category", type: "reference", config: { collection: CATEGORIES, displayField: "name", description: "Empty for the newest products." } },
          { name: "limit", type: "number", config: { format: "integer", min: 1, max: 24 } },
        ],
      },
      {
        name: "shop_add_to_cart",
        label: "Add to cart",
        labels: { ar: "أضف إلى السلة" },
        icon: null,
        fields: [{ name: "product", type: "reference", config: { collection: PRODUCTS, displayField: "title", required: true } }],
      },
    ],
  };
}
