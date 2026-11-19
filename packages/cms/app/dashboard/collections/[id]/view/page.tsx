import { notFound } from "next/navigation";
import type ViewFormType from "../../../../../components/collections/ViewForm";
import { requirePage } from "../../../../../core/authz/page";
import { loadSchema } from "../load";
import { clientPage } from "../../../../../routes/client-page";

const ViewForm = clientPage<typeof ViewFormType>("ViewForm");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requirePage("collection:manage-views");
  const { collection } = await loadSchema((await params).id);
  if (collection.type !== "view" || !collection.viewQuery) notFound();
  return <ViewForm existing={{ id: collection.id, name: collection.name, viewQuery: collection.viewQuery }} />;
}
