import { requirePage } from "../../../../core/authz/page";
import type ClientType from "./page.client";
import { clientPage } from "../../../../routes/client-page";

const Client = clientPage<typeof ClientType>("users/[id]");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requirePage("user:get");
  const { id } = await params;
  return <Client userId={id} selfId={principal.user.id} permissions={[...principal.permissions]} />;
}
