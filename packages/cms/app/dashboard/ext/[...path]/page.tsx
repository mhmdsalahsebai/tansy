import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { accountPath } from "../../../../lib/paths";
import { canListCollection, findAdminPage } from "../../../../core/extend/admin-nav";
import { requirePage } from "../../../../core/authz/page";
import { scopedRecords } from "../../../../core/extend/records";
import { clientPage } from "../../../../routes/client-page";
import type PluginSlotType from "./page.client";

// Keeps a broken plugin page from taking the shell down.
const PluginSlot = clientPage<typeof PluginSlotType>("ext/[...path]");

export default async function Page({ params }: { params: Promise<{ path: string[] }> }) {
  // Signed-in first, so a visitor can't tell which plugin pages exist.
  await requirePage();
  const path = (await params).path.join("/");
  const page = findAdminPage(path);
  if (!page) notFound();
  const principal = await requirePage(...(page.permission ? [page.permission] : []));
  if (page.collection && !(await canListCollection(principal.permissions, page.collection))) redirect(accountPath("?denied=1"));
  const Component = page.component;
  return <PluginSlot plugin={page.plugin}><Component records={scopedRecords(principal, await headers())} user={{ id: principal.user.id, email: principal.user.email, permissions: [...principal.permissions] }} params={page.params} /></PluginSlot>;
}
