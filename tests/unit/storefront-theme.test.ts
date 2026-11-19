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
import { assertThemeManifest } from "@/core/theme/define";
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

function lists(collection: string) {
  if (collection === "shop-store") return store;
  if (collection === "shop-categories") return categories;
  if (collection === "shop-products") return { ...EMPTY_LIST, page: 1, totalPages: 1, totalItems: 2, items: [sweater, soldOut] };
  if (collection === "shop-variants") return { ...EMPTY_LIST, items: [{ id: 11, title: "S", price: null, stock: 0 }, { id: 12, title: "M", price: 1299, stock: 4 }] };
  return EMPTY_LIST;
}

function reader(pages: Record<string, ResolvedAddress>, list = vi.fn(async (collection: string) => lists(collection))): SiteReader {
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
