import { requirePage } from "../../../core/authz/page";
import type ClientType from "./page.client";
import { clientPage } from "../../../routes/client-page";

const Client = clientPage<typeof ClientType>("settings");

export default async function Page() {
  const principal = await requirePage("setting:read");
  return <Client canEdit={principal.permissions.has("setting:update")} />;
}
