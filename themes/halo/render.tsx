import localFont from "next/font/local";
import type { ReactNode } from "react";
import { PostComments, PostMeta, PostTags } from "@tansy/blog/render";
import { authPath, Menu, pageHref, pickWords, sitePath, StreamField } from "tansy/react";
import { defineThemeComponents, type LayoutProps, type SiteList, type SiteRecord, type TemplateProps } from "tansy/theme";
import { Carousel, HeaderSearch, TimeAgo } from "./client";
import type { HaloOptions } from "./index";
import "./theme.css";

// Served from the site's own origin, as font-src 'self' requires.
const font = localFont({ src: "./fonts/GeistVF.woff", variable: "--halo-font", weight: "100 900" });

type Props = TemplateProps<HaloOptions>;
type Story = SiteRecord;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is number => typeof id === "number") : typeof value === "number" ? [value] : []);
const items = (list: SiteList | undefined) => list?.items ?? [];
const byId = (list: SiteList | undefined) => new Map(items(list).map((record) => [record.id, record]));

/**
 * The theme's words, under `halo`, so a client part gets only these with `pickWords`. Owners
 * can change any of them per language under Languages → Site text. The blog's own words, such
 * as `blog.minutes`, come from the blog plugin.
 */
const messages = {
  en: {
    halo: {
      front: "Front page",
      bestOfWeek: "Best of the week",
      recommended: "Recommended",
      latest: "Latest news",
      trending: "Trending now",
      readersChoice: "Readers’ choice",
      readersChoiceBadge: "Readers’ choice",
      thisWeek: "this week",
      popular: "Popular news",
      moreLikeThis: "More like this",
      viewMore: "View more",
      viewAll: "View all",
      readArticle: "Read article",
      noStories: "No stories yet. Publish a post and it shows here.",
      noStoriesHere: "No stories here yet.",
      newer: "Newer stories",
      older: "Older stories",
      pages: "Pages",
      pageOf: "Page {page} of {total}",
      previous: "Previous",
      next: "Next",
      searchLabel: "Search articles",
      searchPlaceholder: "Article name, tag, category…",
      searching: "Searching…",
      searchFailed: "Search isn't working right now. Try again in a moment.",
      found: "{count, plural, one {# article found} other {# articles found}}",
      noResults: "No articles match “{query}”.",
      signIn: "Sign in",
      register: "Register",
      menu: "Main",
      openMenu: "Menu",
      footerMenu: "Footer",
      language: "Language",
      skip: "Skip to content",
      rights: "All rights reserved.",
    },
  },
  ar: {
    halo: {
      front: "الصفحة الأولى",
      bestOfWeek: "الأفضل هذا الأسبوع",
      recommended: "مقترحة لك",
      latest: "آخر الأخبار",
      trending: "الأكثر تداولًا",
      readersChoice: "اختيار القرّاء",
      readersChoiceBadge: "اختيار القرّاء",
      thisWeek: "هذا الأسبوع",
      popular: "الأكثر قراءة",
      moreLikeThis: "مقالات مشابهة",
      viewMore: "عرض المزيد",
      viewAll: "عرض الكل",
      readArticle: "اقرأ المقال",
      noStories: "لا توجد مقالات بعد. انشر مقالًا وسيظهر هنا.",
      noStoriesHere: "لا توجد مقالات هنا بعد.",
      newer: "مقالات أحدث",
      older: "مقالات أقدم",
      pages: "الصفحات",
      pageOf: "الصفحة {page} من {total}",
      previous: "السابق",
      next: "التالي",
      searchLabel: "ابحث في المقالات",
      searchPlaceholder: "اسم المقال، وسم، تصنيف…",
      searching: "جارٍ البحث…",
      searchFailed: "البحث لا يعمل الآن. حاول مجددًا بعد قليل.",
      found: "{count, plural, zero {لا توجد نتائج} one {مقال واحد} two {مقالان} few {# مقالات} many {# مقالًا} other {# مقال}}",
      noResults: "لا توجد مقالات تطابق «{query}».",
      signIn: "تسجيل الدخول",
      register: "إنشاء حساب",
      menu: "القائمة الرئيسية",
      openMenu: "القائمة",
      footerMenu: "روابط التذييل",
      language: "اللغة",
      skip: "انتقل إلى المحتوى",
      rights: "جميع الحقوق محفوظة.",
    },
  },
};

