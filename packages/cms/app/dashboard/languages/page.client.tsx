"use client";

import { useState } from "react";
import { issuesOf, type IssueMap } from "../../../components/fields/types";
import { ArrowDownIcon, ArrowUpIcon, LanguageIcon, PlusIcon } from "@heroicons/react/16/solid";
import { Alert, Badge, Button, DataTable, Field, Input, Modal, PageHeader, SettingsSection } from "../../../components/ui/kit";
import { Switch } from "../../../components/ui/Switch";
import { api, errorText, useApi } from "../../../lib/client/api";
import { apiPath } from "../../../lib/paths";
import { useT } from "../../../components/i18n";

interface Locale { code: string; label: string; fallback: string | null; direction: "ltr" | "rtl"; public: boolean; position: number }
interface Routing { mode: "prefix" | "domains" | "none"; prefixDefault: boolean; domains: Record<string, string>; detectRoot: boolean }
interface Settings { defaultLocale: string; routing: Routing; siteText: Record<string, Record<string, unknown>>; items: Locale[] }

const blank = { code: "", label: "", fallback: "", public: false };

/** Settings → Languages: the languages content is written in, how site addresses carry them, and the theme's words in each. */
export default function LanguagesPage({ canEdit }: { canEdit: boolean }) {
  const { t } = useT();
  const [version, setVersion] = useState(0);
  const { data, error: loadError } = useApi<Settings>(`${apiPath("/settings/locales")}?v=${version}`);
  const [draft, setDraft] = useState(blank);
  const [issues, setIssues] = useState<IssueMap>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Locale | null>(null);

  const run = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setIssues({});
    try {
      await work();
      setVersion((current) => current + 1);
      if (done) setNotice(done);
      return true;
    } catch (err) {
      setIssues(issuesOf(err));
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const settings = (body: Record<string, unknown>, done?: string) => run(() => api(apiPath("/settings/localization"), { method: "PUT", body }), done);

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Locale | null>(null);
  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const body = { code: draft.code.trim(), public: draft.public, ...(draft.label.trim() ? { label: draft.label.trim() } : {}), ...(draft.fallback ? { fallback: draft.fallback } : {}) };
    if (await run(() => api(apiPath("/settings/locales"), { method: "POST", body }), t("languagesPage.added", { code: body.code }))) { setDraft(blank); setAdding(false); }
  };

  const move = (index: number, by: -1 | 1) => {
    const items = data?.items ?? [];
    const other = items[index + by];
    if (!other) return;
    void run(async () => {
      // Positions are rewritten for the two that swap, so gaps or ties left by earlier edits sort out.
      await api(apiPath(`/settings/locales/${encodeURIComponent(items[index].code)}`), { method: "PATCH", body: { position: index + by } });
      await api(apiPath(`/settings/locales/${encodeURIComponent(other.code)}`), { method: "PATCH", body: { position: index } });
    });
  };

  const items = data?.items ?? [];
  const label = (code: string | null) => items.find((item) => item.code === code)?.label ?? code;
  return (
    <div className="cms-gutter">
      <PageHeader title={t("languagesPage.title")} description={t("languagesPage.description")}
        actions={canEdit && <Button onClick={() => { setDraft(blank); setIssues({}); setError(null); setAdding(true); }}><PlusIcon className="cms-icon" aria-hidden="true" />{t("languagesPage.addButton")}</Button>} />
      <div className="cms-stack-6">
        {((error && !adding && !editing) || loadError) && <Alert>{error ?? loadError}</Alert>}
        {notice && <Alert kind="success">{notice}</Alert>}
        <DataTable
          label={t("languagesPage.title")}
          columns={[
            { id: "language", label: t("languagesPage.language") },
            { id: "code", label: t("languagesPage.code") },
            { id: "fallback", label: t("languagesPage.fallsBackTo") },
            { id: "direction", label: t("languagesPage.direction") },
            { id: "visibility", label: t("languagesPage.visibility") },
          ]}
          rows={data ? items.map((locale, index) => {
            const isDefault = locale.code === data.defaultLocale;
            return {
              id: locale.code,
              cells: {
                language: (
                  <span className="cms-inline-row cms-gap-2">
                    <span className="cms-truncate">{locale.label}</span>
                    {isDefault && <Badge tone="accent" tight>{t("languagesPage.default")}</Badge>}
                  </span>
                ),
                code: <span className="cms-mono">{locale.code}</span>,
                fallback: isDefault ? null : label(locale.fallback ?? data.defaultLocale),
                direction: locale.direction === "rtl" ? t("languagesPage.rtl") : t("languagesPage.ltr"),
                visibility: isDefault || locale.public ? <Badge tone="success">{t("languagesPage.public")}</Badge> : <Badge>{t("languagesPage.hidden")}</Badge>,
              },
              actions: canEdit ? (
                <>
                  <button type="button" className="cms-row-action" disabled={busy || index === 0} onClick={() => move(index, -1)} aria-label={t("languagesPage.moveUp", { code: locale.code })} title={t("languagesPage.moveUp", { code: locale.code })}><ArrowUpIcon className="cms-icon-xs" aria-hidden="true" /></button>
                  <button type="button" className="cms-row-action" disabled={busy || index === items.length - 1} onClick={() => move(index, 1)} aria-label={t("languagesPage.moveDown", { code: locale.code })} title={t("languagesPage.moveDown", { code: locale.code })}><ArrowDownIcon className="cms-icon-xs" aria-hidden="true" /></button>
                  <button type="button" className="cms-row-action" disabled={busy} onClick={() => { setIssues({}); setError(null); setEditing(locale); }}>{t("languagesPage.edit")}</button>
                  {!isDefault && <button type="button" className="cms-row-action" disabled={busy} onClick={() => void settings({ defaultLocale: locale.code }, t("languagesPage.nowDefault", { label: locale.label }))}>{t("languagesPage.makeDefault")}</button>}
                  {!isDefault && <button type="button" className="cms-row-action cms-row-action-danger" disabled={busy} onClick={() => setRemoving(locale)}>{t("languagesPage.remove")}</button>}
                </>
              ) : undefined,
            };
          }) : null}
          skeletonRows={3}
          empty={{ icon: <LanguageIcon />, title: t("languagesPage.empty") }}
        />
        {data && <RoutingCard key={JSON.stringify(data.routing)} routing={data.routing} locales={items} canEdit={canEdit} busy={busy} save={(routing) => void settings({ routing }, t("languagesPage.saved"))} />}
        {data && <SiteTextCard key={version} settings={data} canEdit={canEdit} busy={busy} save={(locale, messages) => void settings({ siteText: { locale, messages } }, t("languagesPage.siteTextSaved"))} />}
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} title={t("languagesPage.addTitle")}>
        <form className="cms-stack-4" onSubmit={(event) => void add(event)}>
          <p className="cms-hint">{t("languagesPage.addDescription")}</p>
          {error && <Alert>{error}</Alert>}
          <Field label={t("languagesPage.code")} hint={t("languagesPage.codeHint")}>
            <Input required value={draft.code} maxLength={35} placeholder="fr" onChange={(event) => setDraft({ ...draft, code: event.target.value })} />
          </Field>
          {issues.code && <p className="cms-error">{issues.code}</p>}
          <Field label={t("languagesPage.name")} hint={t("languagesPage.nameHint")}>
            <Input value={draft.label} maxLength={100} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
          </Field>
          {data && (
            <Field label={t("languagesPage.fallsBackTo")} hint={t("languagesPage.fallbackHint")}>
              <select className="cms-input" value={draft.fallback} onChange={(event) => setDraft({ ...draft, fallback: event.target.value })}>
                <option value="">{t("languagesPage.defaultLanguage", { code: data.defaultLocale })}</option>
                {items.filter((other) => other.code !== data.defaultLocale).map((other) => <option key={other.code} value={other.code}>{other.label} ({other.code})</option>)}
              </select>
            </Field>
          )}
          {issues.fallback && <p className="cms-error">{issues.fallback}</p>}
          <Switch checked={draft.public} onChange={(checked) => setDraft({ ...draft, public: checked })} label={t("languagesPage.public")} description={t("languagesPage.publicHint")} />
          <div className="cms-flex cms-end cms-gap-2">
            <Button variant="secondary" onClick={() => setAdding(false)}>{t("languagesPage.cancel")}</Button>
            <Button type="submit" loading={busy}>{t("languagesPage.addButton")}</Button>
          </div>
        </form>
      </Modal>

      {data && <EditDialog key={editing?.code ?? ""} locale={editing} items={items} defaultLocale={data.defaultLocale} busy={busy} error={error} onClose={() => setEditing(null)} save={async (body) => {
        if (editing && await run(() => api(apiPath(`/settings/locales/${encodeURIComponent(editing.code)}`), { method: "PATCH", body }), t("languagesPage.saved"))) setEditing(null);
      }} />}

      <RemoveDialog key={removing?.code ?? ""} locale={removing} onClose={() => setRemoving(null)} busy={busy} remove={async (purge) => {
        if (removing && await run(() => api(apiPath(`/settings/locales/${encodeURIComponent(removing.code)}${purge ? "?purge=true" : ""}`), { method: "DELETE" }), t("languagesPage.removed", { code: removing.code }))) setRemoving(null);
      }} />
    </div>
  );
}

