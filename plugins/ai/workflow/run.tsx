"use client";

import { PageSkeleton, useT } from "tansy/admin";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../markdown";
import { Chevron, Retry, Trash } from "../parts";
import { ApiError, cancelRun, commitRun, deleteRun, imageUrl, loadRun, regenerateItem, retryRun, uploadImage, type Run, type RunItem, type RunTask } from "./client";
import { ModelIcon } from "./icons";

const POLL_MS = 2000;

export function StatusPill({ status }: { status: string }) {
  const { t } = useT();
  return <span className={`wf-status wf-status-${status}`}>{status === "running" ? <span className="wf-pulse" /> : null}{t(`ext.ai.workflows.status.${status}`)}</span>;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const compact = (value: number) => new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);

/** One record the run is writing, as a card on its step's lane. */
function ItemCard({ run, item, task }: { run: Run; item: RunItem; task?: RunTask }) {
  const { t } = useT();
  const agent = run.workflow.agents.find((entry) => entry.id === (item.agent ?? task?.agent));
  const step = run.workflow.steps.find((entry) => entry.id === item.step);
  const working = task?.status === "running";
  const state = working ? "writing" : item.status;
  const passed = item.score !== undefined && step?.judge ? item.score >= step.judge.minScore : undefined;
  return (
    <div className={`wf-card wf-card-${state}`} title={item.error ?? item.brief}>
      <div className="wf-card-top">
        {agent ? <ModelIcon model={agent.model} provider={agent.provider} size={14} /> : <span className="wf-dot" />}
        <span className="wf-card-title">{item.title}</span>
      </div>
      <div className="wf-card-meta">
        <span className={`wf-card-state wf-card-state-${state}`}>{t(`ext.ai.workflows.item.${state}`)}</span>
        {item.score !== undefined ? <span className={`wf-score${passed === false ? " is-low" : ""}`}>{item.score}/10</span> : null}
        {item.revisions ? <span className="wf-muted">↻{item.revisions}</span> : null}
        {Object.keys(item.images).length ? <span className="wf-muted">▣{Object.keys(item.images).length}</span> : null}
        {item.recordId ? <span className="wf-created">#{item.recordId}</span> : null}
      </div>
    </div>
  );
}

export function RunView({ id, onBack, onEdit }: { id: string; onBack: () => void; onEdit: (workflow: string) => void }) {
  const { t } = useT();
  const w = (key: string, values?: Record<string, unknown>) => t(`ext.ai.workflows.${key}`, values as never);
  const [run, setRun] = useState<Run | null>(null);
  const [driving, setDriving] = useState(false);
  const [values, setValues] = useState<Record<string, Record<string, string>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showPlan, setShowPlan] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const logRef = useRef<HTMLOListElement>(null);

  const refresh = useCallback(async () => {
    try {
      const first = await loadRun(id);
      const settled = first.run.status !== "running" && !first.driving;
      const result = settled ? await loadRun(id, true) : first;
      setRun(result.run);
      setDriving(result.driving);
      if (result.values) setValues(result.values);
      setError(null);
      return settled;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return true;
    }
  }, [id]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const settled = await refresh();
      if (!stopped && !settled) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [refresh]);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [run?.log.length]);

  const act = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    setNotice(null);
    try {
      await action();
      // Something started again: follow it.
      let settled = await refresh();
      while (!settled) { await new Promise((resolve) => setTimeout(resolve, POLL_MS)); settled = await refresh(); }
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  const tasksByItem = useMemo(() => {
    const map = new Map<string, RunTask>();
    for (const task of run?.tasks ?? []) if (task.item && task.kind === "write") map.set(task.item, task);
    return map;
  }, [run]);

  if (error && !run) return <div className="wf-page"><p className="wf-problem wf-problem-error">{error}</p><button type="button" className="ai-ghost" onClick={onBack}>← {w("title")}</button></div>;
  if (!run) return <PageSkeleton kind="detail" />;

  const done = run.tasks.filter((task) => task.status === "done").length;
  const failed = run.tasks.filter((task) => task.status === "failed" || task.status === "cancelled").length;
  const total = run.tasks.length;
  const settled = run.status !== "running" && !driving;
  const ready = run.items.filter((item) => item.status === "ready");
  const toCreate = ready.filter((item) => !item.recordId && !excluded.has(item.id) && (!item.parent || !excluded.has(item.parent)));
  const outlining = run.tasks.filter((task) => task.kind === "outline" && task.status === "running");
  const planning = run.tasks.find((task) => task.kind === "plan");
  // While reviewing, what happened shows in the bar by the button, not at the top of the page.
  const reviewing = settled && ready.length > 0;

  async function create() {
    if (!run) return;
    const files: Record<string, string> = {};
    const include = ready.filter((item) => !excluded.has(item.id)).map((item) => item.id);
    const pictures = toCreate.flatMap((item) => Object.entries(item.images).map(([field, image]) => ({ image, name: `${item.title}-${field}` })));
    for (const [index, picture] of pictures.entries()) {
      setBusy(w("review.uploading", { done: index, total: pictures.length }));
      files[picture.image] = await uploadImage(run.id, picture.image, picture.name);
    }
    setBusy(w("review.creating"));
    const result = await commitRun(run.id, { include, files });
    setNotice(w("review.created", { count: result.created.length }));
  }

  const depthOf = (item: RunItem) => {
    let depth = 0;
    for (let parent = item.parent; parent && depth < 6; depth++) parent = run.items.find((other) => other.id === parent)?.parent;
    return depth;
  };
  const tree: RunItem[] = [];
  const visit = (parent: string | undefined) => {
    for (const item of run.items.filter((entry) => entry.parent === parent).sort((a, b) => a.index - b.index)) { tree.push(item); visit(item.id); }
  };
  visit(undefined);

  return (
    <div className="wf-page wf-run">
      <header className="wf-top">
        <button type="button" className="ai-ghost" onClick={onBack}>← {w("title")}</button>
        <div className="wf-run-title">
          <h1>{run.workflow.name}</h1>
          <span className="wf-muted">{w("run.by", { name: run.createdBy.name, time: new Date(run.createdAt).toLocaleString() })}</span>
        </div>
        <StatusPill status={run.status} />
        {run.status === "running" ? <button type="button" className="wf-button wf-button-ghost" disabled={Boolean(busy)} onClick={() => void act("cancel", () => cancelRun(run.id))}>{w("run.cancel")}</button> : null}
        {settled && failed ? <button type="button" className="wf-button wf-button-ghost" disabled={Boolean(busy)} onClick={() => void act("retry", () => retryRun(run.id))}><Retry />{w("run.retry", { count: failed })}</button> : null}
        <button type="button" className="ai-ghost" onClick={() => onEdit(run.workflow.id)}>{w("run.edit")}</button>
        {settled ? <button type="button" className="ai-ghost ai-ghost-icon" aria-label={w("run.delete")} title={w("run.delete")} onClick={() => { if (window.confirm(w("run.deleteConfirm"))) void deleteRun(run.id).then(onBack).catch((caught: Error) => setNotice(caught.message)); }}><Trash /></button> : null}
      </header>

      <div className="wf-stats">
        <div className="wf-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <span style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
          {failed ? <span className="wf-progress-failed" style={{ width: `${(failed / total) * 100}%` }} /> : null}
        </div>
        <dl className="wf-stat-list">
          <div><dt>{w("run.tasks")}</dt><dd>{done}/{total}</dd></div>
          <div><dt>{w("run.records")}</dt><dd>{ready.length}/{run.items.length}</dd></div>
          <div><dt>{w("run.calls")}</dt><dd>{run.usage.calls}</dd></div>
          <div><dt>{w("run.tokens")}</dt><dd>{compact(run.usage.inputTokens)} → {compact(run.usage.outputTokens)}</dd></div>
          <div><dt>{w("run.images")}</dt><dd>{run.usage.images}</dd></div>
        </dl>
      </div>

      {notice && !reviewing ? <p className="wf-notice">{notice}</p> : null}
      {run.error ? <p className="wf-problem wf-problem-error">{run.error}</p> : null}

      <div className="wf-run-grid">
        <div className="wf-lanes">
          {planning ? (
            <div className={`wf-lane wf-lane-plan wf-lane-${planning.status}`}>
              <button type="button" className="wf-lane-head" onClick={() => setShowPlan((value) => !value)} disabled={!run.plan}>
                <Chevron open={showPlan} />
                <strong>{w("run.plan")}</strong>
                <span className="wf-muted">{t(`ext.ai.workflows.task.${planning.status}`)}</span>
              </button>
              {showPlan && run.plan ? (
                <div className="wf-plan">
                  {run.plan.guide ? <><h4>{w("run.guide")}</h4><Markdown text={run.plan.guide} /></> : null}
                  {run.workflow.steps.map((step) => {
                    const entry = run.plan!.steps[step.id];
                    if (!entry) return null;
                    return (
                      <div key={step.id} className="wf-plan-step">
                        <h4>{step.name}</h4>
                        {Object.entries(entry.prompts).map(([agentId, prompt]) => {
                          const agent = run.workflow.agents.find((item) => item.id === agentId);
                          return <div key={agentId} className="wf-plan-prompt"><span className="wf-plan-agent">{agent ? <ModelIcon model={agent.model} provider={agent.provider} size={14} /> : null}{agent?.name ?? agentId}</span><p>{prompt}</p></div>;
                        })}
                        {entry.rubric ? <div className="wf-plan-prompt"><span className="wf-plan-agent">⚖ {w("run.rubric")}</span><p>{entry.rubric}</p></div> : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
          {run.workflow.steps.map((step) => {
            const items = run.items.filter((item) => item.step === step.id);
            const busyOutline = outlining.some((task) => task.step === step.id);
            return (
              <div key={step.id} className="wf-lane">
                <div className="wf-lane-head">
                  <strong>{step.name}</strong>
                  <span className="wf-muted">{items.filter((item) => item.status === "ready").length}/{items.length}{busyOutline ? ` · ${w("run.outlining")}` : ""}</span>
                </div>
                <div className="wf-cards">
                  {items.length ? items.map((item) => <ItemCard key={item.id} run={run} item={item} task={tasksByItem.get(item.id)} />) : <p className="wf-muted wf-pad">{run.status === "running" ? w("run.waiting") : w("run.none")}</p>}
                </div>
              </div>
            );
          })}
        </div>

        <aside className="wf-log">
          <h3>{w("run.activity")}</h3>
          <ol ref={logRef}>
            {run.log.map((entry, index) => <li key={index} className={`wf-log-${entry.level}`}><time>{time(entry.at)}</time>{entry.message}</li>)}
          </ol>
        </aside>
      </div>

      {reviewing ? (
        <section className="wf-review">
          <header className="wf-section-head">
            <div><h2>{w("review.title")}</h2><p className="wf-muted">{w("review.hint")}</p></div>
          </header>
          <ul className="wf-tree">
            {tree.map((item) => {
              const step = run.workflow.steps.find((entry) => entry.id === item.step);
              const expanded = open.has(item.id);
              const fields = values?.[item.id] ?? {};
              const included = !excluded.has(item.id);
              return (
                <li key={item.id} className={`wf-tree-item wf-tree-${item.status}`} style={{ marginInlineStart: `${depthOf(item) * 1.5}rem` }}>
                  <div className="wf-tree-row">
                    <input type="checkbox" aria-label={w("review.include")} disabled={item.status !== "ready" || Boolean(item.recordId)} checked={item.status === "ready" && (included || Boolean(item.recordId))} onChange={() => setExcluded((value) => { const next = new Set(value); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })} />
                    <button type="button" className="wf-tree-toggle" onClick={() => setOpen((value) => { const next = new Set(value); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })}>
                      <Chevron open={expanded} />
                      <span className="wf-tree-step">{step?.name}</span>
                      <span className="wf-tree-title">{item.title}</span>
                    </button>
                    {item.score !== undefined ? <span className={`wf-score${step?.judge && item.score < step.judge.minScore ? " is-low" : ""}`}>{item.score}/10</span> : null}
                    {item.recordId ? <span className="wf-created">{w("review.createdAs", { id: item.recordId })}</span> : null}
                    {item.status === "failed" ? <span className="wf-card-state wf-card-state-failed">{w("item.failed")}</span> : null}
                    {!item.recordId ? <button type="button" className="ai-ghost" disabled={Boolean(busy)} onClick={() => void act("regenerate", () => regenerateItem(run.id, item.id))}><Retry />{w("review.regenerate")}</button> : null}
                  </div>
                  {expanded ? (
                    <div className="wf-tree-body">
                      {item.error ? <p className="wf-problem wf-problem-error">{item.error}</p> : null}
                      {item.feedback ? <div className="wf-feedback"><strong>⚖ {w("review.feedback")}</strong><p>{item.feedback}</p></div> : null}
                      {Object.keys(item.images).length ? (
                        <div className="wf-images">
                          {Object.entries(item.images).map(([field, image]) => (
                            <figure key={field}>
                              {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked API address for a picture not yet saved, which next/image can't fetch */}
                              <img src={imageUrl(run.id, image)} alt={`${item.title}: ${field}`} loading="lazy" />
                              <figcaption>{field}</figcaption>
                            </figure>
                          ))}
                        </div>
                      ) : null}
                      <dl className="wf-values">
                        {Object.entries(fields).map(([name, value]) => (
                          <div key={name}><dt>{run.collections[step?.collection ?? ""]?.fields.find((field) => field.name === name)?.label ?? name}</dt><dd>{value.includes("\n") || value.length > 160 ? <Markdown text={value} /> : value}</dd></div>
                        ))}
                      </dl>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <footer className="wf-review-bar">
            {notice && !busy ? <span className="wf-notice" role="status">{notice}</span> : null}
            <span className="wf-muted">{busy ?? w("review.summary", { count: toCreate.length, status: w(run.workflow.status === "published" ? "editor.published" : "editor.drafts") })}</span>
            <button type="button" className="wf-button" disabled={Boolean(busy) || !toCreate.length} onClick={() => void act("create", create).catch((caught) => setNotice(caught instanceof ApiError ? caught.message : String(caught)))}>{w("review.create", { count: toCreate.length })}</button>
          </footer>
        </section>
      ) : null}
    </div>
  );
}
