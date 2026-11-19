import { requirePage } from "../../../../core/authz/page";
import type ClientType from "./page.client";
import { clientPage } from "../../../../routes/client-page";

const Client = clientPage<typeof ClientType>("collections/create");

export default async function Page() {
  const principal = await requirePage("collection:create");
  return <Client canCreateView={principal.permissions.has("collection:manage-views")} />;
}
