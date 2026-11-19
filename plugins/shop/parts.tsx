"use client";

import { useCallback, useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { apiPath, authPath, contentLocale, sitePath, type SiteWords } from "tansy/react";
import { COUNTRY_CODES, formatMoney, type CartItem } from "./logic";
import { shopWords } from "./words";

/**
 * The shop's parts with behaviour, for its own templates and for any theme's. Everything
 * here goes through public routes, so a headless site can rebuild it. Each takes the page's
 * `words` (`pickWords(words, "shop")` from a template) to speak its language and keep links
 * in it. Without them, English.
 */

const CART_KEY = "tansy-shop-cart";
const CHANGED = "shop-cart-changed";

/** The cart lives in the browser, so it works before sign-in. Checkout prices it again on the server. */
export function readCart(): CartItem[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CART_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const { product, variant, quantity } = (entry ?? {}) as Record<string, unknown>;
      if (typeof product !== "number" || typeof quantity !== "number" || quantity < 1) return [];
      return [{ product, variant: typeof variant === "number" ? variant : null, quantity: Math.min(99, Math.floor(quantity)) }];
    }).slice(0, 50);
  } catch {
    return [];
  }
}

export function writeCart(items: CartItem[]) {
  try {
    window.localStorage.setItem(CART_KEY, JSON.stringify(items.filter((item) => item.quantity > 0).slice(0, 50)));
  } catch { /* storage blocked: the cart lasts as long as the page */ }
  window.dispatchEvent(new Event(CHANGED));
}

export function addToCart(product: number, variant: number | null, quantity: number) {
  const items = readCart();
  const found = items.find((item) => item.product === product && (item.variant ?? null) === variant);
  if (found) found.quantity = Math.min(99, found.quantity + quantity);
  else items.push({ product, variant, quantity });
  writeCart(items);
}

function useCart() {
  const [items, setItems] = useState<CartItem[] | null>(null);
  useEffect(() => {
    const load = () => setItems(readCart());
    load();
    window.addEventListener(CHANGED, load);
    window.addEventListener("storage", load);
    return () => {
      window.removeEventListener(CHANGED, load);
      window.removeEventListener("storage", load);
    };
  }, []);
  return items;
}

/** A file's square thumbnail, through the access-checked files API. */
const thumb = (fileId: string) => apiPath(`/files/${encodeURIComponent(fileId)}?thumb=300x300`);

const here = () => `${window.location.pathname}${window.location.search}`;
/** An address on this site in the page's language, as a path: Payments takes a return path, not a URL. */
const localPath = (words: SiteWords | undefined, path: string) => {
  const url = new URL(sitePath(words, path), window.location.href);
  return `${url.pathname}${url.search}`;
};
/** `&locale=…` for the records API, on a site with more than one language. */
const inLanguage = (words: SiteWords | undefined) => (contentLocale(words) ? `&locale=${encodeURIComponent(contentLocale(words)!)}` : "");
const signInHref = (next = here()) => authPath(`signin?next=${encodeURIComponent(next)}`);

