"use client";

import { Button, defineAdminClient, useT, type FieldActionContext, type RecordPanelProps } from "tansy/admin";
import { useEffect, useState } from "react";
import { aiStatus, post } from "./api";
import "./ai.css";

/** Whether to offer AI here at all: the person may use it, and a provider is set up. */
function useReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => { void aiStatus().then((status) => setReady(Boolean(status?.ready))); }, []);
  return ready;
}

/** Under the record's fields: describe the record, and the form fills in for review. Nothing is saved. */
function FillPanel({ collection, values, setValues }: RecordPanelProps) {
  const ready = useReady();
  const { t } = useT();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ error: boolean; text: string } | null>(null);
  if (!ready) return null;
  const fill = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await post<{ values: Record<string, unknown> }>("/fill", { collection: collection.slug, prompt, values });
      const count = Object.keys(result.values).length;
      setValues(result.values);
      setNote({ error: false, text: count ? t("ext.ai.fill.filled", { count }) : t("ext.ai.fill.nothing") });
    } catch (error) {
      setNote({ error: true, text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ai-panel">
      <label htmlFor="ai-fill-prompt" className="cms-label">{t("ext.ai.fill.title")}</label>
      <textarea id="ai-fill-prompt" className="cms-input cms-mt-1" rows={3} value={prompt} placeholder={t("ext.ai.fill.placeholder")} onChange={(event) => setPrompt(event.target.value)} />
      <Button variant="secondary" className="cms-mt-1" disabled={busy || !prompt.trim()} onClick={() => void fill()}>{busy ? t("ext.ai.fill.busy") : t("ext.ai.fill.button")}</Button>
      {note && <p className={note.error ? "cms-error cms-mt-1" : "cms-hint cms-mt-1"}>{note.text}</p>}
    </section>
  );
}

const ACTIONS = [
  { action: "write", needsText: false },
  { action: "improve", needsText: true },
  { action: "shorten", needsText: true },
  { action: "expand", needsText: true },
  { action: "fix", needsText: true },
  { action: "translate", needsText: true },
] as const;

const hasText = (value: unknown) => (typeof value === "string" ? Boolean(value.trim()) : Boolean(value && typeof value === "object"));

/** By a text field: write it, or rework what's there. The result lands in the form, unsaved. */
function WriteMenu({ collection, field, value, values, setValue }: FieldActionContext) {
  const ready = useReady();
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!ready) return null;
  const run = async (action: (typeof ACTIONS)[number]["action"]) => {
    let asked = instruction.trim();
    if (action === "translate" && !asked) {
      asked = window.prompt(t("ext.ai.write.whichLanguage"))?.trim() ?? "";
      if (!asked) return;
      asked = `Translate into ${asked}.`;
    }
    setBusy(action);
    setError(null);
    try {
      const result = await post<{ value: unknown }>("/write", { collection: collection.slug, field: field.name, action, instruction: asked || undefined, value, values });
      if (result.value !== null && result.value !== undefined) setValue(result.value);
      setOpen(false);
      setInstruction("");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <span className="ai-write">
      <button type="button" className="cms-field-action" aria-expanded={open} onClick={() => setOpen(!open)}>✦ {t("ext.ai.actions.ai-write")}</button>
      {open && (
        <div className="ai-write-menu" role="menu">
          <input className="cms-input" value={instruction} placeholder={t("ext.ai.write.instruction")} onChange={(event) => setInstruction(event.target.value)} />
          {ACTIONS.filter((item) => !item.needsText || hasText(value)).map((item) => (
            <button key={item.action} type="button" role="menuitem" className="ai-write-item" disabled={busy !== null} onClick={() => void run(item.action)}>{busy === item.action ? t("ext.ai.write.working") : t(`ext.ai.write.${item.action}`)}</button>
          ))}
          {error && <p className="cms-error">{error}</p>}
        </div>
      )}
    </span>
  );
}

export default defineAdminClient({
  recordPanels: [{ id: "ai-fill", component: FillPanel }],
  fieldActions: [{ id: "ai-write", label: "AI", permission: "ext.ai:use", types: ["text", "rich_text"], component: WriteMenu }],
});
