"use client";

import { ADMIN_LOCALE_NAMES, ADMIN_LOCALES } from "../core/i18n/catalogs";
import { useT } from "./i18n";
import { Field, Input } from "./ui/kit";

/**
 * A name in each interface language, for a collection or a block. Each person sees the one
 * for the language they chose, and the plain name where it's left empty.
 */
export function LabelsInput({ value, onChange, maxLength }: { value: Record<string, string>; onChange: (value: Record<string, string>) => void; maxLength: number }) {
  const { t } = useT();
  const filled = Object.values(value).filter((text) => text.trim()).length;
  return (
    <details className="cms-box" open={filled > 0}>
      <summary className="cms-summary">{filled ? t("schemaLabels.titleCount", { count: filled }) : t("schemaLabels.title")}</summary>
      <div className="cms-stack-4 cms-mt-2">
        <p className="cms-hint">{t("schemaLabels.hint")}</p>
        {ADMIN_LOCALES.map((code) => (
          <Field key={code} label={ADMIN_LOCALE_NAMES[code] ?? code}>
            <Input lang={code} dir="auto" maxLength={maxLength} value={value[code] ?? ""} onChange={(event) => onChange({ ...value, [code]: event.target.value })} />
          </Field>
        ))}
      </div>
    </details>
  );
}

/** What to send: empty entries left out, and null when there are none, which clears them. */
export const labelsBody = (value: Record<string, string>) => {
  const kept = Object.entries(value).filter(([, text]) => text.trim());
  return kept.length ? Object.fromEntries(kept) : null;
};
