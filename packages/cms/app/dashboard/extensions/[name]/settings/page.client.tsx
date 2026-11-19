"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePluginWord, useT } from "../../../../../components/i18n";
import { Alert, Button, Field, Input, PageHeader, SettingsSection, Tabs } from "../../../../../components/ui/kit";
import { Switch } from "../../../../../components/ui/Switch";
import type { PluginSettingField } from "../../../../../core/extend/define";
import { apiPath } from "../../../../../lib/paths";

/** What the server sends instead of a stored secret. Kept in step with core/auth/settings-schema.ts. */
const SECRET_MASK = "********";

type Values = Record<string, unknown>;

type Suggestion = { value: string; label?: string };
type SuggestionState = { status: "loading" } | { status: "ready"; options: Suggestion[] } | { status: "failed"; message: string };

/** At most this many choices in the list at once. Typing narrows the rest. */
const SHOWN = 150;

/**
 * A text setting with choices from one of the plugin's routes, such as a provider's models:
 * a searchable list under the box. Any text is still accepted, as a model can exist before
 * its provider lists it.
 */
function SuggestedInput({ plugin, id, field, value, values, onChange }: { plugin: string; id: string; field: Extract<PluginSettingField, { type: "text" }>; value: unknown; values: Values; onChange(value: unknown): void }) {
  const { t } = useT();
  const { route, with: names = [] } = field.suggestions!;
  const query = new URLSearchParams(names.map((name) => [name, String(values[name] ?? "")])).toString();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<SuggestionState>({ status: "loading" });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [typed, setTyped] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(apiPath(`/ext/${plugin}${route}${query ? `?${query}` : ""}`), { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const json = await response.json().catch(() => null) as { options?: Suggestion[]; error?: { message?: string } } | null;
        setState(response.ok && Array.isArray(json?.options) ? { status: "ready", options: json.options } : { status: "failed", message: json?.error?.message ?? String(response.status) });
      })
      .catch((error: unknown) => { if (!controller.signal.aborted) setState({ status: "failed", message: String((error as Error)?.message ?? error) }); });
    return () => controller.abort();
  }, [plugin, route, query, attempt]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);
  const text = String(value ?? "");
  // Until the person types, the whole list shows, with the current choice in it.
  const words = typed ? text.trim().toLowerCase() : "";
  const matches = useMemo(() => {
    const all = state.status === "ready" ? state.options : [];
    return words ? all.filter((option) => `${option.value} ${option.label ?? ""}`.toLowerCase().includes(words)) : all;
  }, [state, words]);
  const shown = matches.slice(0, SHOWN);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [active]);
  const pick = (option: Suggestion) => { onChange(option.value); setOpen(false); setTyped(false); setActive(-1); };
  const status = state.status === "loading" ? t("extensions.suggestionsLoading") : state.status === "failed" ? t("extensions.suggestionsFailed", { message: state.message }) : t("extensions.suggestionsCount", { count: state.options.length });
  const listId = `${id}-choices`;
  return (
    <Field label={field.label} hint={field.description}>
      <div ref={root} className="cms-combo">
        <Input
          id={id}
          role="combobox"
          aria-expanded={open && shown.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          maxLength={field.maxLength}
          value={text}
          placeholder={t("extensions.suggestionsPlaceholder")}
          onFocus={() => setOpen(true)}
          onChange={(event) => { onChange(event.target.value); setTyped(true); setOpen(true); setActive(-1); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setOpen(true); setActive((at) => Math.min(at + 1, shown.length - 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setActive((at) => Math.max(at - 1, 0)); }
            else if (event.key === "Enter" && open && active >= 0 && shown[active]) { event.preventDefault(); pick(shown[active]); }
            else if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); }
            else if (event.key === "Tab") setOpen(false);
          }}
        />
        {open && shown.length > 0 && (
          <ul ref={list} id={listId} role="listbox" className="cms-combo-list" aria-label={field.label}>
            {shown.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                data-index={index}
                aria-selected={option.value === text}
                className={index === active ? "cms-combo-option cms-combo-active" : "cms-combo-option"}
                onPointerMove={() => setActive(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => pick(option)}
              >
                <span className="cms-combo-value">{option.value}</span>
                {option.label && option.label !== option.value && <span className="cms-combo-label">{option.label}</span>}
              </li>
            ))}
            {matches.length > SHOWN && <li className="cms-combo-more" role="presentation">{t("extensions.suggestionsMore", { count: matches.length - SHOWN })}</li>}
          </ul>
        )}
      </div>
      <div className="cms-combo-foot">
        <span className={state.status === "failed" ? "cms-status cms-status-warn" : state.status === "ready" ? "cms-status cms-status-on" : "cms-status"} role="status">{status}</span>
        <button type="button" className="cms-link-btn" disabled={state.status === "loading"} onClick={() => { setState({ status: "loading" }); setAttempt(attempt + 1); }}>{t("extensions.suggestionsReload")}</button>
      </div>
    </Field>
  );
}

