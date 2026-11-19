import { requirePage } from "../../../core/authz/page";
import { Alert, PageHeader } from "../../../components/ui/kit";
import { getT } from "../../../core/i18n/admin";
import { scopeLabelIn } from "../../../core/scope/label";
import type ClientType from "./page.client";
import { clientPage } from "../../../routes/client-page";
import { defaultLocale, listLocales } from "../../../core/i18n/locales";
import { installedThemes } from "../../../core/theme/installed";

const Client = clientPage<typeof ClientType>("site");

/** A scope value's own site name, logo, colour and theme, such as one tenant's. */
export default async function Page() {
  const principal = await requirePage("setting:site");
  const { t, locale } = await getT(principal.user.id);
  const label = (scopeLabelIn(t) ?? "").toLocaleLowerCase(locale);
  if (!principal.scope) {
    return (
      <div className="cms-gutter cms-stack-6">
        <PageHeader title={t("siteIdentity.title")} />
        <Alert kind="info">{t("scope.siteChooseFirst", { label })}</Alert>
      </div>
    );
  }
  // The instance's public languages other than the default, which a site may leave out.
  const [locales, primary] = await Promise.all([listLocales(), defaultLocale()]);
  const languages = locales.filter((entry) => entry.public && entry.code !== primary).map((entry) => ({ code: entry.code, label: entry.label }));
  // The themes this build installs, the first being the default. Nothing to choose from with one, so the field is left out.
  const themes = installedThemes().map((theme) => ({ name: theme.name, version: theme.version }));
  return <Client label={label} languages={languages} themes={themes} />;
}
