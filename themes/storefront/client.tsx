"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { addToCart, type VariantOption } from "@tansy/shop/react";
import { apiPath, contentLocale, sitePath, siteWords, type SiteWords } from "tansy/react";
import { Bag, Check, ChevronLeft, ChevronRight, Close, Minus, Plus, Search, Send } from "./icons";
import { cardAnchor, cx, money, text } from "./lib";

/**
 * The theme's parts that need the browser. Each takes `pickWords(words, "storefront")` from a
 * template, so it speaks the page's language and keeps links in it.
 */

/* ------------------------------------------------------- view transitions */

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Runs a change to the page as a same-document view transition where the browser has them, with
 * `type` so styles.css can tell it from moving between pages. Browsers that have transitions but
 * not types get it without one.
 */
function transition(change: () => void, type: string) {
  if (typeof document.startViewTransition !== "function" || reducedMotion()) return change();
  const update = () => flushSync(change);
  try {
    document.startViewTransition({ update, types: [type] });
  } catch {
    document.startViewTransition(update);
  }
}

/** What `pageswap` hands over, in browsers that have cross-document view transitions. */
interface PageSwap extends Event { viewTransition: object | null; activation: { entry: { url: string } | null } | null }

const pathOf = (href: string) => {
  try { return new URL(href, window.location.href).pathname; } catch { return ""; }
};

/**
 * Before a page is left for a product, picks the picture that flies. Pictures that lead to a
 * product carry `data-sf-vt` (the name) and `data-sf-vt-href`. When the same product shows twice,
 * such as in the spotlight and the grid, the one pressed (or else the one most in view) takes the
 * name and the others give it up, since a page may use a name once. The new page names its own.
 */
function nameFlyingPicture(to: string, pressed: Element | null) {
  const path = pathOf(to);
  const pictures = [...document.querySelectorAll<HTMLElement>("[data-sf-vt-href]")].filter((picture) => pathOf(picture.dataset.sfVtHref ?? "") === path);
  if (!pictures.length) return;
  const near = (picture: HTMLElement) => pressed && picture.closest("li, article, [data-sf-vt-scope]")?.contains(pressed);
  const inView = (picture: HTMLElement) => {
    const box = picture.getBoundingClientRect();
    return Math.max(0, Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0)) * Math.max(0, Math.min(box.right, window.innerWidth) - Math.max(box.left, 0));
  };
  const chosen = pictures.find(near) ?? pictures.reduce((best, picture) => (inView(picture) > inView(best) ? picture : best));
  const name = chosen.dataset.sfVt ?? "";
  for (const other of document.querySelectorAll<HTMLElement>("[data-sf-vt]")) {
    if (other !== chosen && other.style.viewTransitionName === name) other.style.viewTransitionName = "none";
  }
  chosen.style.viewTransitionName = name;
}

/** Set once a link here has been followed without loading a new document. */
let softNavigated = false;

/** Ends the view transition of a move between pages, once the new page is in. Set while one runs. */
let pageIn: (() => void) | null = null;

/**
 * The link a click follows inside the app, or null when the browser should load it itself: a
 * new tab, a download, another site, the API (files), another language, or a jump on this page.
 */
function appLink(event: globalThis.MouseEvent): HTMLAnchorElement | null {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
  if (!link || !link.closest(".sf-shell")) return null;
  if ((link.target && link.target !== "_self") || link.hasAttribute("download") || link.hasAttribute("hreflang") || link.relList.contains("external")) return null;
  if (link.origin !== location.origin || link.pathname.startsWith(apiPath("/"))) return null;
  if (link.pathname === location.pathname && link.search === location.search && link.hash) return null;
  return link;
}

/**
 * The Next router, or null where a template is rendered outside one (as tests render them), whose
 * links then load pages as plain links do. `useRouter` throws there, but always reads its context,
 * so catching keeps the hooks in the same order.
 */
function useAppRouter() {
  try {
    return useRouter();
  } catch {
    return null;
  }
}

/** How long the old page may stay frozen waiting for the new one before it's let go without an animation. */
const PAGE_WAIT_MS = 3000;

