"use client";

import { useT } from "tansy/admin";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Plus, Spark, Trash } from "../parts";
import { checkWorkflow, tasksOf, type Problem } from "./check";
import { ApiError, loadCollection, saveWorkflow, type Catalog, type CollectionInfo, type FieldInfo, type WorkflowInput } from "./client";
import { ModelIcon } from "./icons";
import { CapabilityChips, ModelPicker } from "./model-picker";
import { REASONING, STRATEGIES, workflowSchema, type Agent, type Task } from "./schema";

type Draft = WorkflowInput;
type DraftStep = Draft["steps"][number];
type DraftAgent = Draft["agents"][number];

const NOT_WRITABLE = new Set(["file", "image", "gallery", "reference", "json", "password"]);

/** Fields a writer can fill: what the server's write schema asks for. */
export const writable = (field: FieldInfo) => !field.readonly && (field.type === "stream" ? Boolean(field.blocks?.some((block) => block.fields.some((item) => item.type === "rich_text"))) : !NOT_WRITABLE.has(field.type) && !field.type.includes("price") && Boolean(field.schema));

const newKey = (prefix: string, taken: string[]) => {
  for (let index = 1; ; index++) {
    const key = `${prefix}${index === 1 ? "" : `-${index}`}`;
    if (!taken.includes(key)) return key;
  }
};

function Section({ id, title, hint, children, actions }: { id: string; title: string; hint?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="wf-section" id={`wf-${id}`}>
      <header className="wf-section-head">
        <div><h2>{title}</h2>{hint ? <p className="wf-muted">{hint}</p> : null}</div>
        {actions}
      </header>
      {children}
    </section>
  );
}

function Labeled({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`wf-field${wide ? " wf-field-wide" : ""}`}>
      <span className="wf-label">{label}</span>
      {children}
      {hint ? <span className="wf-hint">{hint}</span> : null}
    </label>
  );
}

