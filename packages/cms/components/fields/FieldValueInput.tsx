"use client";

import { useFieldText, useT } from "../i18n";
import { createElement, useState } from "react";
import { useAdminClient } from "../admin-client";
import StreamEditor, { type StreamConfig } from "../stream/StreamEditor";
import type { Field } from "../../types/content";
import type { EditorInput } from "../../core/fields/define";
import ReferencePicker from "./ReferencePicker";
import FileValueInput from "./FileValueInput";
import { PluginBoundary } from "../PluginBoundary";
import RichTextEditor from "./RichTextEditor";
import type { EditorCatalog, IssueMap } from "./types";

interface Choice {
  label: string;
  /** The label in other interface languages. */
  labels?: Record<string, string>;
  value: string;
  disabled?: boolean;
}

interface Props {
  /** Block fields have no database id, so theirs is a string. */
  field: Pick<Field, "name" | "type" | "config"> & { id: number | string };
  input: EditorInput;
  value: unknown;
  onChange: (value: unknown) => void;
  error?: string;
  /** Passed to a plugin's control. */
  disabled?: boolean;
  readOnly?: boolean;
  /** Needed for stream fields. */
  catalog?: EditorCatalog;
  issues?: IssueMap;
  issuePath?: string;
  depth?: number;
}

const inputClass = "cms-input cms-mt-1";

const asText = (value: unknown) => (value === null || value === undefined ? "" : String(value));

function toLocalDateTime(value: unknown) {
  if (!value) return "";
  const date = new Date(value as string);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** Stops the form submitting invalid JSON, since the parent only ever holds parsed values. */
function JsonInput({ field, value, onChange }: Props) {
  const [text, setText] = useState(value === null || value === undefined || value === "" ? "" : JSON.stringify(value, null, 2));
  return (
    <textarea
      id={`field-${field.id}`}
      rows={6}
      className={`${inputClass} cms-mono`}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value.trim() === "") {
          e.target.setCustomValidity("");
          onChange("");
          return;
        }
        try {
          onChange(JSON.parse(e.target.value));
          e.target.setCustomValidity("");
        } catch {
          e.target.setCustomValidity("Enter valid JSON.");
        }
      }}
    />
  );
}

function Control(props: Props) {
  const { field, input, value, onChange } = props;
  const { fieldAdmin } = useAdminClient();
  const { t } = useT();
  const { choice } = useFieldText();
  const id = `field-${field.id}`;
  if (input === "unavailable") {
    return (
      <div id={id} className="cms-notice cms-mt-1">
        <p>{t("fieldValue.pluginMissing")}</p>
        {value !== null && value !== undefined && value !== "" && <pre className="cms-mt-1 cms-scroll-x cms-mono cms-text-xs">{typeof value === "object" ? JSON.stringify(value, null, 2) : String(value)}</pre>}
      </div>
    );
  }
  const custom = fieldAdmin.find((definition) => definition.type === field.type);
  if (custom?.Input) {
    return <PluginBoundary plugin={custom.plugin}>{createElement(custom.Input, { id, field, value, onChange, path: props.issuePath ?? field.name, error: props.error, disabled: props.disabled === true, readOnly: props.readOnly === true })}</PluginBoundary>;
  }
  if (input === "custom") return <div id={id} className="cms-notice cms-mt-1"><p>{t("fieldValue.noControl")}</p></div>;
  const choices = ((field.config?.options ?? []) as Choice[]).map((option) => ({ ...option, label: choice(option) }));
  const toNumber = (text: string) => onChange(text === "" ? "" : Number(text));

  switch (input) {
    case "richtext":
      return <RichTextEditor value={value} onChange={onChange} label={String(field.config?.label || field.name)} allowedFeatures={field.config?.allowedFeatures as string[] | Record<string, boolean> | undefined} />;
    case "stream":
      if (!props.catalog) return null;
      return <StreamEditor value={value} onChange={onChange} config={(field.config ?? {}) as StreamConfig} catalog={props.catalog} issues={props.issues ?? {}} path={props.issuePath ?? field.name} depth={props.depth ?? 1} label={String(field.config?.label || field.name)} />;
    case "image":
    case "file":
    case "gallery":
      return <FileValueInput id={id} kind={input} value={value} onChange={onChange} allowedTypes={field.config?.allowedTypes as string[] | undefined} />;
    case "number":
      return <input id={id} type="number" step="any" className={inputClass} value={asText(value)} onChange={(e) => toNumber(e.target.value)} />;
    case "reference":
      return <ReferencePicker id={id} collectionId={Number(field.config?.collection)} multiple={Boolean(field.config?.allowMultiple)} value={value} onChange={onChange} inputClass={inputClass} />;
    case "boolean":
      return <input id={id} type="checkbox" className="cms-check cms-mt-2" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
    case "date":
      return <input id={id} type="date" className={inputClass} value={asText(value)} onChange={(e) => onChange(e.target.value)} />;
    case "datetime":
      return <input id={id} type="datetime-local" className={inputClass} value={toLocalDateTime(value)} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : "")} />;
    case "email":
      return <input id={id} type="email" className={inputClass} value={asText(value)} onChange={(e) => onChange(e.target.value)} />;
    case "url":
      return <input id={id} type="url" className={inputClass} value={asText(value)} onChange={(e) => onChange(e.target.value)} />;
    case "code":
      return <textarea id={id} rows={8} className={`${inputClass} cms-mono`} value={asText(value)} onChange={(e) => onChange(e.target.value)} />;
    case "select":
      return (
        <select id={id} className={inputClass} value={asText(value)} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t("fieldValue.select")}</option>
          {choices.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
        </select>
      );
    case "multiselect": {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="cms-mt-2 cms-stack-1">
          {choices.map((o) => (
            <label key={o.value} className="cms-check-label">
              <input
                type="checkbox"
                className="cms-check"
                disabled={o.disabled}
                checked={selected.includes(o.value)}
                onChange={(e) => onChange(e.target.checked ? [...selected, o.value] : selected.filter((item) => item !== o.value))}
              />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    case "json":
      return <JsonInput {...props} />;
    default:
      if (field.config?.multiline) return <textarea id={id} rows={Number(field.config.rows ?? 3)} className={inputClass} value={asText(value)} onChange={(e) => onChange(e.target.value)} />;
      return <input id={id} type="text" className={inputClass} value={asText(value)} onChange={(e) => onChange(e.target.value)} />;
  }
}

export default function FieldValueInput(props: Props) {
  const { field, error } = props;
  const text = useFieldText();
  const description = text.description(field);
  return (
    <div>
      <label htmlFor={`field-${field.id}`} className="cms-label">
        {text.label(field)}
        {field.config?.required ? <span className="cms-danger"> *</span> : null}
      </label>
      <Control {...props} />
      {description && <p className="cms-muted cms-mt-2">{description}</p>}
      {error && <p className="cms-error cms-mt-1">{error}</p>}
    </div>
  );
}
