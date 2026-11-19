"use client";

import { LanguageIcon } from "@heroicons/react/16/solid";
import type { EditorLocalization } from "../../core/i18n/context";
import { relativeTime } from "../../lib/time";
import { cn } from "../../lib/utils";
import { useAdminLocale, useT } from "../i18n";
import { Badge, Button, type BadgeTone } from "../ui/kit";

export type { EditorLocalization };

/** The state of one language for one record, as the grid and editor show it. */
export function translationState(localization: Pick<EditorLocalization, "translations">, code: string): "missing" | "draft" | "published" | "outdated" {
  const translation = localization.translations.find((entry) => entry.locale === code);
  if (!translation) return "missing";
  if (translation.outdated.length) return "outdated";
  return translation.status === "published" ? "published" : "draft";
}

const TONE: Record<ReturnType<typeof translationState>, BadgeTone> = {
  missing: "neutral",
  draft: "warning",
  published: "success",
  outdated: "danger",
};

export const canEditLocale = (localization: Pick<EditorLocalization, "editable">, code: string) => localization.editable === null || localization.editable.includes(code);

/** The language switcher in the editor's top bar. */
export function LanguageSwitcher({ localization, onSwitch, disabled }: { localization: EditorLocalization; onSwitch: (code: string) => void; disabled?: boolean }) {
  const { t } = useT();
  return (
    <label className="cms-row cms-gap-1 cms-editor-language" title={t("editorLanguages.language")}>
      <LanguageIcon className="cms-icon" aria-hidden="true" />
      <span className="cms-sr-only">{t("editorLanguages.language")}</span>
      <select className="cms-input cms-input-sm" value={localization.locale} disabled={disabled} onChange={(event) => onSwitch(event.target.value)}>
        {localization.locales.map((locale) => {
          const state = translationState(localization, locale.code);
          return <option key={locale.code} value={locale.code}>{locale.label} ({locale.code}){state === "missing" ? `, ${t("editorLanguages.notTranslated")}` : state === "outdated" ? `, ${t("editorLanguages.outdated")}` : ""}</option>;
        })}
      </select>
    </label>
  );
}

interface PanelProps {
  localization: EditorLocalization;
  recordId?: string;
  busy: boolean;
  translators: Array<{ name: string; label: string }>;
  onSwitch: (code: string) => void;
  onCopySource: () => void;
  onTranslate: (provider: string) => void;
  onDeleteTranslation: (code: string) => void;
}

/** Every language of the record, with what each needs, in the editor's side panel. */
export function LanguagePanel({ localization, recordId, busy, translators, onSwitch, onCopySource, onTranslate, onDeleteTranslation }: PanelProps) {
  const current = localization.locale;
  const isSource = current === localization.defaultLocale;
  const sourceLabel = localization.locales.find((locale) => locale.code === localization.defaultLocale)?.label ?? localization.defaultLocale;
  const writable = canEditLocale(localization, current);
  const here = localization.translations.find((entry) => entry.locale === current);
  const { locale: uiLocale } = useAdminLocale();
  const { t } = useT();
  return (
    <div className="cms-stack-4">
      <ul className="cms-language-list">
        {localization.locales.map((locale) => {
          const state = translationState(localization, locale.code);
          const translation = localization.translations.find((entry) => entry.locale === locale.code);
          return (
            <li key={locale.code} className={cn("cms-language-row", locale.code === current && "cms-language-row-current")}>
              <button type="button" className="cms-link" disabled={busy || locale.code === current} onClick={() => onSwitch(locale.code)} aria-current={locale.code === current ? "true" : undefined}>
                {locale.label} <span className="cms-muted">({locale.code})</span>
              </button>
              <Badge tone={TONE[state]} title={translation ? t("editorLanguages.savedAgo", { when: relativeTime(translation.updatedAt, undefined, uiLocale) }) : undefined}>{t(`editorLanguages.states.${state}`)}</Badge>
              {!locale.public && <Badge title={t("editorLanguages.hiddenHint")}>{t("editorLanguages.hidden")}</Badge>}
            </li>
          );
        })}
      </ul>
      {here && here.outdated.length > 0 && <p className="cms-hint">{t("editorLanguages.sourceChanged", { source: sourceLabel, fields: here.outdated.join(", ") })}</p>}
      {!isSource && writable && localization.source && (
        <div className="cms-row cms-wrap cms-gap-2">
          <Button variant="secondary" disabled={busy} onClick={onCopySource}>{t("editorLanguages.copyFrom", { source: sourceLabel })}</Button>
          {translators.map((translator) => <Button key={translator.name} variant="secondary" disabled={busy} onClick={() => onTranslate(translator.name)}>{t("editorLanguages.translateWith", { translator: translator.label })}</Button>)}
        </div>
      )}
      {!writable && <p className="cms-hint">{t("editorLanguages.readOnly")}</p>}
      {recordId && here && !isSource && writable && localization.translations.length > 1 && (
        <button type="button" className="cms-danger cms-text-sm" disabled={busy} onClick={() => onDeleteTranslation(current)}>{t("editorLanguages.deleteTranslation")}</button>
      )}
    </div>
  );
}

/** Above a field in a localized collection: whether it's shared, outdated, and what the source language says. */
export function FieldLanguageNote({ localization, name, localized, input }: { localization: EditorLocalization; name: string; localized: boolean; input: string }) {
  const { t } = useT();
  if (!localized) return <Badge tight className="cms-field-language" title={t("editorLanguages.sharedHint")}>{t("editorLanguages.shared")}</Badge>;
  const outdated = localization.translations.find((entry) => entry.locale === localization.locale)?.outdated.includes(name);
  const source = localization.source?.values[name];
  const sourceLabel = localization.locales.find((locale) => locale.code === localization.source?.locale)?.label;
  return (
    <div className="cms-field-language">
      {outdated && <Badge tight tone="danger">{t("editorLanguages.states.outdated")}</Badge>}
      {typeof source === "string" && source && (input === "text" || input === "textarea") && (
        <p className="cms-hint cms-source-text" lang={localization.source?.locale}><span className="cms-medium">{sourceLabel}:</span> {source}</p>
      )}
    </div>
  );
}
