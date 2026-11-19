import { adminPath, defineAdminPlugin, PageHeader, TabLinks, type AdminPageProps } from "tansy/admin";
import { getT } from "tansy/server";
import { RequestLogView } from "./view";

async function RequestLogs({ user }: AdminPageProps) {
  const { t } = await getT(user.id);
  const word = (key: string) => t(`ext.request-logs.${key}`);
  const canSet = user.permissions.includes("setting:update");
  return (
    <div className="cms-gutter">
      <PageHeader title={word("pages.request-logs")} description={word("description")} />
      {canSet && (
        <TabLinks label={word("pages.request-logs")} links={[
          { href: adminPath("/ext/request-logs"), label: word("tabs.logs"), active: true },
          { href: adminPath("/extensions/request-logs/settings"), label: word("tabs.settings") },
        ]} />
      )}
      <RequestLogView />
    </div>
  );
}

export default defineAdminPlugin({
  pages: [{ path: "request-logs", title: "Request logs", permission: "ext.request-logs:read", component: RequestLogs }],
  section: { title: "Request logs", icon: "logs", items: [{ page: "request-logs" }, { settings: true }] },
});
