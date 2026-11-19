import { adminPath, defineAdminPlugin, PageHeader, TabLinks, type AdminPageProps } from "tansy/admin";
import { getT } from "tansy/server";
import { AnalyticsReportView, AnalyticsWidget } from "./dashboard";

/** Three rising bars, in the navigation's 16 by 16 box. */
const ICON = {
  paths: ["M2 13.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75ZM3 9.5A1 1 0 0 1 4 8.5h1a1 1 0 0 1 1 1v1.5H3V9.5Zm3.5-3A1 1 0 0 1 7.5 5.5h1a1 1 0 0 1 1 1V11h-3V6.5ZM10 3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v8h-3V3Z"],
};

async function Analytics({ user }: AdminPageProps) {
  const { t } = await getT(user.id);
  const word = (key: string) => t(`ext.analytics.${key}`);
  const canSet = user.permissions.includes("setting:update");
  return (
    <div className="cms-gutter">
      <PageHeader title={word("pages.analytics")} description={word("description")} />
      {canSet && (
        <TabLinks label={word("pages.analytics")} links={[
          { href: adminPath("/ext/analytics"), label: word("pages.analytics"), active: true },
          { href: adminPath("/extensions/analytics/settings"), label: word("tabs.settings") },
        ]} />
      )}
      <AnalyticsReportView />
    </div>
  );
}

export default defineAdminPlugin({
  pages: [{ path: "analytics", title: "Analytics", permission: "ext.analytics:read", component: Analytics }],
  widgets: [{ id: "analytics-overview", title: "Visitors", permission: "ext.analytics:read", component: AnalyticsWidget }],
  section: { title: "Analytics", icon: ICON, items: [{ page: "analytics" }, { settings: true }] },
});
