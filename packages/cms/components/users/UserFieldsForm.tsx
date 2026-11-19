"use client";

import { useFieldText, useT } from "../i18n";
import { useState } from "react";
import FieldValueInput from "../fields/FieldValueInput";
import { issueFor, issuesOf, type IssueMap } from "../fields/types";
import { Alert, Button, Card } from "../ui/kit";
import type { EditorInput } from "../../core/fields/define";
import { api, errorText } from "../../lib/client/api";

export interface UserFieldValue {
  id: number;
  name: string;
  type: string;
  input: EditorInput;
  config: Record<string, unknown>;
  selfEditable: boolean;
  value: unknown;
}

interface Props {
  fields: UserFieldValue[];
  /** Where to save, and how: PUT for a manager, PATCH for the user's own account. */
  url: string;
  method: "PUT" | "PATCH";
  /** A person can only change their own selfEditable fields. Others show their value. */
  own?: boolean;
}

function show(value: unknown, notSet: string) {
  if (value === null || value === undefined || value === "") return notSet;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export default function UserFieldsForm({ fields, url, method, own = false }: Props) {
  const { t } = useT();
  const { label: fieldLabel } = useFieldText();
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(fields.map((field) => [field.name, field.value])));
  const [issues, setIssues] = useState<IssueMap>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const editable = fields.filter((field) => !own || field.selfEditable);

  if (!fields.length) return null;

  const save = async () => {
    setSaving(true);
    setIssues({});
    setError(null);
    setSaved(false);
    try {
      await api(url, { method, body: { values: Object.fromEntries(editable.map((field) => [field.name, values[field.name] ?? ""])) } });
      setSaved(true);
    } catch (err) {
      setIssues(issuesOf(err));
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={t("userFields.moreDetails")}>
      {error && <Alert>{error}</Alert>}
      {saved && <Alert kind="success">{t("userFields.saved")}</Alert>}
      {fields.map((field) => (own && !field.selfEditable ? (
        <div key={field.id}>
          <p className="cms-label">{fieldLabel(field)}</p>
          <p className="cms-text-sm cms-soft">{show(field.value, t("userFields.notSet"))}</p>
        </div>
      ) : (
        <FieldValueInput
          key={field.id}
          field={{ id: `user-${field.id}`, name: field.name, type: field.type, config: field.config }}
          input={field.input}
          value={values[field.name]}
          onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
          error={issueFor(issues, field.name)}
        />
      )))}
      {editable.length > 0 && <Button loading={saving} onClick={() => void save()}>{t("userFields.saveValues")}</Button>}
    </Card>
  );
}
