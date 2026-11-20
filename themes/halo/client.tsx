"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { apiPath, contentLocale, sitePath, siteWords, type SiteWords } from "tansy/react";

const text = (value: unknown) => (typeof value === "string" ? value : "");

/* ---------------------------------------------------------------- time ago */

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [["day", 86_400], ["hour", 3_600], ["minute", 60]];
const WEEK = 7 * 86_400;

/** "4 hours ago" for the last week, else null, so the date stays. */
function relative(date: string, locale: string): string | null {
  const at = new Date(date).getTime();
  if (Number.isNaN(at)) return null;
  const seconds = (at - Date.now()) / 1000;
  if (Math.abs(seconds) >= WEEK) return null;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of UNITS) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(0, "minute");
}

/**
 * A date that reads "4 hours ago" in the visitor's browser. The server renders the date
 * itself, so a cached page, or one read with no script, is never wrong, only less friendly.
 */
export function TimeAgo({ date, label, locale }: { date: string; label: string; locale: string }) {
  const [shown, setShown] = useState(label);
  useEffect(() => {
    const update = () => setShown(relative(date, locale) ?? label);
    update();
    const timer = setInterval(update, 60_000);
    return () => clearInterval(timer);
  }, [date, label, locale]);
  return <time dateTime={date} title={label}>{shown}</time>;
}

/* ---------------------------------------------------------------- carousel */

/**
 * A row of cards that scrolls sideways, with previous and next buttons. Without script it is
 * still a row that scrolls by touch, trackpad or keyboard; the buttons only move it further.
 */
export function Carousel({ children, previous, next, label }: { children: ReactNode; previous: string; next: string; label: string }) {
  const track = useRef<HTMLDivElement>(null);
  const [ends, setEnds] = useState({ start: true, end: false });

  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const measure = () => {
      // Negative in right-to-left layouts, so compare sizes rather than signs.
      const travelled = Math.abs(element.scrollLeft);
      setEnds({ start: travelled < 4, end: travelled + element.clientWidth >= element.scrollWidth - 4 });
    };
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      element.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, []);

  function move(direction: 1 | -1) {
    const element = track.current;
    if (!element) return;
    const rtl = getComputedStyle(element).direction === "rtl";
    element.scrollBy({ left: direction * (rtl ? -1 : 1) * element.clientWidth * 0.85, behavior: "smooth" });
  }

  return (
    <div className="ha-carousel">
      <div ref={track} className="ha-carousel-track" role="region" aria-label={label} tabIndex={0}>{children}</div>
      <div className="ha-carousel-controls">
        <button type="button" className="ha-round" onClick={() => move(-1)} disabled={ends.start} aria-label={previous}><Arrow back /></button>
        <button type="button" className="ha-round ha-round-ink" onClick={() => move(1)} disabled={ends.end} aria-label={next}><Arrow /></button>
      </div>
    </div>
  );
}

const Arrow = ({ back = false }: { back?: boolean }) => (
  <svg className={back ? "ha-arrow ha-arrow-back" : "ha-arrow"} aria-hidden="true" viewBox="0 0 20 20" width="16" height="16"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M4 10h12m-5-5 5 5-5 5" /></svg>
);

/* ------------------------------------------------------------------ search */

interface Found { id: number; title?: unknown; publishedAt?: unknown; cover?: unknown; recordPath?: unknown }

const MIN_LENGTH = 2;
const WAIT_MS = 250;

/**
 * The header's search field. It looks up published posts as the visitor types, through the
 * records API, as whoever is looking, so the posts collection's list rule decides what can be
 * found. Pass `pickWords(words, "halo")`.
 */
export function HeaderSearch({ words, showDates }: { words?: SiteWords; showDates: boolean }) {
  const { t, formatDate } = siteWords(words);
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
    const params = new URLSearchParams({ search: terms, filter: 'status = "published"', perPage: "6", fields: "id,title,publishedAt,cover", urls: "1" });
    const locale = contentLocale(words);
    if (locale) params.set("locale", locale);
    try {
      const response = await fetch(apiPath(`/collections/blog-posts/records?${params}`), { signal: controller.signal, headers: { accept: "application/json" } });
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
    ? t("halo.searching")
    : state === "failed"
      ? t("halo.searchFailed")
      : results === null ? "" : results.length ? t("halo.found", { count: results.length }) : t("halo.noResults", { query: query.trim() });

  return (
    <div className="ha-search">
      <form role="search" onSubmit={submit}>
        <label className="ha-visually-hidden" htmlFor={`${id}-q`}>{t("halo.searchLabel")}</label>
        <input
          id={`${id}-q`}
          type="search"
          name="q"
          autoComplete="off"
          maxLength={200}
          placeholder={t("halo.searchPlaceholder")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
          aria-controls={`${id}-results`}
          aria-describedby={`${id}-status`}
        />
        <button type="submit" aria-label={t("halo.searchLabel")}>
          <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18"><path fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" d="M9 15.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm4.7-1.8 3.8 3.8" /></svg>
        </button>
      </form>
      <p id={`${id}-status`} className="ha-visually-hidden" role="status" aria-live="polite">{status}</p>
      <div id={`${id}-results`} className="ha-search-results" hidden={!open}>
        {results && results.length > 0 ? (
          <ul>
            {results.map((post) => {
              const path = text(post.recordPath);
              const date = text(post.publishedAt);
              return (
                <li key={post.id}>
                  <a href={path ? sitePath(words, path) : undefined}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked API address that redirects to a signed URL */}
                    {text(post.cover) ? <img src={apiPath(`/files/${encodeURIComponent(text(post.cover))}?thumb=100x100`)} alt="" width={44} height={44} loading="lazy" /> : <span className="ha-thumb-empty" aria-hidden="true" />}
                    <span>
                      <span className="ha-search-title">{text(post.title)}</span>
                      {showDates && date && <time dateTime={date}>{formatDate(date, "medium")}</time>}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        ) : <p className="ha-search-empty">{status}</p>}
      </div>
    </div>
  );
}
