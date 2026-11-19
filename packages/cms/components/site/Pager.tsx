import type { SiteList } from "../../core/theme/define";
import { sitePath, siteWords, type SiteWords } from "../../core/site/words";

/** The address of one page of a paged list. Page 1 is the plain path, so it has a single address. */
export const pageHref = (path: string, page: number) => (page <= 1 ? path : `${path}?page=${page}`);

/**
 * Previous and next links for a list from a `paged` query, at the page's own `path`, which
 * templates get as a prop. Renders nothing when the list fits on one page. Works in server components.
 * Pass the template's `words` so it speaks the page's language, and links stay in it: `path`
 * is then the address without its language, as templates get it.
 */
export function Pager({ list, path, previous, next, className = "site-pager", words }: { list: SiteList | undefined; path: string; previous?: string; next?: string; className?: string; words?: SiteWords }) {
  if (!list || list.totalPages <= 1) return null;
  const { page, totalPages } = list;
  const { t } = siteWords(words);
  const at = sitePath(words, path);
  return (
    <nav className={className} aria-label={t("cms.pages")}>
      {page > 1 && <a rel="prev" href={pageHref(at, page - 1)}>{previous ?? t("cms.previous")}</a>}
      <span aria-current="page">{t("cms.pageOf", { page, total: totalPages })}</span>
      {page < totalPages && <a rel="next" href={pageHref(at, page + 1)}>{next ?? t("cms.next")}</a>}
    </nav>
  );
}
