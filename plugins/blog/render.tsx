import { useId } from "react";
import { apiPath, defineRenderers, pickWords, Pager, sitePath, RichText, StreamField, type BlockProps, type SiteWords } from "tansy/react";
import type { SiteList, SiteRecord, TemplateProps } from "tansy/theme";
import { Comments, type CommentsHeadings, type PublicComment } from "./comments";
import { blogWords, siteMessages } from "./site-messages";
import { Heading } from "./heading";
import { embedUrl, type HeadingLevel } from "./text";
import "./blog.css";

const text = (value: unknown) => (typeof value === "string" ? value : "");
const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is number => typeof id === "number") : typeof value === "number" ? [value] : []);
const items = (list: SiteList | undefined) => list?.items ?? [];
const fileHref = (id: string, thumb?: "800x0") => apiPath(`/files/${encodeURIComponent(id)}${thumb ? `?thumb=${thumb}` : ""}`);

/** Records of a lookup list, by id, so links follow each collection's URL pattern. */
const byId = (list: SiteList | undefined) => new Map(items(list).map((record) => [record.id, record]));

/** A link to a record in the page's language. */
function Linked({ record, label, words }: { record: SiteRecord | undefined; label: unknown; words?: SiteWords }) {
  if (!record) return null;
  const href = text(record.recordPath) && sitePath(words, text(record.recordPath));
  return href ? <a href={href}>{text(label)}</a> : <span>{text(label)}</span>;
}

/**
 * The parts of the blog's pages, for a theme that designs its own. Give them the template's
 * `record`, `data` and `words`: a theme's template for a blog collection gets the same lists as the
 * plugin's own, so each part finds what it needs there.
 *
 *   import { PostMeta, MorePosts, PostComments } from "@tansy/blog/render";
 *
 * Parts carry no outer margin or border; the template places them. The plugin's own pages do
 * that inside `.bl-main`, so a theme that embeds a part gets only its inner spacing and styles
 * it with the part's `bl-` classes, each a single class it can override with one of its own.
 * Parts that title themselves take `heading` and `headingLevel`, so the theme sets the outline.
 */
type PartProps = { post: SiteRecord; data: TemplateProps["data"]; words?: SiteWords };

/** Byline, date and reading time. */
export function PostMeta({ post, words }: PartProps) {
  const { t, formatDate } = blogWords(words);
  const date = text(post.publishedAt);
  const minutes = typeof post.readingMinutes === "number" ? post.readingMinutes : null;
  const byline = text(post.byline);
  return (
    <p className="bl-meta">
      {byline && <><span className="bl-byline">{byline}</span><span aria-hidden> · </span></>}
      {date && <time dateTime={date}>{formatDate(date, "long")}</time>}
      {minutes !== null && <><span aria-hidden> · </span>{t("blog.minutes", { count: minutes })}</>}
    </p>
  );
}

/**
 * Posts as a list of titles, meta and excerpts, with featured posts marked.
 * `headingLevel` (2 to 6, default 2) is the level of each post's title.
 */
export function PostList({ posts, data, empty, words, headingLevel = 2 }: { posts: SiteRecord[]; data: TemplateProps["data"]; empty: string; words?: SiteWords; headingLevel?: HeadingLevel }) {
  if (!posts.length) return <p className="bl-muted">{empty}</p>;
  return (
    <ul className="bl-list">
      {posts.map((post) => (
        <li key={post.id} className={post.featured === true ? "bl-item bl-featured" : "bl-item"}>
          <Heading level={headingLevel} className="bl-item-title"><Linked record={post} label={post.title} words={words} /></Heading>
          <PostMeta post={post} data={data} words={words} />
          {text(post.excerpt) && <p>{text(post.excerpt)}</p>}
        </li>
      ))}
    </ul>
  );
}

/** The post's categories, as links. */
export function PostCategories({ post, data, words }: PartProps) {
  const categories = byId(data.categories);
  if (!ids(post.categories).length) return null;
  return <p className="bl-kicker">{ids(post.categories).map((id) => <Linked key={id} record={categories.get(id)} label={categories.get(id)?.name} words={words} />)}</p>;
}

