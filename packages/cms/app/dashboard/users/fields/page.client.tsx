"use client";

import { useState } from "react";
import FieldListEditor from "../../../../components/fields/FieldListEditor";
import { issuesOf, type DraftField, type FieldTypeInfo, type IssueMap } from "../../../../components/fields/types";
import { useT } from "../../../../components/i18n";
import { Alert, Button, Modal, PageHeader } from "../../../../components/ui/kit";
import { api, ApiError, errorText } from "../../../../lib/client/api";
import { adminPath, apiPath } from "../../../../lib/paths";

export interface StoredUserField {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  selfEditable: boolean;
}

const OMITTED_OPTIONS = ["hidden", "unique", "readonly", "searchable", "showIf"];

const toDrafts = (fields: StoredUserField[]): DraftField[] => fields.map((field) => ({ key: crypto.randomUUID(), id: field.id, name: field.name, type: field.type, config: field.config, selfEditable: field.selfEditable }));

export default function UserFieldsPage({ initial, types }: { initial: StoredUserField[]; types: FieldTypeInfo[] }) {
  const { t } = useT();
  const [fields, setFields] = useState<DraftField[]>(() => toDrafts(initial));
  const [issues, setIssues] = useState<IssueMap>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [warnings, setWarnings] = useState<string[] | null>(null);

  const patch = (key: string, change: Partial<DraftField>) => setFields((current) => current.map((field) => (field.key === key ? { ...field, ...change } : field)));

  const save = async (confirm: boolean) => {
    setSaving(true);
    setIssues({});
    setError(null);
    setNotice(null);
    try {
      const saved = await api<StoredUserField[]>(apiPath("/user-fields"), { method: "PUT", body: { confirm, fields: fields.map(({ id, name, type, config, selfEditable }) => ({ id, name, type, config, selfEditable })) } });
      setFields(toDrafts(saved));
      setWarnings(null);
      setNotice(t("userFields.saved"));
    } catch (err) {
      if (err instanceof ApiError && err.code === "CONFIRMATION_REQUIRED") setWarnings(((err.details ?? [])).map((detail) => detail.message));
      else {
        setIssues(issuesOf(err));
        setError(errorText(err));
        setWarnings(null);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cms-gutter">
      <PageHeader
        title={t("userFields.title")}
        description={t("userFields.description")}
        back={{ href: adminPath("/users"), label: t("userFields.backToUsers") }}
      />
      <form onSubmit={(e) => { e.preventDefault(); void save(false); }} className="cms-stack-6">
        {error && <Alert>{error}</Alert>}
        {notice && <Alert kind="success">{notice}</Alert>}
        <Alert kind="warning">{t("userFields.selfEditWarning")}</Alert>
        <FieldListEditor
          fields={fields}
          onChange={setFields}
          types={types}
          collections={[]}
          issues={issues}
          omitOptions={OMITTED_OPTIONS}
          extra={(field, index) => (
            <div className="cms-flex cms-wrap cms-gap-spread">
              <label className="cms-check-label">
                <input type="checkbox" className="cms-check" checked={field.selfEditable === true} disabled={field.config.hidden === true} onChange={(e) => patch(field.key, { selfEditable: e.target.checked })} />
                {t("userFields.selfEditable")}
              </label>
              <label className="cms-check-label">
                <input
                  type="checkbox"
                  className="cms-check"
                  checked={field.config.hidden === true}
                  onChange={(e) => {
                    const { hidden: _unused, ...rest } = field.config;
                    void _unused;
                    patch(field.key, { config: e.target.checked ? { ...rest, hidden: true } : rest, selfEditable: e.target.checked ? false : field.selfEditable });
                  }}
                />
                {t("userFields.hidden")}
              </label>
              {issues[`fields.${index}.selfEditable`] && <p className="cms-error">{issues[`fields.${index}.selfEditable`]}</p>}
            </div>
          )}
        />
        <div className="cms-flex cms-end"><Button type="submit" loading={saving}>{t("userFields.save")}</Button></div>
      </form>
      <Modal open={warnings !== null} onClose={() => setWarnings(null)} title={t("userFields.deletesData")}>
        <ul className="cms-list cms-mb-4">{warnings?.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        <div className="cms-flex cms-end cms-gap-2">
          <Button variant="secondary" onClick={() => setWarnings(null)}>{t("userFields.cancel")}</Button>
          <Button variant="danger" loading={saving} onClick={() => void save(true)}>{t("userFields.deleteAndSave")}</Button>
        </div>
      </Modal>
    </div>
  );
}
