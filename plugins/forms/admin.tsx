import { Badge, defineAdminPlugin, PageHeader, type AdminPageProps } from "tansy/admin";
import { getT } from "tansy/server";
import { FORMS, SUBMISSIONS } from "./schema";
import { SetupStatus } from "./status";

/** An envelope with a pencil's line, in the navigation's 16 by 16 box. */
const FORM_ICON = {
  paths: ["M3 1.5A1.5 1.5 0 0 0 1.5 3v10A1.5 1.5 0 0 0 3 14.5h10a1.5 1.5 0 0 0 1.5-1.5V3A1.5 1.5 0 0 0 13 1.5H3Zm0 1.5h10v10H3V3Zm1.5 1.75a.75.75 0 0 0 0 1.5h7a.75.75 0 0 0 0-1.5h-7Zm0 3a.75.75 0 0 0 0 1.5h7a.75.75 0 0 0 0-1.5h-7Zm0 3a.75.75 0 0 0 0 1.5h4a.75.75 0 0 0 0-1.5h-4Z"],
  fillRule: "evenodd" as const,
};

/** As the signed-in person: someone who can't read submissions sees no counts rather than someone else's. */
async function newCount(records: AdminPageProps["records"], form: number) {
  try {
    return (await records.list(SUBMISSIONS, { filter: `form = ${form} && state = "new"`, perPage: 1, fields: "id" })).totalItems;
  } catch {
    return null;
  }
}

async function Overview({ records, user }: AdminPageProps) {
  const { t } = await getT(user.id);
  const forms = await records.list(FORMS, { perPage: 200, sort: "title", fields: "id,title,status" }).then((list) => list.items).catch(() => null);
  const counts = forms ? await Promise.all(forms.map((form) => newCount(records, form.id as number))) : [];
  return (
    <div className="cms-gutter">
      <PageHeader title={t("ext.forms.pages.forms")} description={t("ext.forms.overview.description")} />
      <SetupStatus />
      {!forms ? <p className="cms-empty">{t("ext.forms.overview.cantRead")}</p>
        : !forms.length ? <p className="cms-empty">{t("ext.forms.overview.empty")}</p>
          : (
            <ul className="cms-panel cms-feed">
              {forms.map((form, index) => (
                <li key={String(form.id)} className="cms-feed-row">
                  <span className="cms-feed-main"><span className="cms-feed-title">{String(form.title ?? "")}</span></span>
                  {form.status !== "published" && <Badge tone="warning">{t("ext.forms.overview.draft")}</Badge>}
                  {counts[index] !== null && <Badge tone={counts[index] ? "success" : "info"}>{t("ext.forms.overview.new", { count: counts[index] ?? 0 })}</Badge>}
                </li>
              ))}
            </ul>
          )}
    </div>
  );
}

export default defineAdminPlugin({
  // Only for people who may list the forms: the page shows nothing to anyone else.
  pages: [{ path: "forms", title: "Overview", permission: "dashboard:access", collection: FORMS, component: Overview }],
  section: {
    title: "Forms",
    icon: FORM_ICON,
    items: [{ page: "forms" }, { collection: FORMS }, { collection: SUBMISSIONS }, { settings: true }],
  },
});
