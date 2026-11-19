import type { FieldTypeInfo } from "../../../../components/fields/types";
import { listUserFields, userFieldCatalogue } from "../../../../core/auth/user-fields";
import { requirePage } from "../../../../core/authz/page";
import { plain } from "../../../../core/http/plain";
import type ClientType from "./page.client";
import type { StoredUserField } from "./page.client";
import { clientPage } from "../../../../routes/client-page";

const Client = clientPage<typeof ClientType>("users/fields");

export default async function Page() {
  await requirePage("setting:update", "user:get");
  return <Client initial={plain<StoredUserField[]>(await listUserFields())} types={plain<FieldTypeInfo[]>(userFieldCatalogue())} />;
}
