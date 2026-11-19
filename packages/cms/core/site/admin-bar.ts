import "server-only";
import { getSessionCookie } from "better-auth/cookies";
import { headers } from "next/headers";
import prisma from "../../lib/prisma";
import { adminPath } from "../../lib/paths";
import { getRuntime } from "../auth/instance";
import { holdsRecordPermissionForSome } from "../authz/permissions";
import { principalFromSession } from "../authz/principal";
import { adminDirection, adminLocale, adminMessages } from "../i18n/admin";
import { formatters } from "../i18n/messages";

export interface SiteAdminBar {
  dashboard: { href: string; label: string };
  edit?: { href: string; label: string };
  direction: "ltr" | "rtl";
}

/**
 * The bar a signed-in person with dashboard access sees on the site: a way back to the dashboard,
 * and to edit the record on screen when they may. Only links: the page itself is still read as a
 * visitor. Visitors without a session cookie cost nothing, since the session is only looked up
 * when one is there.
 */
export async function siteAdminBar(page: { collection: string | null; recordId: number | null }): Promise<SiteAdminBar | null> {
  const requestHeaders = await headers();
  if (!getSessionCookie(requestHeaders)) return null;
  const principal = await principalFromSession(requestHeaders, await getRuntime());
  if (principal.kind !== "user" || !principal.permissions.has("dashboard:access")) return null;
  const locale = await adminLocale(principal.user.id);
  const { t } = formatters(locale, adminMessages(locale));
  const bar: SiteAdminBar = { dashboard: { href: adminPath(), label: t("siteBar.dashboard") }, direction: adminDirection(locale) };
  if (page.collection && page.recordId !== null) {
    const collection = await prisma.collection.findUnique({ where: { slug: page.collection }, select: { id: true } });
    if (collection && principal.permissions.has("collection:read") && holdsRecordPermissionForSome(principal.permissions, "record:update", collection.id)) {
      bar.edit = { href: adminPath(`/collections/${collection.id}/content/${page.recordId}`), label: t("siteBar.edit") };
    }
  }
  return bar;
}
