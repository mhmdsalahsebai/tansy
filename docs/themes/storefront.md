# Storefront theme (`@tansy/theme-storefront`)

How themes work in general is in [Themes](../EXTENDING.md#themes) and [Write and publish a theme](../guides/themes.md).

A storefront look for the [shop plugin](../plugins/shop.md): a large heading with product search beside the newest product, products as soft rounded cards, a product page with an image stage, option chips and a quantity stepper, and a cart in two columns. It follows the visitor's light or dark setting and works right to left.

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
| Any other record, such as a page | `default` | Title and body |

The theme's templates replace the shop plugin's for the same collections. Checkout, the cart, orders and the header's cart count are the plugin's exported parts (`Cart`, `OrderList`, `OrderReturn`, `CartLink`, `addToCart`), so pricing, stock checks and payment behave exactly as on the plugin's own pages. The product page's buy box is the theme's own, and puts things in the same cart through `addToCart`. **Buy now** adds to the cart and opens it.

Products like this one share a category with it. When none do, the newest products take their place.

## 2. Options

| Option | Default | What it does |
|---|---|---|
| `tagline` | none | Replaces the words under the front page's heading, and shows under the name in the footer |
| `search` | `true` | The product search box on the front page. It reads published products through the records API, as the visitor |
| `accountLinks` | `true` | An orders button in the header |
| `colorScheme` | `"auto"` | `"auto"` follows the visitor's light or dark setting. `"light"` always shows light colours |

## 3. Content it uses

| Collection | Fields read |
|---|---|
| `shop-products` | `title`, `summary`, `price`, `compareAtPrice`, `images`, `stock`, `categories`, `sku`, `description` |
| `shop-variants` | `title`, `price`, `stock`, through the plugin's own query |
| `shop-categories` | `name`, `description` |
| `shop-store`, `shop-cart`, `shop-account` | `title`, `intro`, and the store's `currency` |
| `site-menu` | `items`, a stream of **Menu item** blocks |

Product pictures look best as cut-outs on a transparent or plain background, since they sit on the theme's soft grey stage rather than filling it. A product with no picture gets a bag icon.

The theme's schema creates one collection, **Menu** (`site-menu`), as the magazine theme does.

## 4. Styles

The theme is styled with Tailwind CSS 4, and only the theme: a site using it needs no Tailwind, PostCSS config or build step of its own.

- `styles.css` is the source. It maps Tailwind's colours, radius, shadow and widths to the `--site-*` tokens, so the accent under Settings restyles every button and chip.
- `theme.css` is what the site loads. It is built from `styles.css` and the components with `npm run build -w @tansy/theme-storefront` (or `npm run watch -w @tansy/theme-storefront` while working), and again before `npm pack`. A unit test fails when it is out of date.
- Every utility carries the `sf:` prefix, such as `sf:rounded-full`, and there is no global reset, so nothing reaches the dashboard or a plugin's own page. The reset for the theme's markup sits under `.sf-shell` with no specificity.
- The shop plugin's parts keep their `shop-*` class names and are restyled at the end of `styles.css`, outside any layer, as `shop.css` is.
