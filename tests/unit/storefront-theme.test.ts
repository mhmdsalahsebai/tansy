import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThemedPage } from "@/components/site/ThemedPage";
import { pluginRenderers } from "@/components/stream/StreamField";
import { EMPTY_LIST, loadSitePage, type ResolvedAddress, type SiteReader, type SiteTheme } from "@/core/site/page";
import { assertThemeManifest, type SiteList } from "@/core/theme/define";
import { tokensProblem } from "@/core/theme/tokens";
import shopRenderers from "../../plugins/shop/render";
import { storefront } from "../../themes/storefront/index";
import storefrontComponents from "../../themes/storefront/render";

const shop = pluginRenderers("shop", shopRenderers);
const theme = (options?: Parameters<typeof storefront>[0]) => ({ manifest: storefront(options), components: storefrontComponents }) as unknown as SiteTheme;

const store = { ...EMPTY_LIST, items: [{ id: 1, currency: "eur", recordPath: "/shop" }] };
const categories = { ...EMPTY_LIST, items: [{ id: 2, name: "Knitwear", recordPath: "/shop/category/knitwear" }] };
const sweater = { id: 5, title: "Hooded <Tracksuit>", summary: "Latest design wear", price: 1259, compareAtPrice: 1500, images: ["green"], stock: 3, categories: [2], recordPath: "/shop/hooded-tracksuit" };
const soldOut = { id: 6, title: "Glory Headwear", price: 100, images: [], stock: 0, categories: [], recordPath: "/shop/glory" };

function lists(collection: string, _query?: unknown) {
  if (collection === "shop-store") return store;
  if (collection === "shop-categories") return categories;
  if (collection === "shop-products") return { ...EMPTY_LIST, page: 1, totalPages: 1, totalItems: 2, items: [sweater, soldOut] };
  if (collection === "shop-variants") return { ...EMPTY_LIST, items: [{ id: 11, title: "S", price: null, stock: 0 }, { id: 12, title: "M", price: 1299, stock: 4 }] };
  return EMPTY_LIST;
}

function reader(pages: Record<string, ResolvedAddress>, list: SiteReader["list"] = vi.fn(async (collection: string) => lists(collection))): SiteReader {
  return {
    resolve: async (at) => pages[at] ?? null,
    list,
    get: async () => null,
    singleton: async () => null,
    branding: async () => ({ name: "Clothing Co", logoUrl: "" }),
    preview: async () => null,
    fileUrl: (id, thumb) => `/f/${id}${thumb ? `?thumb=${thumb}` : ""}`,
  };
}

async function render(site: SiteTheme, source: SiteReader, at: string) {
  const page = await loadSitePage(site, source, at, { renderers: shop });
  if (page.type !== "page") throw new Error(`Expected a page at ${at}, got ${page.type}`);
  return { page, html: renderToStaticMarkup(createElement(ThemedPage, { theme: site, page, renderers: shop }) as never) };
}

