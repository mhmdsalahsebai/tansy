import { requirePage } from "../../../core/authz/page";
import type ClientType from "./page.client";
import { clientPage } from "../../../routes/client-page";

const Client = clientPage<typeof ClientType>("reviews");

export default async function Page() {
  await requirePage("dashboard:access");
  return <Client />;
}
