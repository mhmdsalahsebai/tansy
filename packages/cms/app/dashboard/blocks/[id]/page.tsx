import { notFound } from "next/navigation";
import type BlockTypeFormType from "../../../../components/blocks/BlockTypeForm";
import type { BlockTypeInfo, FieldTypeInfo } from "../../../../components/fields/types";
import { requirePage } from "../../../../core/authz/page";
import { listBlockTypes } from "../../../../core/blocks/service";
import { listCollections } from "../../../../core/content/collections";
import { fieldCatalogue } from "../../../../core/fields/registry";
import { plain } from "../../../../core/http/plain";
import { clientPage } from "../../../../routes/client-page";

const BlockTypeForm = clientPage<typeof BlockTypeFormType>("BlockTypeForm");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requirePage("collection:read", "collection:update");
  const { id } = await params;
  const [blocks, collections] = await Promise.all([listBlockTypes(), listCollections()]);
  const initial = blocks.find((block) => String(block.id) === id);
  if (!initial) notFound();
  return <BlockTypeForm initial={plain<BlockTypeInfo>(initial)} fieldTypes={plain<FieldTypeInfo[]>(fieldCatalogue())} collections={collections.map((c) => ({ id: c.id, name: c.name }))} />;
}
