import type { UserFieldValue } from "../../components/users/UserFieldsForm";
import { userFieldValues } from "../../core/auth/user-fields";
import { requireUser } from "../../core/authz/page";
import { adminConfigIfProvided } from "../../core/config";
import { PluginBoundary } from "../../components/PluginBoundary";
import { plain } from "../../core/http/plain";
import AccountClient from "./account-client";
import { chosenAdminLocale } from "../../core/i18n/admin";

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ denied?: string; enroll?: string }> }) {
  const principal = await requireUser();
  const { denied, enroll } = await searchParams;
  const user = { id: principal.user.id, email: principal.user.email, permissions: [...principal.permissions] };
  const panels = (adminConfigIfProvided()?.plugins ?? []).flatMap((plugin) => (plugin.accountPanels ?? []).map((panel) => ({ ...panel, plugin: plugin.name })));
  return (
    <AccountClient
      initialName={principal.user.name}
      email={principal.user.email}
      twoFactorEnabled={principal.user.twoFactorEnabled}
      permissions={[...principal.permissions]}
      customFields={plain<UserFieldValue[]>(await userFieldValues(principal.user.id, { includeHidden: false }))}
      denied={denied === "1"}
      enrollMfa={enroll === "mfa"}
      interfaceLocale={await chosenAdminLocale(principal.user.id)}
    >
      {panels.map(({ plugin, id, component: Panel }) => <PluginBoundary key={`${plugin}:${id}`} plugin={plugin}><Panel user={user} /></PluginBoundary>)}
    </AccountClient>
  );
}
