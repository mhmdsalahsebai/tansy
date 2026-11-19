import { requirePage } from "../../../../../core/authz/page";
import type ClientType from "./page.client";
import { clientPage } from "../../../../../routes/client-page";

const Client = clientPage<typeof ClientType>("collections/[id]/rules");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requirePage("collection:manage-rules");
  return <Client id={(await params).id} />;
}
