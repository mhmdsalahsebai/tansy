import { defineAdminPlugin, type AdminPageProps } from "tansy/admin";

const collections = () => (process.env.TANSY_EXAMPLE_SEO_COLLECTIONS ?? "posts").split(",");

async function counts({ records }: AdminPageProps) {
  return Promise.all(collections().map(async (slug) => {
    const missing = await records.list(slug, { filter: 'seo_title = ""', perPage: 1 }).then((page) => page.totalItems).catch(() => null);
    return { slug, missing };
  }));
}

async function SeoDashboard(props: AdminPageProps) {
  const rows = await counts(props);
  return (
    <div className="cms-p-6">
      <h1 className="cms-page-title cms-mb-4">SEO</h1>
      <ul className="cms-panel cms-divide cms-text-sm">
        {rows.map(({ slug, missing }) => <li key={slug} className="cms-cell cms-flex cms-between"><span className="cms-mono cms-body">{slug}</span><span className="cms-faded">{missing === null ? "Not available" : `${missing} without an SEO title`}</span></li>)}
      </ul>
    </div>
  );
}

async function SeoWidget(props: AdminPageProps) {
  const total = (await counts(props)).reduce((sum, { missing }) => sum + (missing ?? 0), 0);
  return <p className="cms-muted">{total} records without an SEO title.</p>;
}

export default defineAdminPlugin({
  pages: [{ path: "seo", title: "SEO", permission: "ext.seo:read", component: SeoDashboard }],
  widgets: [{ id: "seo-missing", title: "SEO", permission: "ext.seo:read", component: SeoWidget }],
});