async function send(path: string, body: unknown) {
  const response = await fetch(apiPath(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json().catch(() => null) as (Record<string, unknown> & { error?: { message?: string } }) | null;
  return { status: response.status, ok: response.ok, json };
}

async function records<T>(slug: string, query: string) {
  const response = await fetch(apiPath(`/collections/${slug}/records?${query}`));
  if (!response.ok) return [];
  return ((await response.json()) as { items?: T[] }).items ?? [];
}

/** How many things are in the cart, linking to it. For a theme's header. `label` can be an icon with hidden text, so the link keeps a name. */
export function CartLink({ href = "/cart", label, className = "shop-cart-link", words }: { href?: string; label?: ReactNode; className?: string; words?: SiteWords }) {
  const { t } = shopWords(words);
  const items = useCart();
  const count = items?.reduce((total, item) => total + item.quantity, 0) ?? 0;
  return <a className={className} href={sitePath(words, href)}>{label ?? t("shop.cart")}{count > 0 && <span className="shop-count" aria-label={t("shop.items", { count })}>{count}</span>}</a>;
}

export interface VariantOption { id: number; title: string; price: number | null; stock: number | null }

/** Chooses a variant, when the product has them, and a quantity, and adds them to the cart. */
export function AddToCart({ product, price, stock, variants = [], currency, cartHref = "/cart", words }: { product: number; price: number | null; stock: number | null; variants?: VariantOption[]; currency: string; cartHref?: string; words?: SiteWords }) {
  const { t } = shopWords(words);
  const locale = words?.locale;
  const id = useId();
  const [variant, setVariant] = useState<number | null>(variants.find((option) => option.stock !== 0)?.id ?? null);
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);
  const chosen = variants.find((option) => option.id === variant) ?? null;
  const left = variants.length ? chosen?.stock ?? null : stock;
  const amount = chosen?.price ?? price;
  const soldOut = variants.length ? !chosen || chosen.stock === 0 : stock === 0;

  function add(event: FormEvent) {
    event.preventDefault();
    if (soldOut) return;
    addToCart(product, chosen?.id ?? null, quantity);
    setAdded(true);
  }

  return (
    <form className="shop-buy" onSubmit={add}>
      {amount !== null && <p className="shop-price shop-price-large">{formatMoney(amount, currency, locale)}</p>}
      {variants.length > 0 && (
        <label className="shop-field" htmlFor={`${id}-variant`}>
          <span>{t("shop.option")}</span>
          <select id={`${id}-variant`} value={variant ?? ""} onChange={(event) => { setVariant(Number(event.target.value) || null); setAdded(false); }}>
            {variants.map((option) => <option key={option.id} value={option.id} disabled={option.stock === 0}>{option.stock === 0 ? t("shop.soldOutOption", { title: option.title }) : option.title}</option>)}
          </select>
        </label>
      )}
      {!soldOut && (
        <label className="shop-field shop-field-small" htmlFor={`${id}-quantity`}>
          <span>{t("shop.quantity")}</span>
          <input id={`${id}-quantity`} type="number" min={1} max={Math.min(99, left ?? 99)} value={quantity} onChange={(event) => setQuantity(Math.max(1, Math.min(99, Number(event.target.value) || 1)))} />
        </label>
      )}
      {left !== null && left > 0 && left <= 5 && <p className="shop-muted">{t("shop.onlyLeft", { count: left })}</p>}
      <button type="submit" className="shop-button" disabled={soldOut}>{soldOut ? t("shop.soldOut") : t("shop.addToCart")}</button>
      {added && <p className="shop-success" role="status">{t("shop.added")} <a href={sitePath(words, cartHref)}>{t("shop.viewCart")}</a></p>}
    </form>
  );
}

/** What the server says about the cart: priced from stored products, with shipping for the chosen country. */
interface Quote {
  currency: string | null;
  lines: Array<{ product: number; variant: number | null; title: string; variantTitle: string | null; unitPrice: number; quantity: number; subtotal: number; available: boolean; issue: Issue | null; href: string | null; image: string | null }>;
  subtotal: number;
  needsShipping: boolean;
  shipping: number | null;
  total: number | null;
  countries: string[] | "any";
  issues: Issue[];
  ready: boolean;
}
interface Issue { code: string; values?: Record<string, number> }

const EMPTY_ADDRESS = { name: "", line1: "", line2: "", city: "", region: "", postalCode: "", phone: "" };
const regionNames = (locale: string) => { try { return new Intl.DisplayNames([locale, "en"], { type: "region" }); } catch { return null; } };

/** The cart page: lines, where to send it, and checkout through the Payments plugin. */
export function Cart({ ordersPath = "/orders", words }: { ordersPath?: string; words?: SiteWords }) {
  const { t } = shopWords(words);
  const locale = words?.locale ?? "en";
  const reading = contentLocale(words);
  const items = useCart();
  const id = useId();
  const [country, setCountry] = useState("");
  const [address, setAddress] = useState(EMPTY_ADDRESS);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = useMemo(() => regionNames(locale), [locale]);

  useEffect(() => {
    if (!items) return;
    let live = true;
    void send("/ext/shop/quote", { items, ...(country ? { country } : {}), ...(reading ? { locale: reading } : {}) }).then(({ ok, json }) => {
      if (live) setQuote(ok ? json as unknown as Quote : null);
    }).catch(() => { if (live) setQuote(null); });
    return () => { live = false; };
  }, [items, country, reading]);

  const setQuantity = useCallback((product: number, variant: number | null, quantity: number) => {
    writeCart(readCart().map((item) => (item.product === product && (item.variant ?? null) === variant ? { ...item, quantity } : item)));
  }, []);

  async function checkout(event: FormEvent) {
    event.preventDefault();
    if (!items?.length) return;
    setBusy(true);
    setError(null);
    try {
      const shipping = quote?.needsShipping ? { country, address: Object.fromEntries(Object.entries(address).filter(([, value]) => value.trim())) } : {};
      const made = await send("/ext/shop/orders", { items, ...shipping, ...(reading ? { locale: reading } : {}) });
      if (made.status === 401) return void window.location.assign(signInHref());
      if (!made.ok) return setError(t("shop.orderFailed"));
      const order = (made.json as { order: { id: number } }).order;
      // The order is a record with a price, so Payments sells it like anything else.
      const paying = await send("/ext/payments/checkout", { collection: "shop-orders", id: order.id, returnPath: `${localPath(words, ordersPath)}?order=${order.id}` });
      const url = (paying.json as { url?: string } | null)?.url;
      if (!paying.ok || !url) return setError(t("shop.checkoutSaved"));
      window.location.assign(url);
    } catch {
      setError(t("shop.orderOffline"));
    } finally {
      setBusy(false);
    }
  }

  if (!items) return null;
  if (!items.length) return <p className="shop-muted">{t("shop.emptyCart")}</p>;
  if (!quote) return <p className="shop-muted" role="status">{t("shop.pricing")}</p>;
  const currency = quote.currency ?? "usd";
  const money = (amount: number) => formatMoney(amount, currency, locale);
  const countries = quote.countries === "any" ? COUNTRY_CODES : quote.countries;
  const field = (name: keyof typeof EMPTY_ADDRESS, label: string, required = true, autoComplete?: string) => (
    <label className="shop-field" htmlFor={`${id}-${name}`}>
      <span>{label}{!required && <span className="shop-muted"> {t("shop.optional")}</span>}</span>
      <input id={`${id}-${name}`} required={required} autoComplete={autoComplete} maxLength={200} value={address[name]} onChange={(event) => setAddress({ ...address, [name]: event.target.value })} />
    </label>
  );

  return (
    <form className="shop-cart" onSubmit={checkout}>
      <ul className="shop-lines">
        {quote.lines.map((line) => (
          <li key={`${line.product}:${line.variant ?? ""}`} className="shop-line">
            {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked API address, which next/image can't optimize */}
            {line.image ? <img className="shop-thumb" src={thumb(line.image)} alt="" /> : <span className="shop-thumb" aria-hidden />}
            <div className="shop-line-main">
              {line.href ? <a href={sitePath(words, line.href)}>{line.title}</a> : <span>{line.title}</span>}
              {line.variantTitle && <span className="shop-muted"> · {line.variantTitle}</span>}
              {line.issue ? <p className="shop-error">{t(`shop.issues.${line.issue.code}`, line.issue.values)}</p> : <p className="shop-muted">{t("shop.each", { price: money(line.unitPrice) })}</p>}
            </div>
            <label className="shop-qty">
              <span className="sr-only">{t("shop.quantityOf", { title: line.title })}</span>
              <input type="number" min={0} max={99} value={line.quantity} onChange={(event) => setQuantity(line.product, line.variant, Math.max(0, Math.min(99, Number(event.target.value) || 0)))} />
            </label>
            <span className="shop-line-total">{money(line.subtotal)}</span>
            <button type="button" className="shop-link-button" onClick={() => setQuantity(line.product, line.variant, 0)}>{t("shop.remove")}</button>
          </li>
        ))}
      </ul>

      {quote.needsShipping && countries.length > 0 && (
        <fieldset className="shop-address">
          <legend>{t("shop.whereTo")}</legend>
          <label className="shop-field" htmlFor={`${id}-country`}>
            <span>{t("shop.country")}</span>
            <select id={`${id}-country`} required value={country} onChange={(event) => setCountry(event.target.value)} autoComplete="country">
              <option value="">{t("shop.chooseCountry")}</option>
              {countries.map((code) => <option key={code} value={code}>{names?.of(code) ?? code}</option>)}
            </select>
          </label>
          {field("name", t("shop.fullName"), true, "name")}
          {field("line1", t("shop.address"), true, "address-line1")}
          {field("line2", t("shop.address2"), false, "address-line2")}
          <div className="shop-row">
            {field("city", t("shop.city"), true, "address-level2")}
            {field("region", t("shop.region"), false, "address-level1")}
            {field("postalCode", t("shop.postalCode"), true, "postal-code")}
          </div>
          {field("phone", t("shop.phone"), false, "tel")}
        </fieldset>
      )}

      <dl className="shop-totals">
        <div><dt>{t("shop.subtotal")}</dt><dd>{money(quote.subtotal)}</dd></div>
        {quote.needsShipping && <div><dt>{t("shop.shipping")}</dt><dd>{quote.shipping === null ? "—" : quote.shipping === 0 ? t("shop.free") : money(quote.shipping)}</dd></div>}
        <div className="shop-grand"><dt>{t("shop.total")}</dt><dd>{quote.total === null ? "—" : money(quote.total)}</dd></div>
      </dl>
      {/* Every reason checkout is off, so a disabled button always says why. */}
      {quote.issues.map((issue) => <p key={issue.code} className={issue.code === "chooseCountry" ? "shop-muted" : "shop-error"} role="status">{t(`shop.issues.${issue.code}`, issue.values)}</p>)}
      <button type="submit" className="shop-button" disabled={busy || !quote.ready}>{busy ? t("shop.opening") : t("shop.checkout")}</button>
      {error && <p className="shop-error" role="alert">{error}</p>}
    </form>
  );
}

/** Pays for an order that's waiting for payment. */
export function PayButton({ orderId, ordersPath = "/orders", words }: { orderId: number; ordersPath?: string; words?: SiteWords }) {
  const { t } = shopWords(words);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const { status, ok, json } = await send("/ext/payments/checkout", { collection: "shop-orders", id: orderId, returnPath: `${localPath(words, ordersPath)}?order=${orderId}` });
      if (status === 401) return void window.location.assign(signInHref());
      const url = (json as { url?: string } | null)?.url;
      if (!ok || !url) return setError(t("shop.checkoutFailed"));
      window.location.assign(url);
    } catch {
      setError(t("shop.checkoutOffline"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="shop-cta">
      <button type="button" className="shop-button" onClick={pay} disabled={busy}>{busy ? t("shop.opening") : t("shop.payNow")}</button>
      {error && <p className="shop-error" role="alert">{error}</p>}
    </div>
  );
}

/**
 * Back from the payment provider: confirms the payment through Payments, so the order
 * doesn't wait for the webhook, empties the cart, and reloads once the order is paid.
 */
export function OrderReturn({ words }: { words?: SiteWords }) {
  const { t } = shopWords(words);
  const params = useSearchParams();
  const returned = params.get("purchase") === "success";
  const sessionId = params.get("session_id");
  const order = Number(params.get("order"));
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!returned || !Number.isSafeInteger(order) || order <= 0) return;
    writeCart([]);
    if (sessionId) void send("/ext/payments/confirm", { sessionId }).catch(() => null);
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      const [found] = await records<{ state?: string }>("shop-orders", `filter=${encodeURIComponent(`id = ${order}`)}&fields=state&perPage=1`).catch(() => []);
      if (found?.state && found.state !== "pending" && found.state !== "cancelled") {
        clearInterval(timer);
        window.location.assign(window.location.pathname);
      } else if (tries >= 20) {
        clearInterval(timer);
        setSlow(true);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [returned, sessionId, order]);

  if (!returned) return null;
  return slow
    ? <p className="shop-notice" role="status">{t("shop.paymentSlow")}</p>
    : <p className="shop-notice shop-success" role="status">{t("shop.paymentReceived")}</p>;
}

/** Sends a signed-out visitor to sign in and back. */
export function SignInLink({ label, words }: { label?: string; words?: SiteWords }) {
  // The address to come back to is known only in the browser, so it's added on click.
  return <a href={authPath("signin")} onClick={(event) => { event.preventDefault(); window.location.assign(signInHref()); }}>{label ?? shopWords(words).t("shop.signIn")}</a>;
}

/** A product as lists read it. */
export interface ListedProduct { id: number; title?: string; price?: number | null; compareAtPrice?: number | null; images?: string[]; stock?: number | null; recordPath?: string }

/** One product in a grid. */
export function ProductCard({ product, currency, words }: { product: ListedProduct; currency: string; words?: SiteWords }) {
  const { t } = shopWords(words);
  const locale = words?.locale;
  const image = Array.isArray(product.images) ? product.images[0] : undefined;
  const price = typeof product.price === "number" ? product.price : null;
  const was = typeof product.compareAtPrice === "number" && price !== null && product.compareAtPrice > price ? product.compareAtPrice : null;
  return (
    <li className="shop-card">
      <a href={product.recordPath ? sitePath(words, product.recordPath) : "#"}>
        {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked API address, which next/image can't optimize */}
        {image ? <img className="shop-card-image" src={thumb(image)} alt="" loading="lazy" /> : <span className="shop-card-image" aria-hidden />}
        <span className="shop-card-title">{product.title ?? t("shop.product", { id: product.id })}</span>
      </a>
      <span className="shop-price">
        {price !== null && formatMoney(price, currency, locale)}
        {was !== null && <s className="shop-muted"> {formatMoney(was, currency, locale)}</s>}
        {product.stock === 0 && <span className="shop-badge">{t("shop.soldOut")}</span>}
      </span>
    </li>
  );
}

const LIST_FIELDS = "id,title,price,compareAtPrice,images,stock";

async function storeCurrency() {
  const [store] = await records<{ currency?: string }>("shop-store", "perPage=1&fields=currency");
  return store?.currency ?? "usd";
}

/** Products from the records API, for blocks on any page. */
export function ProductGrid({ category, limit = 8, title, words }: { category: number | null; limit?: number; title?: string; words?: SiteWords }) {
  const language = inLanguage(words);
  const [state, setState] = useState<{ products: ListedProduct[]; currency: string } | null>(null);
  useEffect(() => {
    let live = true;
    const filter = category ? `&filter=${encodeURIComponent(`categories ?= ${category}`)}` : "";
    void Promise.all([records<ListedProduct>("shop-products", `perPage=${limit}&sort=-createdAt&fields=${LIST_FIELDS}&urls=1${filter}${language}`), storeCurrency()])
      .then(([products, currency]) => { if (live) setState({ products, currency }); })
      .catch(() => { if (live) setState({ products: [], currency: "usd" }); });
    return () => { live = false; };
  }, [category, limit, language]);
  if (!state) return null;
  return (
    <section className="shop-block">
      {title && <h2>{title}</h2>}
      {state.products.length ? <ul className="shop-grid">{state.products.map((product) => <ProductCard key={product.id} product={product} currency={state.currency} words={words} />)}</ul> : <p className="shop-muted">{shopWords(words).t("shop.noProducts")}</p>}
    </section>
  );
}

/** Add to cart for one product, by id, for a block on any page. */
export function AddProduct({ product, words }: { product: number; words?: SiteWords }) {
  const language = inLanguage(words);
  const [state, setState] = useState<{ found: ListedProduct & { price?: number | null }; variants: VariantOption[]; currency: string } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([
      records<ListedProduct>("shop-products", `perPage=1&fields=${LIST_FIELDS}&urls=1&filter=${encodeURIComponent(`id = ${product}`)}${language}`),
      records<VariantOption>("shop-variants", `perPage=100&sort=position&fields=id,title,price,stock&filter=${encodeURIComponent(`product = ${product}`)}${language}`),
      storeCurrency(),
    ]).then(([[found], variants, currency]) => { if (live && found) setState({ found, variants, currency }); }).catch(() => null);
    return () => { live = false; };
  }, [product, language]);
  if (!state) return null;
  return (
    <div className="shop-block">
      <p className="shop-card-title">{state.found.recordPath ? <a href={sitePath(words, state.found.recordPath)}>{state.found.title}</a> : state.found.title}</p>
      <AddToCart product={product} price={state.found.price ?? null} stock={state.found.stock ?? null} variants={state.variants} currency={state.currency} words={words} />
    </div>
  );
}
