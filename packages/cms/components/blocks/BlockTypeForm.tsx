"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BLOCK_ICONS } from "./block-icons";
import FieldListEditor from "../fields/FieldListEditor";
import { issuesOf, toRequest, type BlockTypeInfo, type DraftField, type FieldTypeInfo, type IssueMap } from "../fields/types";
import { useSchemaText, useT } from "../i18n";
import { LabelsInput, labelsBody } from "../LabelsInput";
import { Alert, Button, Card, Field, Input, PageHeader } from "../ui/kit";
import { api, errorText } from "../../lib/client/api";
import { adminPath, apiPath } from "../../lib/paths";

// The server refuses these on block fields (core/blocks/service.ts).
const UNSUPPORTED_OPTIONS = ["unique", "hidden", "readonly", "defaultValue", "searchable"];

interface Props {
  initial?: BlockTypeInfo;
  fieldTypes: FieldTypeInfo[];
  collections: Array<{ id: number; name: string }>;
}

const toDrafts = (fields: BlockTypeInfo["fields"]): DraftField[] =>
  fields.map((field) => ({ key: crypto.randomUUID(), name: field.name, type: field.type, config: (field.config ?? {}) as Record<string, unknown> }));

export default function BlockTypeForm({ initial, fieldTypes, collections }: Props) {
  const { t } = useT();
  const router = useRouter();
  const [name, setName] = useState(initial?.name ?? "");
  const schemaText = useSchemaText();
  const [label, setLabel] = useState(initial?.label ?? "");
  const [labels, setLabels] = useState<Record<string, string>>({ ...initial?.labels });
  const [icon, setIcon] = useState(initial?.icon ?? "");
  const [fields, setFields] = useState<DraftField[]>(() => toDrafts(initial?.fields ?? []));
  const [issues, setIssues] = useState<IssueMap>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setIssues({});
    setError(null);
    try {
      const body = { label, labels: labelsBody(labels), icon: icon || undefined, fields: toRequest(fields) };
      if (initial) await api(apiPath(`/block-types/${initial.id}`), { method: "PUT", body });
      else await api(apiPath("/block-types"), { method: "POST", body: { ...body, name } });
      router.push(adminPath("/blocks"));
      router.refresh();
    } catch (err) {
      setIssues(issuesOf(err));
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cms-p-6">
      <PageHeader
        title={initial ? t("blocks.editTitle", { label: schemaText.block(initial) }) : t("blocks.newBlock")}
        description={initial ? t("blocks.editDescription", { version: initial.version }) : t("blocks.newDescription")}
        back={{ href: adminPath("/blocks"), label: t("blocks.backToBlocks") }}
      />
      <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="cms-stack-6">
        {error && <Alert>{error}</Alert>}
        {initial?.managedBy && <Alert kind="warning">{t("blocks.managedBy", { plugin: initial.managedBy })}</Alert>}
        <fieldset disabled={Boolean(initial?.managedBy)} className="cms-stack-6">
        <Card>
          <Field label={t("blocks.label")}><Input required value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
          <LabelsInput value={labels} maxLength={120} onChange={setLabels} />
          <Field label={t("blocks.name")} hint={t(initial ? "blocks.nameFixed" : "blocks.nameHint")}>
            <Input required disabled={Boolean(initial)} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {issues.name && <p className="cms-error">{issues.name}</p>}
          <Field label={t("blocks.icon")} hint={t("blocks.iconHint")}>
            <select className="cms-input" value={icon} onChange={(e) => setIcon(e.target.value)}>
              <option value="">{t("blocks.none")}</option>
              {Object.keys(BLOCK_ICONS).map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </Field>
        </Card>
        <FieldListEditor fields={fields} onChange={setFields} types={fieldTypes} collections={collections} issues={issues} omitOptions={UNSUPPORTED_OPTIONS} />
        </fieldset>
        {!initial?.managedBy && <div className="cms-flex cms-end"><Button type="submit" loading={saving}>{t("blocks.save")}</Button></div>}
      </form>
    </div>
  );
}
