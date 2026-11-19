import type { ReactNode } from "react";
import { adminPath, Badge, DataTable, defineAdminPlugin, PageHeader, type AdminPageProps } from "tansy/admin";
import { getT } from "tansy/server";
import { ACCESS, countByPlan, ENTITLEMENTS, PLANS } from "./logic";
import { AccessManager, MembersManager, PlansManager } from "./manage";

type Records = AdminPageProps["records"];
type Row = Record<string, unknown>;

const MANAGE = "ext.subscriptions:manage";

/** As the signed-in person, so someone who can't read a collection gets nothing rather than another person's view. */
async function rows(records: Records, slug: string, fields: string): Promise<Row[] | null> {
  try {
    const items: Row[] = [];
    for (let page = 1; page <= 20; page++) {
      const result = await records.list(slug, { fields, page, perPage: 200 });
      items.push(...result.items);
      if (page >= result.totalPages) break;
    }
    return items;
  } catch {
    return null;
  }
}

/** This plugin's words in the person's interface language. */
async function words(userId: string) {
  const { t } = await getT(userId);
  return (key: string, values?: Record<string, string | number>) => t(`ext.subscriptions.${key}`, values);
}

/** A sentence with one link in it, at `{link}`. */
function withLink(text: (values: Record<string, string>) => string, link: ReactNode) {
  const [before, after = ""] = text({ link: "\u0000" }).split("\u0000");
  return <>{before}{link}{after}</>;
}

const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is number => typeof id === "number") : []);
const link = (path: string) => adminPath(`/ext/subscriptions${path}`);

async function Overview({ records, user }: AdminPageProps) {
  const t = await words(user.id);
  const [plans, access, entitlements] = await Promise.all([
    rows(records, PLANS, "id,name,includes,status"),
    rows(records, ACCESS, "id,name,collections"),
    rows(records, ENTITLEMENTS, "user,plans"),
  ]);
  if (!plans || !access) {
    return <div className="cms-gutter"><PageHeader title={t("overview.title")} /><p className="cms-empty">{t("overview.cantRead")}</p></div>;
  }
  const counts = countByPlan(entitlements ?? []);
  const subscribers = (entitlements ?? []).filter((row) => Array.isArray(row.plans) && row.plans.length > 0).length;
  const accessName = new Map(access.map((item) => [item.id, String(item.name)]));
  const steps = [
    { done: access.length > 0, text: withLink((values) => t("overview.step1", values), <a className="cms-underline" href={link("/access")}>{t("overview.accessLink")}</a>) },
    { done: plans.some((plan) => ids(plan.includes).length > 0), text: withLink((values) => t("overview.step2", values), <a className="cms-underline" href={link("/plans")}>{t("overview.plansLink")}</a>) },
    { done: access.some((item) => Array.isArray(item.collections) && item.collections.length > 0), text: withLink((values) => t("overview.step3", values), <a className="cms-underline" href={link("/access")}>{t("overview.accessLink")}</a>) },
  ];
  return (
    <div className="cms-gutter">
      <PageHeader title={t("overview.title")} description={t("overview.description")} />
      <div className="cms-stat-strip cms-mb-6">
        <div><p className="cms-stat-label">{t("overview.stats.people")}</p><p className="cms-stat-value">{subscribers}</p></div>
        <div><p className="cms-stat-label">{t("overview.stats.plans")}</p><p className="cms-stat-value">{plans.filter((plan) => plan.status === "published").length}</p></div>
        <div><p className="cms-stat-label">{t("overview.stats.access")}</p><p className="cms-stat-value">{access.length}</p></div>
      </div>
      {steps.some((step) => !step.done) && (
        <>
          <h2 className="cms-section-title cms-mb-2">{t("overview.gettingStarted")}</h2>
          <ol className="cms-panel cms-feed cms-mb-6">
            {steps.map((step, index) => (
              <li key={index} className="cms-feed-row">
                <span className={step.done ? "cms-status cms-status-on" : "cms-status cms-status-off"} aria-hidden="true" />
                <span className={step.done ? "cms-feed-main cms-muted" : "cms-feed-main cms-text-sm cms-strong"}>{step.done && <span className="cms-sr-only">✓ </span>}{index + 1}. {step.text}</span>
              </li>
            ))}
          </ol>
        </>
      )}
      <div className="cms-mb-6">
        <DataTable
          label={t("overview.plans")}
          title={t("overview.plans")}
          columns={[{ id: "plan", label: t("columns.plan") }, { id: "opens", label: t("columns.opens") }, { id: "people", label: t("columns.people"), numeric: true }, { id: "onSale", label: t("columns.onSale") }]}
          rows={plans.map((plan) => ({
            id: String(plan.id),
            href: link("/plans"),
            cells: {
              plan: String(plan.name),
              opens: ids(plan.includes).map((id) => accessName.get(id) ?? `#${id}`).join(", ") || <span className="cms-muted">{t("common.nothingYet")}</span>,
              people: entitlements ? counts.get(String(plan.name)) ?? 0 : null,
              onSale: plan.status === "published" ? <Badge tone="success">{t("common.yes")}</Badge> : <Badge>{t("common.hidden")}</Badge>,
            },
          }))}
          empty={{ title: t("overview.noPlans") }}
        />
      </div>
      <p className="cms-muted cms-text-sm">{t("overview.payments")}</p>
    </div>
  );
}