/** A site address in the page's language, under the site's path prefix if it has one. */
const link = (props: Pick<Props, "words">, path: string) => sitePath(props.words, path);

/** From the collection's URL pattern, so links follow whatever the owner sets. */
const hrefOf = (record: SiteRecord | undefined, props: Pick<Props, "words">) => (record && text(record.recordPath) ? link(props, text(record.recordPath)) : undefined);

/** Where "View more" goes: the blog's own address, when visitors can read it. */
const blogHref = (props: Props) => hrefOf(items(props.data.blogHome)[0], props);

const localeOf = (props: Pick<Props, "words" | "language">) => props.words?.locale ?? props.language?.locale ?? "en";

/* ------------------------------------------------------------------- icons */

const Arrow = ({ back = false }: { back?: boolean }) => (
  <svg className={back ? "ha-arrow ha-arrow-back" : "ha-arrow"} aria-hidden="true" viewBox="0 0 20 20" width="16" height="16"><path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M4 10h12m-5-5 5 5-5 5" /></svg>
);

/* ------------------------------------------------------------- story parts */

function When({ value, props }: { value: unknown; props: Props }) {
  const date = text(value);
  if (!props.options.showDates || !date) return null;
  const label = props.formatDate(date, "medium");
  return props.options.relativeDates ? <TimeAgo date={date} label={label} locale={localeOf(props)} /> : <time dateTime={date}>{label}</time>;
}

/** Category · time. The category is a link of its own, above the story's link. */
function Meta({ story, props }: { story: Story; props: Props }) {
  const category = byId(props.data.categories).get(ids(story.categories)[0] ?? -1);
  const dated = props.options.showDates && Boolean(text(story.publishedAt));
  if (!category && !dated) return null;
  const href = hrefOf(category, props);
  return (
    <p className="ha-meta">
      {category && (href ? <a className="ha-category" href={href}>{text(category.name)}</a> : <span className="ha-category">{text(category.name)}</span>)}
      {category && dated && <span className="ha-dot" aria-hidden="true" />}
      <When value={story.publishedAt} props={props} />
    </p>
  );
}

