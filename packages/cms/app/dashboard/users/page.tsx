import { requirePage } from "../../../core/authz/page";
import type ClientType from "./page.client";
import { clientPage } from "../../../routes/client-page";

const Client = clientPage<typeof ClientType>("users");

export default async function Page() {
  const principal = await requirePage("user:list");
  return <Client permissions={[...principal.permissions]} />;
}
