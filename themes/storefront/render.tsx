import localFont from "next/font/local";
import type { ReactNode } from "react";
import { BillingButton, SubscribeButton } from "@tansy/payments/react";
import { Cart as ShopCart, CartLink, OrderReturn, type VariantOption } from "@tansy/shop/react";
import { OrderList } from "@tansy/shop/render";
import { Menu, Pager, pickWords, RichText, StreamField } from "tansy/react";
import { defineThemeComponents, type LayoutProps, type SiteList, type SiteRecord, type TemplateProps } from "tansy/theme";
import { BuyBox, ProductGallery, ProductSearch, ShareButton, ViewTransitionNames } from "./client";
import { ArrowUpRight, Bag, Bars, BookOpen, ChevronLeft, Download, Globe, Lock, Search, Store, User } from "./icons";
import type { StorefrontOptions } from "./index";
import { cx, fileIds, ids, money, num, text } from "./lib";
import { messages } from "./messages";
import "./theme.css";

// Served from the site's own origin, as font-src 'self' requires.
const font = localFont({ src: "./fonts/GeistVF.woff", variable: "--storefront-font", weight: "100 900" });

type Props = TemplateProps<StorefrontOptions>;

const items = (list: SiteList | undefined) => list?.items ?? [];
const byId = (list: SiteList | undefined) => new Map(items(list).map((record) => [record.id, record]));

/** An address in the page's language: "/shop" is "/ar/shop" on an Arabic page. */
const inLanguage = (props: Pick<Props, "language">, path: string) => props.language?.href(path) ?? path;
/** From the collection's URL pattern, so links follow whatever the owner sets. */
const hrefOf = (record: SiteRecord | undefined, props: Pick<Props, "language">) => (record && text(record.recordPath) ? inLanguage(props, text(record.recordPath)) : undefined);

/** The shop's currency and front page, from the `store` list every template here reads. */
const storeOf = (data: Props["data"]) => items(data.store)[0];
const currencyOf = (data: Props["data"]) => text(storeOf(data)?.currency) || "usd";
const shopHref = (props: Pick<Props, "data" | "language">) => hrefOf(storeOf(props.data), props) ?? inLanguage(props, "/shop");

const forClient = (words: Props["words"]) => (words ? pickWords(words, "storefront") : undefined);

/* ------------------------------------------------------------------ shared */

const container = "sf:mx-auto sf:w-full sf:max-w-wide sf:px-gutter";
const iconButton = "sf:relative sf:grid sf:size-11 sf:shrink-0 sf:place-items-center sf:rounded-full sf:border sf:border-line sf:bg-page sf:text-ink sf:no-underline sf:transition sf:hover:border-ink sf:focus-visible:outline-2 sf:focus-visible:outline-offset-2 sf:focus-visible:outline-accent";
const pill = "sf:inline-flex sf:h-10 sf:items-center sf:rounded-full sf:border sf:px-5 sf:text-sm sf:font-medium sf:no-underline sf:transition";