/** Its first tags, as #links. */
function Tags({ story, props, limit = 2 }: { story: Story; props: Props; limit?: number }) {
  const tags = byId(props.data.tags);
  const found = ids(story.tags).map((id) => tags.get(id)).filter((tag): tag is SiteRecord => Boolean(tag)).slice(0, limit);
  if (!found.length) return null;
  return (
    <ul className="ha-tags">
      {found.map((tag) => {
        const href = hrefOf(tag, props);
        return <li key={tag.id}>{href ? <a href={href}>#{text(tag.name)}</a> : `#${text(tag.name)}`}</li>;
      })}
    </ul>
  );
}

/** The story's title as a link that covers its whole card, so the card is one stop for the keyboard. */
function Title({ story, props, as: Tag = "h3", className }: { story: Story; props: Props; as?: "h1" | "h2" | "h3"; className?: string }) {
  const href = hrefOf(story, props);
  return <Tag className={className}>{href ? <a className="ha-cover-link" href={href}>{text(story.title)}</a> : text(story.title)}</Tag>;
}

function Picture({ story, props, size, className, eager = false }: { story: Story; props: Props; size: "300x300" | "800x0"; className: string; eager?: boolean }) {
  const cover = text(story.cover);
  // eslint-disable-next-line @next/next/no-img-element -- an access-checked API address that redirects to a signed URL, which next/image can't optimize
  if (cover) return <img className={className} src={props.fileUrl(cover, size)} alt={props.fileText(cover).alt} style={{ objectPosition: props.fileFocus(cover).objectPosition }} loading={eager ? "eager" : "lazy"} />;
  return <span className={`${className} ha-blank`} aria-hidden="true" />;
}

function ReadButton({ story, props }: { story: Story; props: Props }) {
  const href = hrefOf(story, props);
  if (!href) return null;
  return (
    <a className="ha-read" href={href}>
      {props.t("halo.readArticle")}
      <span className="ha-read-icon"><Arrow /></span>
      <span className="ha-visually-hidden">: {text(story.title)}</span>
    </a>
  );
}

/** A caps label with the lavender marker, and "View more" at the other end. */
function SectionHead({ id, label, more, props }: { id?: string; label: string; more?: string; props: Props }) {
  return (
    <div className="ha-section-head">
      <h2 id={id} className="ha-label">{label}</h2>
      {more && <a className="ha-more" href={more}>{props.t("halo.viewMore")}<Arrow /></a>}
    </div>
  );
}

/** Title and meta at the start, a square thumbnail at the end. */
function Row({ story, props }: { story: Story; props: Props }) {
  return (
    <article className="ha-row" lang={text(story.locale) || undefined}>
      <div className="ha-row-text">
        <Meta story={story} props={props} />
        <Title story={story} props={props} className="ha-row-title" />
      </div>
      <Picture story={story} props={props} size="300x300" className="ha-row-image" />
    </article>
  );
}

function Rows({ stories, props }: { stories: Story[]; props: Props }) {
  return <ul className="ha-rows">{stories.map((story) => <li key={story.id}><Row story={story} props={props} /></li>)}</ul>;
}

/** Image, meta, title and tags. */
function Card({ story, props, eager = false }: { story: Story; props: Props; eager?: boolean }) {
  return (
    <article className="ha-card" lang={text(story.locale) || undefined}>
      <Picture story={story} props={props} size="800x0" className="ha-card-image" eager={eager} />
      <Meta story={story} props={props} />
      <Title story={story} props={props} className="ha-card-title" />
      <Tags story={story} props={props} />
    </article>
  );
}

/** The cover with a lavender wash rising from the bottom, and the story over it in white. */
function Feature({ story, props, large = false }: { story: Story; props: Props; large?: boolean }) {
  return (
    <article className={large ? "ha-feature ha-feature-large" : "ha-feature"} lang={text(story.locale) || undefined}>
      <Picture story={story} props={props} size="800x0" className="ha-feature-image" />
      <div className="ha-feature-body">
        <Meta story={story} props={props} />
        <Title story={story} props={props} className="ha-feature-title" />
        {large && <Tags story={story} props={props} />}
      </div>
    </article>
  );
}

/* ---------------------------------------------------------------- layout */

const GlobeIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16"><path fill="none" stroke="currentColor" strokeWidth="1.5" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm-8-8h16M10 2c2.2 2.2 3.2 5 3.2 8s-1 5.8-3.2 8c-2.2-2.2-3.2-5-3.2-8s1-5.8 3.2-8Z" /></svg>
);

/**
 * The same page in each language it's published in. In the header it's a menu showing the
 * current language's code; in the small-screen drawer it's a plain list.
 */
function LanguageSwitcher({ language, t, inline = false }: Pick<Props, "language" | "t"> & { inline?: boolean }) {
  if (!language) return null;
  const available = language.locales.filter((locale) => language.alternates[locale.code]);
  if (available.length < 2) return null;
  const list = (
    <ul className="ha-languages-list">
      {available.map((locale) => (
        <li key={locale.code}>
          <a href={language.alternates[locale.code]} hrefLang={locale.code} lang={locale.code} aria-current={locale.code === language.locale ? "true" : undefined}>
            <span>{locale.label}</span>
            <span className="ha-languages-code">{locale.code}</span>
          </a>
        </li>
      ))}
    </ul>
  );
  if (inline) {
    return (
      <nav className="ha-languages ha-languages-inline" aria-label={t("halo.language")}>
        <p className="ha-label"><GlobeIcon />{t("halo.language")}</p>
        {list}
      </nav>
    );
  }
  return (
    <nav className="ha-languages" aria-label={t("halo.language")}>
      <details className="ha-languages-menu">
        <summary>
          <span className="ha-languages-current">{language.locale}</span>
          <span className="ha-chevron" aria-hidden="true" />
        </summary>
        <div className="ha-languages-panel">{list}</div>
      </details>
    </nav>
  );
}

function Brand({ branding, words }: Pick<Props, "branding" | "words">) {
  return (
    <a className="ha-brand" href={link({ words }, "/")}>
      {/* eslint-disable-next-line @next/next/no-img-element -- the logo from Settings, a site path or data image */}
      {branding.logoUrl ? <img src={branding.logoUrl} alt="" width={20} height={20} /> : <span className="ha-brand-mark" aria-hidden="true" />}
      <span>{branding.name}</span>
    </a>
  );
}

function AccountLinks({ t }: Pick<Props, "t">) {
  return (
    <div className="ha-account">
      <a className="ha-chip" href={authPath("signin")}>{t("halo.signIn")}</a>
      <a className="ha-chip ha-chip-ink" href={authPath("signup")}>{t("halo.register")}</a>
    </div>
  );
}

