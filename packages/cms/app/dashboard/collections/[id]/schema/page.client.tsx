"use client";

import { useState } from "react";
import { useSchemaText, useT } from "../../../../../components/i18n";
import { LabelsInput, labelsBody } from "../../../../../components/LabelsInput";
import FieldListEditor from "../../../../../components/fields/FieldListEditor";
import { issuesOf, toRequest, type DraftField, type FieldTypeInfo, type IssueMap } from "../../../../../components/fields/types";
import { Alert, Button, Card, Field, Input, Modal, PageHeader, PageSkeleton } from "../../../../../components/ui/kit";
import { ReviewCard } from "../../../../../components/collections/ReviewCard";
import { Switch } from "../../../../../components/ui/Switch";
import { api, ApiError, errorText, useApi } from "../../../../../lib/client/api";
import type { Collection } from "../../../../../types/content";
import { adminPath, apiPath } from "../../../../../lib/paths";

const toDrafts = (collection: Collection): DraftField[] =>
  collection.fields.map((f) => ({ key: String(f.id), id: f.id, name: f.name, type: f.type, config: f.config ?? {} }));

/** `scopeLabel`: what the scope provider calls a value, such as "tenant", or null without one. */
export default function SchemaPage({ id, scopeLabel = null }: { id: string; scopeLabel?: string | null }) {
  const collection = useApi<Collection>(apiPath(`/collections/${id}`));
  const types = useApi<FieldTypeInfo[]>(apiPath("/field-types"));
  const collections = useApi<Array<{ id: number; name: string }>>(apiPath("/collections"));
  const { t } = useT();

  if (collection.error) return <Alert>{collection.error}</Alert>;
  if (types.error) return <Alert>{types.error}</Alert>;
  if (!collection.data || !types.data) return <PageSkeleton kind="form" />;
  return <SchemaForm id={id} initial={collection.data} types={types.data} collections={collections.data ?? []} scopeLabel={scopeLabel} />;
}

function SchemaForm({ id, initial, types, collections, scopeLabel }: { id: string; initial: Collection; types: FieldTypeInfo[]; collections: Array<{ id: number; name: string }>; scopeLabel: string | null }) {
  const { t } = useT();
  const schemaText = useSchemaText();
  const [stored, setStored] = useState(initial);
  const [details, setDetails] = useState({ name: initial.name, labels: { ...initial.labels }, slug: initial.slug, description: initial.description ?? "", urlPattern: initial.urlPattern ?? "" });
  const [fields, setFields] = useState(toDrafts(initial));
  const [issues, setIssues] = useState<IssueMap>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingLoss, setPendingLoss] = useState<string[] | null>(null);
  // Bumped after each save, so editors holding local text start from the stored values.
  const [revision, setRevision] = useState(0);

  const save = async (confirm: boolean) => {
    setSaving(true);
    setError(null);
    setSaved(false);
    setIssues({});
    setPendingLoss(null);
    try {
      // Fields first: a refused or unconfirmed field change must not half-apply the form.
      let current = await api<Collection>(apiPath(`/collections/${id}/fields`), { method: "PUT", body: { fields: toRequest(fields), confirm } });
      setStored(current);
      setFields(toDrafts(current));
      setRevision((r) => r + 1);
      const labels = labelsBody(details.labels);
      if (details.name !== current.name || JSON.stringify(labels) !== JSON.stringify(current.labels ?? null) || details.slug !== current.slug || details.description !== (current.description ?? "") || details.urlPattern.trim() !== (current.urlPattern ?? "")) {
        current = await api<Collection>(apiPath(`/collections/${id}`), { method: "PATCH", body: { ...details, labels, urlPattern: details.urlPattern.trim() || null } });
        setStored(current);
      }
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFIRMATION_REQUIRED" && Array.isArray(err.details)) {
        setPendingLoss(err.details.map((d) => d.message));
      } else {
        setIssues(issuesOf(err));
        setError(errorText(err));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cms-gutter">
      <PageHeader
        title={t("schemaEditor.editTitle", { name: schemaText.collection(stored) })}
        description={t("schemaEditor.editDescription")}
        back={{ href: adminPath(`/collections/${id}`), label: t("schemaEditor.backToRecords") }}
      />
      <form onSubmit={(e) => { e.preventDefault(); void save(false); }} className="cms-stack-6">
        {error && <Alert>{error}</Alert>}
        {saved && <Alert kind="success">{t("schemaEditor.saved")}</Alert>}
        <Card>
          <Field label={t("schemaEditor.name")}><Input required value={details.name} onChange={(e) => setDetails({ ...details, name: e.target.value })} /></Field>
          <LabelsInput value={details.labels} maxLength={120} onChange={(labels) => setDetails({ ...details, labels })} />
          <Field label={t("schemaEditor.slug")} hint={t("schemaEditor.slugRenames")}><Input required value={details.slug} onChange={(e) => setDetails({ ...details, slug: e.target.value })} /></Field>
          <Field label={t("schemaEditor.description")}><Input value={details.description} onChange={(e) => setDetails({ ...details, description: e.target.value })} /></Field>
          {stored.type !== "view" && (
            <Field label={t("schemaEditor.urlPattern")} hint={t(stored.type === "singleton" ? "schemaEditor.urlSingleton" : "schemaEditor.urlCollection")}>
              <Input value={details.urlPattern} placeholder={stored.type === "singleton" ? "/about" : "/blog/:slug"} onChange={(e) => setDetails({ ...details, urlPattern: e.target.value })} />
            </Field>
          )}
          {issues.urlPattern && <p className="cms-error">{issues.urlPattern}</p>}
        </Card>
        {stored.type !== "view" && (scopeLabel !== null || stored.scoped) && <ScopeCard id={id} collection={stored} label={scopeLabel ?? ""} onSaved={setStored} />}
        {stored.type !== "view" && <ReviewCard collection={stored} onSaved={setStored} />}
        {stored.type !== "view" && <LocalizationCard id={id} collection={stored} onSaved={(current) => { setStored(current); setFields(toDrafts(current)); setRevision((r) => r + 1); }} />}
        <FieldListEditor key={revision} fields={fields} onChange={setFields} types={types} collections={collections} issues={issues} localized={stored.localization?.enabled === true} />
        <div className="cms-flex cms-end">
          <Button type="submit" loading={saving}>{t("schemaEditor.saveChanges")}</Button>
        </div>
      </form>

      <Modal open={pendingLoss !== null} onClose={() => setPendingLoss(null)} title={t("schemaEditor.deletesData")}>
        <ul className="cms-list cms-mb-4">
          {pendingLoss?.map((message) => <li key={message}>{message}</li>)}
        </ul>
        <div className="cms-flex cms-end cms-gap-2">
          <Button variant="secondary" onClick={() => setPendingLoss(null)}>{t("schemaEditor.cancel")}</Button>
          <Button variant="danger" onClick={() => void save(true)}>{t("schemaEditor.deleteAndSave")}</Button>
        </div>
      </Modal>
    </div>
  );
}

