"use client";

import { createElement, useState } from "react";
import { useAdminClient } from "../admin-client";
import { PluginBoundary } from "../PluginBoundary";
import { useSchemaText, useT, useTOr } from "../i18n";
import { Input } from "../ui/kit";
import type { JsonSchema, IssueMap } from "./types";

interface CollectionOption {
  id: number;
  name: string;
  labels?: Record<string, string> | null;
}

interface Props {
  /** The field type, for a plugin's own config form. */
  type: string;
  /** The plugin that registered the type, whose `messages` name its options under `fieldTypes.<type>.options`. */
  plugin?: string;
  schema: JsonSchema;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  collections: CollectionOption[];
  issues: IssueMap;
  issuePrefix: string;
  /** Includes the field's type, so a type change remounts the text-based controls. */
  idPrefix: string;
  /** Options this context can't honour. */
  omit?: string[];
}

const RULES = ["required", "unique", "readonly", "hidden", "localized"];
const DISPLAY = ["label", "description", "placeholder", "hint", "defaultValue"];
const selectClass = "cms-input";
const areaClass = `${selectClass} cms-mono`;

interface ControlProps {
  id: string;
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  collections: CollectionOption[];
}

interface Option {
  value: string;
  label: string;
  [key: string]: unknown;
}

function OptionsControl({ id, value, onChange }: ControlProps) {
  const { t } = useT();
  const current = Array.isArray(value) ? (value as Option[]) : [];
  const [text, setText] = useState(current.map((o) => (o.label === o.value ? o.value : `${o.value} | ${o.label}`)).join("\n"));
  return (
    <textarea
      id={id}
      rows={4}
      className={areaClass}
      placeholder={t("fieldEditor.optionsPlaceholder")}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const parsed = e.target.value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
          const [optionValue, label] = line.split("|").map((part) => part.trim());
          return { ...current.find((o) => o.value === optionValue), value: optionValue, label: label || optionValue };
        });
        onChange(parsed.length ? parsed : undefined);
      }}
    />
  );
}

function ListControl({ id, value, onChange }: ControlProps) {
  const { t } = useT();
  const [text, setText] = useState(Array.isArray(value) ? value.join(", ") : "");
  return (
    <Input
      id={id}
      placeholder={t("fieldEditor.commaSeparated")}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const items = e.target.value.split(",").map((item) => item.trim()).filter(Boolean);
        onChange(items.length ? items : undefined);
      }}
    />
  );
}

/** For config with no simpler control. Schema-less values, like a default, may also be plain text. */
function JsonControl({ id, schema, value, onChange }: ControlProps) {
  const { t } = useT();
  const freeform = schema.type === undefined;
  const initial = value === undefined ? "" : freeform && typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const [text, setText] = useState(initial);
  return (
    <textarea
      id={id}
      rows={2}
      className={areaClass}
      value={text}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        e.target.setCustomValidity("");
        if (next.trim() === "") return onChange(undefined);
        try {
          onChange(JSON.parse(next));
        } catch {
          if (freeform) onChange(next);
          else e.target.setCustomValidity(t("fieldEditor.invalidJson"));
        }
      }}
    />
  );
}

function Control(props: ControlProps) {
  const { t } = useT();
  const schemaText = useSchemaText();
  const tOr = useTOr();
  const { id, schema, value, onChange, collections } = props;
  if (schema.widget === "options") return <OptionsControl {...props} />;
  if (schema.widget === "collection") {
    return (
      <select id={id} className={selectClass} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}>
        <option value="">{t("fieldEditor.selectCollection")}</option>
        {collections.map((c) => <option key={c.id} value={c.id}>{schemaText.collection(c)}</option>)}
      </select>
    );
  }
  if (schema.enum) {
    return (
      <select id={id} className={selectClass} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">{t("fieldEditor.default")}</option>
        {schema.enum.map((option) => <option key={String(option)} value={String(option)}>{tOr(`fieldEditor.choices.${String(option)}`, String(option))}</option>)}
      </select>
    );
  }
  if (schema.type === "number" || schema.type === "integer") {
    return <Input id={id} type="number" step="any" value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />;
  }
  if (schema.type === "string") return <Input id={id} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value || undefined)} />;
  if (schema.type === "array" && schema.items?.type === "string") return <ListControl {...props} />;
  return <JsonControl {...props} />;
}

export default function FieldConfigEditor({ type, plugin, schema, config, onChange, collections, issues, issuePrefix, idPrefix, omit }: Props) {
  const { t } = useT();
  const tOr = useTOr();
  // A plugin's own option has no catalog entry, so it shows its name as words.
  const titleOf = (key: string) => {
    const humanized = key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
    return tOr(`fieldEditor.options.${key}`, plugin ? tOr(`ext.${plugin}.fieldTypes.${type}.options.${key}`, humanized) : humanized);
  };
  const custom = useAdminClient().fieldAdmin.find((definition) => definition.type === type);
  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([key]) => !omit?.includes(key)));
  const required = new Set(schema.required ?? []);
  const set = (key: string, value: unknown) => {
    const next = { ...config };
    if (value === undefined || value === false) delete next[key];
    else next[key] = value;
    onChange(next);
  };

  const row = (key: string) => {
    const property = properties[key];
    const id = `${idPrefix}-${key}`;
    const error = issues[`${issuePrefix}.${key}`];
    if (property.type === "boolean") {
      return (
        <div key={key}>
          <label className="cms-check-label">
            <input type="checkbox" className="cms-check" checked={config[key] === true} onChange={(e) => set(key, e.target.checked)} />
            {titleOf(key)}
          </label>
          {error && <p className="cms-error cms-mt-1">{error}</p>}
        </div>
      );
    }
    return (
      <div key={key}>
        <label htmlFor={id} className="cms-label cms-mb-1">
          {titleOf(key)}{required.has(key) && <span className="cms-danger"> *</span>}
        </label>
        <Control key={id} id={id} schema={property} value={config[key]} onChange={(value) => set(key, value)} collections={collections} />
        {error && <p className="cms-error cms-mt-1">{error}</p>}
      </div>
    );
  };

  const specific = Object.keys(properties).filter((key) => !RULES.includes(key) && !DISPLAY.includes(key));
  const mandatory = specific.filter((key) => required.has(key));
  const optional = specific.filter((key) => !required.has(key));

  return (
    <div className="cms-stack-3">
      <div className="cms-flex cms-wrap cms-gap-spread">{RULES.filter((key) => properties[key]).map(row)}</div>
      {custom?.ConfigInput
        ? <PluginBoundary plugin={custom.plugin}>{createElement(custom.ConfigInput, { idPrefix, type, config, onChange, issues, issuePrefix })}</PluginBoundary>
        : mandatory.map(row)}
      <details className="cms-box">
        <summary className="cms-summary">{t("fieldEditor.moreOptions")}</summary>
        <div className="cms-mt-3 cms-grid cms-gap-3 cms-sm-2">{[...(custom?.ConfigInput ? [] : optional), ...DISPLAY.filter((key) => properties[key])].map(row)}</div>
      </details>
    </div>
  );
}
