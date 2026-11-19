import { requirePage } from "../../../../core/authz/page";
import { PageHeader, Alert } from "../../../../components/ui/kit";
import { getT } from "../../../../core/i18n/admin";
import { withScope } from "../../../../core/scope/context";
import { scopeLabelIn } from "../../../../core/scope/label";
import { adminPath } from "../../../../lib/paths";
import { holdsRecordPermissionForSome, type RecordPermission } from "../../../../core/authz/permissions";
import { hasRecords } from "../../../../core/content/content-service";
import { loadSchema } from "./load";
import type ClientType from "./page.client";
import { clientPage } from "../../../../routes/client-page";

const Client = clientPage<typeof ClientType>("collections/[id]");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const principal = await requirePage({ collection: id, own: true }, "collection:read", "record:list");
  const { collection, catalog } = await loadSchema(id);
  // An own grant counts: the API refuses other people's records.
  const can = (permission: RecordPermission) => holdsRecordPermissionForSome(principal.permissions, permission, collection.id);
  const singleton = collection.type === "singleton";
  // A scoped collection's records belong to one value at a time, so with none chosen there are none to show.
  if (collection.scoped && !principal.scope) {
    const { t, locale } = await getT(principal.user.id);
    const label = (scopeLabelIn(t) ?? "").toLocaleLowerCase(locale);
    return (
      <div className="cms-gutter cms-stack-6">
        <PageHeader title={collection.name} back={{ href: adminPath("/collections"), label: t("nav.Collections") }} />
        <Alert kind="info">{t("scope.chooseFirst", { label })}</Alert>
      </div>
    );
  }
  const full = singleton && await withScope(principal.scope ?? null, () => hasRecords(collection.slug));
  return <Client collection={collection} fieldTypes={catalog.fieldTypes} canCreate={!full && can("record:create")} canDelete={!singleton && collection.type !== "view" && can("record:delete")}
    canEditSchema={principal.permissions.has(collection.type === "view" ? "collection:manage-views" : "collection:update")}
    canEditRules={principal.permissions.has("collection:manage-rules")} />;
}
