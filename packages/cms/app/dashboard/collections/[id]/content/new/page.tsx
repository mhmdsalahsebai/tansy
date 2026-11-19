import type RecordFormType from "../../../../../../components/collections/RecordForm";
import { requirePage } from "../../../../../../core/authz/page";
import { scopeBasePathOf } from "../../../../../../core/scope/provider";
import { loadSchema } from "../../load";
import { clientPage } from "../../../../../../routes/client-page";

const RecordForm = clientPage<typeof RecordFormType>("RecordForm");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await requirePage({ collection: id }, "collection:read", "record:create");
  const { collection, catalog } = await loadSchema(id, principal.permissions.has("collection:create"));
  return <RecordForm collection={collection} catalog={catalog} siteBasePath={await scopeBasePathOf(principal.scope ?? null)} />;
}
