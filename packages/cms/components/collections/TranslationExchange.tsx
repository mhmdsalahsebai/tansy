"use client";

import { useRef, useState } from "react";
import { api, errorText } from "../../lib/client/api";
import { apiPath } from "../../lib/paths";
import { Alert, Button, ButtonLink, Field, Modal } from "../ui/kit";
import { useT } from "../i18n";

interface Language { code: string; label: string }
interface ImportResult { from: string; to: string; results: Array<{ id: number; outcome: "saved" | "draft" | "skipped"; reason?: string }> }

/**
 * XLIFF 2.0 out to a translation agency or tool, and back in as drafts. Export takes the
 * selected records, or the collection's first ones. Import checks every record as a save would.
 */
export function TranslationExchange({ collectionId, defaultLocale, locales, selected, onImported }: { collectionId: number; defaultLocale: string; locales: Language[]; selected: number[]; onImported: () => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(locales.find((locale) => locale.code !== defaultLocale)?.code ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const exportHref = apiPath(`/collections/${collectionId}/translations/xliff?from=${encodeURIComponent(defaultLocale)}&to=${encodeURIComponent(target)}${selected.length ? `&ids=${selected.join(",")}` : ""}`);

  const upload = async () => {
    const chosen = file.current?.files?.[0];
    if (!chosen) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api<ImportResult>(apiPath(`/collections/${collectionId}/translations/xliff`), { method: "POST", body: { xliff: await chosen.text() } }));
      onImported();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  };

  const count = (outcome: string) => result?.results.filter((entry) => entry.outcome === outcome).length ?? 0;
  return (
    <>
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>{t("exchange.button")}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={t("exchange.title")}>
        <div className="cms-stack-4">
          <p className="cms-text-sm">{t("exchange.intro")}</p>
          <Field label={t("exchange.into")}>
            <select className="cms-input" value={target} onChange={(event) => setTarget(event.target.value)}>
              {locales.filter((locale) => locale.code !== defaultLocale).map((locale) => <option key={locale.code} value={locale.code}>{locale.label} ({locale.code})</option>)}
            </select>
          </Field>
          <div><ButtonLink native variant="secondary" href={exportHref} download>{selected.length ? t("exchange.exportSelected", { count: selected.length }) : t("exchange.exportRecords")}</ButtonLink></div>
          <Field label={t("exchange.importLabel")} hint={t("exchange.importHint")}>
            <input ref={file} type="file" accept=".xlf,.xliff,application/xliff+xml,application/xml,text/xml" className="cms-input" />
          </Field>
          <div><Button type="button" loading={busy} onClick={() => void upload()}>{t("exchange.import")}</Button></div>
          {error && <Alert>{error}</Alert>}
          {result && (
            <Alert kind={count("skipped") ? "warning" : "success"}>
              {t("exchange.result", { saved: count("saved"), draft: count("draft"), skipped: count("skipped") })}
              {count("skipped") > 0 && <ul className="cms-list">{result.results.filter((entry) => entry.outcome === "skipped").slice(0, 10).map((entry) => <li key={entry.id}>#{entry.id}: {entry.reason}</li>)}</ul>}
            </Alert>
          )}
        </div>
      </Modal>
    </>
  );
}
