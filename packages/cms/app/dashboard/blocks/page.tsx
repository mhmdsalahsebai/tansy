import { requirePage } from "../../../core/authz/page";
import { listBlockLayouts } from "../../../core/blocks/layouts";
import { listBlockTypes } from "../../../core/blocks/service";
import { plain } from "../../../core/http/plain";
import type { BlockLayoutInfo, BlockTypeInfo } from "../../../components/fields/types";
import type ClientType from "./page.client";
import { clientPage } from "../../../routes/client-page";

const Client = clientPage<typeof ClientType>("blocks");

export default async function Page() {
  const principal = await requirePage("collection:read");
  return (
    <Client
      initial={plain<BlockTypeInfo[]>(await listBlockTypes())}
      initialLayouts={plain<BlockLayoutInfo[]>(await listBlockLayouts())}
      canCreate={principal.permissions.has("collection:create")}
      canEdit={principal.permissions.has("collection:update")}
      canDelete={principal.permissions.has("collection:delete")}
    />
  );
}
