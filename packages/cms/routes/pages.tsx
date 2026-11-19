import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import DashboardLayout from "../app/dashboard/layout";
import type { CmsConfig } from "../core/auth/extensions";
import { requirePage } from "../core/authz/page";
import { provideAdminConfig, provideCmsConfig } from "../core/config";
import type { AdminConfig } from "../core/extend/admin";
import { createMatcher, type RouteParams } from "./match";
import { dashboardPages } from "./pages-table.generated";

/** The default export of the dashboard's loading.tsx: a skeleton shaped like the page being opened. */
export { DashboardLoading } from "../components/shell/DashboardLoading";

type PageProps = { params: Promise<{ cms?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
type TablePage = (props: { params: Promise<RouteParams>; searchParams: PageProps["searchParams"] }) => ReactNode | Promise<ReactNode>;

const match = createMatcher(dashboardPages);

/** Refuses maps that don't match the running config, instead of dropping a plugin's pages. Only plugins this server runs count, and only ones with an admin half. */
export function assertMapsMatch(config: CmsConfig, admin: AdminConfig) {
  for (const plugin of config.plugins ?? []) {
    if (!plugin.admin) continue;
    const synced = admin.synced.find(({ name }) => name === plugin.name);
    if (synced?.version !== plugin.version) throw new Error(`Plugin "${plugin.name}" ${plugin.version} isn't in the admin maps${synced ? `, which have ${synced.version}` : ""}. Run tansy sync and rebuild.`);
  }
}

function provide(config: CmsConfig, admin: AdminConfig) {
  assertMapsMatch(config, admin);
  provideCmsConfig(config);
  const enabled = new Set((config.plugins ?? []).map(({ name }) => name));
  provideAdminConfig({ ...admin, plugins: admin.plugins.filter(({ name }) => enabled.has(name)) });
}

export function createDashboardLayout(config: CmsConfig, admin: AdminConfig) {
  provide(config, admin);
  return DashboardLayout;
}

/** Serves every dashboard page from one catch-all file. It grants nothing: each page still calls requirePage itself. */
export function createDashboardPage(config: CmsConfig, admin: AdminConfig) {
  provide(config, admin);
  return async function DashboardCatchAll({ params, searchParams }: PageProps) {
    const found = match((await params).cms ?? []);
    if (!found) {
      // Signed-in first, so a visitor can't tell which addresses exist.
      await requirePage();
      notFound();
    }
    const Page = (await found.entry.load()).default as TablePage;
    return <Page params={Promise.resolve(found.params)} searchParams={searchParams} />;
  };
}