/** Everything about a language but its code, which can't change. */
function EditDialog({ locale, items, defaultLocale, busy, error, onClose, save }: { locale: Locale | null; items: Locale[]; defaultLocale: string; busy: boolean; error: string | null; onClose: () => void; save: (body: Partial<Locale>) => void }) {
  const { t } = useT();
  const [values, setValues] = useState(() => ({ label: locale?.label ?? "", fallback: locale?.fallback ?? "", direction: locale?.direction ?? "ltr", public: locale?.public ?? false }));
  const isDefault = locale?.code === defaultLocale;
  return (
    <Modal open={locale !== null} onClose={onClose} title={t("languagesPage.editTitle", { label: locale?.label ?? "" })}>
      <form className="cms-stack-4" onSubmit={(event) => { event.preventDefault(); save({ label: values.label.trim() || locale?.label, direction: values.direction as Locale["direction"], ...(isDefault ? {} : { fallback: values.fallback || null, public: values.public }) }); }}>
        {error && <Alert>{error}</Alert>}
        <Field label={t("languagesPage.name")}>
          <Input required value={values.label} maxLength={100} onChange={(event) => setValues({ ...values, label: event.target.value })} />
        </Field>
        {!isDefault && (
          <Field label={t("languagesPage.fallsBackTo")} hint={t("languagesPage.fallbackHint")}>
            <select className="cms-input" value={values.fallback} onChange={(event) => setValues({ ...values, fallback: event.target.value })}>
              <option value="">{t("languagesPage.defaultLanguage", { code: defaultLocale })}</option>
              {items.filter((other) => other.code !== locale?.code && other.code !== defaultLocale).map((other) => <option key={other.code} value={other.code}>{other.label} ({other.code})</option>)}
            </select>
          </Field>
        )}
        <Field label={t("languagesPage.direction")}>
          <select className="cms-input" value={values.direction} onChange={(event) => setValues({ ...values, direction: event.target.value as Locale["direction"] })}>
            <option value="ltr">{t("languagesPage.ltr")}</option>
            <option value="rtl">{t("languagesPage.rtl")}</option>
          </select>
        </Field>
        {!isDefault && <Switch checked={values.public} onChange={(checked) => setValues({ ...values, public: checked })} label={t("languagesPage.public")} description={t("languagesPage.publicHint")} />}
        <div className="cms-flex cms-end cms-gap-2">
          <Button variant="secondary" onClick={onClose}>{t("languagesPage.cancel")}</Button>
          <Button type="submit" loading={busy}>{t("languagesPage.save")}</Button>
        </div>
      </form>
    </Modal>
  );
}