/** The post's tags, as links. */
export function PostTags({ post, data, words }: PartProps) {
  const tags = byId(data.tags);
  if (!ids(post.tags).length) return null;
  return <ul className="bl-tags" aria-label={blogWords(words).t("blog.tags")}>{ids(post.tags).map((id) => <li key={id}><Linked record={tags.get(id)} label={tags.get(id)?.name} words={words} /></li>)}</ul>;
}

/** How a part that titles itself is titled. */
type Headed = {
  /** A string replaces the default heading; `false` shows none, and the section keeps the default as its `aria-label`. */
  heading?: string | false;
  /** The heading's level, 2 to 6, default 2. */
  headingLevel?: HeadingLevel;
};

/**
 * Up to three posts sharing a tag with this one, or the latest when none do, under "More posts"
 * or `heading`. Given a `headingLevel`, the post titles are one level below it; without one they
 * are h2, as they have always been.
 */
export function MorePosts({ post, data, words, heading, headingLevel }: PartProps & Headed) {
  const titleId = useId();
  const related = items(data.related);
  const more = (related.length ? related : items(data.recent)).filter((other) => other.id !== post.id).slice(0, 3);
  if (!more.length) return null;
  const fallback = blogWords(words).t("blog.morePosts");
  const title = heading ?? fallback;
  return (
    <section className="bl-more" {...(title === false ? { "aria-label": fallback } : { "aria-labelledby": titleId })}>
      {title !== false && <Heading level={headingLevel} id={titleId} className="bl-more-title">{title}</Heading>}
      <PostList posts={more} data={data} empty="" words={words} headingLevel={headingLevel ? (Math.min(6, headingLevel + 1) as HeadingLevel) : 2} />
    </section>
  );
}

/**
 * Approved comments and the form, unless the post has comments turned off. Shows replies one level deep.
 * `heading` replaces "Comments" or, as `false`, hides it while the section keeps "Comments" as its
 * `aria-label`; `formHeading` does the same for "Leave a comment"; `headingLevel` (2 to 6, default 2)
 * sets the section heading's level, with the form heading one below.
 */
export function PostComments({ post, data, words, heading, formHeading, headingLevel }: PartProps & CommentsHeadings) {
  if (post.allowComments === false) return null;
  return <Comments postId={post.id} initial={items(data.comments) as unknown as PublicComment[]} words={words ? pickWords(words, "blog") : undefined} heading={heading} formHeading={formHeading} headingLevel={headingLevel} />;
}

function Home({ record, data, stream, path, words, t }: TemplateProps) {
  const posts = items(data.posts);
  // Featured posts go first, keeping the newest-first order within each group.
  const ordered = [...posts.filter((post) => post.featured === true), ...posts.filter((post) => post.featured !== true)];
  return (
    <main className="bl-main">
      <h1>{text(record?.title) || t("blog.home")}</h1>
      {Array.isArray(record?.intro) && (data.posts?.page ?? 1) === 1 && <div className="bl-body"><StreamField blocks={record.intro} {...stream} /></div>}
      <PostList posts={ordered} data={data} empty={t("blog.noPosts")} words={words} />
      <Pager list={data.posts} path={path} previous={t("blog.newerPosts")} next={t("blog.olderPosts")} className="bl-pager" words={words} />
    </main>
  );
}

