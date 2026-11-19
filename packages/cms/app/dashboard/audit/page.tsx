import { requirePage } from "../../../core/authz/page";
import type ClientType from "./page.client";
import { clientPage } from "../../../routes/client-page";

const Client = clientPage<typeof ClientType>("audit");

export default async function Page() {
  const principal = await requirePage("audit:read");
  return <Client canConfigure={principal.permissions.has("setting:read")} />;
}
