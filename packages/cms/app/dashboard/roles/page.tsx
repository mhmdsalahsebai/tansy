import { requirePage } from "../../../core/authz/page";
import { getT } from "../../../core/i18n/admin";
import { scopeLabelIn } from "../../../core/scope/label";
import type ClientType from "./page.client";
import { clientPage } from "../../../routes/client-page";

const Client = clientPage<typeof ClientType>("roles");

export default async function Page() {
  const principal = await requirePage("role:list");
  const { t, locale } = await getT(principal.user.id);
  // What the scope provider calls a value, such as "tenant", for roles that apply within one.
  return <Client permissions={[...principal.permissions]} scopeLabel={scopeLabelIn(t)?.toLocaleLowerCase(locale) ?? ""} />;
}