const page = (title: string, description: string, body: ReactNode) => (
  <div className="cms-gutter">
    <PageHeader title={title} description={description} />
    {body}
  </div>
);

const Plans = async ({ user }: AdminPageProps) => { const t = await words(user.id); return page(t("pages.subscriptions/plans"), t("plans.description"), <PlansManager />); };
const Access = async ({ user }: AdminPageProps) => { const t = await words(user.id); return page(t("pages.subscriptions/access"), t("access.description"), <AccessManager />); };
const Members = async ({ user }: AdminPageProps) => { const t = await words(user.id); return page(t("pages.subscriptions/members"), t("members.description"), <MembersManager />); };

async function Widget({ records, user }: AdminPageProps) {
  const t = await words(user.id);
  const entitlements = await rows(records, ENTITLEMENTS, "plans");
  if (!entitlements) return <p className="cms-muted cms-text-sm">{t("overview.widgetCantRead")}</p>;
  const counts = [...countByPlan(entitlements)].sort((a, b) => b[1] - a[1]);
  if (!counts.length) return <p className="cms-muted cms-text-sm">{t("overview.widgetEmpty")}</p>;
  return <ul className="cms-muted cms-text-sm">{counts.map(([plan, count]) => <li key={plan}>{t("overview.widgetLine", { count, plan })}</li>)}</ul>;
}

/** A ticket, from Heroicons (MIT), drawn by the navigation like its own icons. */
const TICKET = {
  viewBox: "0 0 16 16",
  fillRule: "evenodd" as const,
  paths: ["M1 4.5A1.5 1.5 0 0 1 2.5 3h11A1.5 1.5 0 0 1 15 4.5v1.75a.75.75 0 0 1-.75.75 1 1 0 0 0 0 2 .75.75 0 0 1 .75.75v1.75a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 11.5V9.75A.75.75 0 0 1 1.75 9a1 1 0 0 0 0-2A.75.75 0 0 1 1 6.25V4.5Zm9.5.25a.75.75 0 0 1 .75.75v.5a.75.75 0 0 1-1.5 0v-.5a.75.75 0 0 1 .75-.75Zm.75 3.5a.75.75 0 0 0-1.5 0v.5a.75.75 0 0 0 1.5 0v-.5Zm-.75 2.5a.75.75 0 0 1 .75.75v.5a.75.75 0 0 1-1.5 0v-.5a.75.75 0 0 1 .75-.75Z"],
};

export default defineAdminPlugin({
  pages: [
    { path: "subscriptions", title: "Overview", permission: MANAGE, component: Overview },
    { path: "subscriptions/plans", title: "Plans", permission: MANAGE, component: Plans },
    { path: "subscriptions/access", title: "Access", permission: MANAGE, component: Access },
    { path: "subscriptions/members", title: "Members", permission: MANAGE, component: Members },
  ],
  section: {
    title: "Subscriptions",
    icon: TICKET,
    items: [
      { page: "subscriptions" },
      { page: "subscriptions/plans" },
      { page: "subscriptions/access" },
      { page: "subscriptions/members" },
    ],
  },
  widgets: [{ id: "subscriptions-plans", title: "Subscriptions", permission: MANAGE, component: Widget }],
});
