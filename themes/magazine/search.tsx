"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { apiPath, contentLocale, sitePath, siteWords, type SiteWords } from "tansy/react";

interface Found { id: number; title?: unknown; publishedAt?: unknown; cover?: unknown; recordPath?: unknown }

const text = (value: unknown) => (typeof value === "string" ? value : "");
const MIN_LENGTH = 2;
const WAIT_MS = 250;

/**
 * Searches published posts as the visitor types, through the records API. It reads as whoever
 * is looking, so the posts collection's list rule still decides what can be found.
 * Pass `pickWords(words, "magazine")`.
 */
export function PostSearch({ words, showDates }: { words?: SiteWords; showDates: boolean }) {
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
    ? t("magazine.searching")
    : state === "failed"
      ? t("magazine.searchFailed")
      : results === null ? "" : results.length ? t("magazine.found", { count: results.length }) : t("magazine.noResults", { query: query.trim() });

  return (
    <div className="mg-search">
      <form className="mg-search-form" role="search" onSubmit={submit}>
        <label className="mg-visually-hidden" htmlFor={`${id}-q`}>{t("magazine.searchLabel")}</label>
        <span className="mg-search-field">
          <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18"><path fill="currentColor" d="M8.5 2a6.5 6.5 0 0 1 5.2 10.4l3.9 4a1 1 0 0 1-1.4 1.4l-4-3.9A6.5 6.5 0 1 1 8.5 2Zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z" /></svg>
          <input
            id={`${id}-q`}
            type="search"
            name="q"
            autoComplete="off"
            maxLength={200}
            placeholder={t("magazine.searchPlaceholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") setQuery(""); }}
            aria-controls={`${id}-results`}
            aria-describedby={`${id}-status`}
          />
        </span>
        <button className="mg-button" type="submit">{t("magazine.searchButton")}</button>
      </form>
      <p id={`${id}-status`} className="mg-visually-hidden" role="status" aria-live="polite">{status}</p>
      <div id={`${id}-results`} className="mg-search-results" hidden={!open}>
        {results && results.length > 0 ? (
          <ul>
            {results.map((post) => {
              const path = text(post.recordPath);
              const date = text(post.publishedAt);
              return (
                <li key={post.id}>
                  <a href={path ? sitePath(words, path) : undefined}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked API address that redirects to a signed URL */}
                    {text(post.cover) ? <img src={apiPath(`/files/${encodeURIComponent(text(post.cover))}?thumb=100x100`)} alt="" width={48} height={48} loading="lazy" /> : <span className="mg-thumb-empty" aria-hidden="true" />}
                    <span>
                      <span className="mg-search-title">{text(post.title)}</span>
                      {showDates && date && <time dateTime={date}>{formatDate(date, "medium")}</time>}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        ) : <p className="mg-search-empty">{status}</p>}
      </div>
    </div>
  );
}