function Layout(props: LayoutProps<HaloOptions>) {
  const { branding, globals, options, children, language, t, words } = props;
  const menu = globals["site-menu"]?.items;
  const search = options.search ? <HeaderSearch words={words ? pickWords(words, "halo") : undefined} showDates={options.showDates} /> : null;
  return (
    <div className="ha-shell" data-scheme={options.colorScheme}>
      <a className="ha-skip" href="#ha-content">{t("halo.skip")}</a>
      <header className="ha-header">
        <div className="ha-header-inner">
          <Brand branding={branding} words={words} />
          <nav className="ha-nav" aria-label={t("halo.menu")}><Menu items={menu} /></nav>
          <div className="ha-header-end">
            <LanguageSwitcher language={language} t={t} />
            {search}
            {options.accountLinks && <AccountLinks t={t} />}
          </div>
          {/* Small screens: the same menu behind a button, with no script. */}
          <details className="ha-drawer">
            <summary aria-label={t("halo.openMenu")}><span aria-hidden="true" /></summary>
            <div className="ha-drawer-panel">
              {search}
              <nav aria-label={t("halo.menu")}><Menu items={menu} /></nav>
              <LanguageSwitcher language={language} t={t} inline />
              {options.accountLinks && <AccountLinks t={t} />}
            </div>
          </details>
        </div>
      </header>
      <div id="ha-content" className="ha-content">{children}</div>
      <footer className="ha-footer">
        <div className="ha-footer-inner">
          <div>
            <Brand branding={branding} words={words} />
            {options.tagline && <p className="ha-footer-tagline">{options.tagline}</p>}
          </div>
          <nav className="ha-footer-nav" aria-label={t("halo.footerMenu")}><Menu items={menu} /></nav>
          <p className="ha-footer-legal">© {new Date().getFullYear()} {branding.name}. {t("halo.rights")}</p>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------- front page */

/**
 * Hands out stories to the front page's sections, most important first. A section an editor
 * filled shows their picks in their order. Otherwise it takes stories no earlier section
 * showed, and, where `reuse` allows, tops up with ones that did, so a young site's page isn't
 * mostly empty.
 */
function allocator() {
  const used = new Set<number>();
  return (picks: Story[], order: number[], pools: Story[][], count: number, reuse = false): Story[] => {
    if (picks.length) {
      const sorted = [...picks].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).slice(0, count);
      for (const story of sorted) used.add(story.id);
      return sorted;
    }
    const chosen: Story[] = [];
    const seen = new Set<number>();
    const add = (story: Story) => {
      if (chosen.length >= count || seen.has(story.id)) return;
      seen.add(story.id);
      chosen.push(story);
    };
    for (const pool of pools) for (const story of pool) if (!used.has(story.id)) add(story);
    if (reuse) for (const pool of pools) for (const story of pool) add(story);
    for (const story of chosen) used.add(story.id);
    return chosen;
  };
}

function frontStories({ data, record }: Props) {
  const take = allocator();
  const featured = items(data.featured);
  const recent = items(data.recent);
  const order = (field: string) => ids(record?.[field]);
  // Allocated in this order so the newest stories reach "Latest" before the other lists take them.
  const lead = take(items(data.pickLead), order("lead"), [featured, recent], 1)[0];
  const spotlight = take(items(data.pickSpotlight), order("spotlight"), [featured, recent], 1)[0];
  const latest = take([], [], [recent], 4);
  const recommended = take(items(data.pickRecommended), order("recommended"), [recent], 5);
  const strip = take([], [], [featured, recent], 3);
  const trending = take(items(data.pickTrending), order("trending"), [recent], 7, true);
  const readers = take(items(data.pickReaders), order("readersChoice"), [featured, recent], 9, true);
  const popular = take(items(data.pickPopular), order("popular"), [recent], 10, true);
  return { lead, spotlight, latest, recommended, strip, trending, readers, popular };
}

/** The halo itself: CSS only, so it costs no request and follows the accent. */
const Halo = ({ className = "ha-halo" }: { className?: string }) => <span className={className} aria-hidden="true"><span /></span>;

function LeadSection({ lead, strip, recommended, props }: { lead: Story; strip: Story[]; recommended: Story[]; props: Props }) {
  const { t } = props;
  const [first, ...rest] = recommended;
  return (
    <section className="ha-lead-wrap" aria-labelledby="ha-lead-label">
      <div className="ha-lead">
        <Halo />
        <div className="ha-lead-main">
          <p id="ha-lead-label" className="ha-label">{t("halo.bestOfWeek")}</p>
          <Meta story={lead} props={props} />
          <Title story={lead} props={props} as="h2" className="ha-display" />
          <Tags story={lead} props={props} />
          <ReadButton story={lead} props={props} />
        </div>
        {strip.length > 0 && (
          <ul className="ha-strip">
            {strip.map((story) => (
              <li key={story.id}>
                <article className="ha-strip-item">
                  <Meta story={story} props={props} />
                  <Title story={story} props={props} className="ha-strip-title" />
                </article>
              </li>
            ))}
          </ul>
        )}
      </div>
      {first && (
        <aside className="ha-panel ha-recommended" aria-labelledby="ha-recommended">
          <div className="ha-section-head ha-section-head-plain">
            <h2 id="ha-recommended" className="ha-panel-title">{t("halo.recommended")}</h2>
            {blogHref(props) && <a className="ha-more" href={blogHref(props)}>{t("halo.viewAll")}<Arrow /></a>}
          </div>
          <Feature story={first} props={props} />
          {rest.length > 0 && <Rows stories={rest} props={props} />}
        </aside>
      )}
    </section>
  );
}

function SpotlightSection({ spotlight, latest, props }: { spotlight?: Story; latest: Story[]; props: Props }) {
  const { t } = props;
  if (!spotlight && !latest.length) return null;
  return (
    <section className="ha-spotlight-wrap">
      {latest.length > 0 && (
        <div className="ha-panel ha-latest" aria-labelledby="ha-latest">
          <SectionHead id="ha-latest" label={t("halo.latest")} more={blogHref(props)} props={props} />
          <Rows stories={latest} props={props} />
        </div>
      )}
      {spotlight && (
        <article className="ha-spotlight" lang={text(spotlight.locale) || undefined}>
          <div className="ha-spotlight-head">
            <Meta story={spotlight} props={props} />
            <Title story={spotlight} props={props} as="h2" className="ha-headline" />
            <Tags story={spotlight} props={props} />
          </div>
          <div className="ha-spotlight-side">
            {text(spotlight.excerpt) && <p className="ha-excerpt">{text(spotlight.excerpt)}</p>}
            <ReadButton story={spotlight} props={props} />
          </div>
          <a className="ha-badge" href="#ha-readers">
            <Halo className="ha-badge-halo" />
            <span>{t("halo.readersChoiceBadge")}</span>
            <small>{t("halo.thisWeek")}</small>
          </a>
        </article>
      )}
    </section>
  );
}

function TrendingSection({ stories, props }: { stories: Story[]; props: Props }) {
  const [first, ...grid] = stories;
  if (!first) return null;
  const { t } = props;
  return (
    <section className="ha-trending" aria-labelledby="ha-trending">
      <div className="ha-trending-lead">
        <SectionHead id="ha-trending" label={t("halo.trending")} more={blogHref(props)} props={props} />
        <article className="ha-trending-story" lang={text(first.locale) || undefined}>
          <Meta story={first} props={props} />
          <Title story={first} props={props} className="ha-headline" />
          <Tags story={first} props={props} />
          <ReadButton story={first} props={props} />
        </article>
        <Picture story={first} props={props} size="800x0" className="ha-trending-image" />
      </div>
      {grid.length > 0 && <ul className="ha-grid">{grid.map((story) => <li key={story.id}><Card story={story} props={props} /></li>)}</ul>}
    </section>
  );
}

function ReadersSection({ stories, props }: { stories: Story[]; props: Props }) {
  const [first, ...rest] = stories;
  if (!first) return null;
  return (
    <section className="ha-section" aria-labelledby="ha-readers">
      <SectionHead id="ha-readers" label={props.t("halo.readersChoice")} more={blogHref(props)} props={props} />
      <div className="ha-readers">
        <Feature story={first} props={props} large />
        {rest.length > 0 && <Rows stories={rest} props={props} />}
      </div>
    </section>
  );
}

function PopularSection({ stories, props }: { stories: Story[]; props: Props }) {
  if (!stories.length) return null;
  const { t } = props;
  return (
    <section className="ha-section" aria-labelledby="ha-popular">
      <SectionHead id="ha-popular" label={t("halo.popular")} more={blogHref(props)} props={props} />
      <Carousel previous={t("halo.previous")} next={t("halo.next")} label={t("halo.popular")}>
        <ul className="ha-carousel-list">
          {stories.map((story) => <li key={story.id}><Card story={story} props={props} /></li>)}
        </ul>
      </Carousel>
    </section>
  );
}

/**
 * The home page: at the site's root, from the Front page record when an editor made one, or
 * from featured and recent posts when not.
 */
function Front(props: Props) {
  const { record, branding, t } = props;
  const { lead, spotlight, latest, recommended, strip, trending, readers, popular } = frontStories(props);
  return (
    <main className="ha-page">
      <h1 className="ha-visually-hidden">{text(record?.title) || branding.name}</h1>
      {lead ? (
        <>
          <LeadSection lead={lead} strip={strip} recommended={recommended} props={props} />
          <SpotlightSection spotlight={spotlight} latest={latest} props={props} />
          <TrendingSection stories={trending} props={props} />
          <ReadersSection stories={readers} props={props} />
          <PopularSection stories={popular} props={props} />
        </>
      ) : <p className="ha-panel ha-empty">{t("halo.noStories")}</p>}
    </main>
  );
}

/* --------------------------------------------------------------- archives */

/** Arrow buttons for a paged list. An end it can't go past shows a quiet, disabled circle. */
function PageArrows({ list, props }: { list: SiteList | undefined; props: Props }) {
  if (!list || list.totalPages <= 1) return null;
  const { page, totalPages } = list;
  const at = link(props, props.path);
  const { t } = props;
  return (
    <nav className="ha-page-arrows" aria-label={t("halo.pages")}>
      {page > 1 ? <a className="ha-round" rel="prev" href={pageHref(at, page - 1)} aria-label={t("halo.newer")}><Arrow back /></a> : <span className="ha-round" aria-hidden="true"><Arrow back /></span>}
      <span className="ha-visually-hidden" aria-current="page">{t("halo.pageOf", { page, total: totalPages })}</span>
      {page < totalPages ? <a className="ha-round ha-round-ink" rel="next" href={pageHref(at, page + 1)} aria-label={t("halo.older")}><Arrow /></a> : <span className="ha-round ha-round-ink" aria-hidden="true"><Arrow /></span>}
    </nav>
  );
}

/**
 * The blog's home, a category or a tag: the newest story of the page leads beside a grid of
 * the next six, with arrows to older pages.
 */
function Archive({ kicker, heading, intro, ...props }: Props & { kicker: string; heading: string; intro?: ReactNode }) {
  const posts = items(props.data.posts);
  const [first, ...grid] = posts;
  return (
    <main className="ha-page">
      <section className="ha-trending ha-archive" aria-labelledby="ha-archive">
        <div className="ha-trending-lead">
          <p className="ha-label">{kicker}</p>
          <h1 id="ha-archive" className="ha-archive-title">{heading}</h1>
          {intro}
          {first ? (
            <article className="ha-trending-story" lang={text(first.locale) || undefined}>
              <Meta story={first} props={props} />
              <Title story={first} props={props} as="h2" className="ha-headline" />
              <Tags story={first} props={props} />
              <ReadButton story={first} props={props} />
            </article>
          ) : <p className="ha-empty">{props.t("halo.noStoriesHere")}</p>}
          {first && <Picture story={first} props={props} size="800x0" className="ha-trending-image" eager />}
        </div>
        {grid.length > 0 && (
          <div className="ha-archive-grid">
            <ul className="ha-grid">{grid.map((story, index) => <li key={story.id}><Card story={story} props={props} eager={index < 3} /></li>)}</ul>
            <PageArrows list={props.data.posts} props={props} />
          </div>
        )}
        {!grid.length && <PageArrows list={props.data.posts} props={props} />}
      </section>
    </main>
  );
}

function BlogHome(props: Props) {
  const { record, stream, t } = props;
  const intro = Array.isArray(record?.intro) && record.intro.length > 0 ? <div className="ha-archive-intro"><StreamField blocks={record.intro} {...stream} /></div> : undefined;
  return <Archive {...props} kicker={t("halo.latest")} heading={text(record?.title) || t("halo.latest")} intro={intro} />;
}

function Taxonomy({ kind, ...props }: Props & { kind: "category" | "tag" }) {
  const { record, t } = props;
  if (!record) return null;
  const intro = text(record.description) ? <p className="ha-archive-intro">{text(record.description)}</p> : undefined;
  return <Archive {...props} kicker={t(kind === "category" ? "blog.category" : "blog.tag")} heading={kind === "tag" ? `#${text(record.name)}` : text(record.name)} intro={intro} />;
}

const Category = (props: Props) => <Taxonomy {...props} kind="category" />;
const Tag = (props: Props) => <Taxonomy {...props} kind="tag" />;

/* ------------------------------------------------------------------ posts */

/**
 * A post. Byline, tags and comments are the blog plugin's parts, fed the plugin's lists
 * through `data`, so they behave exactly as on its own page.
 */
function Post(props: Props) {
  const { record, data, stream, fileUrl, fileText, fileFocus, t, words } = props;
  if (!record) return null;
  const side = items(data.sideStories);
  const more = (items(data.moreStories).length ? items(data.moreStories) : side).slice(0, 4);
  const cover = text(record.cover);
  return (
    <main className="ha-page">
      <div className="ha-post">
        <article className="ha-panel ha-article">
          <header className="ha-article-head">
            <Meta story={record} props={props} />
            <h1 className="ha-headline ha-article-title">{text(record.title)}</h1>
            {text(record.excerpt) && <p className="ha-lead-text">{text(record.excerpt)}</p>}
            {props.options.showDates && <PostMeta post={record} data={data} words={words} />}
          </header>
          {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked API address that redirects to a signed URL, which next/image can't optimize */}
          {cover && <figure className="ha-article-cover"><img src={fileUrl(cover, "800x0")} alt={fileText(cover).alt} style={{ objectPosition: fileFocus(cover).objectPosition }} /></figure>}
          <div className="ha-prose">
            <StreamField blocks={record.body} {...stream} />
            <PostTags post={record} data={data} words={words} />
          </div>
          <div className="ha-comments"><PostComments post={record} data={data} words={words} /></div>
        </article>
        {side.length > 0 && (
          <aside className="ha-panel ha-recommended ha-post-aside" aria-labelledby="ha-side">
            <div className="ha-section-head ha-section-head-plain">
              <h2 id="ha-side" className="ha-panel-title">{t("halo.recommended")}</h2>
              {blogHref(props) && <a className="ha-more" href={blogHref(props)}>{t("halo.viewAll")}<Arrow /></a>}
            </div>
            <Rows stories={side} props={props} />
          </aside>
        )}
      </div>
      {more.length > 0 && (
        <section className="ha-section" aria-labelledby="ha-more-like">
          <SectionHead id="ha-more-like" label={t("halo.moreLikeThis")} props={props} />
          <ul className="ha-grid ha-grid-four">{more.map((story) => <li key={story.id}><Card story={story} props={props} /></li>)}</ul>
        </section>
      )}
    </main>
  );
}

/** Any other page, such as About. */
function Page({ record, stream }: Props) {
  if (!record) return null;
  return (
    <main className="ha-page">
      <article className="ha-panel ha-article ha-article-solo">
        <header className="ha-article-head"><h1 className="ha-headline ha-article-title">{text(record.title)}</h1></header>
        <div className="ha-prose"><StreamField blocks={record.body} {...stream} /></div>
      </article>
    </main>
  );
}

/**
 * Categories and tags have a name rather than a title, and posts an excerpt rather than a summary.
 * Only fills what the CMS's defaults (seo_title, title, seo_description, summary) would leave empty.
 */
function metadata({ record, branding }: Props) {
  if (!record) return {};
  return {
    title: !text(record.seo_title) && !text(record.title) ? text(record.name) || (record.lead !== undefined ? branding.name : undefined) : undefined,
    description: !text(record.seo_description) && !text(record.summary) ? text(record.excerpt) || text(record.description) || undefined : undefined,
  };
}

export default defineThemeComponents<HaloOptions>({
  // Blocks come from the blog plugin and are restyled in theme.css.
  templates: { home: Front, "halo-front": Front, "blog-home": BlogHome, "blog-posts": Post, "blog-categories": Category, "blog-tags": Tag, default: Page },
  layouts: { default: Layout },
  metadata,
  fontClassName: font.variable,
  messages,
});
