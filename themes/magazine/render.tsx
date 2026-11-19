import localFont from "next/font/local";
import Link from "next/link";
import type { ReactNode } from "react";
import { PostComments, PostMeta, PostTags } from "@tansy/blog/render";
import { authPath, Menu, Pager, pickWords, RichText, StreamField } from "tansy/react";
import { defineThemeComponents, type LayoutProps, type SiteList, type SiteRecord, type TemplateProps } from "tansy/theme";
import type { MagazineOptions } from "./index";
import { PostSearch } from "./search";
import "./theme.css";

// Served from the site's own origin, as font-src 'self' requires.
const font = localFont({ src: "./fonts/GeistVF.woff", variable: "--magazine-font", weight: "100 900" });

type Props = TemplateProps<MagazineOptions>;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is number => typeof id === "number") : typeof value === "number" ? [value] : []);
const items = (list: SiteList | undefined) => list?.items ?? [];
const byId = (list: SiteList | undefined) => new Map(items(list).map((record) => [record.id, record]));

/**
 * The theme's words, under `magazine`, so a client part gets only these with `pickWords`. Owners
 * can change any of them per language under Languages → Site text. The blog's own words, such
 * as `blog.minutes`, come from the blog plugin.
 */
const messages = {
  en: {
    magazine: {
      kicker: "Blog",
      heroTitle: "Discover our latest stories",
      heroIntro: "Ideas, guides and news from our team, written to be useful and read in a few minutes.",
      searchLabel: "Search posts",
      searchPlaceholder: "Search articles…",
      searchButton: "Find now",
      searching: "Searching…",
      searchFailed: "Search isn't working right now. Try again in a moment.",
      found: "{count, plural, one {# post found} other {# posts found}}",
      noResults: "No posts match “{query}”.",
      latest: "Latest stories",
      featured: "Featured",
      recent: "Latest",
      noPosts: "No posts yet.",
      noPostsHere: "No posts here yet.",
      newerPosts: "Newer posts",
      olderPosts: "Older posts",
      keepReading: "Keep reading",
      pageOf: "Page {page}",
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
    magazine: {
      kicker: "المدونة",
      heroTitle: "اكتشف أحدث قصصنا",
      heroIntro: "أفكار وأدلة وأخبار من فريقنا، مكتوبة لتكون مفيدة وتُقرأ في دقائق.",
      searchLabel: "ابحث في المقالات",
      searchPlaceholder: "ابحث عن مقال…",
      searchButton: "ابحث الآن",
      searching: "جارٍ البحث…",
      searchFailed: "البحث لا يعمل الآن. حاول مجددًا بعد قليل.",
      found: "{count, plural, zero {لا توجد نتائج} one {مقال واحد} two {مقالان} few {# مقالات} many {# مقالًا} other {# مقال}}",
      noResults: "لا توجد مقالات تطابق «{query}».",
      latest: "أحدث القصص",
      featured: "مميزة",
      recent: "الأحدث",
      noPosts: "لا توجد مقالات بعد.",
      noPostsHere: "لا توجد مقالات هنا بعد.",
      newerPosts: "مقالات أحدث",
      olderPosts: "مقالات أقدم",
      keepReading: "تابع القراءة",
      pageOf: "الصفحة {page}",
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

/** An address in the page's language: "/blog" is "/ar/blog" on an Arabic page. */
const inLanguage = (props: Pick<Props, "language">, path: string) => props.language?.href(path) ?? path;

/** From the collection's URL pattern, so links follow whatever the owner sets. */
const hrefOf = (record: SiteRecord | undefined, props: Pick<Props, "language">) => (record && text(record.recordPath) ? inLanguage(props, text(record.recordPath)) : undefined);

function Published({ value, props, style = "medium" }: { value: unknown; props: Pick<Props, "options" | "formatDate">; style?: "medium" | "long" }) {
  const date = text(value);
  if (!props.options.showDates || !date) return null;
  return <time dateTime={date}>{props.formatDate(date, style)}</time>;
}

/* ------------------------------------------------------------------ layout */

const GlobeIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16"><path fill="currentColor" d="M10 1.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Zm2.6 9.3H7.4c.13 2.3.68 4.3 1.43 5.6.4.7.83 1.06 1.17 1.06s.77-.36 1.17-1.06c.75-1.3 1.3-3.3 1.43-5.6Zm-6.8 0H3.15a6.9 6.9 0 0 0 4.2 5.6c-.8-1.5-1.38-3.47-1.55-5.6Zm11.05 0H14.2c-.17 2.13-.75 4.1-1.55 5.6a6.9 6.9 0 0 0 4.2-5.6ZM7.35 3.6a6.9 6.9 0 0 0-4.2 5.6H5.8c.17-2.13.75-4.1 1.55-5.6ZM10 3.1c-.34 0-.77.36-1.17 1.06-.75 1.3-1.3 3.3-1.43 5.04h5.2c-.13-1.74-.68-3.74-1.43-5.04-.4-.7-.83-1.06-1.17-1.06Zm2.65.5c.8 1.5 1.38 3.47 1.55 5.6h2.65a6.9 6.9 0 0 0-4.2-5.6Z" /></svg>
);

/**
 * The same page in each language it's published in. In the header it's a menu, so it stays one
 * button however many languages the site adds; in the small-screen drawer it's a plain list.
 */
function LanguageSwitcher({ language, t, inline = false }: Pick<Props, "language" | "t"> & { inline?: boolean }) {
  if (!language) return null;
  const available = language.locales.filter((locale) => language.alternates[locale.code]);
  if (available.length < 2) return null;
  const current = available.find((locale) => locale.code === language.locale);
  const list = (
    <ul className="mg-languages-list">
      {available.map((locale) => (
        <li key={locale.code}>
          <a href={language.alternates[locale.code]} hrefLang={locale.code} lang={locale.code} aria-current={locale.code === language.locale ? "true" : undefined}>
            <span>{locale.label}</span>
            <span className="mg-languages-code">{locale.code}</span>
          </a>
        </li>
      ))}
    </ul>
  );
  if (inline) {
    return (
      <nav className="mg-languages mg-languages-inline" aria-label={t("magazine.language")}>
        <p className="mg-languages-heading"><GlobeIcon />{t("magazine.language")}</p>
        {list}
      </nav>
    );
  }
  return (
    <nav className="mg-languages" aria-label={t("magazine.language")}>
      <details className="mg-languages-menu">
        <summary>
          <GlobeIcon />
          <span>{current?.label ?? language.locale}</span>
          <span className="mg-chevron" aria-hidden="true" />
        </summary>
        <div className="mg-languages-panel">{list}</div>
      </details>
    </nav>
  );
}

function Brand({ branding, language }: Pick<Props, "branding" | "language">) {
  return (
    <Link className="mg-brand" href={inLanguage({ language }, "/")} prefetch={false}>
      {/* eslint-disable-next-line @next/next/no-img-element -- the logo from Settings, a site path or data image */}
      {branding.logoUrl ? <img src={branding.logoUrl} alt="" width={32} height={32} /> : <span className="mg-brand-mark" aria-hidden="true" />}
      <span>{branding.name}</span>
    </Link>
  );
}

function AccountLinks({ t }: Pick<Props, "t">) {
  return (
    <div className="mg-account">
      <a className="mg-button mg-button-soft" href={authPath("signin")}>{t("magazine.signIn")}</a>
      <a className="mg-button" href={authPath("signup")}>{t("magazine.register")}</a>
    </div>
  );
}

function Layout(props: LayoutProps<MagazineOptions>) {
  const { branding, globals, options, children, language, t } = props;
  const menu = globals["site-menu"]?.items;
  return (
    <div className="mg-shell" data-scheme={options.colorScheme}>
      <a className="mg-skip" href="#mg-content">{t("magazine.skip")}</a>
      <header className="mg-header">
        <div className="mg-header-inner">
          <Brand branding={branding} language={language} />
          <nav className="mg-nav" aria-label={t("magazine.menu")}><Menu items={menu} /></nav>
          <div className="mg-header-end">
            <LanguageSwitcher language={language} t={t} />
            {options.accountLinks && <AccountLinks t={t} />}
          </div>
          {/* Small screens: the same menu behind a button, with no script. */}
          <details className="mg-drawer">
            <summary aria-label={t("magazine.openMenu")}><span aria-hidden="true" /></summary>
            <div className="mg-drawer-panel">
              <nav aria-label={t("magazine.menu")}><Menu items={menu} /></nav>
              <LanguageSwitcher language={language} t={t} inline />
              {options.accountLinks && <AccountLinks t={t} />}
            </div>
          </details>
        </div>
      </header>
      <div id="mg-content" className="mg-content">{children}</div>
      <footer className="mg-footer">
        <div className="mg-footer-inner">
          <div>
            <Brand branding={branding} language={language} />
            {options.tagline && <p className="mg-footer-tagline">{options.tagline}</p>}
          </div>
          <nav className="mg-footer-nav" aria-label={t("magazine.footerMenu")}><Menu items={menu} /></nav>
          <p className="mg-footer-legal">© {new Date().getFullYear()} {branding.name}. {t("magazine.rights")}</p>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------- parts */

/** A post as an image card: its first category, title and excerpt over the cover. The whole card is one link. */
function PostCard({ post, categories, props, eager = false }: { post: SiteRecord; categories: Map<number, SiteRecord>; props: Props; eager?: boolean }) {
  const href = hrefOf(post, props);
  const category = categories.get(ids(post.categories)[0] ?? -1);
  const cover = text(post.cover);
  const minutes = typeof post.readingMinutes === "number" ? post.readingMinutes : null;
  return (
    <article className="mg-card" lang={typeof post.locale === "string" ? post.locale : undefined}>
      {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked API address that redirects to a signed URL, which next/image can't optimize */}
      {cover ? <img className="mg-card-image" src={props.fileUrl(cover, "800x0")} alt={props.fileText(cover).alt} style={{ objectPosition: props.fileFocus(cover).objectPosition }} loading={eager ? "eager" : "lazy"} /> : <span className="mg-card-image mg-card-blank" aria-hidden="true" />}
      <div className="mg-card-body">
        {category && (hrefOf(category, props)
          ? <a className="mg-pill mg-card-pill" href={hrefOf(category, props)}>{text(category.name)}</a>
          : <span className="mg-pill mg-card-pill">{text(category.name)}</span>)}
        <h3 className="mg-card-title">{href ? <a className="mg-card-link" href={href}>{text(post.title)}</a> : text(post.title)}</h3>
        {text(post.excerpt) && <p className="mg-card-excerpt">{text(post.excerpt)}</p>}
        {(props.options.showDates || minutes !== null) && (
          <p className="mg-card-meta">
            <Published value={post.publishedAt} props={props} />
            {props.options.showDates && text(post.publishedAt) && minutes !== null && <span aria-hidden="true"> · </span>}
            {minutes !== null && props.t("blog.minutes", { count: minutes })}
          </p>
        )}
      </div>
    </article>
  );
}

function CardGrid({ posts, props, empty }: { posts: SiteRecord[]; props: Props; empty: string }) {
  if (!posts.length) return <p className="mg-empty">{empty}</p>;
  const categories = byId(props.data.categories);
  return (
    <ul className="mg-grid">
      {posts.map((post, index) => <li key={post.id}><PostCard post={post} categories={categories} props={props} eager={index < 3} /></li>)}
    </ul>
  );
}

/** A heading with a rule that runs to the end of the column. */
const SectionTitle = ({ id, children, as: Tag = "h2" }: { id?: string; children: ReactNode; as?: "h2" | "h3" }) => <Tag id={id} className="mg-section-title"><span>{children}</span></Tag>;

/** Small posts with a thumbnail, for the sidebar. */
function PostRows({ title, posts, props }: { title: string; posts: SiteRecord[]; props: Props }) {
  if (!posts.length) return null;
  return (
    <section className="mg-rows">
      <SectionTitle as="h2">{title}</SectionTitle>
      <ul>
        {posts.map((post) => {
          const href = hrefOf(post, props);
          return (
            <li key={post.id}>
              <article className="mg-row">
                {/* eslint-disable-next-line @next/next/no-img-element -- as for the cards */}
                {text(post.cover) ? <img src={props.fileUrl(text(post.cover), "300x300")} alt={props.fileText(text(post.cover)).alt} width={96} height={96} loading="lazy" /> : <span className="mg-row-blank" aria-hidden="true" />}
                <div>
                  <p className="mg-row-date"><Published value={post.publishedAt} props={props} /></p>
                  <h3>{href ? <a className="mg-card-link" href={href}>{text(post.title)}</a> : text(post.title)}</h3>
                </div>
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Sidebar({ props, featured }: { props: Props; featured: boolean }) {
  const { data, t } = props;
  return (
    <aside className="mg-sidebar">
      {featured && <PostRows title={t("magazine.featured")} posts={items(data.featured)} props={props} />}
      <PostRows title={t("magazine.recent")} posts={items(data.latest)} props={props} />
    </aside>
  );
}

function Hero({ kicker, title, children, compact = false }: { kicker: string; title: string; children?: ReactNode; compact?: boolean }) {
  return (
    <header className={compact ? "mg-hero mg-hero-compact" : "mg-hero"}>
      <div className="mg-hero-inner">
        <p className="mg-pill mg-pill-quiet">{kicker}</p>
        <h1>{title}</h1>
        {children}
      </div>
    </header>
  );
}

/* --------------------------------------------------------------- templates */

/**
 * The front page, at the site's root and at the blog's address. On the blog's address, its
 * title and introduction come from the Blog home record.
 */
function Front(props: Props) {
  const { record, data, options, path, t, words, stream } = props;
  const firstPage = (data.posts?.page ?? 1) === 1;
  const intro = Array.isArray(record?.intro) && record.intro.length > 0
    ? <div className="mg-hero-intro"><StreamField blocks={record.intro} {...stream} /></div>
    : <p className="mg-hero-intro">{options.tagline || t("magazine.heroIntro")}</p>;
  return (
    <main>
      <Hero kicker={t("magazine.kicker")} title={text(record?.title) || t("magazine.heroTitle")} compact={!firstPage}>
        {firstPage && intro}
        {firstPage && options.search && <PostSearch words={words ? pickWords(words, "magazine") : undefined} showDates={options.showDates} />}
      </Hero>
      <div className="mg-columns">
        <section className="mg-primary" aria-labelledby="mg-latest">
          <SectionTitle id="mg-latest">{firstPage ? t("magazine.latest") : t("magazine.pageOf", { page: data.posts?.page ?? 1 })}</SectionTitle>
          <CardGrid posts={items(data.posts)} props={props} empty={t("magazine.noPosts")} />
          <Pager list={data.posts} path={path} previous={t("magazine.newerPosts")} next={t("magazine.olderPosts")} className="mg-pager" words={words} />
        </section>
        <Sidebar props={props} featured={firstPage} />
      </div>
    </main>
  );
}

/**
 * The post page. Meta, tags and comments are the blog plugin's parts, fed the plugin's lists
 * through `data`; the cards under the post are the theme's own lists, which carry covers.
 */
function Post(props: Props) {
  const { record, data, stream, fileUrl, fileText, fileFocus, t, words } = props;
  if (!record) return null;
  const categories = byId(data.categories);
  const more = items(data.moreCards).length ? items(data.moreCards) : items(data.latestCards);
  const cover = text(record.cover);
  return (
    <main>
      <article className="mg-article">
        <header className="mg-article-head">
          {ids(record.categories).length > 0 && (
            <p className="mg-article-kicker">
              {ids(record.categories).map((id) => {
                const category = categories.get(id);
                if (!category) return null;
                const href = hrefOf(category, props);
                return href ? <a key={id} className="mg-pill" href={href}>{text(category.name)}</a> : <span key={id} className="mg-pill">{text(category.name)}</span>;
              })}
            </p>
          )}
          <h1>{text(record.title)}</h1>
          {text(record.excerpt) && <p className="mg-lead">{text(record.excerpt)}</p>}
          {props.options.showDates && <PostMeta post={record} data={data} words={words} />}
        </header>
        {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked API address that redirects to a signed URL, which next/image can't optimize */}
        {cover && <figure className="mg-article-cover"><img src={fileUrl(cover, "800x0")} alt={fileText(cover).alt} style={{ objectPosition: fileFocus(cover).objectPosition }} /></figure>}
        <div className="mg-prose">
          <StreamField blocks={record.body} {...stream} />
          <PostTags post={record} data={data} words={words} />
        </div>
      </article>
      {more.length > 0 && (
        <section className="mg-more" aria-labelledby="mg-more">
          <SectionTitle id="mg-more">{t("magazine.keepReading")}</SectionTitle>
          <CardGrid posts={more.filter((post) => post.id !== record.id).slice(0, 3)} props={props} empty="" />
        </section>
      )}
      <div className="mg-comments"><PostComments post={record} data={data} words={words} /></div>
    </main>
  );
}

/** A category's or a tag's page. */
function Archive({ heading, ...props }: Props & { heading: string }) {
  const { record, data, path, t, words } = props;
  if (!record) return null;
  return (
    <main>
      <Hero kicker={heading} title={text(record.name)} compact>
        {text(record.description) && <p className="mg-hero-intro">{text(record.description)}</p>}
        {record.bio !== undefined && record.bio !== null && <div className="mg-hero-intro"><RichText doc={record.bio} /></div>}
      </Hero>
      <div className="mg-columns">
        <section className="mg-primary" aria-label={text(record.name)}>
          <CardGrid posts={items(data.posts)} props={props} empty={t("magazine.noPostsHere")} />
          <Pager list={data.posts} path={path} previous={t("magazine.newerPosts")} next={t("magazine.olderPosts")} className="mg-pager" words={words} />
        </section>
        <Sidebar props={props} featured={false} />
      </div>
    </main>
  );
}

const Category = (props: Props) => <Archive {...props} heading={props.t("blog.category")} />;
const Tag = (props: Props) => <Archive {...props} heading={props.t("blog.tag")} />;

/** Any other page, such as About. */
function Page({ record, stream }: Props) {
  if (!record) return null;
  return (
    <main>
      <article className="mg-article">
        <header className="mg-article-head"><h1>{text(record.title)}</h1></header>
        <div className="mg-prose"><StreamField blocks={record.body} {...stream} /></div>
      </article>
    </main>
  );
}

/**
 * Categories and tags have a name rather than a title, and posts an excerpt rather than a summary.
 * Only fills what the CMS's defaults (seo_title, title, seo_description, summary) would leave empty.
 */
function metadata({ record }: Props) {
  if (!record) return {};
  return {
    title: !text(record.seo_title) && !text(record.title) ? text(record.name) || undefined : undefined,
    description: !text(record.seo_description) && !text(record.summary) ? text(record.excerpt) || text(record.description) || undefined : undefined,
  };
}

export default defineThemeComponents<MagazineOptions>({
  // Blocks come from the blog plugin and are restyled in theme.css.
  templates: { home: Front, "blog-home": Front, "blog-posts": Post, "blog-categories": Category, "blog-tags": Tag, default: Page },
  layouts: { default: Layout },
  metadata,
  fontClassName: font.variable,
  messages,
});
