import type RecordFormType from "../../../../../../components/collections/RecordForm";
import { requirePage } from "../../../../../../core/authz/page";
import { loadSchema } from "../../load";
import { clientPage } from "../../../../../../routes/client-page";

const RecordForm = clientPage<typeof RecordFormType>("RecordForm");

export default async function Page({ params }: { params: Promise<{ id: string; contentId: string }> }) {
  const { id, contentId } = await params;
  const principal = await requirePage({ collection: id, own: true }, "collection:read", "record:read");
  const { collection, catalog } = await loadSchema(id, principal.permissions.has("collection:create"));
  return <RecordForm collection={collection} catalog={catalog} recordId={contentId} />;
}
