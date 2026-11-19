import { requirePage } from "../../../../../core/authz/page";
import { getT } from "../../../../../core/i18n/admin";
import { scopeLabelIn } from "../../../../../core/scope/label";
import type ClientType from "./page.client";
import { clientPage } from "../../../../../routes/client-page";

const Client = clientPage<typeof ClientType>("collections/[id]/schema");

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requirePage("collection:update");
  const { t, locale } = await getT(principal.user.id);
  // What the scope provider calls a value, for the card that keeps records apart by it. Null without a provider.
  const scopeLabel = scopeLabelIn(t)?.toLocaleLowerCase(locale) ?? null;
  return <Client id={(await params).id} scopeLabel={scopeLabel} />;
}