/**
 * Moves to `href` through the Next router inside a view transition: the browser takes the old page,
 * the router swaps in the new one without loading a document, and `PageTransition` ends the update
 * once it's in, so the browser animates from one to the other. styles.css says how.
 */
function moveTo(router: ReturnType<typeof useRouter>, href: string) {
  if (typeof document.startViewTransition !== "function" || reducedMotion() || document.visibilityState !== "visible") return router.push(href);
  pageIn?.();
  let pushed = false;
  const push = () => {
    if (pushed) return;
    pushed = true;
    router.push(href);
  };
  const update = () => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { pageIn = null; resolve(); }, PAGE_WAIT_MS);
    pageIn = () => { clearTimeout(timer); pageIn = null; resolve(); };
    push();
  });
  let transition: ViewTransition;
  try {
    transition = document.startViewTransition({ update, types: ["sf-page"] });
  } catch {
    transition = document.startViewTransition(update);
  }
  // The browser takes the old page on its next frame. Where none comes, the move goes without the animation.
  setTimeout(() => {
    if (pushed) return;
    transition.skipTransition();
    push();
  }, 1000);
}

/**
 * Follows the theme's links inside the app, through the Next router, so moving between pages swaps
 * the page without loading a new document, each move inside a view transition (`moveTo`): the
 * header holds still, the picture flies and the chip and tab dot slide. Pages loaded in full
 * (another language, a shared link) still get the cross-document transition the layout switches
 * on, named here on `pageswap`.
 * Rendered by the layout on every page, it also leaves the note the back arrow reads.
 */
export function ViewTransitionNames() {
  const router = useAppRouter();
  useCameFromNote();
  useEffect(() => {
    let pressed: Element | null = null;
    const prefetched = new Set<string>();
    const press = (event: PointerEvent) => { pressed = event.target instanceof Element ? event.target : null; };
    if (!router) return;
    const hover = (event: globalThis.MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.origin !== location.origin || link.pathname.startsWith(apiPath("/")) || prefetched.has(link.href)) return;
      prefetched.add(link.href);
      router.prefetch(link.href);
    };
    const click = (event: globalThis.MouseEvent) => {
      const link = appLink(event);
      if (!link) return;
      event.preventDefault();
      if (!reducedMotion()) nameFlyingPicture(link.href, pressed ?? (event.target as Element));
      softNavigated = true;
      const href = link.pathname + link.search + link.hash;
      // The page already showing: the router refreshes it in place, with nothing to animate.
      if (link.pathname === location.pathname && link.search === location.search) router.push(href);
      else moveTo(router, href);
    };
    const swap = (event: Event) => {
      const { viewTransition, activation } = event as PageSwap;
      const to = activation?.entry?.url;
      if (viewTransition && to) nameFlyingPicture(to, pressed);
    };
    window.addEventListener("pointerdown", press, true);
    document.addEventListener("mouseover", hover);
    document.addEventListener("click", click);
    window.addEventListener("pageswap", swap);
    return () => {
      window.removeEventListener("pointerdown", press, true);
      document.removeEventListener("mouseover", hover);
      document.removeEventListener("click", click);
      window.removeEventListener("pageswap", swap);
    };
  }, [router]);
  return null;
}

/**
 * Wraps the page beneath the header and tells a running move between pages (`moveTo`) that the new
 * page is in, as soon as the router has put it in the document, so the browser animates to it.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const search = useSearchParams()?.toString();
  useLayoutEffect(() => { pageIn?.(); }, [pathname, search]);
  return children;
}

const thumb = (fileId: string, size: "100x100" | "300x300" = "100x100") => apiPath(`/files/${encodeURIComponent(fileId)}?thumb=${size}`);

/* ------------------------------------------------------------------ search */

interface Found { id: number; title?: unknown; price?: unknown; images?: unknown; recordPath?: unknown }

const MIN_LENGTH = 2;
const WAIT_MS = 250;

/**
 * Searches published products as the visitor types, through the records API. It reads as
 * whoever is looking, so the products collection's list rule still decides what can be found.
 */
