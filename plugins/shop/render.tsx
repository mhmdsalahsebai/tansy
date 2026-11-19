import { defineRenderers, Pager, pickWords, RichText, sitePath, StreamField, type BlockProps, type SiteWords } from "tansy/react";
import type { SiteList, SiteRecord, TemplateProps } from "tansy/theme";
import { formatMoney, linesOf, str } from "./logic";
import { AddProduct, AddToCart, Cart, OrderReturn, PayButton, ProductCard, ProductGrid, SignInLink, type ListedProduct, type VariantOption } from "./parts";
import { siteMessages } from "./site-messages";
import { shopWords } from "./words";
import { ACCOUNT, CART, CATEGORIES, ORDERS, PRODUCTS, STORE, VARIANTS } from "./schema";
import "./shop.css";

const items = (list: SiteList | undefined) => list?.items ?? [];
const num = (value: unknown) => (typeof value === "number" ? value : null);
/** The shop's currency, from the Shop page every template here asks for as `store`. */
const currencyOf = (data: TemplateProps["data"]) => str(items(data.store)[0]?.currency) || "usd";

/** The shop's words for a client part, and no one else's. */
const forParts = (words: SiteWords | undefined) => (words ? pickWords(words, "shop") : undefined);

/** A grid of products from a list, as the shop's own queries return them. Pass the template's `words`. */
export function ProductList({ list, currency, path, empty, words }: { list: SiteList | undefined; currency: string; path: string; empty?: string; words?: SiteWords }) {
  const products = items(list);
  if (!products.length) return <p className="shop-muted">{empty ?? shopWords(words).t("shop.noProducts")}</p>;
  return (
    <>
      <ul className="shop-grid">{products.map((product) => <ProductCard key={product.id} product={product as ListedProduct} currency={currency} words={forParts(words)} />)}</ul>
      <Pager list={list} path={path} className="shop-pager" words={words} />
    </>
  );
}

function Intro({ record }: { record: SiteRecord | null }) {
  return record?.intro !== undefined && record?.intro !== null ? <div className="shop-body"><RichText doc={record.intro} /></div> : null;
}

function ShopFront({ record, data, path, t, words }: TemplateProps) {
  const categories = items(data.categories);
  return (
    <main className="shop-main shop-wide">
      <header className="shop-hero">
        <h1>{str(record?.title) || t("shop.shop")}</h1>
        <Intro record={record} />
      </header>
      {categories.length > 0 && (
        <nav className="shop-categories" aria-label={t("shop.categories")}>
          {categories.map((category) => <a key={category.id} href={str(category.recordPath) ? sitePath(words, str(category.recordPath)) : "#"}>{str(category.name)}</a>)}
        </nav>
      )}
      <ProductList list={data.products} currency={currencyOf(data)} path={path} words={words} />
    </main>
  );
}