function RemoveDialog({ locale, onClose, busy, remove }: { locale: Locale | null; onClose: () => void; busy: boolean; remove: (purge: boolean) => void }) {
  const [purge, setPurge] = useState(false);
  const [typed, setTyped] = useState("");
  const { t } = useT();
  return (
    <Modal open={locale !== null} onClose={onClose} title={t("languagesPage.removeTitle", { label: locale?.label ?? "" })}>
      <div className="cms-stack-4">
        <p>{t("languagesPage.removeBody")}</p>
        <label className="cms-row cms-gap-2"><input type="checkbox" checked={purge} onChange={(event) => setPurge(event.target.checked)} /> {t("languagesPage.purge")}</label>
        {purge && (
          <Field label={t("languagesPage.typeToConfirm", { code: locale?.code ?? "" })}>
            <Input value={typed} onChange={(event) => setTyped(event.target.value)} />
          </Field>
        )}
        <div className="cms-row cms-gap-2">
          <Button variant="danger" loading={busy} disabled={purge && typed !== locale?.code} onClick={() => remove(purge)}>{purge ? t("languagesPage.removeAndPurge") : t("languagesPage.removeLanguage")}</Button>
          <Button variant="secondary" onClick={onClose}>{t("languagesPage.cancel")}</Button>
        </div>
      </div>
    </Modal>
  );
}

