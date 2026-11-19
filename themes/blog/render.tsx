import localFont from "next/font/local";
import Link from "next/link";
import { MorePosts, PostCategories, PostComments, PostMeta, PostTags } from "@tansy/blog/render";
import { Menu, Pager, RichText, StreamField, type BlockProps } from "tansy/react";
import { defineThemeComponents, type LayoutProps, type SiteRecord, type TemplateProps } from "tansy/theme";
import type { BlogOptions } from "./index";
import "./theme.css";

// Served from the site's own origin, as font-src 'self' requires.
const font = localFont({ src: "./fonts/GeistVF.woff", variable: "--blog-font", weight: "100 900" });

type Props = TemplateProps<BlogOptions>;

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The theme's words. Owners can change any of them per language under Languages → Site text. */
const messages = {
  en: {
    noPosts: "No posts yet.",
    newerPosts: "Newer posts",
    olderPosts: "Older posts",
    keepReading: "Keep reading",
    language: "Language",
    menu: "Main",
  },
  ar: {
    noPosts: "لا توجد مقالات بعد.",
    newerPosts: "مقالات أحدث",
    olderPosts: "مقالات أقدم",
    keepReading: "تابع القراءة",
    language: "اللغة",
    menu: "القائمة الرئيسية",
  },
};

/** An address in the page's language: "/blog" is "/ar/blog" on an Arabic page. */
const inLanguage = (props: Pick<Props, "language">, path: string) => props.language?.href(path) ?? path;

function PublishedOn({ value, show, formatDate }: { value: unknown; show: boolean; formatDate: Props["formatDate"] }) {
  const date = text(value);
  if (!show || !date) return null;
  return <time className="blog-meta" dateTime={date}>{formatDate(date, "long")}</time>;
}

/** The same page in each language it's published in. */
function LanguageSwitcher({ language, t }: Pick<Props, "language" | "t">) {
  if (!language) return null;
  return (
    <nav className="blog-languages" aria-label={t("language")}>
      {language.locales.filter((locale) => language.alternates[locale.code]).map((locale) => (
        <a key={locale.code} href={language.alternates[locale.code]} hrefLang={locale.code} lang={locale.code} aria-current={locale.code === language.locale ? "true" : undefined}>{locale.label}</a>
      ))}
    </nav>
  );
}

function Layout({ branding, globals, options, children, language, t }: LayoutProps<BlogOptions>) {
  return (
    <div className="blog-shell">
      <header className="blog-header">
        <div>
          <Link className="blog-brand" href={inLanguage({ language }, "/")} prefetch={false}>{branding.name}</Link>
          {options.tagline && <p className="blog-tagline">{options.tagline}</p>}
        </div>
        <nav className="blog-nav" aria-label={t("menu")}><Menu items={globals["site-menu"]?.items} /></nav>
        <LanguageSwitcher language={language} t={t} />
      </header>
      {children}
      <footer className="blog-footer">{branding.name}</footer>
    </div>
  );
}

/** From the posts collection's URL pattern, so it follows whatever the owner sets, in the page's language. */
const postHref = (post: SiteRecord, props: Pick<Props, "language">) => (text(post.recordPath) ? inLanguage(props, text(post.recordPath)) : undefined);

function Home(props: Props) {
  const { data, options, path, t, formatDate, words } = props;
  const posts = data.posts?.items ?? [];
  return (
    <main className="blog-main">
      {posts.length === 0 && <p>{t("noPosts")}</p>}
      <ul className="blog-post-list">
        {posts.map((post) => (
          <li key={post.id} lang={typeof post.locale === "string" ? post.locale : undefined}>
            <h2>{postHref(post, props) ? <Link href={postHref(post, props)!} prefetch={false}>{text(post.title)}</Link> : text(post.title)}</h2>
            <PublishedOn value={post.publishedAt} show={options.showDates} formatDate={formatDate} />
            {text(post.excerpt) && <p>{text(post.excerpt)}</p>}
          </li>
        ))}
      </ul>
      <Pager list={data.posts} path={path} previous={t("newerPosts")} next={t("olderPosts")} className="blog-pager" words={words} />
    </main>
  );
}

/**
 * The theme's own post page, built from the blog plugin's parts. It gets the plugin's lists
 * as `data`, so the parts that link categories and tags, suggest posts and take comments
 * work here as they do on the plugin's page.
 */
function Post({ record, data, stream, options, fileUrl, fileText, t, words }: Props) {
  if (!record) return null;
  return (
    <main className="blog-main">
      <article>
        <PostCategories post={record} data={data} words={words} />
        <h1>{text(record.title)}</h1>
        {options.showDates && <PostMeta post={record} data={data} words={words} />}
        {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked API address that redirects to a signed URL, which next/image can't optimize */}
        {text(record.cover) && <img className="blog-cover" src={fileUrl(text(record.cover), "800x0")} alt={fileText(text(record.cover)).alt} />}
        <div className="blog-body"><StreamField blocks={record.body} {...stream} /></div>
        <PostTags post={record} data={data} words={words} />
      </article>
      <MorePosts post={record} data={data} words={words} heading={t("keepReading")} />
      <PostComments post={record} data={data} words={words} />
    </main>
  );
}

function Page({ record, stream }: Props) {
  if (!record) return null;
  return (
    <main className="blog-main">
      <h1>{text(record.title)}</h1>
      <div className="blog-body"><StreamField blocks={record.body} {...stream} /></div>
    </main>
  );
}

const TextBlock = ({ value }: BlockProps) => <RichText doc={value.body} />;

function Quote({ value }: BlockProps) {
  return (
    <blockquote className="blog-quote">
      <p>{text(value.text)}</p>
      {text(value.source) && <cite>{text(value.source)}</cite>}
    </blockquote>
  );
}

export default defineThemeComponents<BlogOptions>({
  blocks: { blog_text: TextBlock, blog_quote: Quote },
  // Archives and the blog's front page use the blog plugin's templates, inside this layout.
  templates: { home: Home, "blog-posts": Post, default: Page },
  layouts: { default: Layout },
  fontClassName: font.variable,
  messages,
});
