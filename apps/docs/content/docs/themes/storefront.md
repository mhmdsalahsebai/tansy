---
title: "Storefront theme (`@tansy/theme-storefront`)"
description: "How themes work in general is in Themes and Write and publish a theme."
---

How themes work in general is in [Themes](/docs/extending#themes) and [Write and publish a theme](/docs/guides/themes).

A storefront look for the [shop plugin](/docs/plugins/shop): a large heading with product search beside the newest product, products as soft rounded cards, a product page with an image stage, option chips and a quantity stepper, a cart in two columns, and on phones the feel of a shopping app: a tab bar, pictures you swipe, and the buttons where a thumb reaches. It follows the visitor's light or dark setting and works right to left.

```ts
// tansy.config.ts
import { payments } from "@tansy/payments";
import { shop } from "@tansy/shop";
import { storefront } from "@tansy/theme-storefront";

export default defineCms({
  theme: storefront({ tagline: "Made to last" }),
  plugins: [payments({ siteUrl: "https://example.com", providers: [/* ... */] }), shop({ siteUrl: "https://example.com" })],
});
```

In the starter, `TANSY_THEME=storefront` turns it on, and turns the shop and Payments plugins on with it. `TANSY_SITE_TAGLINE` sets `tagline`. Themes are chosen at build time, so set the same value for the build and the server, and restart after changing it.

## 1. Pages

| Address | Template | What it shows |
|---|---|---|
| `/` (with no record there) | `home` | Heading, introduction, search and the newest product large; category chips; products as cards (12 a page) |
| The shop's address, `/shop` by default | `shop-store` | The same page. Its heading and introduction come from the **Shop page** record |
| A category | `shop-categories` | Its name and description, category chips, its products as cards with paging |
| A product | `shop-products` | Pictures with arrows and thumbnails, price, options, quantity, **Buy now** and **Add to cart**, description, four products like it |
| The cart, `/cart` | `shop-cart` | The shop plugin's cart: lines on the left, address and total in a panel on the right |
| Orders, `/orders` | `shop-account` | The shop plugin's order list, read as the signed-in customer |
| The library, `/library` | `library` | The memberships on offer with a **Subscribe** button each, then every product in a membership, with its downloads for members and a lock for everyone else |
| Any other record, such as a page | `default` | Title and body |

The theme's templates replace the shop plugin's for the same collections. Checkout, the cart, orders and the header's cart count are the plugin's exported parts (`Cart`, `OrderList`, `OrderReturn`, `CartLink`, `addToCart`), so pricing, stock checks and payment behave exactly as on the plugin's own pages. The product page's buy box is the theme's own, and puts things in the same cart through `addToCart`. **Buy now** adds to the cart and opens it.

A product shows a **Physical**, **Digital** or **Physical and digital** badge from its **Format** field. A product in a membership says so in its buy box: "Free to read with" the membership and the price it starts from, with a link to the library. A member sees the product's library files to download there instead.

Products like this one share a category with it. When none do, the newest products take their place.

## 2. Moving around

**Between pages.** Moving from page to page animates in browsers that support cross-document view transitions (Chrome and Edge 126, Safari 18.2): the page fades through while the header holds still, and a product's picture flies from its card to the product page, and back to its card on the way back. Tapping a product's picture zooms it to fill the screen and back, and the current category chip and the tab bar's dot slide to where they go next. Other browsers load the page as before. Visitors who ask their device for less motion get no animation. The transitions are switched on by the theme's layout, so they apply only to its own pages, never the dashboard.

**On phones** (below 64rem):

- A tab bar at the bottom: the shop, search (it opens the front page with the cursor in the search box), the library, the cart with its count, orders, and the menu, which rises as a sheet over the page. Search, the library and orders follow the `search`, `library` and `accountLinks` options.
- A product page has no tab bar, as a screen an app opens on top has none. Its **Buy now** and **Add to cart** stay pinned to the bottom of the screen instead, and its pictures swipe sideways, with dots to show where you are.
- Things that are tapped give way a little, rows that scroll sideways snap, adding to the cart gives a short vibration on phones that can, and the bars keep clear of the screen's rounded corners and home indicator where the site's viewport allows it.

## 3. Options

| Option | Default | What it does |
|---|---|---|
| `tagline` | none | Replaces the words under the front page's heading, and shows under the name in the footer |
| `search` | `true` | The product search box on the front page. It reads published products through the records API, as the visitor |
| `accountLinks` | `true` | An orders button in the header |
| `library` | `false` | A link to the library in the header and the tab bar. The library page works without it |
| `colorScheme` | `"auto"` | `"auto"` follows the visitor's light or dark setting. `"light"` always shows light colours |

## 4. Content it uses

| Collection | Fields read |
|---|---|
| `shop-products` | `title`, `summary`, `price`, `compareAtPrice`, `images`, `stock`, `categories`, `sku`, `description`, `format`, `membership` |
| `shop-variants` | `title`, `price`, `stock`, through the plugin's own query |
| `shop-categories` | `name`, `description` |
| `shop-store`, `shop-cart`, `shop-account` | `title`, `intro`, and the store's `currency` |
| `site-menu` | `items`, a stream of **Menu item** blocks |
| `library`, `library-files` | `title`, `intro`; `product`, `label`, `file`, read as the visitor |
| `payments-plans`, `payments-access` | Published plans' `name`, `title`, `description`, `amount`, `annualAmount`, `currency`, `featured`, `includes`; memberships' `name` |

Product pictures look best as cut-outs on a transparent or plain background, since they sit on the theme's soft grey stage rather than filling it. A product with no picture gets a bag icon.

The theme's schema creates **Menu** (`site-menu`), as the magazine theme does, and:

- Two fields on products: **Format** (`format`), which only chooses the badge, since what is posted still follows the shop's **Shipping** and what buyers download follows **Download**, and **Membership** (`membership`), the memberships whose members read the product's digital edition for free.
- **Library page** (`library`), a page at `/library` with a title and an introduction.
- **Library files** (`library-files`): a file for a product, with a label such as EPUB, and the memberships it is **Included in**. Its rules let only a signed-in person whose `payments_access` includes one of those see it or download it, and nobody when it is in none. A membership is a **Payments access** record that a plan includes, and is granted by [Subscriptions](/docs/plugins/subscriptions) when someone subscribes.

Membership is for digital editions. A physical book is still bought through the cart.

## 5. Styles

The theme is styled with Tailwind CSS 4, and only the theme: a site using it needs no Tailwind, PostCSS config or build step of its own.

- `styles.css` is the source. It maps Tailwind's colours, radius, shadow and widths to the `--site-*` tokens, so the accent under Settings restyles every button and chip.
- `theme.css` is what the site loads. It is built from `styles.css` and the components with `npm run build -w @tansy/theme-storefront` (or `npm run watch -w @tansy/theme-storefront` while working), and again before `npm pack`. A unit test fails when it is out of date.
- Every utility carries the `sf:` prefix, such as `sf:rounded-full`, and there is no global reset, so nothing reaches the dashboard or a plugin's own page. The reset for the theme's markup sits under `.sf-shell` with no specificity.
- The shop plugin's parts keep their `shop-*` class names and are restyled at the end of `styles.css`, outside any layer, as `shop.css` is.
