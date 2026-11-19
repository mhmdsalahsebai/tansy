"use client";

import { CubeIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useFieldTypeText, useT } from "../i18n";
import { Button, Input } from "../ui/kit";
import FieldConfigEditor from "./FieldConfigEditor";
import { fieldIcons } from "./icons";
import type { ReactNode } from "react";
import { useApi } from "../../lib/client/api";
import { apiPath } from "../../lib/paths";
import type { DraftField, FieldPresetInfo, FieldTypeInfo, IssueMap } from "./types";

interface Props {
  fields: DraftField[];
  onChange: (fields: DraftField[]) => void;
  types: FieldTypeInfo[];
  collections: Array<{ id: number; name: string }>;
  issues: IssueMap;
  omitOptions?: string[];
  /** Extra controls under each field. */
  extra?: (field: DraftField, index: number) => ReactNode;
  /** A collection with localization on, whose fields can each hold a value per language. */
  localized?: boolean;
}

const selectClass = "cms-input";

const presetFieldName = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Adds, edits and removes fields. Shared by the create and edit screens. */
export default function FieldListEditor({ fields, onChange, types, collections, issues, omitOptions, extra, localized = false }: Props) {
  const { t } = useT();
  const { label: typeLabel, description: typeDescription } = useFieldTypeText();
  const omit = localized ? omitOptions : [...(omitOptions ?? []), "localized", "synced"];
  const update = (key: string, patch: Partial<DraftField>) => onChange(fields.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  const add = (type: string) => onChange([...fields, { key: crypto.randomUUID(), name: "", type, config: {} }]);
  // Someone who can't list presets, or a form with no use for them, just sees no presets.
  const presets = (useApi<FieldPresetInfo[]>(apiPath("/field-presets")).data ?? []).filter((preset) => types.some((type) => type.type === preset.type));
  // A copy: changing or deleting the preset later leaves this field alone.
  const addPreset = (preset: FieldPresetInfo) => onChange([...fields, { key: crypto.randomUUID(), name: presetFieldName(preset.name), type: preset.type, config: Object.fromEntries(Object.entries(structuredClone(preset.config)).filter(([option]) => !omitOptions?.includes(option))) }]);

  return (
    <div className="cms-stack-4">
      {fields.map((field, index) => {
        const info = types.find((type) => type.type === field.type);
        const nameError = issues[`fields.${index}.name`];
        const typeError = issues[`fields.${index}.type`];
        return (
          <div key={field.key} data-testid="field-row" className="cms-panel cms-stack-3 cms-p-4">
            <div className="cms-flex cms-wrap cms-start cms-gap-3">
              <div className="cms-min-48 cms-grow">
                <label htmlFor={`name-${field.key}`} className="cms-label cms-mb-1">{t("fieldEditor.fieldName")}</label>
                <Input id={`name-${field.key}`} value={field.name} placeholder="blog_title" onChange={(e) => update(field.key, { name: e.target.value })} />
                {nameError && <p className="cms-error cms-mt-1">{nameError}</p>}
              </div>
              <div className="cms-min-40 cms-grow">
                <label htmlFor={`type-${field.key}`} className="cms-label cms-mb-1">{t("fieldEditor.type")}</label>
                <select id={`type-${field.key}`} className={selectClass} value={field.type} disabled={!info} onChange={(e) => update(field.key, { type: e.target.value, config: {} })}>
                  {!info && <option value={field.type}>{field.type}</option>}
                  {types.map((type) => <option key={type.type} value={type.type}>{typeLabel(type)}</option>)}
                </select>
                {!info && <p className="cms-warning-text cms-mt-1">{t("fieldEditor.missingPlugin")}</p>}
                {typeError && <p className="cms-error cms-mt-1">{typeError}</p>}
              </div>
              <Button variant="secondary" aria-label={field.name ? t("fieldEditor.remove", { name: field.name }) : t("fieldEditor.removeField")} className="cms-mt-6" onClick={() => onChange(fields.filter((f) => f.key !== field.key))}>
                <TrashIcon className="cms-icon-md" />
              </Button>
            </div>
            {info && (
              <FieldConfigEditor
                type={field.type}
                plugin={info.plugin}
                schema={info.configSchema}
                config={field.config}
                onChange={(config) => update(field.key, { config })}
                collections={collections}
                issues={issues}
                issuePrefix={`fields.${index}.config`}
                idPrefix={`${field.key}-${field.type}`}
                omit={omit}
              />
            )}
            {extra?.(field, index)}
          </div>
        );
      })}

      <div className="cms-panel cms-p-4">
        <h3 className="cms-label cms-mb-3">{t("fieldEditor.addField")}</h3>
        {presets.length > 0 && (
          <div className="cms-flex cms-wrap cms-gap-2 cms-mb-3" data-testid="field-presets">
            {presets.map((preset) => <Button key={preset.id} variant="secondary" className="cms-cell-mini cms-text-xs" onClick={() => addPreset(preset)}>{preset.name}</Button>)}
          </div>
        )}
        <div className="cms-grid cms-cols-2 cms-gap-3 cms-md-4">
          {types.map((type) => {
            const Icon = fieldIcons[type.type] ?? CubeIcon;
            const description = typeDescription(type);
            return (
              <button key={type.type} type="button" onClick={() => add(type.type)} className="cms-choice">
                <Icon className="cms-icon-md cms-mb-1 cms-soft" />
                <span className="cms-block cms-text-sm cms-medium cms-strong">{typeLabel(type)}</span>
                {description && <span className="cms-hint cms-block">{description}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
