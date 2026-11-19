"use client";

import { PageSkeleton, Skeleton, useT } from "tansy/admin";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Plus, Spark, Trash } from "../parts";
import { deleteWorkflow, listWorkflows, loadCatalog, loadWorkflow, startRun, type Catalog, type CollectionInfo, type RunSummary, type WorkflowInput, type WorkflowSummary } from "./client";
import { WorkflowEditor } from "./editor";
import { ProviderIcon } from "./icons";
import { RunView, StatusPill } from "./run";
import { fromTemplate, TEMPLATES, type TemplateId } from "./templates";
import "../ai.css";
import "./workflow.css";

/** Which screen is open, kept in the address so a reload or a shared link opens it again. */
type Screen = { kind: "home" } | { kind: "edit"; id: string } | { kind: "new"; template: TemplateId } | { kind: "run"; id: string };

function screenOf(search: string): Screen {
  const params = new URLSearchParams(search);
  const run = params.get("run");
  if (run && /^[a-z0-9]{8,32}$/.test(run)) return { kind: "run", id: run };
  const workflow = params.get("workflow");
  if (workflow && /^[a-z0-9][a-z0-9-]{0,39}$/.test(workflow)) return { kind: "edit", id: workflow };
  const template = params.get("new") as TemplateId | null;
  if (template && TEMPLATES.includes(template)) return { kind: "new", template };
  return { kind: "home" };
}

function go(screen: Screen) {
  const url = new URL(window.location.href);
  for (const key of ["run", "workflow", "new"]) url.searchParams.delete(key);
  if (screen.kind === "run") url.searchParams.set("run", screen.id);
  if (screen.kind === "edit") url.searchParams.set("workflow", screen.id);
  if (screen.kind === "new") url.searchParams.set("new", screen.template);
  window.history.pushState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const subscribe = (change: () => void) => {
  window.addEventListener("popstate", change);
  return () => window.removeEventListener("popstate", change);
};

/** The inputs a run asks for, then starts it. */
function RunDialog({ workflow, onClose, onStarted }: { workflow: WorkflowInput; onClose: () => void; onStarted: (run: string) => void }) {
  const { t } = useT();
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="wf-dialog-scrim" role="presentation" onClick={onClose}>
      <form className="wf-dialog" role="dialog" aria-modal="true" aria-label={t("ext.ai.workflows.start.title")} onClick={(event) => event.stopPropagation()} onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const { run } = await startRun(workflow.id, inputs);
          onStarted(run.id);
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : String(caught));
          setBusy(false);
        }
      }}>
        <h2><Spark className="ai-icon" />{workflow.name}</h2>
        {workflow.description ? <p className="wf-muted">{workflow.description}</p> : null}
        {(workflow.inputs ?? []).map((input) => (
          <label key={input.name} className="wf-field wf-field-wide">
            <span className="wf-label">{input.label}{input.required === false ? ` (${t("ext.ai.workflows.start.optional")})` : ""}</span>
            {input.multiline
              ? <textarea className="wf-input wf-textarea" required={input.required !== false} value={inputs[input.name] ?? ""} onChange={(event) => setInputs({ ...inputs, [input.name]: event.target.value })} />
              : <input className="wf-input" required={input.required !== false} value={inputs[input.name] ?? ""} onChange={(event) => setInputs({ ...inputs, [input.name]: event.target.value })} />}
          </label>
        ))}
        <p className="wf-muted">{t("ext.ai.workflows.start.hint")}</p>
        {error ? <p className="wf-problem wf-problem-error">{error}</p> : null}
        <div className="wf-dialog-actions">
          <button type="button" className="wf-button wf-button-ghost" onClick={onClose}>{t("ext.ai.workflows.start.cancel")}</button>
          <button type="submit" className="wf-button" disabled={busy}>{busy ? t("ext.ai.workflows.start.starting") : t("ext.ai.workflows.start.go")}</button>
        </div>
      </form>
    </div>
  );
}

