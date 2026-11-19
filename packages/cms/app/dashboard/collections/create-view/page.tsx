import type ViewFormType from "../../../../components/collections/ViewForm";
import { requirePage } from "../../../../core/authz/page";
import { clientPage } from "../../../../routes/client-page";

const ViewForm = clientPage<typeof ViewFormType>("ViewForm");

export default async function Page() {
  await requirePage("collection:manage-views");
  return <ViewForm />;
}
