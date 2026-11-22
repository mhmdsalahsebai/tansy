# Changelog

What changed in each release of `@tansy/theme-storefront`. Releases up to 0.1.0 went out with every other package
on one version and are described in [tansy's changelog](../../CHANGELOG.md).

## 0.1.1 — 2026-11-22

- **Pages change without a reload.** Links between the theme's pages are followed inside the app,
  through the Next router, each move inside a view transition: the header holds still, a product's
  picture flies from its card to its page and back, and the current category chip and the tab bar's
  dot slide to their new place. A page loaded in full, such as another language, still animates in
  browsers with cross-document view transitions. Nothing moves for visitors who ask for less motion.
- **Tapping a product's picture zooms it** to fill the screen, and back.
- **The back arrow returns to the page the visitor came from**, as an app's does. From a product,
  that page comes back scrolled to the product's card, and its picture flies back into it. Opened
  from a shared link, it goes to the shop.
- **On phones:** a tab bar with a menu that rises as a sheet, pictures that swipe, and **Buy now**
  and **Add to cart** pinned to the bottom of a product page.
- **A Format field** on products (physical, digital, or both), shown as a badge.
- **Memberships for digital editions:** a **Membership** field on products, a **Library page** at
  `/library` with the plans on offer, and **Library files** that only members of a plan including
  them can see or download. A new `library` option links to it from the header and tab bar.
- The theme now names `@tansy/payments` as a peer dependency, for its Subscribe button, and
  requires `tansy`, `@tansy/shop` and `@tansy/payments` ^0.1.1.
