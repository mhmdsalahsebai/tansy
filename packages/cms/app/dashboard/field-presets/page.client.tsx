"use client";

import { useState } from "react";
import FieldConfigEditor from "../../../components/fields/FieldConfigEditor";
import { issuesOf, type FieldPresetInfo, type FieldTypeInfo, type IssueMap } from "../../../components/fields/types";
import { useFieldTypeText, useT } from "../../../components/i18n";
import { PlusIcon, SwatchIcon } from "@heroicons/react/24/outline";
import { Alert, Badge, Button, DataTable, Input, PageHeader } from "../../../components/ui/kit";
import { api, errorText } from "../../../lib/client/api";
import { apiPath } from "../../../lib/paths";

interface Props {
  initial: FieldPresetInfo[];
  types: FieldTypeInfo[];
  collections: Array<{ id: number; name: string }>;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

interface Draft {
  id?: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
}

const byName = (a: FieldPresetInfo, b: FieldPresetInfo) => a.name.localeCompare(b.name);

/** Named field types with their settings, offered when building a collection or block. */
export default function FieldPresetsPage({ initial, types, collections, canCreate, canEdit, canDelete }: Props) {
  const { t } = useT();
  const { label: typeLabel } = useFieldTypeText();
  const [presets, setPresets] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<IssueMap>({});
  const info = types.find((type) => type.type === draft?.type);

  const open = (next: Draft) => { setDraft(next); setError(null); setIssues({}); };

  const save = async () => {
    if (!draft) return;
    try {
      const saved = draft.id
        ? await api<FieldPresetInfo>(apiPath(`/field-presets/${draft.id}`), { method: "PUT", body: { name: draft.name, config: draft.config } })
        : await api<FieldPresetInfo>(apiPath("/field-presets"), { method: "POST", body: draft });
      setPresets([...presets.filter((preset) => preset.id !== saved.id), saved].sort(byName));
      setDraft(null);
    } catch (err) {
      setError(errorText(err));
      setIssues(issuesOf(err));
    }
  };

  const remove = async (id: number) => {
    try {
      await api(apiPath(`/field-presets/${id}`), { method: "DELETE" });
      setPresets(presets.filter((preset) => preset.id !== id));
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="cms-gutter">
      <PageHeader
        title={t("fieldPresets.title")}
        description={t("fieldPresets.description")}
        actions={canCreate && types.length > 0 ? <Button onClick={() => open({ name: "", type: types[0].type, config: {} })}><PlusIcon className="cms-icon" aria-hidden="true" />{t("fieldPresets.newPreset")}</Button> : undefined}
      />
      {error && <div className="cms-mb-4"><Alert>{error}</Alert></div>}
      {draft && (
        <div className="cms-panel cms-stack-3 cms-p-4 cms-mb-4">
          <div className="cms-grid cms-gap-3 cms-sm-2">
            <div>
              <label htmlFor="preset-name" className="cms-label cms-mb-1">{t("fieldPresets.name")}</label>
              <Input id="preset-name" value={draft.name} placeholder={t("fieldPresets.namePlaceholder")} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              {issues.name && <p className="cms-error cms-mt-1">{issues.name}</p>}
            </div>
            <div>
              <label htmlFor="preset-type" className="cms-label cms-mb-1">{t("fieldPresets.type")}</label>
              <select id="preset-type" className="cms-input" value={draft.type} disabled={draft.id !== undefined} onChange={(e) => setDraft({ ...draft, type: e.target.value, config: {} })}>
                {types.map((type) => <option key={type.type} value={type.type}>{typeLabel(type)}</option>)}
              </select>
            </div>
          </div>
          {info && <FieldConfigEditor type={draft.type} plugin={info.plugin} schema={info.configSchema} config={draft.config} onChange={(config) => setDraft({ ...draft, config })} collections={collections} issues={issues} issuePrefix="config" idPrefix={`preset-${draft.type}`} />}
          <div className="cms-flex cms-end cms-gap-2">
            <Button variant="secondary" onClick={() => setDraft(null)}>{t("fieldPresets.cancel")}</Button>
            <Button disabled={!draft.name.trim()} onClick={() => void save()}>{t("fieldPresets.save")}</Button>
          </div>
        </div>
      )}
      <DataTable
        label={t("fieldPresets.title")}
        columns={[{ id: "name", label: t("fieldPresets.name") }, { id: "type", label: t("fieldPresets.type") }]}
        rows={presets.map((preset) => {
          const info = types.find((type) => type.type === preset.type);
          return {
            id: preset.id,
            cells: { name: preset.name, type: info ? <Badge>{typeLabel(info)}</Badge> : <Badge tone="warning">{t("fieldPresets.notInstalled", { type: preset.type })}</Badge> },
            actions: (
              <>
                {canEdit && info && <button type="button" className="cms-row-action" onClick={() => open({ id: preset.id, name: preset.name, type: preset.type, config: preset.config })}>{t("fieldPresets.edit")}</button>}
                {canDelete && <button type="button" className="cms-row-action cms-row-action-danger" onClick={() => void remove(preset.id)}>{t("fieldPresets.delete")}</button>}
              </>
            ),
          };
        })}
        empty={{ icon: <SwatchIcon />, title: t("fieldPresets.empty") }}
      />
    </div>
  );
}