/** Agents to choose for a step's role, as toggles with each one's model icon. */
function AgentToggles({ agents, value, onChange, single }: { agents: DraftAgent[]; value: string[]; onChange: (value: string[]) => void; single?: boolean }) {
  return (
    <div className="wf-toggles">
      {agents.map((agent) => {
        const on = value.includes(agent.id);
        const order = value.indexOf(agent.id);
        return (
          <button key={agent.id} type="button" aria-pressed={on} className={`wf-toggle${on ? " is-on" : ""}`} onClick={() => onChange(single ? [agent.id] : on ? value.filter((id) => id !== agent.id) : [...value, agent.id])}>
            <ModelIcon model={agent.model} provider={agent.provider} size={16} />
            {agent.name}
            {on && !single && value.length > 1 ? <span className="wf-order">{order + 1}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function WorkflowEditor({ initial, catalog, collections, onSaved, onRun, onBack }: { initial: Draft; catalog: Catalog; collections: CollectionInfo[]; onSaved: (workflow: Draft) => void; onRun: (id: string) => void; onBack: () => void }) {
  const { t } = useT();
  const w = (key: string, values?: Record<string, unknown>) => t(`ext.ai.workflows.${key}`, values as never);
  const [draft, setDraft] = useState<Draft>(initial);
  const [fields, setFields] = useState<Record<string, FieldInfo[] | "error">>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [serverProblems, setServerProblems] = useState<Problem[]>([]);
  const [dirty, setDirty] = useState(false);

  const update = (change: (draft: Draft) => Draft) => { setDraft((value) => change(value)); setDirty(true); setSaved(null); };
  const setStep = (index: number, patch: Partial<DraftStep>) => update((value) => ({ ...value, steps: value.steps.map((step, at) => (at === index ? { ...step, ...patch } : step)) }));
  const setAgent = (index: number, patch: Partial<DraftAgent>) => update((value) => ({ ...value, agents: value.agents.map((agent, at) => (at === index ? { ...agent, ...patch } : agent)) }));

  // Each collection's fields, as the person may see them, for choosing what each step writes.
  const slugs = useMemo(() => [...new Set(draft.steps.map((step) => step.collection).filter(Boolean))], [draft.steps]);
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const slug of slugs) {
      if (asked.current.has(slug)) continue;
      asked.current.add(slug);
      void loadCollection(slug).then((collection) => setFields((value) => ({ ...value, [slug]: collection.fields }))).catch(() => setFields((value) => ({ ...value, [slug]: "error" })));
    }
  }, [slugs]);
  const fieldsOf = (slug: string) => (Array.isArray(fields[slug]) ? (fields[slug] as FieldInfo[]) : []);

  const parsed = useMemo(() => workflowSchema.safeParse(draft), [draft]);
  const problems = useMemo<Problem[]>(() => {
    const shape = parsed.success ? [] : parsed.error.issues.slice(0, 12).map((issue) => ({ path: issue.path.join("."), message: issue.message, level: "error" as const }));
    const models = parsed.success ? checkWorkflow(parsed.data, catalog) : [];
    return [...shape, ...models];
  }, [parsed, catalog]);
  const errors = problems.filter((problem) => problem.level === "error");
  const uses = useMemo(() => (parsed.success ? tasksOf(parsed.data) : tasksOf({ planner: draft.planner, steps: draft.steps.map((step) => ({ ...step, images: step.images ?? [] })) as never })), [parsed, draft]);

  async function save(): Promise<boolean> {
    setSaving(true);
    try {
      const result = await saveWorkflow(draft);
      setServerProblems(result.problems);
      setDraft(result.workflow);
      setDirty(false);
      setSaved(w("editor.saved"));
      onSaved(result.workflow);
      return true;
    } catch (error) {
      setServerProblems(error instanceof ApiError && Array.isArray(error.details) ? (error.details as Problem[]).map((item) => ({ ...item, level: "error" as const })) : [{ path: "", message: error instanceof Error ? error.message : String(error), level: "error" }]);
      return false;
    } finally {
      setSaving(false);
    }
  }

  const agentTasks = (agent: Agent | DraftAgent): Task[] => [...(uses.get(agent.id) ?? [])];
  const stepDepth = (step: DraftStep): number => {
    let depth = 0;
    for (let parent = step.parent; parent && depth < 6; depth++) parent = draft.steps.find((other) => other.id === parent)?.parent;
    return depth;
  };
  const shown = [...problems, ...serverProblems.filter((problem) => !problems.some((other) => other.message === problem.message))];

  return (
    <div className="wf-editor">
      <header className="wf-top">
        <button type="button" className="ai-ghost" onClick={onBack}>← {w("title")}</button>
        <input className="wf-title-input" value={draft.name} aria-label={w("editor.name")} onChange={(event) => update((value) => ({ ...value, name: event.target.value }))} />
        <span className="wf-top-status wf-muted">{saving ? w("editor.saving") : saved ?? (dirty ? w("editor.unsaved") : "")}</span>
        <button type="button" className="wf-button wf-button-ghost" disabled={saving} onClick={() => void save()}>{w("editor.save")}</button>
        <button type="button" className="wf-button" disabled={saving || errors.length > 0} title={errors[0]?.message} onClick={async () => { if (!dirty || (await save())) onRun(draft.id); }}><Spark className="ai-icon" />{w("editor.run")}</button>
      </header>

      <div className="wf-layout">
        <nav className="wf-map" aria-label={w("editor.map")}>
          <a href="#wf-brief" className="wf-map-node wf-map-brief"><span className="wf-map-dot" />{w("editor.brief")}</a>
          {draft.planner ? (
            <a href="#wf-team" className="wf-map-node"><span className="wf-map-icon"><ModelIcon {...(draft.agents.find((agent) => agent.id === draft.planner?.agent) ?? { model: "", provider: "" })} size={14} /></span>{w("editor.planner")}</a>
          ) : null}
          {draft.steps.map((step, index) => (
            <a key={step.id} href={`#wf-step-${index}`} className="wf-map-node" style={{ paddingInlineStart: `${0.75 + stepDepth(step) * 1}rem` }}>
              <span className="wf-map-dot" />
              <span className="wf-map-text">{step.name || step.id}<small>{step.count.min === step.count.max ? step.count.min : `${step.count.min}–${step.count.max}`} × {collections.find((item) => item.slug === step.collection)?.name ?? step.collection}</small></span>
              <span className="wf-map-agents">
                {step.writers.map((id) => { const agent = draft.agents.find((item) => item.id === id); return agent ? <ModelIcon key={id} model={agent.model} provider={agent.provider} size={14} /> : null; })}
                {step.judge ? <span className="wf-map-judge" title={w("editor.judge")}>⚖</span> : null}
                {step.images?.length ? <span className="wf-map-judge" title={w("editor.images")}>▣</span> : null}
              </span>
            </a>
          ))}
          <div className="wf-problems" aria-live="polite">
            {shown.length ? shown.map((problem, index) => <p key={index} className={`wf-problem wf-problem-${problem.level}`}>{problem.message}</p>) : <p className="wf-problem wf-problem-ok">{w("editor.ready")}</p>}
          </div>
        </nav>

        <div className="wf-sections">
          <Section id="brief" title={w("editor.brief")} hint={w("editor.briefHint")}>
            <Labeled label={w("editor.description")} wide><input className="wf-input" value={draft.description ?? ""} maxLength={500} onChange={(event) => update((value) => ({ ...value, description: event.target.value }))} /></Labeled>
            <Labeled label={w("editor.masterPrompt")} hint={w("editor.masterPromptHint")} wide>
              <textarea className="wf-input wf-textarea wf-textarea-tall" value={draft.brief} maxLength={8000} onChange={(event) => update((value) => ({ ...value, brief: event.target.value }))} />
            </Labeled>
            <div className="wf-subhead">
              <h3>{w("editor.inputs")}</h3>
              <button type="button" className="ai-ghost" onClick={() => update((value) => ({ ...value, inputs: [...(value.inputs ?? []), { name: newKey("input", (value.inputs ?? []).map((input) => input.name)).replace(/-/g, "_"), label: w("editor.newInput"), multiline: false, required: true }] }))}><Plus />{w("editor.addInput")}</button>
            </div>
            <p className="wf-muted">{w("editor.inputsHint")}</p>
            {(draft.inputs ?? []).map((input, index) => (
              <div key={index} className="wf-row">
                <input className="wf-input wf-mono" value={input.name} aria-label={w("editor.inputName")} onChange={(event) => update((value) => ({ ...value, inputs: value.inputs!.map((item, at) => (at === index ? { ...item, name: event.target.value } : item)) }))} />
                <input className="wf-input" value={input.label} aria-label={w("editor.inputLabel")} onChange={(event) => update((value) => ({ ...value, inputs: value.inputs!.map((item, at) => (at === index ? { ...item, label: event.target.value } : item)) }))} />
                <label className="wf-check"><input type="checkbox" checked={input.multiline ?? false} onChange={(event) => update((value) => ({ ...value, inputs: value.inputs!.map((item, at) => (at === index ? { ...item, multiline: event.target.checked } : item)) }))} />{w("editor.multiline")}</label>
                <label className="wf-check"><input type="checkbox" checked={input.required ?? true} onChange={(event) => update((value) => ({ ...value, inputs: value.inputs!.map((item, at) => (at === index ? { ...item, required: event.target.checked } : item)) }))} />{w("editor.required")}</label>
                <code className="wf-token">{`{{${input.name}}}`}</code>
                <button type="button" className="ai-ghost ai-ghost-icon" aria-label={w("editor.remove")} onClick={() => update((value) => ({ ...value, inputs: value.inputs!.filter((_, at) => at !== index) }))}><Trash /></button>
              </div>
            ))}
          </Section>

          <Section id="team" title={w("editor.team")} hint={w("editor.teamHint")} actions={
            <button type="button" className="ai-ghost" onClick={() => update((value) => {
              const id = newKey("agent", value.agents.map((agent) => agent.id));
              const first = value.agents[0];
              return { ...value, agents: [...value.agents, { id, name: w("editor.newAgent"), role: "", provider: first?.provider ?? catalog.providers.find((item) => item.ready)?.id ?? "", model: first?.model ?? "", reasoning: "provider-default" }] };
            })}><Plus />{w("editor.addAgent")}</button>
          }>
            <Labeled label={w("editor.planner")} hint={w("editor.plannerHint")} wide>
              <select className="wf-input" value={draft.planner?.agent ?? ""} onChange={(event) => update((value) => ({ ...value, planner: event.target.value ? { agent: event.target.value } : undefined }))}>
                <option value="">{w("editor.noPlanner")}</option>
                {draft.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              </select>
            </Labeled>
            <div className="wf-agents">
              {draft.agents.map((agent, index) => {
                const entry = catalog.providers.find((item) => item.id === agent.provider);
                const choice = entry?.models?.find((item) => item.value === agent.model);
                const tasks = agentTasks(agent);
                return (
                  <article key={index} className="wf-agent">
                    <div className="wf-agent-head">
                      <ModelIcon model={agent.model} provider={agent.provider} icon={entry?.icon} size={28} />
                      <input className="wf-input wf-agent-name" value={agent.name} aria-label={w("editor.agentName")} onChange={(event) => setAgent(index, { name: event.target.value })} />
                      <button type="button" className="ai-ghost ai-ghost-icon" aria-label={w("editor.remove")} disabled={draft.agents.length < 2} onClick={() => update((value) => ({ ...value, agents: value.agents.filter((_, at) => at !== index) }))}><Trash /></button>
                    </div>
                    <div className="wf-agent-tasks">
                      {tasks.length ? tasks.map((task) => <span key={task} className="wf-chip wf-chip-task">{w(`tasks.${task}`)}</span>) : <span className="wf-chip wf-chip-unknown">{w("editor.idle")}</span>}
                      <code className="wf-mono wf-muted">{agent.id}</code>
                    </div>
                    <ModelPicker catalog={catalog} provider={agent.provider} model={agent.model} tasks={tasks} onChange={(value) => setAgent(index, value)} />
                    <div className="wf-model-chips"><CapabilityChips capabilities={choice?.capabilities} /></div>
                    <Labeled label={w("editor.role")} wide><textarea className="wf-input wf-textarea" value={agent.role ?? ""} maxLength={2000} placeholder={w("editor.rolePlaceholder")} onChange={(event) => setAgent(index, { role: event.target.value })} /></Labeled>
                    <div className="wf-grid-2">
                      <Labeled label={w("editor.reasoning")}>
                        <select className="wf-input" value={agent.reasoning ?? "provider-default"} onChange={(event) => setAgent(index, { reasoning: event.target.value as DraftAgent["reasoning"] })}>
                          {REASONING.map((level) => <option key={level} value={level}>{t(`ext.ai.settings.reasoning.options.${level}`)}</option>)}
                        </select>
                      </Labeled>
                      <Labeled label={w("editor.temperature")}>
                        <input className="wf-input" type="number" min={0} max={2} step={0.1} value={agent.temperature ?? ""} placeholder={w("editor.default")} onChange={(event) => setAgent(index, { temperature: event.target.value === "" ? undefined : Number(event.target.value) })} />
                      </Labeled>
                    </div>
                  </article>
                );
              })}
            </div>
          </Section>

          <Section id="steps" title={w("editor.steps")} hint={w("editor.stepsHint")} actions={
            <button type="button" className="ai-ghost" onClick={() => update((value) => ({ ...value, steps: [...value.steps, { id: newKey("step", value.steps.map((step) => step.id)), name: w("editor.newStep"), collection: "", count: { min: 1, max: 3 }, fields: [], instructions: "", writers: [value.agents[0]?.id ?? ""], strategy: "rotate", images: [], links: [] }] }))}><Plus />{w("editor.addStep")}</button>
          }>
            {draft.steps.map((step, index) => {
              const all = fieldsOf(step.collection);
              const canWrite = all.filter(writable);
              const references = all.filter((field) => field.type === "reference");
              const numbers = all.filter((field) => field.type === "number");
              const images = all.filter((field) => field.type === "image");
              const parents = draft.steps.slice(0, index);
              const ancestors: string[] = [];
              for (let parent = step.parent; parent && !ancestors.includes(parent); parent = draft.steps.find((other) => other.id === parent)?.parent) ancestors.push(parent);
              return (
                <article key={index} className="wf-step" id={`wf-step-${index}`}>
                  <header className="wf-step-head">
                    <span className="wf-step-number">{index + 1}</span>
                    <input className="wf-input wf-step-name" value={step.name} aria-label={w("editor.stepName")} onChange={(event) => setStep(index, { name: event.target.value })} />
                    <code className="wf-mono wf-muted">{step.id}</code>
                    <button type="button" className="ai-ghost ai-ghost-icon" aria-label={w("editor.remove")} disabled={draft.steps.length < 2} onClick={() => update((value) => ({ ...value, steps: value.steps.filter((_, at) => at !== index).map((other) => (other.parent === step.id ? { ...other, parent: undefined, link: undefined } : other)) }))}><Trash /></button>
                  </header>

                  <div className="wf-grid-3">
                    <Labeled label={w("editor.collection")}>
                      <select className="wf-input" value={step.collection} onChange={(event) => setStep(index, { collection: event.target.value, fields: [], link: undefined, links: [], orderField: undefined, images: [] })}>
                        <option value="">{w("editor.chooseCollection")}</option>
                        {collections.filter((item) => !item.readOnly).map((item) => <option key={item.slug} value={item.slug}>{item.name}</option>)}
                      </select>
                    </Labeled>
                    <Labeled label={w("editor.parent")} hint={w("editor.parentHint")}>
                      <select className="wf-input" value={step.parent ?? ""} onChange={(event) => setStep(index, { parent: event.target.value || undefined, link: undefined, links: [] })}>
                        <option value="">{w("editor.topLevel")}</option>
                        {parents.map((other) => <option key={other.id} value={other.id}>{w("editor.eachOf", { step: other.name })}</option>)}
                      </select>
                    </Labeled>
                    <div className="wf-field">
                      <span className="wf-label">{w("editor.count")}</span>
                      <div className="wf-count">
                        <input className="wf-input" type="number" min={1} max={50} value={step.count.min} aria-label={w("editor.countMin")} onChange={(event) => setStep(index, { count: { min: Number(event.target.value) || 1, max: Math.max(step.count.max, Number(event.target.value) || 1) } })} />
                        <span>–</span>
                        <input className="wf-input" type="number" min={1} max={50} value={step.count.max} aria-label={w("editor.countMax")} onChange={(event) => setStep(index, { count: { ...step.count, max: Number(event.target.value) || 1 } })} />
                      </div>
                      <span className="wf-hint">{step.count.min === step.count.max ? w("editor.exactly", { count: step.count.min }) : w("editor.between", { min: step.count.min, max: step.count.max })}</span>
                    </div>
                  </div>

                  {step.parent || ancestors.length ? (
                    <div className="wf-grid-3">
                      {step.parent ? (
                        <Labeled label={w("editor.link")} hint={w("editor.linkHint")}>
                          <select className="wf-input" value={step.link ?? ""} onChange={(event) => setStep(index, { link: event.target.value || undefined })}>
                            <option value="">{w("editor.chooseField")}</option>
                            {references.map((field) => <option key={field.name} value={field.name}>{field.label ?? field.name}</option>)}
                          </select>
                        </Labeled>
                      ) : null}
                      {ancestors.slice(1).map((ancestor) => {
                        const current = (step.links ?? []).find((link) => link.step === ancestor);
                        return (
                          <Labeled key={ancestor} label={w("editor.alsoLink", { step: draft.steps.find((other) => other.id === ancestor)?.name ?? ancestor })}>
                            <select className="wf-input" value={current?.field ?? ""} onChange={(event) => setStep(index, { links: [...(step.links ?? []).filter((link) => link.step !== ancestor), ...(event.target.value ? [{ field: event.target.value, step: ancestor }] : [])] })}>
                              <option value="">{w("editor.none")}</option>
                              {references.map((field) => <option key={field.name} value={field.name}>{field.label ?? field.name}</option>)}
                            </select>
                          </Labeled>
                        );
                      })}
                      <Labeled label={w("editor.order")} hint={w("editor.orderHint")}>
                        <select className="wf-input" value={step.orderField ?? ""} onChange={(event) => setStep(index, { orderField: event.target.value || undefined })}>
                          <option value="">{w("editor.none")}</option>
                          {numbers.map((field) => <option key={field.name} value={field.name}>{field.label ?? field.name}</option>)}
                        </select>
                      </Labeled>
                    </div>
                  ) : null}

                  <div className="wf-field wf-field-wide">
                    <span className="wf-label">{w("editor.fields")}</span>
                    {fields[step.collection] === "error" ? <span className="wf-hint">{w("editor.fieldsError")}</span> : null}
                    <div className="wf-toggles">
                      {canWrite.map((field) => {
                        const on = !step.fields?.length || step.fields.includes(field.name);
                        const linked = field.name === step.link || field.name === step.orderField || (step.links ?? []).some((link) => link.field === field.name);
                        if (linked) return null;
                        return (
                          <button key={field.name} type="button" aria-pressed={on} className={`wf-toggle wf-toggle-small${on ? " is-on" : ""}`} onClick={() => {
                            const current = step.fields?.length ? step.fields : canWrite.map((item) => item.name);
                            const next = on ? current.filter((name) => name !== field.name) : [...current, field.name];
                            setStep(index, { fields: next.length === canWrite.length ? [] : next });
                          }}>{field.label ?? field.name}<small>{field.type}</small></button>
                        );
                      })}
                    </div>
                  </div>

                  <Labeled label={w("editor.instructions")} hint={w("editor.instructionsHint")} wide>
                    <textarea className="wf-input wf-textarea" value={step.instructions ?? ""} maxLength={4000} onChange={(event) => setStep(index, { instructions: event.target.value })} />
                  </Labeled>

                  <div className="wf-field wf-field-wide">
                    <span className="wf-label">{w("editor.writers")}</span>
                    <AgentToggles agents={draft.agents} value={step.writers} onChange={(writers) => setStep(index, { writers })} />
                  </div>
                  <div className="wf-field wf-field-wide">
                    <span className="wf-label">{w("editor.strategy")}</span>
                    <div className="wf-segments" role="radiogroup">
                      {STRATEGIES.map((strategy) => (
                        <button key={strategy} type="button" role="radio" aria-checked={(step.strategy ?? "rotate") === strategy} className={`wf-segment${(step.strategy ?? "rotate") === strategy ? " is-on" : ""}`} onClick={() => setStep(index, { strategy })}>
                          <strong>{w(`strategy.${strategy}`)}</strong><span>{w(`strategy.${strategy}Hint`)}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="wf-box">
                    <label className="wf-check wf-box-head">
                      <input type="checkbox" checked={Boolean(step.judge)} onChange={(event) => setStep(index, { judge: event.target.checked ? { agent: draft.agents.find((agent) => !step.writers.includes(agent.id))?.id ?? draft.agents[0].id, criteria: "", minScore: 7, revisions: 1 } : undefined })} />
                      <strong>{w("editor.judge")}</strong><span className="wf-muted">{w("editor.judgeHint")}</span>
                    </label>
                    {step.judge ? (
                      <>
                        <AgentToggles single agents={draft.agents} value={[step.judge.agent]} onChange={([agent]) => setStep(index, { judge: { ...step.judge!, agent } })} />
                        <div className="wf-grid-3">
                          <Labeled label={w("editor.minScore", { score: step.judge.minScore ?? 7 })}>
                            <input type="range" min={1} max={10} value={step.judge.minScore ?? 7} onChange={(event) => setStep(index, { judge: { ...step.judge!, minScore: Number(event.target.value) } })} />
                          </Labeled>
                          <Labeled label={w("editor.revisions")} hint={w("editor.revisionsHint")}>
                            <input className="wf-input" type="number" min={0} max={3} value={step.judge.revisions ?? 1} onChange={(event) => setStep(index, { judge: { ...step.judge!, revisions: Number(event.target.value) } })} />
                          </Labeled>
                        </div>
                        <Labeled label={w("editor.criteria")} hint={draft.planner ? w("editor.criteriaPlannerHint") : w("editor.criteriaHint")} wide>
                          <textarea className="wf-input wf-textarea" value={step.judge.criteria ?? ""} maxLength={2000} onChange={(event) => setStep(index, { judge: { ...step.judge!, criteria: event.target.value } })} />
                        </Labeled>
                      </>
                    ) : null}
                  </div>

                  {images.length ? (
                    <div className="wf-box">
                      <div className="wf-box-head"><strong>{w("editor.images")}</strong><span className="wf-muted">{w("editor.imagesHint")}</span></div>
                      {images.map((field) => {
                        const config = (step.images ?? []).find((image) => image.field === field.name);
                        const setImage = (patch: Partial<NonNullable<typeof config>> | null) => setStep(index, { images: [...(step.images ?? []).filter((image) => image.field !== field.name), ...(patch === null ? [] : [{ field: field.name, artists: [], style: "", aspectRatio: "16:9" as const, ...config, ...patch }])] });
                        return (
                          <div key={field.name} className="wf-image">
                            <label className="wf-check"><input type="checkbox" checked={Boolean(config)} onChange={(event) => setImage(event.target.checked ? { artists: draft.agents.filter((agent) => agentTasks(agent).includes("image")).map((agent) => agent.id).slice(0, 1) } : null)} />{field.label ?? field.name}</label>
                            {config ? (
                              <>
                                <AgentToggles agents={draft.agents} value={config.artists} onChange={(artists) => setImage({ artists })} />
                                <div className="wf-grid-3">
                                  <Labeled label={w("editor.style")} wide><input className="wf-input" value={config.style ?? ""} maxLength={1000} placeholder={w("editor.stylePlaceholder")} onChange={(event) => setImage({ style: event.target.value })} /></Labeled>
                                  <Labeled label={w("editor.aspect")}>
                                    <select className="wf-input" value={config.aspectRatio ?? "16:9"} onChange={(event) => setImage({ aspectRatio: event.target.value as "16:9" })}>
                                      {["1:1", "16:9", "4:3", "3:2", "2:3", "9:16"].map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
                                    </select>
                                  </Labeled>
                                </div>
                              </>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </Section>

          <Section id="reliability" title={w("editor.reliability")} hint={w("editor.reliabilityHint")}>
            <div className="wf-grid-3">
              <Labeled label={w("editor.attempts")} hint={w("editor.attemptsHint")}>
                <input className="wf-input" type="number" min={1} max={6} value={draft.retry?.attempts ?? 3} onChange={(event) => update((value) => ({ ...value, retry: { attempts: Number(event.target.value) || 1, backoffSeconds: value.retry?.backoffSeconds ?? 4 } }))} />
              </Labeled>
              <Labeled label={w("editor.backoff")} hint={w("editor.backoffHint")}>
                <input className="wf-input" type="number" min={0} max={120} value={draft.retry?.backoffSeconds ?? 4} onChange={(event) => update((value) => ({ ...value, retry: { attempts: value.retry?.attempts ?? 3, backoffSeconds: Number(event.target.value) || 0 } }))} />
              </Labeled>
              <Labeled label={w("editor.concurrency")} hint={w("editor.concurrencyHint")}>
                <input className="wf-input" type="number" min={1} max={6} value={draft.concurrency ?? 2} onChange={(event) => update((value) => ({ ...value, concurrency: Number(event.target.value) || 1 }))} />
              </Labeled>
              <Labeled label={w("editor.saveAs")}>
                <select className="wf-input" value={draft.status ?? "draft"} onChange={(event) => update((value) => ({ ...value, status: event.target.value as "draft" }))}>
                  <option value="draft">{w("editor.drafts")}</option>
                  <option value="published">{w("editor.published")}</option>
                </select>
              </Labeled>
              <Labeled label={w("editor.actsAs")} hint={catalog.chooseRole ? w("editor.actsAsHint") : w("editor.actsAsAdmin")}>
                <select className="wf-input" value={draft.actsAs ?? ""} disabled={!catalog.chooseRole} onChange={(event) => update((value) => ({ ...value, actsAs: event.target.value || undefined }))}>
                  <option value="">{w("editor.actsAsDefault", { role: catalog.roles?.find((role) => role.name === catalog.defaultRole)?.label ?? catalog.defaultRole ?? "" })}</option>
                  {(catalog.roles ?? []).map((role) => <option key={role.name} value={role.name} title={role.description}>{role.label}</option>)}
                  {draft.actsAs && !catalog.roles?.some((role) => role.name === draft.actsAs) ? <option value={draft.actsAs}>{draft.actsAs}</option> : null}
                </select>
              </Labeled>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