type Localization = NonNullable<Collection["localization"]>;

/** Turns localization on or off. Off keeps the default language and deletes the others, so it asks first. */
function LocalizationCard({ id, collection, onSaved }: { id: string; collection: Collection; onSaved: (collection: Collection) => void }) {
  const { t } = useT();
  const current: Localization = collection.localization ?? { enabled: false, fallback: "chain", fieldFallback: false };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingLoss, setPendingLoss] = useState<{ body: Partial<Localization>; messages: string[] } | null>(null);

  const save = async (body: Partial<Localization>, confirm = false) => {
    setBusy(true);
    setError(null);
    try {
      await api(apiPath(`/collections/${id}/localization`), { method: "PUT", body: { ...current, ...body, confirm } });
      setPendingLoss(null);
      onSaved(await api<Collection>(apiPath(`/collections/${id}`)));
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFIRMATION_REQUIRED" && Array.isArray(err.details)) setPendingLoss({ body, messages: err.details.map((d) => d.message) });
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t("schemaEditor.languages")} description={t("schemaEditor.languagesDescription")}>
      {error && <Alert>{error}</Alert>}
      <Switch checked={current.enabled} onChange={(enabled) => !busy && void save({ enabled })} label={t("schemaEditor.localize")} description={t(current.enabled ? "schemaEditor.localizedOn" : "schemaEditor.localizedOff")} />
      {current.enabled && (
        <>
          <Field label={t("schemaEditor.whenMissing")} hint={t("schemaEditor.whenMissingHint")}>
            <select className="cms-input" disabled={busy} value={current.fallback} onChange={(e) => void save({ fallback: e.target.value as Localization["fallback"] })}>
              <option value="chain">{t("schemaEditor.fallbackChain")}</option>
              <option value="none">{t("schemaEditor.fallbackNone")}</option>
            </select>
          </Field>
          <Switch checked={current.fieldFallback} onChange={(fieldFallback) => !busy && void save({ fieldFallback })} label={t("schemaEditor.fieldFallback")} description={t("schemaEditor.fieldFallbackHint")} />
        </>
      )}
      <Modal open={pendingLoss !== null} onClose={() => setPendingLoss(null)} title={t("schemaEditor.deletesData")}>
        <ul className="cms-list cms-mb-4">{pendingLoss?.messages.map((message) => <li key={message}>{message}</li>)}</ul>
        <div className="cms-flex cms-end cms-gap-2">
          <Button variant="secondary" onClick={() => setPendingLoss(null)}>{t("schemaEditor.cancel")}</Button>
          <Button variant="danger" loading={busy} onClick={() => pendingLoss && void save(pendingLoss.body, true)}>{t("schemaEditor.deleteTranslations")}</Button>
        </div>
      </Modal>
    </Card>
  );
}

/**
 * Keeps each scope value's records apart, such as each tenant's. Turning it on moves existing
 * records to the provider's first value. The server refuses turning it off while records belong
 * to more than one value, and asks for a recent sign-in either way.
 */
function ScopeCard({ id, collection, label, onSaved }: { id: string; collection: Collection; label: string; onSaved: (collection: Collection) => void }) {
  const { t } = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scoped = collection.scoped === true;

  const save = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(apiPath(`/collections/${id}/scope`), { method: "PUT", body: { scoped: next } });
      onSaved(await api<Collection>(apiPath(`/collections/${id}`)));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t("schemaEditor.scopeTitle", { label })} description={t("schemaEditor.scopeDescription", { label })}>
      {error && <Alert>{error}</Alert>}
      <Switch checked={scoped} onChange={(next) => void save(next)} label={t("schemaEditor.scopeSwitch", { label })} description={t(scoped ? "schemaEditor.scopeOn" : "schemaEditor.scopeOff", { label })} />
    </Card>
  );
}