function Post({ record, data, stream, fileUrl, fileText, words }: TemplateProps) {
  if (!record) return null;
  return (
    <main className="bl-main">
      <article>
        <PostCategories post={record} data={data} words={words} />
        <h1>{text(record.title)}</h1>
        <PostMeta post={record} data={data} words={words} />
        {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked API address that redirects to a signed URL, which next/image can't optimize */}
        {text(record.cover) && <img className="bl-cover" src={fileUrl(text(record.cover), "800x0")} alt={fileText(text(record.cover)).alt} />}
        <div className="bl-body"><StreamField blocks={record.body} {...stream} /></div>
        <PostTags post={record} data={data} words={words} />
      </article>
      <MorePosts post={record} data={data} words={words} />
      <PostComments post={record} data={data} words={words} />
    </main>
  );
}

function Archive({ record, data, path, heading, words, t }: TemplateProps & { heading: string }) {
  if (!record) return null;
  return (
    <main className="bl-main">
      <p className="bl-kicker">{heading}</p>
      <h1>{text(record.name)}</h1>
      {text(record.description) && <p>{text(record.description)}</p>}
      {record.bio !== undefined && record.bio !== null && <div className="bl-body"><RichText doc={record.bio} /></div>}
      <PostList posts={items(data.posts)} data={data} empty={t("blog.noPostsHere")} words={words} />
      <Pager list={data.posts} path={path} previous={t("blog.newerPosts")} next={t("blog.olderPosts")} className="bl-pager" words={words} />
    </main>
  );
}

const Category = (props: TemplateProps) => <Archive {...props} heading={props.t("blog.category")} />;
const Tag = (props: TemplateProps) => <Archive {...props} heading={props.t("blog.tag")} />;

const TextBlock = ({ value }: BlockProps) => <RichText doc={value.body} />;

function Quote({ value }: BlockProps) {
  return (
    <blockquote className="bl-quote">
      <p>{text(value.text)}</p>
      {text(value.source) && <cite>{text(value.source)}</cite>}
    </blockquote>
  );
}

function Callout({ value }: BlockProps) {
  const tone = ["info", "tip", "warning"].includes(text(value.tone)) ? text(value.tone) : "info";
  return <aside className={`bl-callout bl-callout-${tone}`} role="note"><RichText doc={value.body} /></aside>;
}

function Image({ value }: BlockProps) {
  if (!text(value.image)) return null;
  return (
    <figure className="bl-figure">
      {/* eslint-disable-next-line @next/next/no-img-element -- as for the cover image */}
      <img src={fileHref(text(value.image), "800x0")} alt={text(value.alt)} loading="lazy" />
      {text(value.caption) && <figcaption>{text(value.caption)}</figcaption>}
    </figure>
  );
}

function Embed({ value, words }: BlockProps) {
  const url = text(value.url);
  const src = embedUrl(url);
  return (
    <figure className="bl-figure">
      {src
        ? <div className="bl-embed"><iframe src={src} title={text(value.caption) || blogWords(words).t("blog.video")} loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" /></div>
        : <a href={url.startsWith("https://") ? url : undefined} rel="noopener noreferrer">{url}</a>}
      {text(value.caption) && <figcaption>{text(value.caption)}</figcaption>}
    </figure>
  );
}

function Code({ value }: BlockProps) {
  const language = text(value.language).replace(/[^a-z0-9+#-]/gi, "");
  return <pre className="bl-code"><code data-language={language || undefined}>{text(value.code)}</code></pre>;
}

const LOOKUP = { perPage: 200, fields: "id,name", urls: "1" } as const;
const LISTED = { collection: "blog-posts", sort: "-publishedAt", fields: "id,title,excerpt,publishedAt,readingMinutes,byline,featured", urls: "1" } as const;
const PAGE = 20;

export default defineRenderers({
  messages: siteMessages,
  blocks: { blog_text: TextBlock, blog_quote: Quote, blog_callout: Callout, blog_image: Image, blog_embed: Embed, blog_code: Code },
  templates: { "blog-home": Home, "blog-posts": Post, "blog-categories": Category, "blog-tags": Tag },
  queries: {
    "blog-home": { posts: { ...LISTED, perPage: PAGE, paged: true } },
    "blog-posts": {
      related: { ...LISTED, filter: "tags ?= @record.tags && id != @record.id", perPage: 3 },
      recent: { ...LISTED, perPage: 4 },
      categories: { collection: "blog-categories", ...LOOKUP },
      tags: { collection: "blog-tags", ...LOOKUP },
      comments: { collection: "blog-comments", filter: "post = @record.id", sort: "createdAt", perPage: 200, fields: "id,name,body,parent,createdAt" },
    },
    "blog-categories": { posts: { ...LISTED, filter: "categories ?= @record.id", perPage: PAGE, paged: true } },
    "blog-tags": { posts: { ...LISTED, filter: "tags ?= @record.id", perPage: PAGE, paged: true } },
  },
});
