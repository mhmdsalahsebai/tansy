import type { FileListItem } from "../../../components/fields/types";
import { requirePage } from "../../../core/authz/page";
import { listFiles } from "../../../core/files/service";
import { plain } from "../../../core/http/plain";
import { withScope } from "../../../core/scope/context";
import type ClientType from "./page.client";
import { clientPage } from "../../../routes/client-page";

const Client = clientPage<typeof ClientType>("files");

const PER_PAGE = 30;

export default async function Page() {
  const principal = await requirePage("file:list");
  const { items, totalItems } = await withScope(principal.scope ?? null, () => listFiles(1, PER_PAGE));
  return (
    <Client
      initial={plain<FileListItem[]>(items)}
      initialTotal={totalItems}
      perPage={PER_PAGE}
      canUpload={principal.permissions.has("file:create")}
      canDelete={principal.permissions.has("file:delete")}
    />
  );
}
