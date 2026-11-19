import { requirePage } from "../../../core/authz/page";
import { getT } from "../../../core/i18n/admin";
import { collectionOwners } from "../../../core/extend/admin-nav";
import type ClientType from "./page.client";
import { clientPage } from "../../../routes/client-page";

const Client = clientPage<typeof ClientType>("collections");

export default async function Page() {
  const principal = await requirePage("collection:read");
  return <Client owners={collectionOwners((await getT(principal.user.id)).t)} canCreate={principal.permissions.has("collection:create")} canDelete={principal.permissions.has("collection:delete")} />;
}
