import { requirePage } from "../../../core/authz/page";
import type ClientType from "./page.client";
import { clientPage } from "../../../routes/client-page";

const Client = clientPage<typeof ClientType>("schema");

export default async function Page() {
  const principal = await requirePage("collection:read");
  return <Client canImport={principal.permissions.has("collection:update")} />;
}
