import type ClientType from "./page.client";
import type { FieldPresetInfo } from "../../../components/fields/types";
import { requirePage } from "../../../core/authz/page";
import { allCollections } from "../../../core/content/access";
import { listFieldPresets } from "../../../core/fields/presets";
import { fieldCatalogue } from "../../../core/fields/registry";
import { plain } from "../../../core/http/plain";
import { clientPage } from "../../../routes/client-page";

const Client = clientPage<typeof ClientType>("field-presets");

export default async function Page() {
  const principal = await requirePage("collection:read");
  const [presets, collections] = await Promise.all([listFieldPresets(), allCollections()]);
  return (
    <Client
      initial={plain<FieldPresetInfo[]>(presets)}
      types={plain(fieldCatalogue())}
      collections={collections.map(({ id, name }) => ({ id, name }))}
      canCreate={principal.permissions.has("collection:create")}
      canEdit={principal.permissions.has("collection:update")}
      canDelete={principal.permissions.has("collection:delete")}
    />
  );
}