export function Workflows() {
  const { t } = useT();
  const w = (key: string, values?: Record<string, unknown>) => t(`ext.ai.workflows.${key}`, values as never);
  const search = useSyncExternalStore(subscribe, () => window.location.search, () => "");
  const screen = useMemo(() => screenOf(search), [search]);
  const [list, setList] = useState<{ workflows: WorkflowSummary[]; runs: RunSummary[] } | null>(null);
  const [catalog, setCatalog] = useState<(Catalog & { collections: CollectionInfo[] }) | null>(null);
  const [loaded, setLoaded] = useState<WorkflowInput | null>(null);
  const [running, setRunning] = useState<WorkflowInput | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback((next: Screen) => go(next), []);

  const refresh = useCallback(() => listWorkflows().then(setList).catch((caught: Error) => setError(caught.message)), []);
  useEffect(() => { if (screen.kind === "home") void refresh(); }, [screen, refresh]);
  // Models and collections, for the builder and for showing each workflow's team.
  useEffect(() => { void loadCatalog().then(setCatalog).catch((caught: Error) => setError(caught.message)); }, []);

  const editId = screen.kind === "edit" ? screen.id : null;
  useEffect(() => {
    if (editId) void loadWorkflow(editId).then(({ workflow }) => setLoaded(workflow)).catch((caught: Error) => setError(caught.message));
  }, [editId]);
  const template = screen.kind === "new" ? screen.template : null;
  const templateName = template ? w(`templates.${template}.name`) : "";
  const fresh = useMemo(() => (template && catalog ? fromTemplate(template, catalog, catalog.collections.map((item) => item.slug), templateName) : null), [template, catalog, templateName]);
  const editing = screen.kind === "new" ? fresh : loaded?.id === editId ? loaded : null;

  const runWorkflow = async (id: string) => {
    try {
      const { workflow } = await loadWorkflow(id);
      if (!(workflow.inputs ?? []).length) {
        const { run } = await startRun(id, {});
        open({ kind: "run", id: run.id });
      } else setRunning(workflow);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const dialog = running ? <RunDialog workflow={running} onClose={() => setRunning(null)} onStarted={(id) => { setRunning(null); open({ kind: "run", id }); }} /> : null;

  if (screen.kind === "run") return <><RunView key={screen.id} id={screen.id} onBack={() => open({ kind: "home" })} onEdit={(id) => open({ kind: "edit", id })} />{dialog}</>;
  if (screen.kind === "edit" || screen.kind === "new") {
    if (error) return <div className="wf-page"><p className="wf-problem wf-problem-error">{error}</p></div>;
    if (!editing || !catalog) return <PageSkeleton kind="form" />;
    return (
      <>
        <WorkflowEditor key={editing.id} initial={editing} catalog={catalog} collections={catalog.collections} onBack={() => open({ kind: "home" })} onSaved={(saved) => { if (screen.kind === "new") { go({ kind: "edit", id: saved.id }); } }} onRun={(id) => void runWorkflow(id)} />
        {dialog}
      </>
    );
  }

  return (
    <div className="wf-page wf-home">
      <header className="wf-hero">
        <div>
          <h1><Spark className="ai-icon" />{w("title")}</h1>
          <p className="wf-muted">{w("intro")}</p>
        </div>
        {catalog ? (
          <div className="wf-hero-providers" aria-label={w("providers")}>
            {catalog.providers.map((entry) => <span key={entry.id} className={`wf-provider${entry.ready ? " is-ready" : ""}`} title={`${entry.label}: ${entry.ready ? w("ready") : w("notSetUp")}`}><ProviderIcon provider={entry.id} icon={entry.icon} size={18} /></span>)}
          </div>
        ) : null}
      </header>
      {error ? <p className="wf-problem wf-problem-error">{error}</p> : null}

      <section>
        <h2 className="wf-h2">{w("startFrom")}</h2>
        <div className="wf-templates">
          {TEMPLATES.map((template) => (
            <button key={template} type="button" className="wf-template" disabled={!catalog} onClick={() => open({ kind: "new", template })}>
              <span className="wf-template-icon">{template === "blank" ? <Plus /> : <Spark className="ai-icon" />}</span>
              <strong>{w(`templates.${template}.name`)}</strong>
              <span className="wf-muted">{w(`templates.${template}.hint`)}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="wf-h2">{w("yours")}</h2>
        {!list ? <div className="cms-stack-2" aria-busy="true">{[0, 1, 2].map((row) => <Skeleton key={row} height="control" />)}</div> : !list.workflows.length ? <p className="wf-muted">{w("empty")}</p> : (
          <div className="wf-cards-grid">
            {list.workflows.map((summary) => (
              <article key={summary.id} className="wf-workflow">
                <button type="button" className="wf-workflow-main" onClick={() => open({ kind: "edit", id: summary.id })}>
                  <strong>{summary.name}</strong>
                  {summary.description ? <span className="wf-muted">{summary.description}</span> : null}
                  <span className="wf-workflow-meta">{w("meta", { agents: summary.agents, steps: summary.steps })}</span>
                </button>
                <div className="wf-workflow-actions">
                  <button type="button" className="wf-button" onClick={() => void runWorkflow(summary.id)}><Spark className="ai-icon" />{w("run.start")}</button>
                  <button type="button" className="ai-ghost ai-ghost-icon" aria-label={w("delete")} title={w("delete")} onClick={() => { if (window.confirm(w("deleteConfirm", { name: summary.name }))) void deleteWorkflow(summary.id).then(refresh); }}><Trash /></button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {list?.runs.length ? (
        <section>
          <h2 className="wf-h2">{w("runs")}</h2>
          <ul className="wf-runs">
            {list.runs.map((run) => (
              <li key={run.id}>
                <button type="button" className="wf-run-row" onClick={() => open({ kind: "run", id: run.id })}>
                  <StatusPill status={run.status} />
                  <strong>{run.workflowName}</strong>
                  <span className="wf-muted">{w("runRow", { ready: run.ready, items: run.items, created: run.created })}</span>
                  <span className="wf-muted">{run.createdBy} · {new Date(run.createdAt).toLocaleString()}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {dialog}
    </div>
  );
}
