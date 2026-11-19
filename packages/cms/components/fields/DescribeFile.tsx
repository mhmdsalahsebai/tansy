"use client";

import { useRef, useState } from "react";
import { Alert, Button, Field, Input, Modal, Skeleton } from "../ui/kit";
import { api, errorText, useApi } from "../../lib/client/api";
import { apiPath } from "../../lib/paths";
import { useT } from "../i18n";
import { useHolds } from "../admin-client";
import { FocusPicker, type Focus } from "./FocusPicker";

interface Words {
  alt: string;
  caption: string;
  credit: string;
}

interface FileTextData {
  primary: string;
  languages: Array<{ code: string; label: string; direction: "ltr" | "rtl" }>;
  words: Record<string, Partial<Words>>;
}

const EMPTY: Words = { alt: "", caption: "", credit: "" };

export interface DescribableFile {
  id: string;
  name: string;
  /** From the bytes, so only a picture is offered a focal point or shown for one. */
  type?: string;
  /** Changes when the bytes are replaced, so the preview asks for the new ones rather than a cached thumbnail. */
  size?: number;
  focus?: Focus | null;
}

/**
 * What a file is described as: an image's alternative text, with its caption and credit. Each
 * language holds its own words, and the editor shows exactly those, never a fallback's, so
 * saving one language can't copy another's words into it. The API decides who may save.
 *
 * For a picture it also holds where its subject is, which isn't per language, and replacing its
 * bytes under the same id, which needs `file:update`.
 */
export function DescribeFile({ file, onClose, onSaved }: { file: DescribableFile | null; onClose: () => void; onSaved?: () => void }) {
  const { t } = useT();
  const holds = useHolds();
  const { data, error: loadError } = useApi<FileTextData>(file ? apiPath(`/files/${encodeURIComponent(file.id)}/text`) : null);
  const [language, setLanguage] = useState<string | null>(null);
  /** What has been typed, and what the last save returned, each by language. */
  const [edits, setEdits] = useState<Record<string, Words>>({});
  const [written, setWritten] = useState<Record<string, Words>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  /** Undefined until the point is touched, so an untouched one is never written. */
  const [focus, setFocus] = useState<Focus | null | undefined>(undefined);
  const [replacing, setReplacing] = useState(false);
  const bytes = useRef<HTMLInputElement>(null);

  const image = (file?.type ?? "").startsWith("image/");
  const point = focus === undefined ? (file?.focus ?? null) : focus;

  const locale = language ?? data?.primary ?? "";
  const stored: Words = { ...EMPTY, ...data?.words[locale] };
  const draft = edits[locale] ?? written[locale] ?? stored;
  const change = (patch: Partial<Words>) => {
    setEdits({ ...edits, [locale]: { ...draft, ...patch } });
    setSaved(null);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file || !locale) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ words: Words }>(apiPath(`/files/${encodeURIComponent(file.id)}/text`), { method: "PATCH", body: { ...draft, locale } });
      // The focal point belongs to the picture rather than to a language, so it is written once, and only if touched.
      if (focus !== undefined) await api(apiPath(`/files/${encodeURIComponent(file.id)}/focus`), { method: "PATCH", body: { focus } });
      setWritten({ ...written, [locale]: result.words });
      setEdits(Object.fromEntries(Object.entries(edits).filter(([code]) => code !== locale)));
      setSaved(locale);
      onSaved?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setLanguage(null);
    setEdits({});
    setWritten({});
    setError(null);
    setSaved(null);
    setFocus(undefined);
    onClose();
  };

  /** New bytes under the same id, so every record and address that uses this file shows them. */
  const replace = async (chosen: File) => {
    if (!file) return;
    setReplacing(true);
    setError(null);
    setSaved(null);
    try {
      await fetch(apiPath(`/files/${encodeURIComponent(file.id)}/bytes`), {
        method: "PUT",
        headers: { "content-type": chosen.type || "application/octet-stream" },
        body: chosen,
      }).then(async (response) => {
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message ?? t("files.replaceFailed"));
      });
      onSaved?.();
      close();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setReplacing(false);
      if (bytes.current) bytes.current.value = "";
    }
  };

  const languages = data?.languages ?? [];
  return (
    <Modal open={file !== null} onClose={close} title={t("files.describeTitle", { name: file?.name ?? t("files.file") })}>
      {!data && !loadError && <div className="cms-stack-4" aria-busy="true"><Skeleton height="control" /><Skeleton height="control" /><Skeleton height="control" /></div>}
      {loadError && <Alert>{loadError}</Alert>}
      {data && (
        <form onSubmit={save} className="cms-stack-4">
          {error && <Alert>{error}</Alert>}
          {saved === locale && !error && <Alert kind="success">{t("files.saved")}</Alert>}
          {languages.length > 1 && (
            <Field label={t("files.language")} hint={t("files.languageHint")}>
              <select
                aria-label={t("files.language")}
                className="cms-input"
                value={locale}
                onChange={(e) => { setLanguage(e.target.value); setError(null); }}
              >
                {languages.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}
              </select>
            </Field>
          )}
          <Field label={t("files.alt")} hint={t("files.altHint")}>
            <Input value={draft.alt} maxLength={1000} onChange={(e) => change({ alt: e.target.value })} />
          </Field>
          <Field label={t("files.caption")}>
            <Input value={draft.caption} maxLength={2000} onChange={(e) => change({ caption: e.target.value })} />
          </Field>
          <Field label={t("files.credit")}>
            <Input value={draft.credit} maxLength={500} onChange={(e) => change({ credit: e.target.value })} />
          </Field>
          {image && file && <FocusPicker id={file.id} version={file.size} focus={point} onChange={(next) => { setFocus(next); setSaved(null); }} />}
          {holds("file:update") && (
            <Field label={t("files.replace")} hint={t("files.replaceHint")}>
              <input
                ref={bytes}
                type="file"
                className="cms-input"
                accept={image ? "image/*" : undefined}
                disabled={replacing}
                onChange={(e) => { const chosen = e.target.files?.[0]; if (chosen) void replace(chosen); }}
              />
            </Field>
          )}
          <div className="cms-flex cms-end cms-gap-2">
            <Button variant="secondary" onClick={close}>{t("files.cancel")}</Button>
            <Button type="submit" loading={busy}>{t("files.save")}</Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
