"use client";

import { useT } from "tansy/admin";
import { useCallback, useMemo, useRef, useState } from "react";
import type { ModelCapabilities, ModelChoice } from "../provider";
import { Check, ChevronDown, Search, useDismiss } from "../parts";
import { supports, type Catalog, type CatalogEntry } from "./check";
import { ModelIcon, ProviderIcon } from "./icons";
import type { Task } from "./schema";

const SHOWN = 150;

/** What a model can do, as small labels: the parts a workflow cares about. */
export function CapabilityChips({ capabilities }: { capabilities?: ModelCapabilities }) {
  const { t } = useT();
  if (!capabilities) return <span className="wf-chip wf-chip-unknown">{t("ext.ai.workflows.caps.unknown")}</span>;
  const chips: string[] = [];
  if (capabilities.output?.includes("text")) chips.push("text");
  if (capabilities.output?.includes("image")) chips.push("draws");
  if (capabilities.input?.includes("image")) chips.push("vision");
  if (capabilities.tools) chips.push("tools");
  if (capabilities.reasoning) chips.push("thinks");
  if (capabilities.structured) chips.push("json");
  return <>{chips.map((chip) => <span key={chip} className={`wf-chip wf-chip-${chip}`}>{t(`ext.ai.workflows.caps.${chip}`)}</span>)}{!capabilities.reported ? <span className="wf-chip wf-chip-unknown" title={t("ext.ai.workflows.caps.guessedHint")}>{t("ext.ai.workflows.caps.guessed")}</span> : null}</>;
}

/** Whether a model can do every task asked of it, and the first it can't. */
function fit(capabilities: ModelCapabilities | undefined, tasks: Task[]) {
  const results = tasks.map((task) => [task, supports(capabilities, task)] as const);
  const no = results.find(([, support]) => support === "no");
  return { ok: !no, missing: no?.[0], unknown: results.some(([, support]) => support === "unknown") };
}

/**
 * Chooses a provider and model, from every ready provider's list, showing what each model
 * can do as its provider reports it. Models that can't do the agent's tasks are shown but
 * can't be chosen. Any id can still be typed, for a model a provider doesn't list.
 */
export function ModelPicker({ catalog, provider, model, tasks, onChange }: { catalog: Catalog; provider: string; model: string; tasks: Task[]; onChange: (value: { provider: string; model: string }) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<string | null>(null);
  const [onlyFit, setOnlyFit] = useState(true);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => { setOpen(false); setQuery(""); }, []);
  useDismiss(root, open, close);

  const entry = catalog.providers.find((item) => item.id === provider);
  const current = entry?.models?.find((item) => item.value === model);
  const ready = catalog.providers.filter((item) => item.ready);

  const groups = useMemo(() => {
    const words = query.trim().toLowerCase();
    return ready.filter((item) => !only || item.id === only).map((item) => {
      const models = (item.models ?? []).filter((choice) => (!words || `${choice.value} ${choice.label ?? ""}`.toLowerCase().includes(words)) && (!onlyFit || fit(choice.capabilities, tasks).ok));
      return { entry: item, models: models.slice(0, SHOWN), more: Math.max(0, models.length - SHOWN) };
    });
  }, [ready, only, query, onlyFit, tasks]);

  const choose = (value: { provider: string; model: string }) => { onChange(value); close(); };
  const typed = query.trim();
  const typedProvider = only ?? provider ?? ready[0]?.id;

  const row = (item: CatalogEntry, choice: ModelChoice) => {
    const { ok, missing } = fit(choice.capabilities, tasks);
    const selected = item.id === provider && choice.value === model;
    return (
      <li key={`${item.id}:${choice.value}`}>
        <button type="button" className={`wf-model-row${selected ? " is-selected" : ""}`} disabled={!ok} title={!ok && missing ? t("ext.ai.workflows.picker.cannot", { task: t(`ext.ai.workflows.tasks.${missing}`) }) : choice.value} onClick={() => choose({ provider: item.id, model: choice.value })}>
          <ModelIcon model={choice.value} provider={item.id} icon={item.icon} size={20} />
          <span className="wf-model-text">
            <span className="wf-model-name">{choice.label ?? choice.value}</span>
            {choice.label ? <span className="wf-model-id">{choice.value}</span> : null}
          </span>
          <span className="wf-model-chips"><CapabilityChips capabilities={choice.capabilities} /></span>
          {selected ? <Check /> : null}
        </button>
      </li>
    );
  };

  return (
    <div className="wf-picker" ref={root}>
      <button type="button" className="wf-picker-button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ModelIcon model={model} provider={provider} icon={entry?.icon} size={22} />
        <span className="wf-model-text">
          <span className="wf-model-name">{current?.label ?? (model || t("ext.ai.workflows.picker.choose"))}</span>
          <span className="wf-model-id"><ProviderIcon provider={provider} icon={entry?.icon} label={entry?.label} size={12} /> {entry?.label ?? provider}</span>
        </span>
        <ChevronDown />
      </button>
      {open ? (
        <div className="wf-picker-pop" role="dialog" aria-label={t("ext.ai.workflows.picker.title")}>
          <div className="wf-picker-search">
            <Search />
            <input autoFocus value={query} placeholder={t("ext.ai.workflows.picker.search")} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") close(); }} />
          </div>
          <div className="wf-picker-providers">
            <button type="button" className={`wf-pill${only === null ? " is-on" : ""}`} onClick={() => setOnly(null)}>{t("ext.ai.workflows.picker.all")}</button>
            {ready.map((item) => (
              <button key={item.id} type="button" className={`wf-pill${only === item.id ? " is-on" : ""}`} onClick={() => setOnly(item.id)}>
                <ProviderIcon provider={item.id} icon={item.icon} size={14} />{item.label}
              </button>
            ))}
            <label className="wf-picker-fit"><input type="checkbox" checked={onlyFit} onChange={(event) => setOnlyFit(event.target.checked)} />{t("ext.ai.workflows.picker.onlyFit")}</label>
          </div>
          <div className="wf-picker-list">
            {!ready.length ? <p className="wf-muted wf-pad">{t("ext.ai.workflows.picker.noProviders")}</p> : null}
            {groups.map(({ entry: item, models, more }) => (
              <section key={item.id}>
                <h4 className="wf-picker-group"><ProviderIcon provider={item.id} icon={item.icon} size={14} />{item.label}</h4>
                {item.error ? <p className="wf-muted wf-pad">{item.error}</p> : null}
                {!item.models && !item.error ? <p className="wf-muted wf-pad">{t("ext.ai.workflows.picker.noList")}</p> : null}
                <ul>{models.map((choice) => row(item, choice))}</ul>
                {more ? <p className="wf-muted wf-pad">{t("ext.ai.workflows.picker.more", { count: more })}</p> : null}
              </section>
            ))}
            {typed && typedProvider ? (
              <button type="button" className="wf-model-row" onClick={() => choose({ provider: typedProvider, model: typed })}>
                <ModelIcon model={typed} provider={typedProvider} size={20} />
                <span className="wf-model-text"><span className="wf-model-name">{t("ext.ai.workflows.picker.useTyped", { model: typed })}</span><span className="wf-model-id">{catalog.providers.find((item) => item.id === typedProvider)?.label}</span></span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
