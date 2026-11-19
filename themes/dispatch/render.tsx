import localFont from "next/font/local";
import Link from "next/link";
import { MorePosts, PostComments, PostMeta, PostTags } from "@tansy/blog/render";
import { NewsletterManager, SignupForm } from "@tansy/newsletter/render";
import { Menu, Pager, pickWords, RichText, StreamField } from "tansy/react";
import { defineThemeComponents, type LayoutProps, type SiteList, type SiteRecord, type TemplateProps } from "tansy/theme";
import type { DispatchOptions } from "./index";
import "./theme.css";

// Served from the site's own origin, as font-src 'self' requires.
const font = localFont({ src: "./fonts/GeistVF.woff", variable: "--dispatch-font", weight: "100 900" });

type Props = TemplateProps<DispatchOptions>;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const items = (list: SiteList | undefined) => list?.items ?? [];
const hasDoc = (value: unknown) => value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);

/**
 * The theme's words, under `dispatch`. Owners can change any of them per language under
 * Languages → Site text. The forms' own words, such as `newsletter.subscribe`, come from the
 * newsletter plugin, and the blog's, such as `blog.minutes`, from the blog plugin.
 */
const messages = {
  en: {
    dispatch: {
      kicker: "Newsletter",
      intro: "Essays and notes, sent when there's something worth reading. Free, and one click to leave.",
      signupTitle: "Get every issue by email",
      signupText: "Join the list and the next one lands in your inbox.",
      endTitle: "Enjoyed this issue?",
      endText: "Subscribe and get the next one by email.",
      issues: "Issues",
      issue: "Issue {number}",
      pageOf: "Issues, page {page}",
      noIssues: "No issues yet. Subscribe and you'll get the first one.",
      noIssuesHere: "No issues here yet.",
      newer: "Newer issues",
      older: "Older issues",
      keepReading: "More issues",
      allIssues: "All issues",
      subscribe: "Subscribe",
      menu: "Main",
      language: "Language",
      skip: "Skip to content",
      rights: "All rights reserved.",
    },
  },
  ar: {
    dispatch: {
      kicker: "النشرة",
      intro: "مقالات وملاحظات تُرسل حين يكون هناك ما يستحق القراءة. مجانًا، ونقرة واحدة للمغادرة.",
      signupTitle: "تصلك كل الأعداد بالبريد",
      signupText: "انضم إلى القائمة ويصلك العدد القادم في بريدك.",
      endTitle: "أعجبك هذا العدد؟",
      endText: "اشترك ويصلك العدد القادم بالبريد.",
      issues: "الأعداد",
      issue: "العدد {number}",
      pageOf: "الأعداد، الصفحة {page}",
      noIssues: "لا توجد أعداد بعد. اشترك ليصلك أولها.",
      noIssuesHere: "لا توجد أعداد هنا بعد.",
      newer: "أعداد أحدث",
      older: "أعداد أقدم",
      keepReading: "أعداد أخرى",
      allIssues: "كل الأعداد",
      subscribe: "اشترك",
      menu: "القائمة الرئيسية",
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

/** The newsletter plugin's words, for its client parts. */
const formWords = (props: Pick<Props, "words">) => (props.words ? pickWords(props.words, "newsletter") : undefined);

/** The newsletter's own page, where people sign up, confirm and unsubscribe: from its URL pattern, or the plugin's default address. */
const newsletterHref = (props: Pick<Props, "data" | "language">) => hrefOf(items(props.data.newsletter)[0], props) ?? inLanguage(props, "/newsletter");

/* ------------------------------------------------------------------ layout */

/** The same page in each language it's published in. */
function LanguageSwitcher({ language, t }: Pick<Props, "language" | "t">) {
  if (!language) return null;
  const available = language.locales.filter((locale) => language.alternates[locale.code]);
  if (available.length < 2) return null;
  return (
    <nav className="dp-languages" aria-label={t("dispatch.language")}>
      {available.map((locale) => (
        <a key={locale.code} href={language.alternates[locale.code]} hrefLang={locale.code} lang={locale.code} aria-current={locale.code === language.locale ? "true" : undefined}>{locale.label}</a>
      ))}
    </nav>
  );
}

function Brand({ branding, language }: Pick<Props, "branding" | "language">) {
  return (
    <Link className="dp-brand" href={inLanguage({ language }, "/")} prefetch={false}>
      {/* eslint-disable-next-line @next/next/no-img-element -- the logo from Settings, a site path or data image */}
      {branding.logoUrl ? <img src={branding.logoUrl} alt="" width={28} height={28} /> : <span className="dp-brand-mark" aria-hidden="true">{branding.name.slice(0, 1)}</span>}
      <span>{branding.name}</span>
    </Link>
  );
}

function Layout(props: LayoutProps<DispatchOptions>) {
  const { branding, globals, options, children, language, t, path } = props;
  const menu = globals["site-menu"]?.items;
  const subscribe = newsletterHref(props);
  return (
    <div className="dp-shell" data-scheme={options.colorScheme}>
      <a className="dp-skip" href="#dp-content">{t("dispatch.skip")}</a>
      <header className="dp-header">
        <div className="dp-header-inner">
          <Brand branding={branding} language={language} />
          <nav className="dp-nav" aria-label={t("dispatch.menu")}><Menu items={menu} /></nav>
          <div className="dp-header-end">
            <LanguageSwitcher language={language} t={t} />
            {/* Not on the newsletter's own page, which is all about subscribing. */}
            {props.collection !== "newsletter-page" && <a className="dp-button" href={subscribe} aria-current={subscribe === path ? "page" : undefined}>{t("dispatch.subscribe")}</a>}
          </div>
        </div>
      </header>
      <div id="dp-content" className="dp-content">{children}</div>
      <footer className="dp-footer">
        <div className="dp-footer-inner">
          <div>
            <Brand branding={branding} language={language} />
            {options.tagline && <p className="dp-footer-tagline">{options.tagline}</p>}
          </div>
          <nav className="dp-footer-nav" aria-label={t("dispatch.menu")}><Menu items={menu} /></nav>
          <p className="dp-footer-legal">© {new Date().getFullYear()} {branding.name}. {t("dispatch.rights")}</p>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------- parts */

/** The newsletter plugin's sign-up form, in the theme's card. */
function Signup({ props, title, body, variant = "card" }: { props: Props; title: string; body: string; variant?: "card" | "hero" }) {
  return (
    <div className={variant === "hero" ? "dp-signup dp-signup-hero" : "dp-signup"}>
      <SignupForm title={title} text={body} askName={props.options.askName} words={formWords(props)} />
    </div>
  );
}

function Published({ value, props }: { value: unknown; props: Pick<Props, "options" | "formatDate"> }) {
  const date = text(value);
  if (!props.options.showDates || !date) return null;
  return <time dateTime={date}>{props.formatDate(date, "long")}</time>;
}

/**
 * Issues newest first, each numbered: the newest is the highest, counted from the list's total,
 * so numbers stay put from page to page.
 */
function IssueList({ list, props, empty, numbered = true }: { list: SiteList | undefined; props: Props; empty: string; numbered?: boolean }) {
  const posts = items(list);
  if (!posts.length) return <p className="dp-empty">{empty}</p>;
  const first = list ? list.totalItems - (list.page - 1) * list.perPage : 0;
  return (
    <ol className="dp-issues">
      {posts.map((post, index) => {
        const href = hrefOf(post, props);
        const minutes = typeof post.readingMinutes === "number" ? post.readingMinutes : null;
        const number = first - index;
        return (
          <li key={post.id} lang={typeof post.locale === "string" ? post.locale : undefined}>
            <article className="dp-issue">
              {numbered && number > 0 && <p className="dp-issue-number">{props.t("dispatch.issue", { number })}</p>}
              <h3 className="dp-issue-title">{href ? <a className="dp-issue-link" href={href}>{text(post.title)}</a> : text(post.title)}</h3>
              {text(post.excerpt) && <p className="dp-issue-excerpt">{text(post.excerpt)}</p>}
              {(props.options.showDates || minutes !== null) && (
                <p className="dp-issue-meta">
                  <Published value={post.publishedAt} props={props} />
                  {props.options.showDates && text(post.publishedAt) && minutes !== null && <span aria-hidden="true"> · </span>}
                  {minutes !== null && props.t("blog.minutes", { count: minutes })}
                </p>
              )}
            </article>
          </li>
        );
      })}
    </ol>
  );
}

/* --------------------------------------------------------------- templates */

/**
 * The front page, at the site's root and at the blog's address: the masthead with the sign-up
 * form, then the issues. On the blog's address, its title and introduction come from the Blog
 * home record.
 */
function Front(props: Props) {
  const { record, data, options, path, t, words, stream, branding } = props;
  const firstPage = (data.posts?.page ?? 1) === 1;
  return (
    <main>
      {firstPage ? (
        <header className="dp-masthead">
          <p className="dp-kicker">{t("dispatch.kicker")}</p>
          <h1>{text(record?.title) || branding.name}</h1>
          {Array.isArray(record?.intro) && record.intro.length > 0
            ? <div className="dp-lead"><StreamField blocks={record.intro} {...stream} /></div>
            : <p className="dp-lead">{options.tagline || t("dispatch.intro")}</p>}
          <Signup props={props} title={t("dispatch.signupTitle")} body={t("dispatch.signupText")} variant="hero" />
        </header>
      ) : null}
      <section className="dp-section" aria-labelledby="dp-issues">
        <h2 id="dp-issues" className="dp-section-title">{firstPage ? t("dispatch.issues") : t("dispatch.pageOf", { page: data.posts?.page ?? 1 })}</h2>
        <IssueList list={data.posts} props={props} empty={t("dispatch.noIssues")} />
        <Pager list={data.posts} path={path} previous={t("dispatch.newer")} next={t("dispatch.older")} className="dp-pager" words={words} />
      </section>
    </main>
  );
}

/**
 * An issue. Meta, tags, more posts and comments are the blog plugin's parts, fed its lists
 * through `data`; the form at the end is the newsletter plugin's.
 */
function Issue(props: Props) {
  const { record, data, stream, fileUrl, fileText, t, words, options, language } = props;
  if (!record) return null;
  const cover = text(record.cover);
  return (
    <main>
      <article className="dp-article">
        <header className="dp-article-head">
          <p className="dp-kicker"><a href={inLanguage({ language }, "/")}>{t("dispatch.allIssues")}</a></p>
          <h1>{text(record.title)}</h1>
          {text(record.excerpt) && <p className="dp-lead">{text(record.excerpt)}</p>}
          {options.showDates && <PostMeta post={record} data={data} words={words} />}
        </header>
        {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked API address that redirects to a signed URL, which next/image can't optimize */}
        {cover && <figure className="dp-article-cover"><img src={fileUrl(cover, "800x0")} alt={fileText(cover).alt} /></figure>}
        <div className="dp-prose">
          <StreamField blocks={record.body} {...stream} />
          <PostTags post={record} data={data} words={words} />
        </div>
      </article>
      <div className="dp-article-end">
        <Signup props={props} title={t("dispatch.endTitle")} body={t("dispatch.endText")} />
        <div className="dp-more"><MorePosts post={record} data={data} words={words} heading={t("dispatch.keepReading")} /></div>
        <div className="dp-comments"><PostComments post={record} data={data} words={words} /></div>
      </div>
    </main>
  );
}

/** A category's or a tag's issues. */
function Archive({ heading, ...props }: Props & { heading: string }) {
  const { record, data, path, t, words } = props;
  if (!record) return null;
  return (
    <main>
      <header className="dp-masthead dp-masthead-compact">
        <p className="dp-kicker">{heading}</p>
        <h1>{text(record.name)}</h1>
        {text(record.description) && <p className="dp-lead">{text(record.description)}</p>}
        {hasDoc(record.bio) && <div className="dp-lead"><RichText doc={record.bio} /></div>}
      </header>
      <section className="dp-section" aria-label={text(record.name)}>
        <IssueList list={data.posts} props={props} empty={t("dispatch.noIssuesHere")} numbered={false} />
        <Pager list={data.posts} path={path} previous={t("dispatch.newer")} next={t("dispatch.older")} className="dp-pager" words={words} />
      </section>
    </main>
  );
}

const Category = (props: Props) => <Archive {...props} heading={props.t("blog.category")} />;
const Tag = (props: Props) => <Archive {...props} heading={props.t("blog.tag")} />;

/**
 * The newsletter's own page, where its emails link: sign up, or confirm an address or
 * unsubscribe. The part that does it is the newsletter plugin's.
 */
function NewsletterPage(props: Props) {
  const { record, t, options } = props;
  return (
    <main>
      <header className="dp-masthead dp-masthead-compact">
        <p className="dp-kicker">{t("dispatch.kicker")}</p>
        <h1>{text(record?.title) || t("dispatch.signupTitle")}</h1>
        {hasDoc(record?.intro) ? <div className="dp-lead"><RichText doc={record!.intro} /></div> : <p className="dp-lead">{options.tagline || t("dispatch.intro")}</p>}
        <div className="dp-signup dp-signup-hero">
          <NewsletterManager words={formWords(props)} signup={{ askName: options.askName }} />
        </div>
      </header>
    </main>
  );
}

/** Any other page, such as About. */
function Page({ record, stream }: Props) {
  if (!record) return null;
  return (
    <main>
      <article className="dp-article">
        <header className="dp-article-head"><h1>{text(record.title)}</h1></header>
        <div className="dp-prose"><StreamField blocks={record.body} {...stream} /></div>
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

export default defineThemeComponents<DispatchOptions>({
  // Blocks come from the plugins and are restyled in theme.css.
  templates: {
    home: Front,
    "blog-home": Front,
    "blog-posts": Issue,
    "blog-categories": Category,
    "blog-tags": Tag,
    "newsletter-page": NewsletterPage,
    default: Page,
  },
  layouts: { default: Layout },
  metadata,
  fontClassName: font.variable,
  messages,
});