function Category({ record, data, path, fileUrl, fileText, t, words }: TemplateProps) {
  if (!record) return null;
  return (
    <main className="shop-main shop-wide">
      <header className="shop-hero">
        {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked API address, which next/image can't optimize */}
        {str(record.image) && <img className="shop-banner" src={fileUrl(str(record.image), "800x0")} alt={fileText(str(record.image)).alt} />}
        <h1>{str(record.name)}</h1>
        {str(record.description) && <p className="shop-lead">{str(record.description)}</p>}
      </header>
      <ProductList list={data.products} currency={currencyOf(data)} path={path} empty={t("shop.emptyCategory")} words={words} />
    </main>
  );
}

function Product({ record, data, fileUrl, fileText, stream, t, words }: TemplateProps) {
  if (!record) return null;
  const currency = currencyOf(data);
  const images = Array.isArray(record.images) ? record.images.filter((id): id is string => typeof id === "string") : [];
  const variants: VariantOption[] = items(data.variants).map((variant) => ({ id: variant.id, title: str(variant.title), price: num(variant.price), stock: num(variant.stock) }));
  const price = num(record.price);
  const was = num(record.compareAtPrice);
  return (
    <main className="shop-main shop-wide">
      <div className="shop-product">
        <div className="shop-gallery">
          {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked API address, which next/image can't optimize */}
          {images.length ? images.map((id, index) => <img key={id} className={index === 0 ? "shop-gallery-main" : "shop-gallery-thumb"} src={fileUrl(id, index === 0 ? "800x0" : "300x300")} alt={fileText(id).alt} />) : <span className="shop-gallery-main" aria-hidden />}
        </div>
        <div className="shop-details">
          <h1>{str(record.title)}</h1>
          {was !== null && price !== null && was > price && <p className="shop-muted"><s>{formatMoney(was, currency, words?.locale)}</s></p>}
          {str(record.summary) && <p className="shop-lead">{str(record.summary)}</p>}
          <AddToCart product={record.id} price={price} stock={num(record.stock)} variants={variants} currency={currency} words={forParts(words)} />
          {str(record.sku) && <p className="shop-muted shop-small">{t("shop.sku", { sku: str(record.sku) })}</p>}
        </div>
      </div>
      {Array.isArray(record.description) && record.description.length > 0 && <div className="shop-body shop-description"><StreamField blocks={record.description} {...stream} /></div>}
    </main>
  );
}

function CartPage({ record, t, words }: TemplateProps) {
  return (
    <main className="shop-main">
      <h1>{str(record?.title) || t("shop.yourCart")}</h1>
      <Intro record={record} />
      <Cart words={forParts(words)} />
    </main>
  );
}

const STATES = new Set(["pending", "paid", "shipped", "delivered", "cancelled", "refunded"]);

/** The signed-in customer's orders, read as them, so the rule shows each person only their own. Pass the template's `words`. */
export function OrderList({ orders, fileUrl, words }: { orders: SiteRecord[]; fileUrl: TemplateProps["fileUrl"]; words?: SiteWords }) {
  const { t, formatDate } = shopWords(words);
  if (!orders.length) return <p className="shop-muted">{t("shop.noOrders")} <SignInLink label={t("shop.signInToSee")} /></p>;
  return (
    <ul className="shop-orders">
      {orders.map((order) => {
        const currency = str(order.currency) || "usd";
        const state = str(order.state);
        const downloads = Array.isArray(order.downloads) ? order.downloads.filter((id): id is string => typeof id === "string") : [];
        return (
          <li key={order.id} className="shop-order">
            <header>
              <h2>{t("shop.order", { id: order.id })}</h2>
              <span className={`shop-state shop-state-${state}`}>{STATES.has(state) ? t(`shop.states.${state}`) : state}</span>
              <span className="shop-muted">{str(order.createdAt) ? formatDate(str(order.createdAt)) : ""}</span>
            </header>
            <ul className="shop-order-lines">
              {linesOf(order.lines).map((line, index) => (
                <li key={index}><span>{line.title}{line.variantTitle ? ` · ${line.variantTitle}` : ""} × {line.quantity}</span><span>{formatMoney(line.subtotal, currency, words?.locale)}</span></li>
              ))}
            </ul>
            <dl className="shop-totals">
              {order.needsShipping === true && <div><dt>{t("shop.shipping")}</dt><dd>{num(order.shippingCost) ? formatMoney(num(order.shippingCost)!, currency, words?.locale) : t("shop.free")}</dd></div>}
              <div className="shop-grand"><dt>{t("shop.total")}</dt><dd>{formatMoney(num(order.total) ?? 0, currency, words?.locale)}</dd></div>
            </dl>
            {state === "pending" && <PayButton orderId={order.id} words={forParts(words)} />}
            {str(order.trackingUrl) && <p><a href={str(order.trackingUrl)} rel="noopener noreferrer" target="_blank">{t("shop.track")}</a></p>}
            {downloads.length > 0 && <p className="shop-downloads">{downloads.map((id, index) => <a key={id} href={fileUrl(id)} download>{downloads.length > 1 ? t("shop.downloadNumber", { number: index + 1 }) : t("shop.download")}</a>)}</p>}
          </li>
        );
      })}
    </ul>
  );
}

function OrdersPage({ record, data, fileUrl, t, words }: TemplateProps) {
  return (
    <main className="shop-main">
      <h1>{str(record?.title) || t("shop.yourOrders")}</h1>
      <Intro record={record} />
      <OrderReturn words={forParts(words)} />
      <OrderList orders={items(data.orders)} fileUrl={fileUrl} words={words} />
    </main>
  );
}

function ProductsBlock({ value, words }: BlockProps) {
  return <ProductGrid category={num(value.category)} limit={num(value.limit) ?? 8} title={str(value.title) || undefined} words={forParts(words)} />;
}

function AddToCartBlock({ value, words }: BlockProps) {
  const product = num(value.product);
  return product === null ? null : <AddProduct product={product} words={forParts(words)} />;
}

const STORE_QUERY = { store: { collection: STORE, perPage: 1, fields: "currency" } };
const LISTED = { collection: PRODUCTS, sort: "-createdAt", fields: "id,title,price,compareAtPrice,images,stock", urls: "1", perPage: 24, paged: true } as const;

export default defineRenderers({
  messages: siteMessages,
  blocks: { shop_products: ProductsBlock, shop_add_to_cart: AddToCartBlock },
  templates: { [STORE]: ShopFront, [PRODUCTS]: Product, [CATEGORIES]: Category, [CART]: CartPage, [ACCOUNT]: OrdersPage },
  queries: {
    [STORE]: { ...STORE_QUERY, products: LISTED, categories: { collection: CATEGORIES, sort: "name", perPage: 50, fields: "id,name", urls: "1" } },
    [PRODUCTS]: { ...STORE_QUERY, variants: { collection: VARIANTS, filter: "product = @record.id", sort: "position", perPage: 100, fields: "id,title,price,stock" } },
    [CATEGORIES]: { ...STORE_QUERY, products: { ...LISTED, filter: "categories ?= @record.id" } },
    [ACCOUNT]: {
      orders: { collection: ORDERS, viewer: true, sort: "-createdAt", perPage: 50, fields: "id,state,lines,shippingCost,total,currency,needsShipping,trackingUrl,downloads,createdAt" },
    },
  },
});
