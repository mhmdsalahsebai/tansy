"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { apiPath, CaptchaWidget, contentLocale, siteWords, type CaptchaWidgetConfig, type SiteWords } from "tansy/react";
import type { FormField } from "./logic";
import { siteMessages } from "./site-messages";

const ENGLISH: SiteWords = { locale: "en", messages: siteMessages.en };

interface LoadedForm { id: number; title: string; fields: FormField[]; submitLabel: string; captcha: CaptchaWidgetConfig | null; token: string }

type Values = Record<string, string | boolean>;

function Input({ field, id, value, error, onChange, choose }: { field: FormField; id: string; value: string | boolean | undefined; error?: string; onChange(value: string | boolean): void; choose: string }) {
  const described = [field.help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  const common = { id, name: field.name, required: field.required, "aria-invalid": error ? true : undefined, "aria-describedby": described };
  const text = typeof value === "string" ? value : "";
  if (field.kind === "checkbox") {
    return (
      <label className="fm-check">
        <input type="checkbox" {...common} checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        <span>{field.label}</span>
      </label>
    );
  }
  if (field.kind === "textarea") return <textarea {...common} rows={5} maxLength={field.maxLength} placeholder={field.placeholder || undefined} value={text} onChange={(event) => onChange(event.target.value)} />;
  if (field.kind === "select") {
    return (
      <select {...common} value={text} onChange={(event) => onChange(event.target.value)}>
        <option value="">{field.placeholder || choose}</option>
        {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  }
  const type = field.kind === "email" ? "email" : field.kind === "number" ? "number" : "text";
  return <input {...common} type={type} min={field.min} max={field.max} maxLength={field.maxLength} placeholder={field.placeholder || undefined} autoComplete={field.kind === "email" ? "email" : field.name === "name" ? "name" : undefined} value={text} onChange={(event) => onChange(event.target.value)} />;
}

export interface FormViewProps {
  /** The form's record id, in the forms-forms collection. */
  form: number;
  /** The CMS's API, such as https://cms.example.com/api, for a site on another address. This app's own when left out. */
  api?: string;
  /** The page's words, `pickWords(words, "forms")` from a template or block: the form is read, checked and worded in the page's language. English without them. */
  words?: SiteWords;
}

/**
 * A form from the Forms plugin, filled in and sent through its routes. Works on any page,
 * and on a headless site given `api`. Everything it shows comes from the form's public
 * route, and the server checks every answer again.
 */
export function FormView({ form, api, words }: FormViewProps) {
  const { t } = siteWords(words ?? ENGLISH);
  const locale = contentLocale(words);
  const base = (api ?? apiPath("")).replace(/\/+$/, "");
  const id = useId();
  const [loaded, setLoaded] = useState<LoadedForm | null>(null);
  const [missing, setMissing] = useState(false);
  const [values, setValues] = useState<Values>({});
  const [trap, setTrap] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Raised to fetch the form again, for a fresh token once it has expired.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    fetch(`${base}/ext/forms/forms/${form}${locale ? `?locale=${encodeURIComponent(locale)}` : ""}`, { cache: "no-store" })
      .then(async (response) => {
        if (!active) return;
        if (!response.ok) return setMissing(true);
        setLoaded(await response.json() as LoadedForm);
      })
      .catch(() => { if (active) setMissing(true); });
    return () => { active = false; };
  }, [base, form, version, locale]);

  if (missing) return null;
  if (!loaded) return <div className="fm-form fm-loading" aria-busy="true" />;
  if (sent !== null) return <p className="fm-success" role="status">{sent}</p>;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!loaded) return;
    setSending(true);
    setProblem(null);
    setErrors({});
    try {
      const response = await fetch(`${base}/ext/forms/forms/${form}/submit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values, token: loaded.token, page: window.location.pathname, website: trap, ...(answer ? { answer } : {}), ...(locale ? { locale } : {}) }),
      });
      const json = await response.json().catch(() => null) as { message?: string; error?: { code?: string; message?: string }; fields?: Record<string, string> } | null;
      // The route words its answers in the page's language.
      if (response.ok) return setSent(json?.message ?? t("forms.thanks"));
      setProblem(response.status === 429 ? t("forms.tooMany") : json?.error?.message ?? t("forms.failed"));
      if (json?.fields) setErrors(json.fields);
      if (json?.error?.code === "FORM_EXPIRED") setVersion((value) => value + 1);
      // An answer works once, so a new one is needed after any refusal the CAPTCHA saw.
      if (loaded.captcha) setAttempt((value) => value + 1);
    } catch {
      setProblem(t("forms.offline"));
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="fm-form" onSubmit={submit} noValidate={false}>
      {loaded.fields.map((field) => {
        const fieldId = `${id}-${field.name}`;
        return (
          <div key={field.name} className="fm-field">
            {field.kind !== "checkbox" && <label htmlFor={fieldId}>{field.label}{field.required && <span aria-hidden> *</span>}</label>}
            <Input field={field} id={fieldId} value={values[field.name]} error={errors[field.name]} onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))} choose={t("forms.choose")} />
            {field.help && <p id={`${fieldId}-help`} className="fm-help">{field.help}</p>}
            {errors[field.name] && <p id={`${fieldId}-error`} className="fm-error">{errors[field.name]}</p>}
          </div>
        );
      })}
      {/* People never see this. A script that fills in every field fills it in too. */}
      <div className="fm-trap" aria-hidden="true">
        <label htmlFor={`${id}-website`}>{t("forms.trap")}</label>
        <input id={`${id}-website`} name="website" tabIndex={-1} autoComplete="off" value={trap} onChange={(event) => setTrap(event.target.value)} />
      </div>
      {loaded.captcha && <CaptchaWidget config={loaded.captcha} attempt={attempt} onAnswer={setAnswer} />}
      {problem && <p className="fm-error" role="alert">{problem}</p>}
      <p className="fm-actions"><button type="submit" disabled={sending || (loaded.captcha !== null && !answer)}>{sending ? t("forms.sending") : loaded.submitLabel}</button></p>
    </form>
  );
}
