---
title: "Shop plugin (`@tansy/shop`)"
description: "Installing it turns the CMS into an online shop: products with variants and stock, categories, a cart, shipping zones, orders, fulfilment and downloads. Money goes through the Payments plugin, which it requires."
---

Installing it turns the CMS into an online shop: products with variants and stock, categories, a cart, shipping zones, orders, fulfilment and downloads. Money goes through the Payments plugin, which it requires.

```ts
// tansy.config.ts
import { payments } from "@tansy/payments";
import { stripe } from "@tansy/payments-stripe";
import { shop } from "@tansy/shop";

plugins: [
  payments({ siteUrl: "https://example.com", providers: [stripe()] }),
  shop({ siteUrl: "https://example.com", currency: "usd" }),
]
```

Payments must come first: the Shop's first migration stops startup with a clear message when it isn't installed. In the starter, `TANSY_PLUGIN_PAYMENTS=true` and `TANSY_PLUGIN_SHOP=true`.

## 1. The approach

Payments sells one record per checkout, priced from the stored record, and records the purchase from the provider's webhook. A cart is many things, a quantity of each, and shipping. So the cart becomes a record: the Shop prices it on the server into a `shop-orders` record whose `total` is a `payments_price` field, and Payments sells that record like any other. When Payments records the purchase, the Shop's durable hook marks the order paid, and everything else follows from the order's state.

That needs nothing from Payments or core beyond what they already offer:

| Need | What provides it |
|---|---|
| Charging the right amount | Payments reads `total` from the stored order, as the caller. The Shop prices the order from stored products, never from the request |
| Only the customer pays for their order | The order's view rule is `customer = @request.auth.id`, and Payments reads the order as the caller |
| Knowing it's paid | A `record.afterCreate` hook on `payments-purchases` (durable, C12) |
| Paid once, however often the webhook repeats | Purchases are unique by session, and the order moves to `paid` with a conditional update (C13) |
| Knowing a state changed | `previous` on `record.afterUpdate` (C8) |
| Stock that can't be double-counted | Conditional updates on the stock count (C13), and `store.claim` per order line, so a retried hook takes stock once |
| Buyer-only downloads | A hidden `download` file on the product, copied to the order once paid. Core file rules let whoever may view a record read its files, and hidden fields don't count |
| Emails | `mail.send` (C2) |
| Site pages | Plugin templates (C1), with the orders page read as the viewer (C9) |

Product prices are plain number fields, not `payments_price`. Only orders are for sale through Payments, so nothing can be bought around the cart's stock and shipping checks.

## 2. Collections

Rules are `list / view / create / update / delete`. `null` means locked.

