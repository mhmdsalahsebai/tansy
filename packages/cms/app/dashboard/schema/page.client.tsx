"use client";

import { useState } from "react";
import { useT } from "../../../components/i18n";
import { Alert, Button, Card, PageHeader } from "../../../components/ui/kit";
import { api, errorText } from "../../../lib/client/api";
import { apiPath } from "../../../lib/paths";

interface Step { action: string; target: string; detail?: string }
interface Result { dryRun: boolean; steps: Step[] }

export default function SchemaPage({ canImport }: { canImport: boolean }) {
  const { t } = useT();
  const [text, setText] = useState("");
  const [deleteMissing, setDeleteMissing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setError(null);
    try {
      const document_ = await api(apiPath("/schema/export"));
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([JSON.stringify(document_, null, 2)], { type: "application/json" }));
      link.download = "cms-schema.json";
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const submit = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api<Result>(apiPath("/schema/import"), { method: "POST", body: { document: JSON.parse(text), dryRun, deleteMissing, confirm } }));
    } catch (err) {
      setError(err instanceof SyntaxError ? t("schemaTransfer.invalidJson") : errorText(err));
    }
    setBusy(false);
  };

  return (
    <div className="cms-stack-6 cms-p-6">
      <PageHeader title={t("schemaTransfer.title")} description={t("schemaTransfer.description")} />
      {error && <Alert>{error}</Alert>}
      <Card title={t("schemaTransfer.export")} description={t("schemaTransfer.exportDescription")}><Button variant="secondary" onClick={() => void download()}>{t("schemaTransfer.download")}</Button></Card>
      {canImport && (
        <Card title={t("schemaTransfer.import")} description={t("schemaTransfer.importDescription")}>
          <div className="cms-stack-4">
            <div>
              <label htmlFor="schema-json" className="cms-label">{t("schemaTransfer.json")}</label>
              <textarea id="schema-json" rows={12} className="cms-input cms-mt-1 cms-mono" value={text} onChange={(e) => setText(e.target.value)} />
            </div>
            <label className="cms-check-label"><input type="checkbox" className="cms-check" checked={deleteMissing} onChange={(e) => setDeleteMissing(e.target.checked)} />{t("schemaTransfer.deleteMissing")}</label>
            <label className="cms-check-label"><input type="checkbox" className="cms-check" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />{t("schemaTransfer.allowLoss")}</label>
            <div className="cms-flex cms-gap-2"><Button variant="secondary" loading={busy} disabled={!text.trim()} onClick={() => void submit(true)}>{t("schemaTransfer.preview")}</Button><Button loading={busy} disabled={!text.trim()} onClick={() => void submit(false)}>{t("schemaTransfer.import")}</Button></div>
          </div>
        </Card>
      )}
      {result && (
        <Card title={t(result.dryRun ? "schemaTransfer.preview" : "schemaTransfer.imported")}>
          {result.steps.length === 0 ? <p className="cms-muted">{t("schemaTransfer.nothing")}</p> : <ul className="cms-stack-1 cms-text-sm cms-body">{result.steps.map((step, i) => <li key={i}><span className="cms-medium">{step.action}</span> <span className="cms-mono">{step.target}</span>{step.detail ? `: ${step.detail}` : ""}</li>)}</ul>}
        </Card>
      )}
    </div>
  );
}
