import { adminPath, defineAdminPlugin, PageHeader, TabLinks, type AdminPageProps } from "tansy/admin";
import { getT } from "tansy/server";
import { CampaignList, NewsletterStatus, SubscriberList } from "./dashboard";

/** An open envelope, in the navigation's 16 by 16 box. */
const ICON = {
  paths: ["M1.5 4A1.5 1.5 0 0 1 3 2.5h10A1.5 1.5 0 0 1 14.5 4v8a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12V4Zm1.5.31V12h10V4.31L8.46 8.1a.75.75 0 0 1-.92 0L3 4.31ZM12.06 4H3.94L8 7.05 12.06 4Z"],
  fillRule: "evenodd" as const,
};

type View = "campaigns" | "subscribers";

/** Campaigns, subscribers and settings, on one page under one link, with a tab for each. */
async function Newsletter({ user, params }: AdminPageProps) {
  const { t } = await getT(user.id);
  const word = (key: string) => t(`ext.newsletter.${key}`);
  const view: View = params.view === "subscribers" ? "subscribers" : "campaigns";
  const holds = (permission: string) => user.permissions.includes(permission);
  const tabs = [
    { href: adminPath("/ext/newsletter"), label: word("tabs.campaigns"), active: view === "campaigns" },
    { href: adminPath("/ext/newsletter/subscribers"), label: word("tabs.subscribers"), active: view === "subscribers" },
    ...(holds("setting:update") ? [{ href: adminPath("/extensions/newsletter/settings"), label: word("tabs.settings"), active: false }] : []),
  ];
  return (
    <div className="cms-gutter">
      <PageHeader title={word("pages.newsletter")} description={word("description")} />
      <NewsletterStatus />
      <TabLinks label={word("pages.newsletter")} links={tabs} />
      {view === "campaigns" ? <CampaignList canSend={holds("ext.newsletter:send")} /> : <SubscriberList canManage={holds("ext.newsletter:manage")} />}
    </div>
  );
}

export default defineAdminPlugin({
  pages: [
    { path: "newsletter", title: "Newsletter", permission: "dashboard:access", component: Newsletter },
    // A tab of the same page. Pages with params stay out of the navigation, so the plugin keeps one link.
    { path: "newsletter/:view", title: "Newsletter", permission: "dashboard:access", component: Newsletter },
  ],
  section: { title: "Newsletter", icon: ICON, items: [{ page: "newsletter" }] },
});