| Collection | URL | Rules | Contract fields |
|---|---|---|---|
| `shop-products` | `/shop/:slug` | `status = "published"` ×2, `null` ×3 | `title`, `slug` (filled from the title), `price`, `compareAtPrice`, `sku`, `stock` (empty: not counted), `shipping` (boolean), `images` (gallery), `categories` (references), `download` (hidden file) |
| `shop-variants` | none | `status = "published"` ×2, `null` ×3 | `product`, `title` ("Medium / Blue"), `sku`, `price` (empty: the product's), `stock` |
| `shop-categories` | `/shop/category/:slug` | `status = "published"` ×2, `null` ×3 | `name`, `slug` |
| `shop-shipping-zones` | none | `""` ×2, `null` ×3 | `name`, `countries` (`["US", "CA"]`, or `["*"]` for everywhere else), `rate`, `freeOver` |
| `shop-orders` | none | `customer = @request.auth.id` ×2, `null` ×3 | `title`, `customer`, `email`, `state`, `lines` (json), `subtotal`, `shippingCost`, `total` (`payments_price`), `currency`, `needsShipping`, `country`, `address` (json), `trackingUrl`, `downloads`, `paidAt`, `shippedAt`, `deliveredAt`, `flag`, and hidden `staffNotes` |
| `shop-store` (singleton) | `/shop` | `""` ×2, `null` ×3 | `title`, `intro`, `currency` |
| `shop-cart` (singleton) | `/cart` | public | `title`, `intro` |
| `shop-account` (singleton) | `/orders` | public | `title`, `intro` |

Owners can add fields, change URL patterns and tighten rules like on any collection. A product with published variants is bought by variant.

**Shipping zones.** A new shop gets one zone, **Everywhere** (`["*"]`, free), so it can take orders from the start. Change its rate, or replace it with zones of your own. With no zones at all, things that ship can't be ordered, and the cart says so.

**Currency.** Prices are in the Shop page's `currency`. Payments charges an order in its `total` field's currency. Both are set from the `currency` option on install. If they're later changed apart, checkout refuses with 503 and logs which to fix, so an order priced in one currency is never charged in another.

**The cart** lives in the browser's storage, so it works before sign-in. Checkout prices it again on the server.

## 3. Order lifecycle

```
cart ─▶ POST /api/ext/shop/orders ─▶ order: pending ─▶ POST /api/ext/payments/checkout ─▶ provider
                                        │                                                   │ webhook or /confirm
                                        │ unpaid for N days: cancelled                      ▼
                                        └──────────────────────────────────▶ payments-purchases: paid
                                                                                            │ Shop hook
                                  paid ─▶ shipped ─▶ delivered        (download-only: paid ─▶ delivered at once)
                                    └──────┴──────────┴──▶ refunded (a full refund with the provider)
```

States only move forward: `pending → paid | cancelled`, `cancelled → paid` (a late payment still counts), `paid → shipped | delivered | refunded`, `shipped → delivered | refunded`, `delivered → refunded`. A before-hook enforces this for everyone, staff editing in the dashboard included, and refuses changes to what an order was priced at (`customer`, `lines`, `subtotal`, `shippingCost`, `total`, `currency`). It stamps `paidAt`, `shippedAt` and `deliveredAt`.

On entering **paid**, whether from Payments or marked by staff who took money another way: stock is taken once per line, the products' downloads are copied to the order, a download-only order moves to delivered, and the customer and staff are emailed once. If stock ran out after payment, the order stays paid and gets a `flag` for staff. It's never silently cancelled.

On entering **shipped**, the customer is emailed, with the tracking link if there is one. On **refunded**, stock goes back when the setting says so, and the downloads are removed.

Making a new order cancels the customer's other unpaid orders, so there's one to pay at a time. A job cancels unpaid orders after the number of days in the settings.

## 4. Routes

| Method and path | Access | Audit | What it does |
|---|---|---|---|
| `POST /api/ext/shop/quote` | public: "Prices a cart before sign-in…", 120 a minute | | Prices `{ items, country? }` from stored products as the caller. Returns lines with problems (sold out, only N left, choose an option, no longer for sale), shipping, total and the countries the zones cover |
| `POST /api/ext/shop/orders` | authenticated, 20 a minute | `shop.order_create` | Prices the cart again and refuses it unless it's ready. Needs an address when something ships. Creates the order, owned by the caller |
| `POST /api/ext/shop/orders/:id/status` | permission `ext.shop:fulfill` | `shop.order_status` | `{ state: "shipped" \| "delivered", trackingUrl? }`, forward only, applied with a conditional update |

Paying is Payments' own route: `POST /api/ext/payments/checkout` with `{ collection: "shop-orders", id }`. Customers read their orders through the records API, which the rule limits to their own.

### Agent tools

Added on 2026-11-14 (C18). `shop_create_product` creates a product and its variants as drafts, as the caller, over MCP and in the AI assistant ([the AI plugin](/docs/plugins/ai)). Images and the description are added afterwards.

## 5. Dashboard

`permissions: { "ext.shop": ["fulfill", "manage"] }`. Settings need `ext.shop:manage`. A **Shop manager** role is created once, holding both, with full access to the shop's collections and list, read and update on orders.

| Slot | What |
|---|---|
| Section **Shop**, with the plugin's own shopping-bag icon | Overview, Orders, Products, Variants, Categories, Shipping zones, the three pages, Settings |
| Page **Overview** (`ext.shop:fulfill`) | Orders and revenue in the last 30 days, orders to ship, orders flagged for a look, and stock at 5 or fewer |
| Widget (`ext.shop:fulfill`) | Orders to ship and awaiting payment |
| `recordActions` on orders | Mark shipped (asks for a tracking link), Mark delivered |
| `recordPanels` | On an order: its lines, totals and address, readable. On a product: its variants and stock, with links to edit them |
| Settings | Email customers, email new orders to, restock refunded orders, days before unpaid orders are cancelled |

Grids, filters, search and export of orders come from core. Refunds stay with the payment provider.

## 6. Site pages and parts

Templates for `shop-store` (products, paged, and category links), `shop-products` (gallery, price, struck-through earlier price, variant picker, quantity, add to cart, description), `shop-categories`, `shop-cart` (lines, country and address, totals, checkout) and `shop-account` (the customer's orders, read as them: state, lines, Pay now for an unpaid one, tracking and downloads). Back from the provider, the orders page confirms the payment through Payments' `/confirm`, so it doesn't wait for the webhook, and empties the cart.

A theme can place the same parts in its own templates from `@tansy/shop/react`: `AddToCart`, `Cart`, `CartLink` (for a header: its `label` can be an icon with hidden text, and `className` replaces `shop-cart-link`), `PayButton`, `OrderReturn`, `ProductCard`, `ProductGrid`, `AddProduct`. They use only public routes, so a headless site can rebuild them.

Blocks for any page: **Products** (`shop_products`: a category or the newest, and how many) and **Add to cart** (`shop_add_to_cart`: one product).

## 7. Security

- An order's price comes from stored products and zones, read as the caller, never from the request: request bodies are strict, so a price in them is refused. Payments then charges the stored `total`.
- Only the customer reads their order, through every way of reading records, and so only they can pay for it. Nobody writes orders through the records API but staff, and even staff can't change what an order was priced at.
- A purchase is matched to its order by Payments' metadata, which Payments checks. A payment whose buyer or amount doesn't match the order still marks it paid, as the money was taken, and flags it for staff.
- Stock is taken with conditional updates and once per line, so concurrent and repeated hooks can't take it twice. An oversell is flagged, not hidden.
- Downloads sit in a hidden product field and reach a buyer only through their own paid order.
- Emails never include anything secret. Staff alerts go only to the address in the settings.

Covered by `tests/unit/shop-plugin.test.ts` and the Shop block in `tests/integration/payments.test.ts`.

## 8. Later

- Guest checkout, once Payments takes payment without an account.
- Taxes as a line, or the provider's tax where Payments offers it.
- Coupons, which providers do at their checkout today.
- Partial refunds and returns, product reviews, abandoned cart emails.
- Reserving stock at checkout. Today it's taken on payment and a rare oversell is flagged.

## With tenants

With the multi-tenant plugin (or another row scope provider), each tenant keeps its own data. Customer and staff notifications, restocking on refund and the days before unpaid orders are cancelled can differ per tenant, and the cancelling job runs in each one. Links in emails go to the tenant's own domain, or under its path prefix on this app's address until it has one.