export function ProductSearch({ id: anchor, words, currency }: { id?: string; words?: SiteWords; currency: string }) {
  const { t, formatNumber } = siteWords(words);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
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

  // The Search tab links here by its id: arriving that way puts the cursor in the box.
  useEffect(() => {
    if (!anchor) return;
    const focus = () => { if (window.location.hash === `#${anchor}`) input.current?.focus({ preventScroll: false }); };
    focus();
    window.addEventListener("hashchange", focus);
    return () => window.removeEventListener("hashchange", focus);
  }, [anchor]);

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
    <div id={anchor} className="sf:relative sf:w-full sf:max-w-xl sf:scroll-mt-24">
      <form role="search" onSubmit={submit}>
        <label className="sf:sr-only" htmlFor={`${id}-q`}>{t("storefront.searchLabel")}</label>
        <span className="sf:flex sf:h-14 sf:items-center sf:gap-3 sf:rounded-full sf:border sf:border-line sf:bg-surface sf:ps-5 sf:pe-2 sf:transition sf:focus-within:border-accent sf:focus-within:bg-page sf:focus-within:ring-4 sf:focus-within:ring-accent/15">
          <Search className="sf:size-5 sf:shrink-0 sf:text-muted" />
          <input
            ref={input}
            id={`${id}-q`}
            type="search"
            enterKeyHint="search"
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
                    {image ? <img src={thumb(image)} alt="" width={48} height={48} loading="lazy" {...(path ? { "data-sf-vt": `sf-product-${product.id}`, "data-sf-vt-href": sitePath(words, path) } : {})} className="sf-vt-product sf:size-12 sf:rounded-full sf:bg-surface sf:object-cover" /> : <span className="sf:grid sf:size-12 sf:place-items-center sf:rounded-full sf:bg-surface sf:text-muted" aria-hidden="true"><Bag /></span>}
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

/** Smooth unless the visitor asks for less motion. */
const scrollBehavior = (): ScrollBehavior => (reducedMotion() ? "auto" : "smooth");

/**
 * The product's pictures on a soft stage, with a ring around it. They sit side by side in a
 * track that snaps, so a finger swipes through them as in an app, and arrows, thumbnails or the
 * arrow keys (once the stage has focus) step through them too. The picture showing carries
 * `transitionName`, the name its card in a list has, so moving between them flies it across.
 * Tapping it zooms it to fill the screen, the same picture growing out of the stage, and closing
 * shrinks it back.
 */
export function ProductGallery({ images, transitionName, words }: { images: GalleryImage[]; transitionName?: string; words?: SiteWords }) {
  const { t } = siteWords(words);
  const [index, setIndex] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const count = images.length;
  const name = transitionName ?? "sf-zoom";

  function zoom(open: boolean) {
    transition(() => setZoomed(open), "sf-zoom");
    if (!open) opener.current?.focus({ preventScroll: true });
  }

  // While zoomed: Escape closes, and the page behind holds still.
  useEffect(() => {
    if (!zoomed) return;
    const keys = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") zoom(false); };
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    window.addEventListener("keydown", keys);
    return () => { root.style.overflow = overflow; window.removeEventListener("keydown", keys); };
  }, [zoomed]);

  /** Scrolls the track to a picture. The index follows from the scroll, so swiping and stepping agree. */
  function show(at: number) {
    const slide = track.current?.children[(at + count) % count] as HTMLElement | undefined;
    slide?.scrollIntoView({ behavior: scrollBehavior(), block: "nearest", inline: "center" });
  }

  function onScroll() {
    const element = track.current;
    if (!element || !element.clientWidth) return;
    // scrollLeft runs negative right to left, so its size is what counts.
    setIndex(Math.min(count - 1, Math.round(Math.abs(element.scrollLeft) / element.clientWidth)));
  }

  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (count < 2 || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    show(index + ((event.key === "ArrowRight") !== rtl ? 1 : -1));
  }

  return (
    <section aria-label={t("storefront.images")} className="sf:flex sf:flex-col sf:gap-4">
      <div
        role={count > 1 ? "group" : undefined}
        aria-roledescription={count > 1 ? "carousel" : undefined}
        tabIndex={count > 1 ? 0 : undefined}
        onKeyDown={keys}
        className="sf:group sf:relative sf:isolate sf:aspect-square sf:overflow-hidden sf:rounded-card sf:bg-surface sf:focus-visible:outline-2 sf:focus-visible:outline-offset-4 sf:focus-visible:outline-accent"
      >
        {/* The ring the product sits in. */}
        <span aria-hidden="true" className="sf:absolute sf:top-[58%] sf:left-1/2 sf:-z-10 sf:h-[26%] sf:w-[118%] sf:-translate-x-1/2 sf:-rotate-6 sf:rounded-[50%] sf:border sf:border-ink/15" />
        <span aria-hidden="true" className="sf:absolute sf:top-1/2 sf:left-1/2 sf:-z-20 sf:size-[72%] sf:-translate-1/2 sf:rounded-full sf:bg-page/70 sf:blur-2xl" />
        {count > 0 ? (
          <div ref={track} onScroll={onScroll} className="sf-track sf:absolute sf:inset-0 sf:flex sf:snap-x sf:snap-mandatory sf:overflow-x-auto sf:overscroll-x-contain">
            {images.map((image, at) => (
              <div key={image.src} className="sf:grid sf:size-full sf:shrink-0 sf:snap-center sf:snap-always sf:place-items-center" aria-hidden={at !== index ? true : undefined}>
                <button
                  type="button"
                  ref={at === index ? opener : undefined}
                  tabIndex={at === index ? 0 : -1}
                  onClick={() => zoom(true)}
                  aria-label={t("storefront.zoomIn")}
                  className="sf:grid sf:size-full sf:cursor-zoom-in sf:place-items-center sf:focus-visible:outline-none"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked API address that redirects to a signed URL, which next/image can't optimize */}
                  <img
                    src={image.src}
                    alt={image.alt}
                    loading={at === 0 ? "eager" : "lazy"}
                    draggable={false}
                    style={at === index && !zoomed ? { viewTransitionName: name } : undefined}
                    className={cx(at === index && "sf-zoom-target", "sf-vt-product sf:size-[82%] sf:object-contain sf:drop-shadow-[0_24px_30px_rgba(0,0,0,0.18)] sf:transition-transform sf:duration-500 sf:ease-out sf:select-none sf:group-hover:scale-[1.03] sf:motion-reduce:transition-none")}
                  />
                </button>
              </div>
            ))}
          </div>
        ) : <div className="sf:grid sf:size-full sf:place-items-center"><Bag className="sf:size-16 sf:text-muted/50" strokeWidth={1} /></div>}
        {count > 1 && (
          <>
            {/* Small screens: dots, since a finger swipes. */}
            <div aria-hidden="true" className="sf:pointer-events-none sf:absolute sf:bottom-5 sf:left-1/2 sf:flex sf:-translate-x-1/2 sf:gap-1.5 sf:sm:hidden">
              {images.map((image, at) => <span key={image.src} className={cx("sf:h-1.5 sf:rounded-full sf:transition-all sf:duration-300", at === index ? "sf:w-5 sf:bg-ink" : "sf:w-1.5 sf:bg-ink/25")} />)}
            </div>
            <div className="sf:absolute sf:bottom-6 sf:left-1/2 sf:hidden sf:-translate-x-1/2 sf:items-center sf:gap-1 sf:rounded-full sf:border sf:border-line sf:bg-page/80 sf:p-1 sf:shadow-sm sf:backdrop-blur sf:sm:flex">
              <RoundButton label={t("storefront.previousImage")} onClick={() => show(index - 1)}><ChevronLeft className="sf:size-5 sf:rtl:-scale-x-100" /></RoundButton>
              <span className="sf:min-w-12 sf:text-center sf:text-sm sf:text-muted sf:tabular-nums" aria-live="polite">{index + 1} / {count}</span>
              <RoundButton label={t("storefront.nextImage")} onClick={() => show(index + 1)}><ChevronRight className="sf:size-5 sf:rtl:-scale-x-100" /></RoundButton>
            </div>
          </>
        )}
      </div>
      {zoomed && images[index] && (
        <div role="dialog" aria-modal="true" aria-label={images[index].alt || t("storefront.images")} className="sf-zoom sf:fixed sf:inset-0 sf:z-[60] sf:grid sf:cursor-zoom-out sf:place-items-center sf:p-4" onClick={() => zoom(false)}>
          {/* eslint-disable-next-line @next/next/no-img-element -- the same address as on the stage, so it's already loaded and the transition has it */}
          <img src={images[index].src} alt={images[index].alt} draggable={false} style={{ viewTransitionName: name }} className="sf-zoom-target sf-vt-product sf:max-h-[88dvh] sf:w-full sf:max-w-[min(92vw,56rem)] sf:object-contain sf:select-none" />
          <button type="button" autoFocus onClick={(event) => { event.stopPropagation(); zoom(false); }} aria-label={t("storefront.closeZoom")} className="sf-zoom-close sf:fixed sf:end-4 sf:top-4 sf:grid sf:size-11 sf:place-items-center sf:rounded-full sf:border sf:border-line sf:bg-page sf:text-ink sf:shadow-card">
            <Close />
          </button>
        </div>
      )}
      {count > 1 && (
        <ul className="sf-chips sf:flex sf:gap-3 sf:overflow-x-auto sf:pb-1">
          {images.map((image, at) => (
            <li key={image.src} className="sf:shrink-0">
              <button
                type="button"
                onClick={() => show(at)}
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
    // A short tap, as an app gives, on phones that can. Only after a real tap, as browsers refuse it otherwise.
    if (navigator.userActivation?.isActive) navigator.vibrate?.(12);
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

      {/* Small screens: pinned to the bottom of the screen, where a thumb reaches, as in an app. */}
      <div className="sf-buybar sf:grid sf:grid-cols-2 sf:gap-3">
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
const CAME_FROM = "sf-came-from";

/** The page a link on this site was followed from, and where it led. */
interface CameFrom { from: string; to: string }

const withoutHash = (href: string) => href.split("#")[0];

/** Where the visitor followed a link here from, when this page is where it led. */
function cameFrom(): string | null {
  try {
    const kind = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type;
    const note = JSON.parse(sessionStorage.getItem(CAME_FROM) ?? "null") as CameFrom | null;
    if ((kind !== "navigate" && !softNavigated) || !note || withoutHash(note.to) !== withoutHash(location.href)) return null;
    const from = new URL(note.from);
    return from.origin === location.origin && withoutHash(from.href) !== withoutHash(location.href) ? withoutHash(from.href) : null;
  } catch {
    return null;
  }
}

/** Leaves the note `cameFrom` reads whenever a link to another page here is followed. Rendered by the layout, on every page. */
function useCameFromNote() {
  useEffect(() => {
    const note = (event: globalThis.MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.origin !== location.origin || link.target === "_blank" || link.hasAttribute("download")) return;
      try {
        sessionStorage.setItem(CAME_FROM, JSON.stringify({ from: location.href, to: link.href } satisfies CameFrom));
      } catch {
        // Storage can be off. The back arrow then follows its own link.
      }
    };
    document.addEventListener("click", note, true);
    return () => document.removeEventListener("click", note, true);
  }, []);
}

/**
 * A back arrow that returns to the page the visitor came from, as an app's does. It goes there as
 * a new move forward rather than back through history, so it gets the same transition as any link,
 * and adds `#` and the card of `card`, the product being left: the browser scrolls that card into
 * view as the page shows, so the list comes back where the visitor was and the product's
 * picture flies back into its own card. The address is worked out once the page has loaded, before
 * this page's own links leave a note of their own. Opened from a shared link or a new tab, it is
 * `href`.
 */
export function BackLink({ href, card, className, children }: { href: string; card?: number | string; className?: string; children: ReactNode }) {
  const [target, setTarget] = useState(href);
  const pathname = usePathname();
  useEffect(() => {
    const from = cameFrom();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage only exists in the browser
    setTarget(from ? (card === undefined ? from : `${from}#${cardAnchor(card)}`) : href);
  }, [card, href, pathname]);
  return <a href={target} className={className}>{children}</a>;
}

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
