import { defineAdminPlugin, type AdminPageProps } from "tansy/admin";
import { AccountTenants, TenantDomains, TenantMembers, TenantsList } from "./pages";

/** Three buildings side by side, in the navigation's 16 by 16 box. */
const ICON = {
  paths: ["M1.75 14.5a.75.75 0 0 1 0-1.5H2V3.5A1.5 1.5 0 0 1 3.5 2h4A1.5 1.5 0 0 1 9 3.5V6h3.5A1.5 1.5 0 0 1 14 7.5V13h.25a.75.75 0 0 1 0 1.5H1.75ZM4 4.5v1h1.5v-1H4Zm0 3v1h1.5v-1H4Zm0 3v1h1.5v-1H4Zm6-2v1h1.5v-1H10Zm0 3v1h1.5v-1H10Z"],
};

function Tenants({ user }: AdminPageProps) {
  const can = (action: string) => user.permissions.includes(`ext.multi-tenant:${action}`);
  return <TenantsList canCreate={can("create")} canManage={can("read")} canUpdate={can("update")} canDelete={can("delete")} />;
}

function Members({ user }: AdminPageProps) {
  return <TenantMembers canRename={user.permissions.includes("ext.multi-tenant:update")} />;
}

export default defineAdminPlugin({
  pages: [
    // Everyone in the dashboard sees the tenants they can work in. The route lists only those.
    { path: "tenants", title: "Tenants", component: Tenants },
    // Within the current tenant: a tenant admin holds this there, staff through their instance roles.
    { path: "tenants/members", title: "Members", permission: "ext.multi-tenant:members", component: Members },
    // Instance staff only: a domain decides which tenant a host's visitors see.
    { path: "tenants/domains", title: "Domains", permission: "ext.multi-tenant:domains", component: TenantDomains },
  ],
  section: { title: "Tenants", icon: ICON, items: [{ page: "tenants" }, { page: "tenants/members" }, { page: "tenants/domains" }, { settings: true }] },
  switcher: { label: "Tenant", options: "/switcher", select: "/switcher" },
  accountPanels: [{ id: "tenants", component: AccountTenants }],
});
