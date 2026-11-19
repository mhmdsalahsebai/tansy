import type BlockTypeFormType from "../../../../components/blocks/BlockTypeForm";
import type { FieldTypeInfo } from "../../../../components/fields/types";
import { requirePage } from "../../../../core/authz/page";
import { listCollections } from "../../../../core/content/collections";
import { fieldCatalogue } from "../../../../core/fields/registry";
import { plain } from "../../../../core/http/plain";
import { clientPage } from "../../../../routes/client-page";

const BlockTypeForm = clientPage<typeof BlockTypeFormType>("BlockTypeForm");

export default async function Page() {
  await requirePage("collection:read", "collection:create");
  const collections = await listCollections();
  return <BlockTypeForm fieldTypes={plain<FieldTypeInfo[]>(fieldCatalogue())} collections={collections.map(({ id, name }) => ({ id, name }))} />;
}
