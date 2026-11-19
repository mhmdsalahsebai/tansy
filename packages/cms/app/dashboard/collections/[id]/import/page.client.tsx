"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowUpTrayIcon } from "@heroicons/react/24/outline";
import { Alert, Badge, Button, ButtonLink, Card, DataTable, Field, PageHeader, Skeleton } from "../../../../../components/ui/kit";
import { useT } from "../../../../../components/i18n";
import { api, errorText, useApi } from "../../../../../lib/client/api";
import type { Collection } from "../../../../../types/content";
import { adminPath, apiPath } from "../../../../../lib/paths";

interface ImportField {
  name: string;
  type: string;
  multiple: boolean;
  required: boolean;
  unique: boolean;
  json: boolean;
}

interface Preview {
  columns: string[];
  total: number;
  mapping: Record<string, string>;
  sample: Array<Record<string, unknown>>;
  problems?: Array<{ line: number; message: string }>;
}

interface Result {
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  failed: number;
  remaining: number;
  rows: Array<{ row: number; action: string; id?: number; error?: string; field?: string }>;
}

const LEAVE_OUT = "";

/** A cell as the file holds it, for the sample table. */
const cell = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value) ?? "");

export default function ImportPage({ collection, canUpdate }: { collection: Collection; canUpdate: boolean }) {
  const { t } = useT();
  const path = apiPath(`/collections/${collection.id}/import`);
  const { data: schema } = useApi<{ fields: ImportField[]; maxRows: number }>(path);
  const [fileName, setFileName] = useState<string | null>(null);
  const [payload, setPayload] = useState<{ csv?: string; rows?: Array<Record<string, unknown>> } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [keyField, setKeyField] = useState("");
  const [status, setStatus] = useState<"draft" | "published">("draft");
  const [onError, setOnError] = useState<"stop" | "skip">("stop");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fields = schema?.fields ?? [];
  const unique = fields.filter((field) => field.unique && !field.multiple && !field.json);

  const choose = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setPreview(null);
    try {
      const text = await file.text();
      // A JSON file is read here, so the API always takes rows or CSV, never a file.
      const body = /\.json$/i.test(file.name) ? { rows: asRows(text) } : { csv: text };
      const answer = await api<Preview>(path, { method: "POST", body: { ...body, preview: true } });
      setFileName(file.name);
      setPayload(body);
      setPreview(answer);
      setMapping(answer.mapping);
    } catch (err) {
      setError(errorText(err));
      setFileName(null);
      setPayload(null);
    } finally {
      setBusy(false);
    }
  };

  const run = async (dryRun: boolean) => {
    if (!payload) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api<Result>(path, { method: "POST", body: { ...payload, mapping, keyField: keyField || undefined, status, onError, dryRun } }));
    } catch (err) {
      setError(errorText(err));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const mapped = Object.values(mapping).filter((name) => name !== LEAVE_OUT);
  const duplicate = mapped.find((name, at) => mapped.indexOf(name) !== at);
  const ready = preview !== null && mapped.length > 0 && !duplicate;

  return (
    <div className="cms-gutter cms-stack-6">
      <PageHeader
        title={t("import.title", { name: collection.name })}
        description={t("import.description")}
        back={{ href: adminPath(`/collections/${collection.id}`), label: t("import.backToRecords") }}
      />
      {error && <Alert>{error}</Alert>}

      <Card title={t("import.fileTitle")} description={schema ? t("import.fileHelp", { max: schema.maxRows }) : undefined}>
        {!schema && <Skeleton height="control" />}
        {schema && (
          <div className="cms-row cms-gap-3">
            <label className={`cms-btn cms-btn-secondary cms-btn-label ${busy ? "cms-dimmed" : ""}`}>
              {t("import.chooseFile")}
              <input type="file" accept=".csv,.tsv,.json,text/csv,application/json" className="cms-sr-only" disabled={busy} onChange={(e) => { void choose(e.target.files); e.target.value = ""; }} />
            </label>
            {fileName && <span className="cms-muted">{fileName}</span>}
          </div>
        )}
      </Card>

      {preview && (
        <>
          {preview.problems?.map((problem) => <Alert key={`${problem.line}-${problem.message}`} kind="warning">{t("import.lineProblem", { line: problem.line, message: problem.message })}</Alert>)}
          <Card title={t("import.columnsTitle")} description={t("import.columnsHelp", { count: preview.total })}>
            <div className="cms-stack-4">
              {duplicate && <Alert>{t("import.duplicateField", { name: duplicate })}</Alert>}
              <DataTable
                label={t("import.columnsTitle")}
                columns={[{ id: "column", label: t("import.column") }, { id: "field", label: t("import.field") }, { id: "sample", label: t("import.sample") }]}
                rows={preview.columns.map((column) => ({
                  id: column,
                  cells: {
                    column: <span className="cms-mono cms-text-xs">{column}</span>,
                    field: (
                      <select aria-label={t("import.fieldFor", { column })} className="cms-input" value={mapping[column] ?? LEAVE_OUT} onChange={(e) => setMapping({ ...mapping, [column]: e.target.value })}>
                        <option value={LEAVE_OUT}>{t("import.leaveOut")}</option>
                        {fields.map((field) => <option key={field.name} value={field.name}>{field.name}{field.required ? " *" : ""}</option>)}
                      </select>
                    ),
                    sample: <span className="cms-truncate cms-muted">{preview.sample.map((row) => cell(row[column])).filter(Boolean).slice(0, 2).join(" · ")}</span>,
                  },
                }))}
                empty={{ title: t("import.noColumns") }}
              />
            </div>
          </Card>

          <Card title={t("import.optionsTitle")}>
            <Field label={t("import.status")} hint={t("import.statusHint")}>
              <select aria-label={t("import.status")} className="cms-input" value={status} onChange={(e) => setStatus(e.target.value as "draft" | "published")}>
                <option value="draft">{t("import.draft")}</option>
                <option value="published">{t("import.published")}</option>
              </select>
            </Field>
            <Field label={t("import.keyField")} hint={canUpdate ? t("import.keyFieldHint") : t("import.keyFieldDenied")}>
              <select aria-label={t("import.keyField")} className="cms-input" value={keyField} disabled={!canUpdate || !unique.length} onChange={(e) => setKeyField(e.target.value)}>
                <option value="">{t("import.alwaysCreate")}</option>
                {unique.map((field) => <option key={field.name} value={field.name}>{field.name}</option>)}
              </select>
            </Field>
            <Field label={t("import.onError")} hint={t("import.onErrorHint")}>
              <select aria-label={t("import.onError")} className="cms-input" value={onError} onChange={(e) => setOnError(e.target.value as "stop" | "skip")}>
                <option value="stop">{t("import.stop")}</option>
                <option value="skip">{t("import.skip")}</option>
              </select>
            </Field>
            <div className="cms-flex cms-end cms-gap-2">
              <Button variant="secondary" loading={busy} disabled={!ready} onClick={() => void run(true)}>{t("import.check")}</Button>
              <Button loading={busy} disabled={!ready} onClick={() => void run(false)}>{t("import.import")}</Button>
            </div>
          </Card>
        </>
      )}

      {result && (
        <Card
          title={result.dryRun ? t("import.checkedTitle") : t("import.doneTitle")}
          actions={!result.dryRun && result.created + result.updated > 0 ? <ButtonLink variant="secondary" href={adminPath(`/collections/${collection.id}`)}>{t("import.seeRecords")}</ButtonLink> : undefined}
        >
          <div className="cms-stack-4">
            <p className="cms-row cms-gap-2">
              <Badge tone="success">{t("import.created", { count: result.created })}</Badge>
              <Badge tone="info">{t("import.updated", { count: result.updated })}</Badge>
              <Badge tone={result.failed ? "danger" : "neutral"}>{t("import.failed", { count: result.failed })}</Badge>
              {result.remaining > 0 && <Badge tone="warning">{t("import.remaining", { count: result.remaining })}</Badge>}
            </p>
            {result.dryRun && result.failed === 0 && <Alert kind="success">{t("import.allGood")}</Alert>}
            {result.failed > 0 && (
              <DataTable
                label={t("import.problems")}
                columns={[{ id: "row", label: t("import.row") }, { id: "field", label: t("import.field") }, { id: "error", label: t("import.problem") }]}
                rows={result.rows.filter((row) => row.action === "failed").map((row) => ({
                  id: row.row,
                  cells: { row: row.row, field: row.field ? <span className="cms-mono cms-text-xs">{row.field}</span> : null, error: row.error },
                }))}
                empty={{ title: t("import.noProblems") }}
              />
            )}
            {!result.dryRun && result.created + result.updated > 0 && (
              <p className="cms-muted">
                <Link className="cms-link-quiet" href={adminPath(`/collections/${collection.id}`)}>{t("import.seeRecords")}</Link>
              </p>
            )}
          </div>
        </Card>
      )}

      {!preview && !busy && (
        <p className="cms-muted cms-row cms-gap-2"><ArrowUpTrayIcon className="cms-icon" aria-hidden="true" />{t("import.start")}</p>
      )}
    </div>
  );
}

/** A JSON file: an array of rows, or one row per line. */
function asRows(text: string): Array<Record<string, unknown>> {
  const trimmed = text.trim();
  const rows = trimmed.startsWith("[")
    ? JSON.parse(trimmed)
    : trimmed.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error("A JSON file holds a list of objects, or one object per line.");
  }
  return rows as Array<Record<string, unknown>>;
}
