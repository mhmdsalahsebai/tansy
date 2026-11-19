import { loadSchema } from "../../../load";
import { requirePage } from "../../../../../../../core/authz/page";
import { holdsRecordPermissionForSome } from "../../../../../../../core/authz/permissions";
import type ClientType from "./page.client";
import { clientPage } from "../../../../../../../routes/client-page";

const Client = clientPage<typeof ClientType>("collections/[id]/content/[contentId]/history");

export default async function Page({ params }: { params: Promise<{ id: string; contentId: string }> }) {
  const { id, contentId } = await params;
  const principal = await requirePage({ collection: id, own: true }, "collection:read", "record:read");
  const { collection } = await loadSchema(id);
  return <Client collectionId={collection.id} collectionName={collection.name} collectionLabels={collection.labels as Record<string, string> | null} recordId={contentId} canRestore={holdsRecordPermissionForSome(principal.permissions, "record:update", collection.id)} />;
}
