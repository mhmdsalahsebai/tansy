import { requirePage } from "../../../../../core/authz/page";
import { loadSchema } from "../load";
import { holdsRecordPermission } from "../../../../../core/authz/permissions";
import type ClientType from "./page.client";
import { clientPage } from "../../../../../routes/client-page";

const Client = clientPage<typeof ClientType>("collections/[id]/import");

/** Importing writes records, so this needs the collection's `record:create`, as the route does. */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await requirePage({ collection: id }, "collection:read", "record:create");
  const { collection } = await loadSchema(id);
  return <Client collection={collection} canUpdate={holdsRecordPermission(principal.permissions, "record:update", collection.id)} />;
}
