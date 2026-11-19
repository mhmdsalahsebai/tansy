"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { addToCart, type VariantOption } from "@tansy/shop/react";
import { apiPath, contentLocale, sitePath, siteWords, type SiteWords } from "tansy/react";
import { Bag, Check, ChevronLeft, ChevronRight, Minus, Plus, Search, Send } from "./icons";
import { cx, money, text } from "./lib";

/**
 * The theme's parts that need the browser. Each takes `pickWords(words, "storefront")` from a
 * template, so it speaks the page's language and keeps links in it.
 */

const thumb = (fileId: string, size: "100x100" | "300x300" = "100x100") => apiPath(`/files/${encodeURIComponent(fileId)}?thumb=${size}`);

/* ------------------------------------------------------------------ search */

interface Found { id: number; title?: unknown; price?: unknown; images?: unknown; recordPath?: unknown }

const MIN_LENGTH = 2;
const WAIT_MS = 250;

/**
 * Searches published products as the visitor types, through the records API. It reads as
 * whoever is looking, so the products collection's list rule still decides what can be found.
 */
export function ProductSearch({ words, currency }: { words?: SiteWords; currency: string }) {
  const { t, formatNumber } = siteWords(words);
  const id = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Found[] | null>(null);
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const pending = useRef<AbortController | null>(null);

  async function run(value: string) {
    pending.current?.abort();
    const terms = value.trim();
    if (terms.length < MIN_LENGTH) {
      setResults(null);
      setState("idle");
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setState("busy");
    // Published only, so staff who may list drafts find what visitors find, and every link opens.
    const params = new URLSearchParams({ search: terms, filter: 'status = "published"', perPage: "6", fields: "id,title,price,images", urls: "1" });
    const locale = contentLocale(words);
    if (locale) params.set("locale", locale);
    try {
      const response = await fetch(apiPath(`/collections/shop-products/records?${params}`), { signal: controller.signal, headers: { accept: "application/json" } });
      const json = await response.json().catch(() => null) as { items?: Found[] } | null;
      if (controller.signal.aborted) return;
      if (!response.ok || !Array.isArray(json?.items)) {
        setState("failed");
        setResults(null);
        return;
      }
      setResults(json.items);
      setState("idle");
    } catch {
      if (!controller.signal.aborted) setState("failed");
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => void run(query), WAIT_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- searches again only when the words typed change
  }, [query]);

  useEffect(() => () => pending.current?.abort(), []);

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(query);
  }

  const open = results !== null || state === "failed";
  const status = state === "busy"
    ? t("storefront.searching")
    : state === "failed"
      ? t("storefront.searchFailed")
      : results === null ? "" : results.length ? t("storefront.found", { count: results.length }) : t("storefront.noResults", { query: query.trim() });

  return (
    <div className="sf:relative sf:w-full sf:max-w-xl">
      <form role="search" onSubmit={submit}>
        <label className="sf:sr-only" htmlFor={`${id}-q`}>{t("storefront.searchLabel")}</label>
        <span className="sf:flex sf:h-14 sf:items-center sf:gap-3 sf:rounded-full sf:border sf:border-line sf:bg-surface sf:ps-5 sf:pe-2 sf:transition sf:focus-within:border-accent sf:focus-within:bg-page sf:focus-within:ring-4 sf:focus-within:ring-accent/15">
          <Search className="sf:size-5 sf:shrink-0 sf:text-muted" />
          <input
            id={`${id}-q`}
            type="search"
            name="q"
            autoComplete="off"
            maxLength={200}
            placeholder={t("storefront.searchPlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
            aria-controls={`${id}-results`}
            aria-describedby={`${id}-status`}
            className="sf:h-full sf:min-w-0 sf:flex-1 sf:bg-transparent sf:text-base sf:text-ink sf:outline-none sf:placeholder:text-muted"
          />
          <button type="submit" className="sf:inline-flex sf:h-10 sf:shrink-0 sf:items-center sf:rounded-full sf:bg-ink sf:px-5 sf:text-sm sf:font-medium sf:text-page sf:transition sf:hover:bg-accent sf:hover:text-on-accent">
            {t("storefront.searchLabel")}
          </button>
        </span>
      </form>
      <p id={`${id}-status`} className="sf:sr-only" role="status" aria-live="polite">{status}</p>
      <div id={`${id}-results`} hidden={!open} className="sf:absolute sf:inset-x-0 sf:top-full sf:z-20 sf:mt-2 sf:overflow-hidden sf:rounded-3xl sf:border sf:border-line sf:bg-page sf:p-2 sf:shadow-card">
        {results && results.length > 0 ? (
          <ul>
            {results.map((product) => {
              const path = text(product.recordPath);
              const image = Array.isArray(product.images) ? text(product.images[0]) : "";
              const price = typeof product.price === "number" ? product.price : null;
              return (
                <li key={product.id}>
                  <a href={path ? sitePath(words, path) : undefined} className="sf:flex sf:items-center sf:gap-3 sf:rounded-2xl sf:p-2 sf:text-ink sf:no-underline sf:hover:bg-surface sf:focus-visible:bg-surface sf:focus-visible:outline-none">
                    {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked API address that redirects to a signed URL */}
                    {image ? <img src={thumb(image)} alt="" width={48} height={48} loading="lazy" className="sf:size-12 sf:rounded-full sf:bg-surface sf:object-cover" /> : <span className="sf:grid sf:size-12 sf:place-items-center sf:rounded-full sf:bg-surface sf:text-muted" aria-hidden="true"><Bag /></span>}
                    <span className="sf:min-w-0 sf:flex-1 sf:truncate sf:font-medium">{text(product.title)}</span>
                    {price !== null && <span className="sf:text-sm sf:text-muted sf:tabular-nums">{money(formatNumber, price, currency)}</span>}
                  </a>
                </li>
              );
            })}
          </ul>
        ) : <p className="sf:p-3 sf:text-sm sf:text-muted">{status}</p>}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- gallery */

export interface GalleryImage { src: string; thumb: string; /** What the image shows, for a reader who can't see it (set beside the file). */ alt: string }

const RoundButton = ({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) => (
  <button type="button" aria-label={label} onClick={onClick} className="sf:grid sf:size-10 sf:place-items-center sf:rounded-full sf:text-ink sf:transition sf:hover:bg-ink sf:hover:text-page sf:focus-visible:outline-2 sf:focus-visible:outline-accent">
    {children}
  </button>
);

/**
 * The product's pictures on a soft stage, with a ring around it and arrows to step through
 * them. Arrow keys step too once the stage has focus, the way they point in the page's direction.
 */
export function ProductGallery({ images, words }: { images: GalleryImage[]; words?: SiteWords }) {
  const { t } = siteWords(words);
  const [index, setIndex] = useState(0);
  const count = images.length;
  const go = (step: number) => setIndex((current) => (current + step + count) % count);

  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (count < 2 || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    go((event.key === "ArrowRight") !== rtl ? 1 : -1);
  }

  const current = images[index];
  return (
    <section aria-label={t("storefront.images")} className="sf:flex sf:flex-col sf:gap-4">
      <div
        role={count > 1 ? "group" : undefined}
        aria-roledescription={count > 1 ? "carousel" : undefined}
        tabIndex={count > 1 ? 0 : undefined}
        onKeyDown={keys}
        className="sf:group sf:relative sf:isolate sf:grid sf:aspect-square sf:place-items-center sf:overflow-hidden sf:rounded-card sf:bg-surface sf:focus-visible:outline-2 sf:focus-visible:outline-offset-4 sf:focus-visible:outline-accent"
      >
        {/* The ring the product sits in. */}
        <span aria-hidden="true" className="sf:absolute sf:top-[58%] sf:left-1/2 sf:-z-10 sf:h-[26%] sf:w-[118%] sf:-translate-x-1/2 sf:-rotate-6 sf:rounded-[50%] sf:border sf:border-ink/15" />
        <span aria-hidden="true" className="sf:absolute sf:top-1/2 sf:left-1/2 sf:-z-20 sf:size-[72%] sf:-translate-1/2 sf:rounded-full sf:bg-page/70 sf:blur-2xl" />
        {current ? (
          // eslint-disable-next-line @next/next/no-img-element -- an access-checked API address that redirects to a signed URL, which next/image can't optimize
          <img key={current.src} src={current.src} alt={current.alt} className="sf:size-[82%] sf:object-contain sf:drop-shadow-[0_24px_30px_rgba(0,0,0,0.18)] sf:transition-transform sf:duration-500 sf:ease-out sf:group-hover:scale-[1.03] sf:motion-reduce:transition-none" />
        ) : <Bag className="sf:size-16 sf:text-muted/50" strokeWidth={1} />}
        {count > 1 && (
          <div className="sf:absolute sf:bottom-6 sf:left-1/2 sf:flex sf:-translate-x-1/2 sf:items-center sf:gap-1 sf:rounded-full sf:border sf:border-line sf:bg-page/80 sf:p-1 sf:shadow-sm sf:backdrop-blur">
            <RoundButton label={t("storefront.previousImage")} onClick={() => go(-1)}><ChevronLeft className="sf:size-5 sf:rtl:-scale-x-100" /></RoundButton>
            <span className="sf:min-w-12 sf:text-center sf:text-sm sf:text-muted sf:tabular-nums" aria-live="polite">{index + 1} / {count}</span>
            <RoundButton label={t("storefront.nextImage")} onClick={() => go(1)}><ChevronRight className="sf:size-5 sf:rtl:-scale-x-100" /></RoundButton>
          </div>
        )}
      </div>
      {count > 1 && (
        <ul className="sf:flex sf:gap-3 sf:overflow-x-auto sf:pb-1">
          {images.map((image, at) => (
            <li key={image.src} className="sf:shrink-0">
              <button
                type="button"
                onClick={() => setIndex(at)}
                aria-label={t("storefront.showImage", { number: at + 1 })}
                aria-current={at === index ? "true" : undefined}
                className={cx(
                  "sf:block sf:size-20 sf:overflow-hidden sf:rounded-full sf:border-2 sf:bg-surface sf:p-1 sf:transition sf:focus-visible:outline-2 sf:focus-visible:outline-offset-2 sf:focus-visible:outline-accent",
                  at === index ? "sf:border-accent" : "sf:border-transparent sf:opacity-70 sf:hover:opacity-100",
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- as above */}
                <img src={image.thumb} alt={image.alt} loading="lazy" className="sf:size-full sf:rounded-full sf:object-cover" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- buy box */

function Stepper({ value, max, onChange, id, words }: { value: number; max: number; onChange: (value: number) => void; id: string; words?: SiteWords }) {
  const { t } = siteWords(words);
  const set = (next: number) => onChange(Math.max(1, Math.min(max, next)));
  const step = "sf:grid sf:size-11 sf:place-items-center sf:rounded-full sf:text-ink sf:transition sf:hover:bg-page sf:disabled:opacity-35 sf:disabled:hover:bg-transparent sf:focus-visible:outline-2 sf:focus-visible:outline-accent";
  return (
    <div className="sf:inline-flex sf:items-center sf:gap-1 sf:rounded-full sf:bg-surface sf:p-1">
      <button type="button" className={step} aria-label={t("storefront.decrease")} aria-controls={id} disabled={value <= 1} onClick={() => set(value - 1)}><Minus /></button>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        max={max}
        value={value}
        onChange={(event) => set(Number(event.target.value) || 1)}
        className="sf:w-10 sf:bg-transparent sf:text-center sf:text-lg sf:font-semibold sf:text-ink sf:tabular-nums sf:outline-none sf:[appearance:textfield] sf:[&::-webkit-inner-spin-button]:appearance-none sf:[&::-webkit-outer-spin-button]:appearance-none"
      />
      <button type="button" className={step} aria-label={t("storefront.increase")} aria-controls={id} disabled={value >= max} onClick={() => set(value + 1)}><Plus /></button>
    </div>
  );
}

/**
 * Price, options as chips, a quantity stepper, and two ways to buy: into the cart and stay,
 * or into the cart and straight to it. The cart is the shop plugin's, so checkout prices it
 * again on the server whatever this page showed.
 */
export function BuyBox({ product, price, compareAt, stock, variants = [], currency, cartHref = "/cart", words }: {
  product: number;
  price: number | null;
  compareAt: number | null;
  stock: number | null;
  variants?: VariantOption[];
  currency: string;
  cartHref?: string;
  words?: SiteWords;
}) {
  const { t, formatNumber } = siteWords(words);
  const id = useId();
  const [variant, setVariant] = useState<number | null>(variants.find((option) => option.stock !== 0)?.id ?? null);
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);
  const chosen = variants.find((option) => option.id === variant) ?? null;
  const left = variants.length ? chosen?.stock ?? null : stock;
  const amount = chosen?.price ?? price;
  const soldOut = variants.length ? !chosen || chosen.stock === 0 : stock === 0;
  const max = Math.max(1, Math.min(99, left ?? 99));

  function choose(option: VariantOption) {
    setVariant(option.id);
    setQuantity((current) => Math.min(current, Math.max(1, option.stock ?? 99)));
    setAdded(false);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (soldOut) return;
    addToCart(product, chosen?.id ?? null, quantity);
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    if (submitter?.getAttribute("value") === "buy") window.location.assign(sitePath(words, cartHref));
    else setAdded(true);
  }

  return (
    <form onSubmit={submit} className="sf:flex sf:flex-col sf:gap-7">
      <div className="sf:flex sf:flex-wrap sf:items-end sf:gap-x-4 sf:gap-y-2">
        {amount !== null && <p className="sf:text-4xl sf:font-semibold sf:tracking-tight sf:text-ink sf:tabular-nums sf:sm:text-5xl">{money(formatNumber, amount, currency)}</p>}
        {compareAt !== null && amount !== null && compareAt > amount && <p className="sf:pb-1.5 sf:text-lg sf:text-muted sf:tabular-nums"><s>{money(formatNumber, compareAt, currency)}</s></p>}
        <p className={cx("sf:ms-auto sf:mb-1.5 sf:inline-flex sf:items-center sf:gap-1.5 sf:rounded-full sf:px-3 sf:py-1 sf:text-sm sf:font-medium", soldOut ? "sf:bg-surface sf:text-muted" : "sf:bg-accent/10 sf:text-accent")}>
          {!soldOut && <Check className="sf:size-4" />}
          {soldOut ? t("storefront.soldOut") : left !== null && left <= 5 ? t("storefront.onlyLeft", { count: left }) : t("storefront.inStock")}
        </p>
      </div>

      {variants.length > 0 && (
        <fieldset className="sf:flex sf:flex-col sf:gap-3">
          <legend className="sf:mb-3 sf:text-sm sf:font-medium sf:text-muted">{t("storefront.options")}</legend>
          <div className="sf:flex sf:flex-wrap sf:gap-2">
            {variants.map((option) => (
              <label key={option.id} className="sf:relative">
                <input
                  type="radio"
                  name={`${id}-variant`}
                  value={option.id}
                  checked={variant === option.id}
                  disabled={option.stock === 0}
                  onChange={() => choose(option)}
                  className="sf:peer sf:sr-only"
                />
                <span className="sf:inline-flex sf:h-12 sf:min-w-12 sf:cursor-pointer sf:items-center sf:justify-center sf:rounded-full sf:border sf:border-line sf:bg-page sf:px-4 sf:text-sm sf:font-medium sf:text-ink sf:transition sf:select-none sf:hover:border-ink sf:peer-checked:border-accent sf:peer-checked:bg-accent sf:peer-checked:text-on-accent sf:peer-focus-visible:ring-4 sf:peer-focus-visible:ring-accent/25 sf:peer-disabled:cursor-not-allowed sf:peer-disabled:text-muted sf:peer-disabled:line-through sf:peer-disabled:opacity-60 sf:peer-disabled:hover:border-line">
                  {option.title}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {!soldOut && (
        <div className="sf:flex sf:items-center sf:gap-4">
          <label htmlFor={`${id}-quantity`} className="sf:text-sm sf:font-medium sf:text-muted">{t("storefront.quantity")}</label>
          <Stepper id={`${id}-quantity`} value={Math.min(quantity, max)} max={max} onChange={(value) => { setQuantity(value); setAdded(false); }} words={words} />
        </div>
      )}

      <div className="sf:grid sf:grid-cols-2 sf:gap-3">
        <button type="submit" value="buy" disabled={soldOut} className="sf:inline-flex sf:h-14 sf:items-center sf:justify-center sf:rounded-full sf:bg-accent sf:px-6 sf:text-base sf:font-semibold sf:text-on-accent sf:shadow-[0_10px_24px_-10px] sf:shadow-accent sf:transition sf:hover:brightness-110 sf:active:scale-[0.98] sf:disabled:cursor-not-allowed sf:disabled:opacity-50 sf:disabled:shadow-none sf:focus-visible:outline-2 sf:focus-visible:outline-offset-2 sf:focus-visible:outline-accent">
          {t("storefront.buyNow")}
        </button>
        <button type="submit" value="add" disabled={soldOut} className="sf:inline-flex sf:h-14 sf:items-center sf:justify-center sf:rounded-full sf:border sf:border-line sf:bg-surface sf:px-6 sf:text-base sf:font-semibold sf:text-ink sf:transition sf:hover:border-ink sf:active:scale-[0.98] sf:disabled:cursor-not-allowed sf:disabled:opacity-50 sf:focus-visible:outline-2 sf:focus-visible:outline-offset-2 sf:focus-visible:outline-accent">
          {soldOut ? t("storefront.soldOut") : t("storefront.addToCart")}
        </button>
      </div>
      <p role="status" className={cx("sf:-mt-3 sf:text-sm sf:text-accent", !added && "sf:sr-only")}>
        {added && <>{t("storefront.added")} <a href={sitePath(words, cartHref)} className="sf:font-semibold sf:underline sf:underline-offset-4">{t("storefront.viewCart")}</a></>}
      </p>
    </form>
  );
}

/* ------------------------------------------------------------------- share */

/** The browser's share sheet where there is one, and copying the address where there isn't. */
export function ShareButton({ title, words, className }: { title: string; words?: SiteWords; className?: string }) {
  const { t } = siteWords(words);
  const [copied, setCopied] = useState(false);

  async function share() {
    const url = window.location.href;
    if (typeof navigator.share === "function") {
      await navigator.share({ title, url }).catch(() => null);
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked: nothing to say */ }
  }

  return (
    <>
      <button type="button" onClick={share} aria-label={t("storefront.share")} className={className}>
        {copied ? <Check /> : <Send />}
      </button>
      <span role="status" className="sf:sr-only">{copied ? t("storefront.copied") : ""}</span>
    </>
  );
}
