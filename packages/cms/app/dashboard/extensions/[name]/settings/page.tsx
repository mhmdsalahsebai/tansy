import { notFound } from "next/navigation";
import { requirePage } from "../../../../../core/authz/page";
import { getAdminConfig } from "../../../../../core/config";
import { settingsPermission } from "../../../../../core/extend/admin-nav";
import { dashboardPluginSettings, settingsFields } from "../../../../../core/extend/settings";
import { clientPage } from "../../../../../routes/client-page";
import { getT } from "../../../../../core/i18n/admin";
import { pluginWord } from "../../../../../core/i18n/messages";
import { withScope } from "../../../../../core/scope/context";
import { scopeLabelIn } from "../../../../../core/scope/label";
import type ClientType from "./page.client";

const Client = clientPage<typeof ClientType>("extensions/[name]/settings");

export default async function Page({ params }: { params: Promise<{ name: string }> }) {
  // Signed in first, so a visitor can't tell which plugins have settings.
  await requirePage();
  const { name } = await params;
  const permission = settingsPermission(name);
  const fields = settingsFields(name);
  if (!permission || !fields) notFound();
  const principal = await requirePage(permission);
  const section = getAdminConfig().plugins.find((plugin) => plugin.name === name)?.section?.title;
  const { t, locale } = await getT(principal.user.id);
  const title = section ? pluginWord(t, name, "section", section) : name;
  // Inside a scope value, such as a tenant, its own values for fields marked perScope show over the instance's.
  const { values, fromEnv } = await withScope(principal.scope ?? null, () => dashboardPluginSettings(name));
  const own = principal.scope ? fields.filter((field) => field.perScope === true).map((field) => field.name) : [];
  const scope = own.length ? (scopeLabelIn(t) ?? "").toLocaleLowerCase(locale) : null;
  return <Client plugin={name} title={title} fields={fields} initial={values} fromEnv={fromEnv} own={own} scope={scope} />;
}