function SectionHeading({ id, title, aside }: { id?: string; title: string; aside?: ReactNode }) {
  return (
    <div className="sf:mb-8 sf:flex sf:flex-wrap sf:items-end sf:justify-between sf:gap-4">
      <h2 id={id} className="sf:text-3xl sf:font-semibold sf:tracking-tight sf:text-ink sf:sm:text-4xl">{title}</h2>
      {aside && <p className="sf:text-sm sf:text-muted">{aside}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ layout */

function Brand({ branding, language }: Pick<Props, "branding" | "language">) {
  return (
    <a href={inLanguage({ language }, "/")} className="sf:flex sf:shrink-0 sf:items-center sf:gap-2.5 sf:text-2xl sf:font-bold sf:tracking-tight sf:text-ink sf:no-underline">
      {/* eslint-disable-next-line @next/next/no-img-element -- the logo from Settings, a site path or data image */}
      {branding.logoUrl && <img src={branding.logoUrl} alt="" width={32} height={32} className="sf:size-8 sf:rounded-full sf:object-cover" />}
      <span>{branding.name}</span>
    </a>
  );
}

/** The same page in each language it's published in, as one button however many languages the site adds. */
function LanguageSwitcher({ language, t }: Pick<Props, "language" | "t">) {
  if (!language) return null;
  const available = language.locales.filter((locale) => language.alternates[locale.code]);
  if (available.length < 2) return null;
  return (
    <nav aria-label={t("storefront.language")}>
      <details className="sf-popover sf:relative">
        <summary className={iconButton}>
          <Globe />
          <span className="sf:sr-only">{t("storefront.language")}</span>
        </summary>
        <ul className="sf:absolute sf:end-0 sf:top-full sf:z-40 sf:mt-2 sf:min-w-48 sf:rounded-3xl sf:border sf:border-line sf:bg-page sf:p-2 sf:shadow-card">
          {available.map((locale) => (
            <li key={locale.code}>
              <a href={language.alternates[locale.code]} hrefLang={locale.code} lang={locale.code} aria-current={locale.code === language.locale ? "true" : undefined} className="sf:flex sf:items-center sf:justify-between sf:gap-4 sf:rounded-2xl sf:px-3 sf:py-2 sf:text-ink sf:no-underline sf:hover:bg-surface sf:aria-[current]:font-semibold sf:aria-[current]:text-accent">
                <span>{locale.label}</span>
                <span className="sf:text-xs sf:text-muted sf:uppercase">{locale.code}</span>
              </a>
            </li>
          ))}
        </ul>
      </details>
    </nav>
  );
}

/**
 * Moving between the theme's pages animates where the browser can: the page fades through, and a
 * product's picture flies from its card to the product page and back. Every link here is a
 * plain page load, so this is the browser's cross-document view transition, switched on only
 * while a page in this theme's layout is showing, and never for visitors who ask for less motion.
 * The animations themselves are in styles.css.
 */
const VIEW_TRANSITIONS = "@media (prefers-reduced-motion: no-preference) { @view-transition { navigation: auto; } }";

/** Which tab of the bar at the bottom of small screens a page belongs to. */
const TAB_OF: Record<string, "shop" | "library" | "cart" | "orders"> = { home: "shop", "shop-store": "shop", "shop-categories": "shop", "shop-products": "shop", library: "library", "shop-cart": "cart", "shop-account": "orders" };

/**
 * A dot under the current tab. It carries the same view-transition name on every page, so moving
 * between tabs slides it from one to the other.
 */
const TabDot = () => <span aria-hidden="true" className="sf-tab-dot" style={{ viewTransitionName: "sf-tab-dot" }} />;

const tab = "sf-tab sf:relative sf:flex sf:min-w-0 sf:flex-1 sf:flex-col sf:items-center sf:justify-center sf:gap-1 sf:pt-2 sf:pb-1.5 sf:text-[0.6875rem] sf:font-medium sf:text-muted sf:no-underline sf:select-none sf:aria-[current]:text-accent";

/**
 * The bar at the bottom of small screens, as an app has: the shop, search, the cart with its
 * count, orders and the menu. The menu opens as a sheet from the bottom, with no script.
 */
function TabBar({ props, menu, current }: { props: LayoutProps<StorefrontOptions>; menu: unknown[] | null; current: string | undefined }) {
  const { options, language, t, words } = props;
  const shop = shopHref(props);
  return (
    <nav aria-label={t("storefront.tabs")} className="sf-tabbar sf:fixed sf:inset-x-0 sf:bottom-0 sf:z-40 sf:border-t sf:border-line/70 sf:lg:hidden">
      <div className="sf:mx-auto sf:flex sf:max-w-xl sf:items-stretch sf:px-2">
        <a href={shop} className={tab} aria-current={current === "shop" ? "page" : undefined}><Store className="sf:size-6" /><span>{t("storefront.tabShop")}</span>{current === "shop" && <TabDot />}</a>
        {options.search && <a href={`${shop}#sf-search`} className={tab}><Search className="sf:size-6" /><span>{t("storefront.tabSearch")}</span></a>}
        {options.library && <a href={inLanguage({ language }, "/library")} className={tab} aria-current={current === "library" ? "page" : undefined}><BookOpen className="sf:size-6" /><span>{t("storefront.library")}</span>{current === "library" && <TabDot />}</a>}
        <CartLink
          className={cx(tab, "sf-tab-cart")}
          label={<><Bag className="sf:size-6" /><span>{t("storefront.cart")}</span>{current === "cart" && <TabDot />}</>}
          words={words ? pickWords(words, "shop") : undefined}
        />
        {options.accountLinks && <a href={inLanguage({ language }, "/orders")} className={tab} aria-current={current === "orders" ? "page" : undefined}><User className="sf:size-6" /><span>{t("storefront.tabOrders")}</span>{current === "orders" && <TabDot />}</a>}
        {menu && (
          <details className="sf-sheet sf:flex sf:min-w-0 sf:flex-1">
            <summary className={cx(tab, "sf:w-full")}><Bars className="sf:size-6" /><span>{t("storefront.openMenu")}</span></summary>
            <nav aria-label={t("storefront.menu")} className="sf-sheet-panel sf-menu sf-menu-stacked sf:fixed sf:inset-x-0 sf:bottom-0 sf:z-50 sf:max-h-[70dvh] sf:overflow-y-auto sf:rounded-t-[2rem] sf:border-t sf:border-line sf:bg-page sf:px-4 sf:pt-3 sf:shadow-card">
              <span aria-hidden="true" className="sf:mx-auto sf:mb-3 sf:block sf:h-1 sf:w-10 sf:rounded-full sf:bg-line" />
              <Menu items={menu} />
            </nav>
          </details>
        )}
      </div>
    </nav>
  );
}

function Layout(props: LayoutProps<StorefrontOptions>) {
  const { branding, globals, options, children, language, t, words, collection } = props;
  const menu = globals["site-menu"]?.items;
  const hasMenu = Array.isArray(menu) && menu.length > 0;
  const page = collection ?? "home";
  return (
    <div className="sf-shell sf:flex sf:min-h-dvh sf:flex-col sf:bg-page sf:font-sans sf:text-ink sf:antialiased" data-scheme={options.colorScheme} data-page={page}>
      <style href="sf-view-transitions" precedence="default">{VIEW_TRANSITIONS}</style>
      <ViewTransitionNames />
      <a href="#sf-content" className="sf:sr-only sf:focus:not-sr-only sf:focus:fixed sf:focus:start-4 sf:focus:top-4 sf:focus:z-50 sf:focus:rounded-full sf:focus:bg-ink sf:focus:px-5 sf:focus:py-3 sf:focus:text-page">{t("storefront.skip")}</a>
      <header className="sf-header sf:sticky sf:top-0 sf:z-30 sf:border-b sf:border-line/70 sf:bg-page/85 sf:backdrop-blur-xl">
        <div className={cx(container, "sf:flex sf:h-16 sf:items-center sf:gap-8 sf:lg:h-20")}>
          <Brand branding={branding} language={language} />
          {hasMenu && <nav className="sf-menu sf:hidden sf:lg:block" aria-label={t("storefront.menu")}><Menu items={menu} /></nav>}
          <div className="sf:ms-auto sf:flex sf:items-center sf:gap-2">
            <LanguageSwitcher language={language} t={t} />
            {options.library && (
              <a href={inLanguage({ language }, "/library")} className={cx(iconButton, "sf:max-lg:hidden")} aria-current={collection === "library" ? "page" : undefined}>
                <BookOpen />
                <span className="sf:sr-only">{t("storefront.library")}</span>
              </a>
            )}
            {options.accountLinks && (
              <a href={inLanguage({ language }, "/orders")} className={cx(iconButton, "sf:max-lg:hidden")}>
                <User />
                <span className="sf:sr-only">{t("storefront.orders")}</span>
              </a>
            )}
            <CartLink
              className={cx("sf-cart-button sf-header-cart", iconButton)}
              label={<><Bag /><span className="sf:sr-only">{t("storefront.cart")}</span></>}
              words={words ? pickWords(words, "shop") : undefined}
            />
          </div>
        </div>
      </header>

      <div id="sf-content" className="sf:flex-1">{children}</div>
      {/* Small screens: the menu, cart and orders move to the bar at the bottom. */}
      <TabBar props={props} menu={hasMenu ? menu : null} current={TAB_OF[page]} />

      <footer className="sf:mt-24 sf:rounded-t-[3rem] sf:bg-surface">
        <div className={cx(container, "sf:grid sf:gap-10 sf:py-14 sf:md:grid-cols-[1fr_auto]")}>
          <div className="sf:flex sf:max-w-sm sf:flex-col sf:gap-3">
            <Brand branding={branding} language={language} />
            <p className="sf:text-muted">{options.tagline || t("storefront.heroIntro")}</p>
          </div>
          {hasMenu && <nav className="sf-menu sf-menu-footer" aria-label={t("storefront.footerMenu")}><Menu items={menu} /></nav>}
          <p className="sf:border-t sf:border-line sf:pt-6 sf:text-sm sf:text-muted sf:md:col-span-2">© {new Date().getFullYear()} {branding.name}. {t("storefront.rights")}</p>
        </div>
      </footer>
    </div>
  );
}

/* -------------------------------------------------------------- products */

/**
 * The name a product's picture carries on its card and on its own page, so moving between them
 * flies the picture from one to the other. Unique per product, as a page may name each only once.
 */
const productTransition = (id: number) => `sf-product-${id}`;

/**
 * Marks a picture that leads to a product's page. A page may show the same product twice, such
 * as the front page's spotlight beside its card, and may name it only once. So the picture tapped
 * gets the name as the page is left (ViewTransitionNames in client.tsx), and that one flies.
 */
const flies = (product: SiteRecord, href: string | undefined) => (href ? { "data-sf-vt": productTransition(product.id), "data-sf-vt-href": href } : {});

/** Physical, digital, or both, from the product's Format, for a badge. Empty when it has none. */
function formatLabel(product: SiteRecord, t: Props["t"]) {
  const format = text(product.format);
  return format === "physical" ? t("storefront.formatPhysical") : format === "digital" ? t("storefront.formatDigital") : format === "both" ? t("storefront.formatBoth") : "";
}

/** A product as a tall soft card: its picture with an arrow over it, then price and name. The whole card is one link. */
function ProductCard({ product, categories, props, eager = false }: { product: SiteRecord; categories: Map<number, SiteRecord>; props: Props; eager?: boolean }) {
  const href = hrefOf(product, props);
  const image = fileIds(product.images)[0];
  const price = num(product.price);
  const was = num(product.compareAtPrice);
  const onSale = price !== null && was !== null && was > price;
  const soldOut = product.stock === 0;
  const format = formatLabel(product, props.t);
  const category = categories.get(ids(product.categories)[0] ?? -1);
  const subtitle = text(category?.name) || text(product.summary);
  const currency = currencyOf(props.data);
  return (
    <article className="sf-press sf:group sf:relative sf:flex sf:flex-col sf:gap-4" lang={typeof product.locale === "string" ? product.locale : undefined}>
      <div className="sf:relative sf:isolate sf:grid sf:aspect-[4/5] sf:place-items-center sf:overflow-hidden sf:rounded-[3rem] sf:bg-surface sf:transition-shadow sf:duration-300 sf:group-hover:shadow-card">
        <span aria-hidden="true" className="sf:absolute sf:inset-x-[12%] sf:top-[14%] sf:-z-10 sf:aspect-square sf:rounded-full sf:bg-page/60 sf:blur-xl" />
        {image
          // eslint-disable-next-line @next/next/no-img-element -- an access-checked API address that redirects to a signed URL, which next/image can't optimize
          ? <img src={props.fileUrl(image, "800x0")} alt={props.fileText(image).alt} loading={eager ? "eager" : "lazy"} style={{ viewTransitionName: productTransition(product.id) }} {...flies(product, href)} className={cx("sf-vt-product sf:size-[80%] sf:object-contain sf:drop-shadow-[0_18px_22px_rgba(0,0,0,0.16)] sf:transition-transform sf:duration-500 sf:ease-out sf:group-hover:scale-105 sf:group-hover:-rotate-2 sf:motion-reduce:transition-none", soldOut && "sf:opacity-60 sf:grayscale")} />
          : <Bag className="sf:size-12 sf:text-muted/50" strokeWidth={1} />}
        <span aria-hidden="true" className="sf:absolute sf:top-1/2 sf:left-1/2 sf:grid sf:size-14 sf:-translate-1/2 sf:place-items-center sf:rounded-full sf:border sf:border-page/60 sf:bg-page/40 sf:text-ink sf:backdrop-blur-md sf:transition sf:duration-300 sf:group-hover:scale-110 sf:group-hover:border-accent sf:group-hover:bg-accent sf:group-hover:text-on-accent">
          <ArrowUpRight className="sf:size-5 sf:rtl:-scale-x-100" />
        </span>
        {format && <span className="sf:absolute sf:end-5 sf:top-5 sf:rounded-full sf:bg-page/80 sf:px-3 sf:py-1 sf:text-xs sf:font-medium sf:text-ink sf:backdrop-blur">{format}</span>}
        {(onSale || soldOut) && (
          <span className={cx("sf:absolute sf:start-5 sf:top-5 sf:rounded-full sf:px-3 sf:py-1 sf:text-xs sf:font-semibold", soldOut ? "sf:bg-ink sf:text-page" : "sf:bg-accent sf:text-on-accent")}>
            {soldOut ? props.t("storefront.soldOut") : props.t("storefront.sale")}
          </span>
        )}
      </div>
      <div className="sf:flex sf:flex-col sf:gap-1 sf:px-2">
        {price !== null && (
          <p className="sf:flex sf:items-baseline sf:gap-2 sf:text-xl sf:font-semibold sf:tracking-tight sf:text-ink sf:tabular-nums">
            {money(props.formatNumber, price, currency)}
            {onSale && <s className="sf:text-sm sf:font-normal sf:text-muted">{money(props.formatNumber, was, currency)}</s>}
          </p>
        )}
        <h3 className="sf:text-base sf:font-medium sf:text-ink">
          {href
            ? <a href={href} className="sf:text-inherit sf:no-underline sf:outline-none sf:after:absolute sf:after:inset-0 sf:after:rounded-[3rem] sf:focus-visible:after:outline-2 sf:focus-visible:after:outline-offset-4 sf:focus-visible:after:outline-accent">{text(product.title)}</a>
            : text(product.title)}
        </h3>
        {subtitle && <p className="sf:line-clamp-1 sf:text-sm sf:text-muted">{subtitle}</p>}
      </div>
    </article>
  );
}

function ProductGrid({ products, props, empty }: { products: SiteRecord[]; props: Props; empty: string }) {
  if (!products.length) {
    return (
      <div className="sf:grid sf:place-items-center sf:gap-3 sf:rounded-card sf:border sf:border-dashed sf:border-line sf:px-6 sf:py-20 sf:text-center sf:text-muted">
        <Bag className="sf:size-10" strokeWidth={1.25} />
        <p>{empty}</p>
      </div>
    );
  }
  const categories = byId(props.data.categories);
  return (
    <ul className="sf:grid sf:grid-cols-2 sf:gap-x-4 sf:gap-y-10 sf:sm:gap-x-6 sf:md:grid-cols-3 sf:xl:grid-cols-4">
      {products.map((product, index) => <li key={product.id}><ProductCard product={product} categories={categories} props={props} eager={index < 4} /></li>)}
    </ul>
  );
}

/** Every category as a chip, the current one filled. "All" is the shop's own page. */
function CategoryChips({ props, current }: { props: Props; current: number | "all" | null }) {
  const categories = items(props.data.categories);
  if (!categories.length) return null;
  const chip = (active: boolean) => cx(pill, active ? "sf:border-ink sf:bg-ink sf:text-page" : "sf:border-line sf:bg-page sf:text-ink sf:hover:border-ink");
  // The chosen chip has the same name on every page, so moving between categories slides it across.
  const slide = (active: boolean) => (active ? { viewTransitionName: "sf-chip" } : undefined);
  return (
    <nav aria-label={props.t("storefront.categories")} className="sf-chips sf:-mx-gutter sf:mb-10 sf:overflow-x-auto sf:px-gutter">
      <ul className="sf:flex sf:w-max sf:gap-2">
        <li><a href={shopHref(props)} className={chip(current === "all")} style={slide(current === "all")} aria-current={current === "all" ? "page" : undefined}>{props.t("storefront.all")}</a></li>
        {categories.map((category) => {
          const href = hrefOf(category, props);
          const active = current === category.id;
          return <li key={category.id}>{href ? <a href={href} className={chip(active)} style={slide(active)} aria-current={active ? "page" : undefined}>{text(category.name)}</a> : <span className={chip(active)}>{text(category.name)}</span>}</li>;
        })}
      </ul>
    </nav>
  );
}

function ProductPager({ props, list }: { props: Props; list: SiteList | undefined }) {
  return <Pager list={list} path={props.path} previous={props.t("storefront.previousPage")} next={props.t("storefront.nextPage")} className="sf-pager" words={props.words} />;
}

/** The newest product, large, beside the front page's heading. */
function Spotlight({ product, props }: { product: SiteRecord; props: Props }) {
  const image = fileIds(product.images)[0];
  const href = hrefOf(product, props);
  const price = num(product.price);
  return (
    <div className="sf:relative sf:isolate sf:mx-auto sf:hidden sf:aspect-square sf:w-full sf:max-w-[34rem] sf:place-items-center sf:lg:grid">
      <span aria-hidden="true" className="sf:absolute sf:inset-[6%] sf:-z-20 sf:rounded-full sf:bg-surface" />
      <span aria-hidden="true" className="sf:absolute sf:top-[56%] sf:left-1/2 sf:-z-10 sf:h-[24%] sf:w-[112%] sf:-translate-x-1/2 sf:-rotate-6 sf:rounded-[50%] sf:border sf:border-ink/15" />
      {/* eslint-disable-next-line @next/next/no-img-element -- as for the cards */}
      {image ? <img src={props.fileUrl(image, "800x0")} alt={props.fileText(image).alt} {...flies(product, href)} className="sf-vt-product sf:size-[74%] sf:object-contain sf:drop-shadow-[0_30px_36px_rgba(0,0,0,0.2)]" /> : <Bag className="sf:size-20 sf:text-muted/40" strokeWidth={1} />}
      <div className="sf:absolute sf:start-0 sf:bottom-[8%] sf:flex sf:max-w-[18rem] sf:items-center sf:gap-4 sf:rounded-3xl sf:border sf:border-line sf:bg-page/90 sf:p-4 sf:pe-5 sf:shadow-card sf:backdrop-blur">
        <div className="sf:min-w-0">
          <p className="sf:text-xs sf:font-medium sf:tracking-wide sf:text-accent sf:uppercase">{props.t("storefront.featured")}</p>
          <p className="sf:truncate sf:font-semibold sf:text-ink">{href ? <a href={href} className="sf:text-inherit sf:no-underline sf:after:absolute sf:after:inset-0 sf:after:rounded-3xl">{text(product.title)}</a> : text(product.title)}</p>
          {price !== null && <p className="sf:text-sm sf:text-muted sf:tabular-nums">{money(props.formatNumber, price, currencyOf(props.data))}</p>}
        </div>
        <span aria-hidden="true" className="sf:grid sf:size-10 sf:shrink-0 sf:place-items-center sf:rounded-full sf:bg-accent sf:text-on-accent"><ArrowUpRight className="sf:size-4 sf:rtl:-scale-x-100" /></span>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- templates */

/**
 * The front page, at the site's root and at the shop's address. On the shop's address, its
 * heading and introduction come from the Shop page record.
 */
function Front(props: Props) {
  const { record, data, options, t, words } = props;
  const products = items(data.products);
  const firstPage = (data.products?.page ?? 1) === 1;
  const intro = record?.intro !== undefined && record?.intro !== null
    ? <div className="sf-prose sf:max-w-lg sf:text-lg sf:text-muted"><RichText doc={record.intro} /></div>
    : <p className="sf:max-w-lg sf:text-lg sf:text-muted">{options.tagline || t("storefront.heroIntro")}</p>;
  return (
    <main>
      {firstPage && (
        <section className={cx(container, "sf:grid sf:items-center sf:gap-10 sf:pt-10 sf:pb-14 sf:lg:grid-cols-[1.1fr_1fr] sf:lg:pt-16")}>
          <div className="sf:flex sf:flex-col sf:items-start sf:gap-6">
            <p className="sf:rounded-full sf:bg-accent/10 sf:px-4 sf:py-1.5 sf:text-sm sf:font-medium sf:text-accent">{t("storefront.kicker")}</p>
            <h1 className="sf:max-w-[12ch] sf:text-5xl sf:leading-[1.02] sf:font-semibold sf:tracking-tight sf:text-balance sf:text-ink sf:sm:text-6xl sf:xl:text-7xl">{text(record?.title) || t("storefront.heroTitle")}</h1>
            {intro}
            {options.search && <ProductSearch id="sf-search" words={forClient(words)} currency={currencyOf(data)} />}
          </div>
          {products[0] && <Spotlight product={products[0]} props={props} />}
        </section>
      )}
      <section aria-labelledby="sf-products" className={cx(container, !firstPage && "sf:pt-12")}>
        <CategoryChips props={props} current={record ? "all" : null} />
        <SectionHeading
          id="sf-products"
          title={firstPage ? t("storefront.newArrivals") : t("storefront.pageOf", { page: data.products?.page ?? 1 })}
          aside={data.products?.totalItems ? t("storefront.products", { count: data.products.totalItems }) : undefined}
        />
        <ProductGrid products={products} props={props} empty={t("storefront.noProducts")} />
        <ProductPager props={props} list={data.products} />
      </section>
    </main>
  );
}

function Category(props: Props) {
  const { record, data, t } = props;
  if (!record) return null;
  return (
    <main>
      <header className={cx(container, "sf:flex sf:flex-col sf:items-start sf:gap-4 sf:pt-10 sf:pb-10 sf:lg:pt-14")}>
        <a href={shopHref(props)} className="sf:inline-flex sf:items-center sf:gap-1 sf:text-sm sf:font-medium sf:text-muted sf:no-underline sf:hover:text-ink">
          <ChevronLeft className="sf:size-4 sf:rtl:-scale-x-100" />{t("storefront.back")}
        </a>
        <h1 className="sf:text-5xl sf:font-semibold sf:tracking-tight sf:text-ink sf:sm:text-6xl">{text(record.name)}</h1>
        {text(record.description) && <p className="sf:max-w-2xl sf:text-lg sf:text-muted">{text(record.description)}</p>}
      </header>
      <section aria-label={text(record.name)} className={container}>
        <CategoryChips props={props} current={record.id} />
        {(data.products?.totalItems ?? 0) > 0 && <p className="sf:mb-6 sf:text-sm sf:text-muted">{t("storefront.products", { count: data.products!.totalItems })}</p>}
        <ProductGrid products={items(data.products)} props={props} empty={t("storefront.emptyCategory")} />
        <ProductPager props={props} list={data.products} />
      </section>
    </main>
  );
}

/**
 * A product: its pictures on a stage, and beside them a panel with the price, options and two
 * ways to buy. Below, its description and products like it.
 */
function Product(props: Props) {
  const { record, data, fileUrl, fileText, stream, t, words } = props;
  if (!record) return null;
  const currency = currencyOf(data);
  const categories = byId(data.categories);
  const category = categories.get(ids(record.categories)[0] ?? -1);
  const images = fileIds(record.images).map((id) => ({ src: fileUrl(id, "800x0"), thumb: fileUrl(id, "100x100"), alt: fileText(id).alt }));
  const variants: VariantOption[] = items(data.variants).map((variant) => ({ id: variant.id, title: text(variant.title), price: num(variant.price), stock: num(variant.stock) }));
  const more = (items(data.related).length ? items(data.related) : items(data.latest)).filter((product) => product.id !== record.id).slice(0, 4);
  const description = Array.isArray(record.description) && record.description.length > 0;
  return (
    <main className={cx(container, "sf:pt-6 sf:lg:pt-10")}>
      <div className="sf:mb-6 sf:flex sf:items-center sf:justify-between sf:gap-4">
        <nav aria-label={t("storefront.back")} className="sf:flex sf:min-w-0 sf:items-center sf:gap-3">
          <a href={shopHref(props)} className={iconButton}><ChevronLeft className="sf:size-5 sf:rtl:-scale-x-100" /><span className="sf:sr-only">{t("storefront.back")}</span></a>
          {category && hrefOf(category, props) && <a href={hrefOf(category, props)} className="sf:hidden sf:truncate sf:text-sm sf:font-medium sf:text-muted sf:no-underline sf:hover:text-ink sf:sm:inline">{text(category.name)}</a>}
        </nav>
        <ShareButton title={text(record.title)} words={forClient(words)} className={iconButton} />
      </div>

      <div className="sf:grid sf:items-start sf:gap-8 sf:lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] sf:lg:gap-14">
        <ProductGallery images={images} transitionName={productTransition(record.id)} words={forClient(words)} />
        <div className="sf:flex sf:flex-col sf:gap-7 sf:rounded-card sf:border sf:border-line sf:bg-page sf:p-6 sf:shadow-card sf:sm:p-10 sf:lg:sticky sf:lg:top-28">
          <span aria-hidden="true" className="sf:mx-auto sf:-mt-2 sf:h-1 sf:w-12 sf:rounded-full sf:bg-line sf:lg:hidden" />
          <div className="sf:flex sf:flex-col sf:gap-2">
            {(category || formatLabel(record, t)) && (
              <p className="sf:flex sf:flex-wrap sf:items-center sf:gap-2 sf:text-sm sf:font-medium">
                {category && <span className="sf:text-accent">{text(category.name)}</span>}
                {formatLabel(record, t) && <span className="sf:rounded-full sf:bg-surface sf:px-3 sf:py-0.5 sf:text-ink">{formatLabel(record, t)}</span>}
              </p>
            )}
            <h1 className="sf:text-3xl sf:font-semibold sf:tracking-tight sf:text-balance sf:text-ink sf:sm:text-4xl">{text(record.title)}</h1>
            {text(record.summary) && <p className="sf:text-muted">{text(record.summary)}</p>}
          </div>
          <BuyBox product={record.id} price={num(record.price)} compareAt={num(record.compareAtPrice)} stock={num(record.stock)} variants={variants} currency={currency} words={forClient(words)} />
          <MembershipPanel props={props} />
          {text(record.sku) && <p className="sf:border-t sf:border-line sf:pt-5 sf:text-xs sf:text-muted">{t("shop.sku", { sku: text(record.sku) })}</p>}
        </div>
      </div>

      {description && (
        <section aria-labelledby="sf-details" className="sf:mt-20 sf:grid sf:gap-6 sf:border-t sf:border-line sf:pt-12 sf:lg:grid-cols-[16rem_minmax(0,1fr)] sf:lg:gap-14">
          <h2 id="sf-details" className="sf:text-2xl sf:font-semibold sf:tracking-tight sf:text-ink">{t("storefront.details")}</h2>
          <div className="sf-prose sf:max-w-measure"><StreamField blocks={record.description} {...stream} /></div>
        </section>
      )}

      {more.length > 0 && (
        <section aria-labelledby="sf-more" className="sf:mt-20">
          <SectionHeading id="sf-more" title={t("storefront.youMayLike")} />
          <ProductGrid products={more} props={props} empty="" />
        </section>
      )}
    </main>
  );
}

/* ------------------------------------------------------------- membership */

interface Plan { name: string; title: string; description: string; amount: number | null; annualAmount: number | null; currency: string; featured: boolean; includes: number[] }

const plansOf = (data: Props["data"]): Plan[] => items(data.plans).map((plan) => ({
  name: text(plan.name),
  title: text(plan.title) || text(plan.name),
  description: text(plan.description),
  amount: num(plan.amount),
  annualAmount: num(plan.annualAmount),
  currency: text(plan.currency) || currencyOf(data),
  featured: plan.featured === true,
  includes: ids(plan.includes),
}));

/** A member's downloads: each library file is fetched through the files API, which checks the same rule again. */
function Downloads({ files, props }: { files: SiteRecord[]; props: Props }) {
  return (
    <ul className="sf:flex sf:flex-wrap sf:gap-2">
      {files.map((file) => {
        const id = text(file.file);
        return id ? (
          <li key={file.id}>
            <a href={props.fileUrl(id)} download className="sf-press sf:inline-flex sf:h-10 sf:items-center sf:gap-2 sf:rounded-full sf:bg-accent sf:px-4 sf:text-sm sf:font-semibold sf:text-on-accent sf:no-underline">
              <Download className="sf:size-4" />{props.t("storefront.download", { label: text(file.label) || props.t("storefront.edition") })}
            </a>
          </li>
        ) : null;
      })}
    </ul>
  );
}

/**
 * On a product in a membership: a member gets its digital edition here, and everyone else sees
 * which membership opens it, from what price, and a way to the library to join.
 */
function MembershipPanel({ props }: { props: Props }) {
  const { record, data, t } = props;
  const access = ids(record?.membership);
  if (!record || !access.length) return null;
  const files = items(data.files);
  const names = items(data.access).filter((item) => access.includes(item.id)).map((item) => text(item.name)).filter(Boolean);
  const plans = plansOf(data).filter((plan) => plan.includes.some((id) => access.includes(id)) && plan.amount !== null);
  const cheapest = plans.sort((a, b) => (a.amount ?? 0) - (b.amount ?? 0))[0];
  return (
    <section aria-label={t("storefront.library")} className="sf:flex sf:flex-col sf:gap-3 sf:rounded-3xl sf:bg-accent/10 sf:p-5">
      <p className="sf:flex sf:items-center sf:gap-2 sf:font-semibold sf:text-ink">
        <BookOpen className="sf:size-5 sf:text-accent" />
        {files.length ? t("storefront.memberRead") : t("storefront.includedIn", { name: names[0] ?? t("storefront.library") })}
      </p>
      {files.length ? <Downloads files={files} props={props} /> : (
        <p className="sf:flex sf:flex-wrap sf:items-center sf:gap-x-3 sf:gap-y-1 sf:text-sm sf:text-muted">
          {cheapest && <span>{t("storefront.fromPrice", { price: money(props.formatNumber, cheapest.amount!, cheapest.currency) })}</span>}
          <a href={inLanguage(props, "/library")} className="sf:font-semibold sf:text-accent sf:underline sf:underline-offset-4">{t("storefront.join")}</a>
        </p>
      )}
    </section>
  );
}

/** One membership to choose, with its price and the provider's checkout behind Subscribe. */
function PlanCard({ plan, props, member }: { plan: Plan; props: Props; member: boolean }) {
  const { t, words } = props;
  return (
    <li className={cx("sf:flex sf:flex-col sf:gap-4 sf:rounded-card sf:border sf:p-7", plan.featured ? "sf:border-accent sf:bg-accent/5 sf:shadow-card" : "sf:border-line sf:bg-page")}>
      <div className="sf:flex sf:flex-col sf:gap-1">
        <h3 className="sf:text-xl sf:font-semibold sf:text-ink">{plan.title}</h3>
        {plan.description && <p className="sf:text-muted">{plan.description}</p>}
      </div>
      {plan.amount !== null && (
        <p className="sf:flex sf:flex-wrap sf:items-baseline sf:gap-x-2 sf:text-ink">
          <span className="sf:text-4xl sf:font-semibold sf:tracking-tight sf:tabular-nums">{money(props.formatNumber, plan.amount, plan.currency)}</span>
          <span className="sf:text-muted">{t("storefront.perMonth")}</span>
          {plan.annualAmount !== null && <span className="sf:basis-full sf:text-sm sf:text-muted">{t("storefront.perYear", { price: money(props.formatNumber, plan.annualAmount, plan.currency) })}</span>}
        </p>
      )}
      <div className="sf-plan-action sf:mt-auto">
        {member ? <BillingButton words={words ? pickWords(words, "payments") : undefined} /> : <SubscribeButton plan={plan.name} label={t("storefront.join")} words={words ? pickWords(words, "payments") : undefined} />}
      </div>
    </li>
  );
}

/**
 * The members' library: the memberships to join, then every product in one. A member's own
 * editions show their downloads, read through the rule as them. The rest show a lock.
 */
function Library(props: Props) {
  const { record, data, t } = props;
  const books = items(data.books);
  const files = items(data.files);
  const member = files.length > 0;
  const plans = plansOf(data);
  const categories = byId(data.categories);
  const filesOf = (product: number) => files.filter((file) => file.product === product);
  return (
    <main className={cx(container, "sf:pt-10 sf:lg:pt-14")}>
      <PageHeading title={text(record?.title) || t("storefront.library")} record={record} />
      {member && <p className="sf:mb-8 sf:inline-flex sf:items-center sf:gap-2 sf:rounded-full sf:bg-accent/10 sf:px-4 sf:py-2 sf:text-sm sf:font-medium sf:text-accent"><BookOpen className="sf:size-4" />{t("storefront.youAreMember")}</p>}
      {plans.length > 0 && (
        <section aria-labelledby="sf-plans" className="sf:mb-16">
          <SectionHeading id="sf-plans" title={t("storefront.memberships")} />
          <ul className="sf:grid sf:gap-5 sf:md:grid-cols-2 sf:xl:grid-cols-3">
            {plans.map((plan) => <PlanCard key={plan.name} plan={plan} props={props} member={member} />)}
          </ul>
        </section>
      )}
      <section aria-labelledby="sf-library-books">
        <SectionHeading id="sf-library-books" title={t("storefront.inTheLibrary")} aside={books.length ? t("storefront.products", { count: books.length }) : undefined} />
        {books.length ? (
          <ul className="sf:grid sf:grid-cols-2 sf:gap-x-4 sf:gap-y-10 sf:sm:gap-x-6 sf:md:grid-cols-3 sf:xl:grid-cols-4">
            {books.map((book, index) => {
              const open = filesOf(book.id);
              return (
                <li key={book.id} className="sf:flex sf:flex-col sf:gap-3">
                  <ProductCard product={book} categories={categories} props={props} eager={index < 4} />
                  <div className="sf:px-2">
                    {open.length ? <Downloads files={open} props={props} /> : <p className="sf:inline-flex sf:items-center sf:gap-1.5 sf:text-sm sf:text-muted"><Lock className="sf:size-4" />{t("storefront.membersOnly")}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : <p className="sf:text-muted">{t("storefront.libraryEmpty")}</p>}
      </section>
    </main>
  );
}

function PageHeading({ title, record, back }: { title: string; record: SiteRecord | null; back?: ReactNode }) {
  return (
    <header className="sf:mb-10 sf:flex sf:flex-col sf:items-start sf:gap-4">
      {back}
      <h1 className="sf:text-4xl sf:font-semibold sf:tracking-tight sf:text-ink sf:sm:text-5xl">{title}</h1>
      {record?.intro !== undefined && record?.intro !== null && <div className="sf-prose sf:max-w-2xl sf:text-muted"><RichText doc={record.intro} /></div>}
    </header>
  );
}

/** The cart is the shop plugin's, laid out in two columns by theme.css: lines, then where it goes and the total. */
function CartPage(props: Props) {
  const { record, t, words } = props;
  return (
    <main className={cx(container, "sf:pt-10 sf:lg:pt-14")}>
      <PageHeading
        title={text(record?.title) || t("shop.yourCart")}
        record={record}
        back={<a href={shopHref(props)} className="sf:inline-flex sf:items-center sf:gap-1 sf:text-sm sf:font-medium sf:text-muted sf:no-underline sf:hover:text-ink"><ChevronLeft className="sf:size-4 sf:rtl:-scale-x-100" />{t("storefront.back")}</a>}
      />
      <div className="sf-cart"><ShopCart words={words ? pickWords(words, "shop") : undefined} /></div>
    </main>
  );
}

/** The signed-in customer's orders, read as them, as the shop plugin lists them. */
function OrdersPage(props: Props) {
  const { record, data, fileUrl, t, words } = props;
  return (
    <main className={cx(container, "sf:max-w-4xl sf:pt-10 sf:lg:pt-14")}>
      <PageHeading title={text(record?.title) || t("shop.yourOrders")} record={record} />
      <div className="sf-orders">
        <OrderReturn words={words ? pickWords(words, "shop") : undefined} />
        <OrderList orders={items(data.orders)} fileUrl={fileUrl} words={words} />
      </div>
    </main>
  );
}

/** Any other page, such as About. */
function Page({ record, stream }: Props) {
  if (!record) return null;
  return (
    <main className={cx(container, "sf:max-w-3xl sf:pt-12 sf:lg:pt-16")}>
      <article>
        <h1 className="sf:mb-8 sf:text-4xl sf:font-semibold sf:tracking-tight sf:text-ink sf:sm:text-5xl">{text(record.title) || text(record.name)}</h1>
        <div className="sf-prose"><StreamField blocks={record.body} {...stream} /></div>
      </article>
    </main>
  );
}

/**
 * Categories have a name rather than a title. Only fills what the CMS's defaults (seo_title,
 * title, seo_description, summary) would leave empty.
 */
function metadata({ record }: Props) {
  if (!record) return {};
  return {
    title: !text(record.seo_title) && !text(record.title) ? text(record.name) || undefined : undefined,
    description: !text(record.seo_description) && !text(record.summary) ? text(record.description) || undefined : undefined,
  };
}

export default defineThemeComponents<StorefrontOptions>({
  // The shop's blocks (product grids, add to cart) come from the plugin and are restyled in theme.css.
  templates: { home: Front, "shop-store": Front, "shop-categories": Category, "shop-products": Product, library: Library, "shop-cart": CartPage, "shop-account": OrdersPage, default: Page },
  layouts: { default: Layout },
  metadata,
  fontClassName: font.variable,
  messages,
});
