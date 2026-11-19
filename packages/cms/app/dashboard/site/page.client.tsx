"use client";

import { useEffect, useState } from "react";
import { useT } from "../../../components/i18n";
import { Alert, Button, Card, Field, Input, PageHeader, PageSkeleton } from "../../../components/ui/kit";
import { api, useAction, useApi } from "../../../lib/client/api";
import { apiPath } from "../../../lib/paths";

interface Identity { name: string; logoUrl: string; accentColor: string; theme: string; hiddenLocales: string[] }
interface ThemeChoice { name: string; version: string }

/** Dashboard → Site: the current scope value's own name, logo, colour and theme. */
export default function SitePage({ label, languages, themes = [] }: { label: string; languages: Array<{ code: string; label: string }>; themes?: ThemeChoice[] }) {
  const { t } = useT();
  const remote = useApi<Identity>(apiPath("/settings/site"));
  const [draft, setDraft] = useState<Identity | null>(null);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (!remote.data) return;
    const timer = setTimeout(() => setDraft(remote.data!));
    return () => clearTimeout(timer);
  }, [remote.data]);

  if (remote.error) return <div className="cms-gutter"><Alert>{remote.error}</Alert></div>;
  if (!draft) return <PageSkeleton kind="form" />;

  const set = (name: keyof Identity) => (event: { target: { value: string } }) => {
    setSaved(false);
    setDraft({ ...draft, [name]: event.target.value });
  };
  const toggleLanguage = (code: string, shown: boolean) => {
    setSaved(false);
    setDraft({ ...draft, hiddenLocales: shown ? draft.hiddenLocales.filter((entry) => entry !== code) : [...draft.hiddenLocales, code] });
  };
  const save = async () => setSaved(await run(async () => setDraft(await api<Identity>(apiPath("/settings/site"), { method: "PUT", body: draft }))));

  return (
    <div>
      <PageHeader title={t("siteIdentity.title")} description={t("siteIdentity.description", { label })} actions={<Button loading={busy} onClick={save}>{t("siteIdentity.save")}</Button>} />
      <div className="cms-gutter cms-stack-4">
        {error && <Alert>{error}</Alert>}
        {saved && <Alert kind="success">{t("siteIdentity.saved")}</Alert>}
        <Card>
          <Field label={t("siteIdentity.name")} hint={t("siteIdentity.nameHint")}><Input value={draft.name} maxLength={80} onChange={set("name")} /></Field>
          <Field label={t("siteIdentity.logo")} hint={t("siteIdentity.logoHint")}><Input value={draft.logoUrl} maxLength={500} dir="ltr" onChange={set("logoUrl")} /></Field>
          <Field label={t("siteIdentity.accent")} hint={t("siteIdentity.accentHint")}><Input value={draft.accentColor} maxLength={7} dir="ltr" onChange={set("accentColor")} /></Field>
          {/* Only where the build has more than one theme to choose between. */}
          {themes.length > 1 && (
            <Field label={t("siteIdentity.theme")} hint={t("siteIdentity.themeHint", { label })}>
              <select className="cms-input" value={draft.theme} onChange={set("theme")}>
                <option value="">{t("siteIdentity.themeDefault", { name: themes[0].name })}</option>
                {themes.map((theme) => <option key={theme.name} value={theme.name}>{theme.name}</option>)}
              </select>
            </Field>
          )}
        </Card>
        {languages.length > 0 && (
          <Card>
            <Field label={t("siteIdentity.languages")} hint={t("siteIdentity.languagesHint", { label })}>
              <div className="cms-stack-2">
                {languages.map((language) => (
                  <label key={language.code} className="cms-check-label">
                    <input type="checkbox" className="cms-check" checked={!draft.hiddenLocales.includes(language.code)} onChange={(event) => toggleLanguage(language.code, event.target.checked)} />
                    {language.label}
                  </label>
                ))}
              </div>
            </Field>
          </Card>
        )}
      </div>
    </div>
  );
}