function Control({ plugin, field: registered, value, values, onChange, fromEnv }: { plugin: string; field: PluginSettingField; value: unknown; values: Values; onChange(value: unknown): void; fromEnv: boolean }) {
  const { t } = useT();
  const field = useSettingText(plugin, registered);
  const id = `setting-${field.name}`;
  switch (field.type) {
    case "boolean":
      return <Switch checked={value === true} onChange={onChange} label={field.label} description={field.description} />;
    case "number":
      return (
        <Field label={field.label} hint={field.description}>
          <Input id={id} type="number" value={typeof value === "number" ? value : ""} min={field.min} max={field.max} step={field.integer ? 1 : "any"} onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))} />
        </Field>
      );
    case "select":
      return (
        <Field label={field.label} hint={field.description}>
          <select id={id} className="cms-input" value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
            {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </Field>
      );
    case "secret":
      // The server sends only a mask for a stored secret. Sending the mask back keeps it.
      return (
        <Field label={field.label} hint={fromEnv && field.env ? t("extensions.setByEnv", { env: field.env }) : field.description}>
          <Input id={id} type="password" autoComplete="off" disabled={fromEnv} placeholder={value ? t("extensions.secretSaved") : t("extensions.notSet")} value={value === SECRET_MASK ? "" : String(value ?? "")} onChange={(event) => onChange(event.target.value === "" && value === SECRET_MASK ? SECRET_MASK : event.target.value)} />
          {value === SECRET_MASK && !fromEnv && <div><Button type="button" variant="secondary" onClick={() => onChange("")}>{t("extensions.removeSecret")}</Button></div>}
        </Field>
      );
    case "text":
      if (field.suggestions && !field.multiline) return <SuggestedInput plugin={plugin} id={id} field={field} value={value} values={values} onChange={onChange} />;
      return (
        <Field label={field.label} hint={field.description}>
          {field.multiline
            ? <textarea id={id} className="cms-input" rows={4} maxLength={field.maxLength} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} />
            : <Input id={id} maxLength={field.maxLength} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)} />}
        </Field>
      );
  }
}

/** A setting's label, description and choices from the plugin's `messages`, under `settings.<name>`. */
function useSettingText(plugin: string, field: PluginSettingField): PluginSettingField {
  const word = usePluginWord();
  const key = `settings.${field.name}`;
  const text = { ...field, label: word(plugin, `${key}.label`, field.label), description: field.description && word(plugin, `${key}.description`, field.description) };
  return text.type === "select" ? { ...text, options: text.options.map((option) => ({ ...option, label: word(plugin, `${key}.options.${option.value}`, option.label) })) } : text;
}

interface ProviderGroup { id: string; label: string; fields: PluginSettingField[] }

/**
 * Splits a plugin's settings into its own and each provider's. A plugin with adapters has a
 * select named `provider`, and every provider's settings start with that provider's id, such
 * as resendApiKey, so a field goes to the provider with the longest id it starts with.
 */
function groupSettings(fields: PluginSettingField[]): { shared: PluginSettingField[]; chooser: PluginSettingField | null; providers: ProviderGroup[] } {
  const chooser = fields.find((field) => field.name === "provider" && field.type === "select") ?? null;
  if (!chooser || chooser.type !== "select") return { shared: fields, chooser: null, providers: [] };
  const ids = chooser.options.map((option) => option.value).sort((a, b) => b.length - a.length);
  const owner = (name: string) => ids.find((id) => name.startsWith(id) && name.length > id.length && /[A-Z0-9_]/.test(name[id.length]));
  const providers = chooser.options.map((option) => ({ id: option.value, label: option.label, fields: fields.filter((field) => field !== chooser && owner(field.name) === option.value) }));
  // A choice with nothing to fill in, such as analytics' "none", gets no tab.
  const withFields = providers.filter((provider) => provider.fields.length);
  if (!withFields.length) return { shared: fields, chooser: null, providers: [] };
  return { shared: fields.filter((field) => field === chooser || !owner(field.name)), chooser, providers: withFields };
}

/**
 * `own`: inside a scope value, such as a tenant, the settings that are its own. The rest
 * change for every value. `scope` is what a value is called, lower-case.
 */
