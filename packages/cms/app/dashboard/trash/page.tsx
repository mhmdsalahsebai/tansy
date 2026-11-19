import { requirePage } from "../../../core/authz/page";
import type ClientType from "./page.client";
import { clientPage } from "../../../routes/client-page";

const Client = clientPage<typeof ClientType>("trash");

/** What a caller may put back is decided per entry by the API, which the page only reflects. */
export default async function Page() {
  await requirePage("dashboard:access");
  return <Client />;
}