function RoutingCard({ routing, locales, canEdit, busy, save }: { routing: Routing; locales: Locale[]; canEdit: boolean; busy: boolean; save: (routing: Routing) => void }) {
  const [draft, setDraft] = useState(routing);
  const { t } = useT();
  return (
    <SettingsSection title={t("languagesPage.addressesTitle")} description={t("languagesPage.addressesDescription")}>
      <Field label={t("languagesPage.inAddress")}>
        <select className="cms-input" disabled={!canEdit} value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as Routing["mode"] })}>
          <option value="prefix">{t("languagesPage.modePrefix")}</option>
          <option value="domains">{t("languagesPage.modeDomains")}</option>
          <option value="none">{t("languagesPage.modeNone")}</option>
        </select>
      </Field>
      {draft.mode === "prefix" && (
        <>
          <Switch checked={draft.prefixDefault} onChange={(checked) => setDraft({ ...draft, prefixDefault: checked })} label={t("languagesPage.prefixDefault")} description={t("languagesPage.prefixDefaultHint")} />
          <Switch checked={draft.detectRoot} onChange={(checked) => setDraft({ ...draft, detectRoot: checked })} label={t("languagesPage.detectRoot")} description={t("languagesPage.detectRootHint")} />
        </>
      )}
      {draft.mode === "domains" && locales.map((locale) => (
        <Field key={locale.code} label={t("languagesPage.hostFor", { label: locale.label })}>
          <Input value={draft.domains[locale.code] ?? ""} placeholder={`${locale.code.toLowerCase()}.example.com`} disabled={!canEdit} onChange={(event) => setDraft({ ...draft, domains: Object.fromEntries(Object.entries({ ...draft.domains, [locale.code]: event.target.value.trim().toLowerCase() }).filter(([, host]) => host)) })} />
        </Field>
      ))}
      {canEdit && <div className="cms-flex cms-end"><Button type="button" loading={busy} onClick={() => save(draft)}>{t("languagesPage.saveAddresses")}</Button></div>}
    </SettingsSection>
  );
}

function SiteTextCard({ settings, canEdit, busy, save }: { settings: Settings; canEdit: boolean; busy: boolean; save: (locale: string, messages: Record<string, unknown>) => void }) {
  const [locale, setLocale] = useState(settings.defaultLocale);
  const stored = (code: string) => JSON.stringify(settings.siteText[code] ?? {}, null, 2);
  const [text, setText] = useState(() => stored(settings.defaultLocale));
  const [problem, setProblem] = useState<string | null>(null);
  const { t } = useT();
  const submit = () => {
    try {
      const parsed = JSON.parse(text || "{}") as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(t("languagesPage.notObject"));
      setProblem(null);
      save(locale, parsed as Record<string, unknown>);
    } catch (error) {
      setProblem(error instanceof SyntaxError ? t("languagesPage.notJson") : error instanceof Error ? error.message : t("languagesPage.notJson"));
    }
  };
  return (
    <SettingsSection title={t("languagesPage.siteTextTitle")} description={t("languagesPage.siteTextDescription")}>
      <Field label={t("languagesPage.language")}>
        <select className="cms-input" value={locale} onChange={(event) => { setLocale(event.target.value); setText(stored(event.target.value)); setProblem(null); }}>
          {settings.items.map((item) => <option key={item.code} value={item.code}>{item.label} ({item.code})</option>)}
        </select>
      </Field>
      <Field label={t("languagesPage.messages")} hint={t("languagesPage.messagesHint")}>
        <textarea className="cms-input cms-mono" rows={10} dir="auto" value={text} disabled={!canEdit} onChange={(event) => setText(event.target.value)} />
      </Field>
      {problem && <p className="cms-error">{problem}</p>}
      {canEdit && <div className="cms-flex cms-end"><Button type="button" loading={busy} onClick={submit}>{t("languagesPage.saveSiteText")}</Button></div>}
    </SettingsSection>
  );
}