export default function PluginSettingsPage({ plugin, title, fields, initial, fromEnv = [], own = [], scope = null }: { plugin: string; title: string; fields: PluginSettingField[]; initial: Values; fromEnv?: string[]; own?: string[]; scope?: string | null }) {
  const { t } = useT();
  const word = usePluginWord();
  const [values, setValues] = useState<Values>(initial);
  const [saved, setSavedValues] = useState<Values>(initial);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const { shared, chooser, providers } = groupSettings(fields);
  const chosen = chooser ? String(values[chooser.name] ?? "") : "";
  const [tab, setTab] = useState(chosen || providers[0]?.id || "");
  const dirty = JSON.stringify(values) !== JSON.stringify(saved);
  const providerLabel = (group: ProviderGroup) => word(plugin, `settings.provider.options.${group.id}`, group.label);
  const set = (name: string, value: unknown) => { setMessage(null); setValues((current) => ({ ...current, [name]: value })); };
  const hasKeys = (group: ProviderGroup) => group.fields.some((field) => field.type === "secret" && (values[field.name] === SECRET_MASK || fromEnv.includes(field.name) || Boolean(values[field.name])));

  const save = async () => {
    setSaving(true);
    setMessage(null);
    const response = await fetch(apiPath(`/extensions/${plugin}/settings`), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ values }) });
    const json = await response.json().catch(() => null) as { values?: Values; error?: { message?: string; details?: Array<{ path: string; message: string }> } } | null;
    setSaving(false);
    if (!response.ok) {
      const detail = json?.error?.details?.[0];
      const field = detail && fields.find((candidate) => candidate.name === detail.path);
      const label = field && word(plugin, `settings.${field.name}.label`, field.label);
      if (field) {
        const group = providers.find((candidate) => candidate.fields.includes(field));
        if (group) setTab(group.id);
      }
      setMessage({ kind: "error", text: label ? `${label}: ${detail.message}` : (json?.error?.message ?? t("extensions.notSaved")) });
      return;
    }
    if (json?.values) { setValues(json.values); setSavedValues(json.values); } else setSavedValues(values);
    setMessage({ kind: "success", text: t("extensions.savedSettings") });
  };

  const controls = (list: PluginSettingField[]) => list.map((field) => <Control key={field.name} plugin={plugin} field={field} value={values[field.name]} values={values} fromEnv={fromEnv.includes(field.name)} onChange={(value) => set(field.name, value)} />);

  return (
    <div className="cms-gutter">
      <PageHeader title={t("extensions.settingsTitle", { plugin: title })} description={t("extensions.settingsDescription")} />
      <form className="cms-settings-stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        {own.length > 0 && scope && (
          <Alert kind="info">{t("extensions.ownSettings", { label: scope, names: fields.filter((field) => own.includes(field.name)).map((field) => word(plugin, `settings.${field.name}.label`, field.label)).join(", ") })}</Alert>
        )}
        {shared.length > 0 && (
          <SettingsSection title={t("extensions.general")}>
            {controls(shared)}
          </SettingsSection>
        )}
        {providers.length > 0 && (
          <SettingsSection title={t("extensions.providers")} description={t("extensions.providersHint")}>
            <Tabs
              label={t("extensions.providers")}
              variant="pills"
              value={tab}
              onChange={setTab}
              tabs={providers.map((group) => ({
                id: group.id,
                label: providerLabel(group),
                badge: group.id === chosen ? t("extensions.inUse") : undefined,
                content: (
                  <div className="cms-stack-4">
                    <div className="cms-provider-head">
                      <span className={group.id === chosen ? "cms-status cms-status-on" : hasKeys(group) ? "cms-status" : "cms-status cms-status-off"}>
                        {group.id === chosen ? t("extensions.inUse") : hasKeys(group) ? t("extensions.keysSaved") : t("extensions.noKeys")}
                      </span>
                      {chooser && group.id !== chosen && <Button variant="secondary" onClick={() => set(chooser.name, group.id)}>{t("extensions.useProvider", { provider: providerLabel(group) })}</Button>}
                    </div>
                    {group.fields.length ? controls(group.fields) : <p className="cms-muted">{t("extensions.noSettings")}</p>}
                  </div>
                ),
              }))}
            />
          </SettingsSection>
        )}
        <div className="cms-form-foot">
          {message ? <Alert kind={message.kind}>{message.text}</Alert> : dirty && <span className="cms-status cms-status-warn cms-grow">{t("extensions.unsaved")}</span>}
          <Button type="submit" loading={saving}>{t("extensions.saveSettings")}</Button>
        </div>
      </form>
    </div>
  );
}