describe("storefront theme", () => {
  it("validates its own tokens and options, and needs the shop plugin", () => {
    expect(tokensProblem(storefront().tokens!)).toBeNull();
    expect(() => storefront({ colorScheme: "dark" as never })).toThrow();
    expect(() => assertThemeManifest(storefront(), [])).toThrow(/"shop" plugin/);
    expect(() => assertThemeManifest(storefront(), ["shop"])).not.toThrow();
  });

  it("shows products as cards on the front page, with prices in the shop's currency", async () => {
    const list = vi.fn(async (collection: string) => lists(collection));
    const { html } = await render(theme(), reader({}, list), "/");
    expect(list).toHaveBeenCalledWith("shop-products", expect.objectContaining({ perPage: 12, sort: "-createdAt", fields: expect.stringContaining("categories"), urls: "1" }));
    expect(html).toContain('data-theme="storefront"');
    expect(html).toContain('data-scheme="auto"');
    expect(html).toContain("Hooded &lt;Tracksuit&gt;");
    expect(html).toContain('href="/shop/hooded-tracksuit"');
    expect(html).toContain("€1,259.00");
    expect(html).toContain("<s");
    expect(html).toContain("Sold out");
    expect(html).toContain('href="/shop/category/knitwear"');
    expect(html).toContain('src="/f/green?thumb=800x0"');
    expect(html).toContain('role="search"');
    expect(html).toContain('href="/orders"');
    expect(html).toContain('href="/cart"');
  });

  it("leaves out search and the orders button when told to", async () => {
    const { html } = await render(theme({ search: false, accountLinks: false, colorScheme: "light", tagline: "Made to last" }), reader({}), "/");
    expect(html).not.toContain('role="search"');
    expect(html).not.toContain('href="/orders"');
    expect(html).toContain("Made to last");
    expect(html).toContain('data-scheme="light"');
  });

  it("replaces the shop plugin's product page, with options as chips and products like it", async () => {
    const list = vi.fn(async (collection: string) => lists(collection));
    const product: ResolvedAddress = { type: "record", collection: "shop-products", path: "/shop/hooded-tracksuit", record: { ...sweater, sku: "HT-1" } };
    const { page, html } = await render(theme(), reader({ "/shop/hooded-tracksuit": product }, list), "/shop/hooded-tracksuit");
    expect(page).toMatchObject({ template: "shop-products", source: "theme" });
    expect(list).toHaveBeenCalledWith("shop-variants", expect.objectContaining({ filter: "product = 5" }));
    expect(list).toHaveBeenCalledWith("shop-products", expect.objectContaining({ filter: "categories ?= 2 && id != 5", perPage: 4 }));
    expect(html).toContain("<h1");
    expect(html).toContain('type="radio"');
    // The sold-out size can't be chosen, and the first one in stock starts chosen, at its own price.
    const option = (value: string) => html.match(new RegExp(`<input type="radio"[^>]*value="${value}"[^>]*>`))?.[0] ?? "";
    expect(option("11")).toContain("disabled");
    expect(option("12")).toContain("checked");
    expect(option("12")).not.toContain("disabled");
    expect(html).toContain("€1,299.00");
    expect(html).toContain("Buy now");
    expect(html).toContain("SKU HT-1");
    expect(html).toContain("You may also like");
    expect(html).toContain('href="/shop/glory"');
  });

  it("moves between pages with view transitions, flying a product's picture from its card to its page", async () => {
    const { html: front } = await render(theme(), reader({}), "/");
    // Switched on by the layout, so only this theme's pages, and only for visitors who don't ask for less motion.
    expect(front).toContain("@view-transition");
    expect(front).toContain("prefers-reduced-motion: no-preference");
    expect(front).toContain("view-transition-name:sf-product-5");
    const product: ResolvedAddress = { type: "record", collection: "shop-products", path: "/shop/hooded-tracksuit", record: sweater };
    const { html } = await render(theme(), reader({ "/shop/hooded-tracksuit": product }), "/shop/hooded-tracksuit");
    // The same name on the product page's picture, and once only: products like it carry their own.
    expect(html.match(/view-transition-name:sf-product-5/g)).toHaveLength(1);
    expect(html).toContain('data-page="shop-products"');
    expect(html).toContain('class="sf-buybar');
  });

  it("gives small screens a tab bar like an app's, marking the page's own tab", async () => {
    const { html } = await render(theme(), reader({}), "/");
    const bar = html.slice(html.indexOf('class="sf-tabbar'));
    expect(bar).toMatch(/href="\/shop"[^>]*aria-current="page"/);
    expect(bar).toContain('href="/shop#sf-search"');
    expect(bar).toContain('href="/cart"');
    expect(bar).toContain('href="/orders"');
    const { html: plain } = await render(theme({ search: false, accountLinks: false }), reader({}), "/");
    const plainBar = plain.slice(plain.indexOf('class="sf-tabbar'));
    expect(plainBar).not.toContain("#sf-search");
    expect(plainBar).not.toContain('href="/orders"');
  });

  it("shows a product's format, and for one in a membership who opens it and from what price", async () => {
    const ebook = { ...sweater, format: "digital", membership: [30] };
    const memberships = (files: SiteList["items"]) => vi.fn(async (collection: string, query?: unknown): Promise<SiteList> => {
      if (collection === "payments-access") return { ...EMPTY_LIST, items: [{ id: 30, name: "Readers' Club" }] };
      if (collection === "payments-plans") return { ...EMPTY_LIST, items: [{ id: 40, name: "club", title: "Readers' Club", amount: 9, currency: "eur", includes: [30] }] };
      if (collection === "library-files") return { ...EMPTY_LIST, items: files };
      return lists(collection, query);
    });
    const product: ResolvedAddress = { type: "record", collection: "shop-products", path: "/shop/hooded-tracksuit", record: ebook };
    const list = memberships([]);
    const { html } = await render(theme(), reader({ "/shop/hooded-tracksuit": product }, list), "/shop/hooded-tracksuit");
    expect(list).toHaveBeenCalledWith("library-files", expect.objectContaining({ filter: "product = 5", fields: "id,product,label,file" }));
    expect(html).toContain("Digital");
    expect(html).toContain("Free to read with Readers&#x27; Club");
    expect(html).toContain("From €9.00 a month");
    expect(html).toContain('href="/library"');
    // A member, whose files the rule lets them read, gets the downloads instead.
    const { html: member } = await render(theme(), reader({ "/shop/hooded-tracksuit": product }, memberships([{ id: 50, product: 5, label: "EPUB", file: "book-epub" }])), "/shop/hooded-tracksuit");
    expect(member).toContain("Download EPUB");
    expect(member).toContain('href="/f/book-epub"');
    expect(member).not.toContain("From €9.00 a month");
  });

  it("lists the library's memberships and books, locked until the visitor's membership opens them", async () => {
    const library: ResolvedAddress = { type: "record", collection: "library", path: "/library", record: { id: 1, title: "The library" } };
    const list = vi.fn(async (collection: string, query?: unknown): Promise<SiteList> => {
      if (collection === "payments-plans") return { ...EMPTY_LIST, items: [{ id: 40, name: "club", title: "Readers' Club", amount: 9, annualAmount: 90, currency: "eur", includes: [30], featured: true }] };
      if (collection === "library-files") return EMPTY_LIST;
      return lists(collection, query);
    });
    const { page, html } = await render(theme({ library: true }), reader({ "/library": library }, list), "/library");
    expect(page).toMatchObject({ template: "library", source: "theme" });
    expect(list).toHaveBeenCalledWith("shop-products", expect.objectContaining({ filter: "membership:length > 0" }));
    expect(html).toContain("The library");
    expect(html).toContain("Readers&#x27; Club");
    expect(html).toContain("or €90.00 a year");
    expect(html).toContain("Members only");
    // The Library tab, marked as the current one.
    expect(html.slice(html.indexOf('class="sf-tabbar'))).toMatch(/href="\/library"[^>]*aria-current="page"/);
    const { html: without } = await render(theme(), reader({ "/library": library }, list), "/library");
    expect(without.slice(without.indexOf('class="sf-tabbar'))).not.toContain('href="/library"');
  });

  it("places the shop plugin's cart in its own two-column layout", async () => {
    const cart: ResolvedAddress = { type: "record", collection: "shop-cart", path: "/cart", record: { id: 1, title: "Your bag" } };
    const { page, html } = await render(theme(), reader({ "/cart": cart }), "/cart");
    expect(page).toMatchObject({ template: "shop-cart", source: "theme" });
    expect(html).toContain('class="sf-cart"');
    expect(html).toContain("Your bag");
  });

  it("ships theme.css built from styles.css and the components", () => {
    const dir = path.resolve(__dirname, "../../themes/storefront");
    const out = path.join(mkdtempSync(path.join(tmpdir(), "storefront-css-")), "theme.css");
    const cli = path.resolve(__dirname, "../../node_modules/@tailwindcss/cli/dist/index.mjs");
    execFileSync(process.execPath, [cli, "--input", "./styles.css", "--output", out], { cwd: dir, stdio: "pipe" });
    // Out of date: run `npm run build -w @tansy/theme-storefront`.
    expect(readFileSync(path.join(dir, "theme.css"), "utf8")).toBe(readFileSync(out, "utf8"));
  });
});
