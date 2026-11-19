import { defineAdminPlugin, PageHeader, type AdminPageProps } from "tansy/admin";
import { getT } from "tansy/server";
import { ModerateButtons } from "./moderate";

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** As the signed-in person, so someone without access to a collection gets null rather than another person's view. */
async function count(records: AdminPageProps["records"], slug: string, filter: string) {
  return records.list(slug, { filter, perPage: 1, fields: "id" }).then((page) => page.totalItems).catch(() => null);
}

async function CommentQueue({ records, user }: AdminPageProps) {
  const { t } = await getT(user.id);
  const pending = await records.list("blog-comments", { filter: 'state = "pending"', sort: "createdAt", perPage: 100, expand: "post", fields: "id,name,body,createdAt,expand.post.title" }).catch(() => null);
  return (
    <div className="cms-gutter">
      <PageHeader title={t("ext.blog.pages.blog/comments")} description={t("ext.blog.queue.intro")} />
      {pending === null && <p className="cms-empty">{t("ext.blog.queue.cantRead")}</p>}
      {pending?.items.length === 0 && <p className="cms-empty">{t("ext.blog.queue.empty")}</p>}
      {pending && pending.items.length > 0 && (
        <ul className="cms-panel cms-divide">
          {pending.items.map((comment) => {
            const post = (comment.expand as { post?: { title?: unknown } } | undefined)?.post;
            return (
              <li key={String(comment.id)} className="cms-cell">
                <p className="cms-text-sm cms-faded cms-mb-1">{t("ext.blog.queue.on", { name: text(comment.name), post: text(post?.title) || t("ext.blog.queue.aPost") })}</p>
                <p className="cms-mb-2" style={{ whiteSpace: "pre-line" }}>{text(comment.body)}</p>
                <ModerateButtons id={Number(comment.id)} />
              </li>
            );
          })}
        </ul>
      )}
      {pending && pending.totalItems > pending.items.length && <p className="cms-muted cms-mt-4">{t("ext.blog.queue.showing", { shown: pending.items.length, total: pending.totalItems })}</p>}
    </div>
  );
}

async function Overview({ records, user }: AdminPageProps) {
  const { t } = await getT(user.id);
  const [pending, drafts, published] = await Promise.all([
    count(records, "blog-comments", 'state = "pending"'),
    count(records, "blog-posts", 'status = "draft"'),
    count(records, "blog-posts", 'status = "published"'),
  ]);
  const line = (value: number | null, key: "pending" | "drafts" | "published") => <li>{value === null ? t("ext.blog.overview.unknown", { label: t(`ext.blog.overview.${key}Label`) }) : t(`ext.blog.overview.${key}`, { count: value })}</li>;
  return <ul className="cms-muted cms-text-sm">{line(pending, "pending")}{line(drafts, "drafts")}{line(published, "published")}</ul>;
}

export default defineAdminPlugin({
  pages: [{ path: "blog/comments", title: "Comments to review", permission: "ext.blog:moderate", component: CommentQueue }],
  section: {
    title: "Blog",
    icon: "newspaper",
    items: [
      { collection: "blog-posts" },
      { collection: "blog-categories" },
      { collection: "blog-tags" },
      { page: "blog/comments" },
      { collection: "blog-comments", title: "All comments" },
      { collection: "blog-home", title: "Blog home page" },
      { settings: true },
    ],
  },
  widgets: [{ id: "blog-overview", title: "Blog", permission: "ext.blog:moderate", component: Overview }],
});
