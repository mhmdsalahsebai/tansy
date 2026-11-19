"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Alert, apiPath, Badge, Button, DataTable, Field, Input, SearchInput, Toolbar, translate, useT } from "tansy/admin";
import { ACCESS, gated, gateOf, INCLUDED, PLANS, ungated, type GateMode } from "./logic";

type Values = Record<string, string | number>;

/** This plugin's words, in a component. */
function useWords() {
  const { t, formatDate } = useT();
  return { t: (key: string, values?: Values) => t(`ext.subscriptions.${key}`, values), formatDate };
}

/** This plugin's words outside a component, such as an error from a click. */
const word = (key: string, values?: Values) => translate(`ext.subscriptions.${key}`, values);

type Row = Record<string, unknown> & { id: number };
interface Plan extends Row { name: string; title?: string | null; description?: string | null; amount?: number | null; annualAmount?: number | null; featured?: boolean | null; priceId?: string; annualPriceId?: string | null; trialDays?: number | null; includes?: number[] | null; status?: string }
interface Access extends Row { name: string; description?: string | null; collections?: string[] | null; status?: string }
interface FieldDef { id?: number; name: string; type: string; config?: Record<string, unknown> | null }
interface Collection { id: number; slug: string; name: string; type?: string; fields: FieldDef[]; listRule: string | null; viewRule: string | null; createRule: string | null; updateRule: string | null; deleteRule: string | null }

/** Through core's API as the signed-in person, so every change passes the same permissions, rules and audit as anywhere else. */
async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(apiPath(path), { method: init?.method ?? "GET", headers: init?.body === undefined ? undefined : { "content-type": "application/json" }, body: init?.body === undefined ? undefined : JSON.stringify(init.body) });
  const json = await response.json().catch(() => null) as { error?: { code?: string; message?: string; details?: Array<{ path?: string; message?: string }> } } | null;
  if (!response.ok) {
    if (json?.error?.code === "REAUTH_REQUIRED") throw new Error(word("common.reauth"));
    const detail = json?.error?.details?.[0];
    throw new Error(detail?.message ? `${detail.path ? `${detail.path}: ` : ""}${detail.message}` : (json?.error?.message ?? word("common.failed", { status: response.status })));
  }
  return json as T;
}

const records = (slug: string) => `/collections/${slug}/records`;
const listRecords = async <T,>(slug: string, fields: string) => (await call<{ items: T[] }>(`${records(slug)}?perPage=200&sort=createdAt&fields=${fields}`)).items;
const PLAN_FIELDS = "id,name,title,description,amount,annualAmount,featured,priceId,annualPriceId,trialDays,includes,status";
const ACCESS_FIELDS = "id,name,description,collections,status";

function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => { load().then(setData, (problem: Error) => setError(problem.message)); }, [load]);
  useEffect(reload, [reload]);
  return { data, error, reload, setError };
}

/** Runs a change, shows what went wrong, and reloads after. */
function useAction(reload: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      reload();
      return true;
    } catch (problem) {
      setError((problem as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is number => typeof id === "number") : []);

function Checks({ options, chosen, onChange, empty }: { options: Array<{ id: number; label: string; hint?: string }>; chosen: number[]; onChange(next: number[]): void; empty: ReactNode }) {
  if (!options.length) return <p className="cms-muted cms-text-sm">{empty}</p>;
  return (
    <div className="cms-stack-2">
      {options.map((option) => (
        <label key={option.id} className="cms-text-sm" style={{ display: "flex", gap: "0.5rem", alignItems: "baseline" }}>
          <input type="checkbox" checked={chosen.includes(option.id)} onChange={(event) => onChange(event.target.checked ? [...chosen, option.id] : chosen.filter((id) => id !== option.id))} />
          <span>{option.label}{option.hint ? <span className="cms-muted"> · {option.hint}</span> : null}</span>
        </label>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Plans

const EMPTY_PLAN = { name: "", title: "", description: "", amount: "", annualAmount: "", featured: false, priceId: "", annualPriceId: "", trialDays: "", includes: [] as number[], published: true };
const numberText = (value: number | null | undefined) => (value == null ? "" : String(value));
const numberOrNull = (value: string) => (value.trim() ? Number(value) : null);

function PlanForm({ plan, access, busy, onSave, onCancel }: { plan?: Plan; access: Access[]; busy: boolean; onSave(values: Record<string, unknown>): Promise<boolean>; onCancel?(): void }) {
  const { t } = useWords();
  const [values, setValues] = useState(() => plan
    ? {
      name: plan.name, title: plan.title ?? "", description: plan.description ?? "", amount: numberText(plan.amount), annualAmount: numberText(plan.annualAmount), featured: plan.featured === true,
      priceId: plan.priceId ?? "", annualPriceId: plan.annualPriceId ?? "", trialDays: numberText(plan.trialDays), includes: ids(plan.includes), published: plan.status === "published",
    }
    : EMPTY_PLAN);
  const set = (change: Partial<typeof values>) => setValues((current) => ({ ...current, ...change }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const saved = await onSave({
      name: values.name.trim(),
      title: values.title.trim() || null,
      description: values.description.trim() || null,
      amount: numberOrNull(values.amount),
      annualAmount: numberOrNull(values.annualAmount),
      featured: values.featured,
      priceId: values.priceId.trim(),
      annualPriceId: values.annualPriceId.trim() || null,
      trialDays: numberOrNull(values.trialDays),
      includes: values.includes,
      status: values.published ? "published" : "draft",
    });
    if (saved && !plan) setValues(EMPTY_PLAN);
  };
  return (
    <form onSubmit={submit} className="cms-stack-4">
      <div className="cms-grid cms-gap-4 cms-sm-2">
        <Field label={t("plans.name")} hint={t("plans.nameHint")}><Input required value={values.name} onChange={(event) => set({ name: event.target.value })} /></Field>
        <Field label={t("plans.priceId")} hint={t("plans.priceIdHint")}><Input required value={values.priceId} onChange={(event) => set({ priceId: event.target.value })} /></Field>
        <Field label={t("plans.annual")} hint={t("plans.optional")}><Input value={values.annualPriceId} onChange={(event) => set({ annualPriceId: event.target.value })} /></Field>
        <Field label={t("plans.trial")} hint={t("plans.trialHint")}><Input type="number" min={0} value={values.trialDays} onChange={(event) => set({ trialDays: event.target.value })} /></Field>
      </div>
      <div className="cms-grid cms-gap-4 cms-sm-2">
        <Field label={t("plans.title")} hint={t("plans.titleHint")}><Input value={values.title} maxLength={80} onChange={(event) => set({ title: event.target.value })} /></Field>
        <Field label={t("plans.blurb")} hint={t("plans.optional")}><Input value={values.description} maxLength={500} onChange={(event) => set({ description: event.target.value })} /></Field>
        <Field label={t("plans.amount")} hint={t("plans.amountHint")}><Input type="number" min={0} step="0.01" value={values.amount} onChange={(event) => set({ amount: event.target.value })} /></Field>
        <Field label={t("plans.annualAmount")} hint={t("plans.optional")}><Input type="number" min={0} step="0.01" value={values.annualAmount} onChange={(event) => set({ annualAmount: event.target.value })} /></Field>
      </div>
      <Field label={t("plans.opens")} hint={t("plans.opensHint")}>
        <Checks
          options={access.map((item) => ({ id: item.id, label: item.name, hint: item.collections?.length ? t("plans.opensCollections", { collections: item.collections.join(", ") }) : undefined }))}
          chosen={values.includes}
          onChange={(includes) => set({ includes })}
          empty={t("plans.noAccess")}
        />
      </Field>
      <label className="cms-check-label">
        <input type="checkbox" className="cms-check" checked={values.published} onChange={(event) => set({ published: event.target.checked })} />
        {t("plans.onSale")}
      </label>
      <label className="cms-check-label">
        <input type="checkbox" className="cms-check" checked={values.featured} onChange={(event) => set({ featured: event.target.checked })} />
        {t("plans.featured")}
      </label>
      <div className="cms-row cms-gap-2">
        <Button type="submit" loading={busy}>{plan ? t("plans.savePlan") : t("plans.addPlan")}</Button>
        {onCancel && <Button type="button" variant="secondary" onClick={onCancel}>{t("common.cancel")}</Button>}
      </div>
    </form>
  );
}

export function PlansManager() {
  const { t } = useWords();
  const load = useCallback(async () => {
    const [plans, access] = await Promise.all([listRecords<Plan>(PLANS, PLAN_FIELDS), listRecords<Access>(ACCESS, ACCESS_FIELDS)]);
    return { plans, access };
  }, []);
  const { data, error, reload } = useLoad(load);
  const action = useAction(reload);
  const [editing, setEditing] = useState<number | null>(null);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <DataTable label={t("columns.plan")} rows={null} empty={{ title: "" }} columns={[{ id: "plan", label: t("columns.plan") }, { id: "opens", label: t("columns.opens") }, { id: "priceId", label: t("columns.priceId") }, { id: "onSale", label: t("columns.onSale") }]} />;
  const accessName = new Map(data.access.map((item) => [item.id, item.name]));
  return (
    <div className="cms-stack-6">
      {action.error && <Alert>{action.error}</Alert>}
      <div className="cms-panel cms-table-wrap">
        <table className="cms-table">
          <thead><tr><th>{t("columns.plan")}</th><th>{t("columns.opens")}</th><th>{t("columns.priceId")}</th><th>{t("columns.onSale")}</th><th /></tr></thead>
          <tbody>
            {data.plans.length === 0 && <tr><td colSpan={5} className="cms-muted">{t("plans.empty")}</td></tr>}
            {data.plans.map((plan) => editing === plan.id ? (
              <tr key={plan.id}><td colSpan={5}>
                <PlanForm plan={plan} access={data.access} busy={action.busy} onCancel={() => setEditing(null)}
                  onSave={(values) => action.run(async () => { await call(`${records(PLANS)}/${plan.id}`, { method: "PATCH", body: values }); setEditing(null); })} />
              </td></tr>
            ) : (
              <tr key={plan.id}>
                <td><strong>{plan.title || plan.name}</strong>{plan.title ? <span className="cms-muted cms-text-sm"> · {plan.name}</span> : null}{plan.featured ? <>{" "}<Badge>{t("plans.featuredBadge")}</Badge></> : null}</td>
                <td>{ids(plan.includes).map((id) => accessName.get(id) ?? `#${id}`).join(", ") || <span className="cms-muted">{t("common.nothingYet")}</span>}</td>
                <td><code className="cms-text-sm">{plan.priceId}</code></td>
                <td>{plan.status === "published" ? t("common.yes") : <span className="cms-muted">{t("common.hidden")}</span>}</td>
                <td className="cms-right cms-nowrap">
                  <Button type="button" variant="secondary" onClick={() => setEditing(plan.id)}>{t("common.edit")}</Button>{" "}
                  <Button type="button" variant="secondary" disabled={action.busy} onClick={() => {
                    if (window.confirm(t("plans.confirmDelete", { plan: plan.name }))) void action.run(() => call(`${records(PLANS)}/${plan.id}`, { method: "DELETE" }));
                  }}>{t("common.delete")}</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="cms-panel cms-cell">
        <h2 className="cms-section-title cms-mb-4">{t("plans.newPlan")}</h2>
        <PlanForm access={data.access} busy={action.busy} onSave={(values) => action.run(() => call(records(PLANS), { method: "POST", body: values }))} />
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Access and gating

const accessIdOf = (collections: Collection[]) => collections.find((collection) => collection.slug === ACCESS)?.id ?? null;
const includedField = (collection: Collection, accessId: number | null) =>
  collection.fields.find((field) => field.name === INCLUDED && field.type === "reference" && Number(field.config?.collection) === accessId) ?? null;

/** Collections a site gates: its own, not Payments' or other plugin machinery that rules already lock. */
const gateable = (collection: Collection) => collection.type !== "view" && !collection.slug.startsWith("payments-") && !(collection.listRule === null && collection.viewRule === null);

function modeOf(collection: Collection): GateMode | null {
  return gateOf(collection.viewRule, collection.slug) ?? gateOf(collection.listRule, collection.slug);
}

async function putRules(collection: Collection, change: (rule: string | null) => string | null) {
  await call(`/collections/${collection.id}/rules`, {
    method: "PUT",
    body: { listRule: change(collection.listRule), viewRule: change(collection.viewRule), createRule: collection.createRule, updateRule: collection.updateRule, deleteRule: collection.deleteRule },
  });
}

/** Adds an "Included in" field, a reference to Access that allows several, keeping every field as it is. */
async function addIncluded(collection: Collection, accessId: number) {
  if (collection.fields.some((field) => field.name === INCLUDED)) throw new Error(word("gate.fieldTaken", { collection: collection.name, field: INCLUDED }));
  const fields = collection.fields.map((field) => ({ id: field.id, name: field.name, type: field.type, config: field.config ?? {} }));
  await call(`/collections/${collection.id}/fields`, {
    method: "PUT",
    body: { fields: [...fields, { name: INCLUDED, type: "reference", config: { collection: accessId, displayField: "name", allowMultiple: true, label: word("gate.includedIn"), description: word("gate.includedInHint") } }] },
  });
}

function GatePanel({ collections, access, reload }: { collections: Collection[]; access: Access[]; reload(): void }) {
  const { t } = useWords();
  const action = useAction(reload);
  const accessId = accessIdOf(collections);
  const [choice, setChoice] = useState<{ slug: string; mode: GateMode; access: number | null }>({ slug: "", mode: "records", access: null });
  const candidates = collections.filter(gateable);
  const gatedOnes = candidates.filter((collection) => modeOf(collection));
  const open = candidates.filter((collection) => !modeOf(collection));

  const gate = () => action.run(async () => {
    const collection = collections.find((candidate) => candidate.slug === choice.slug);
    if (!collection || accessId === null) throw new Error(word("gate.chooseCollection"));
    if (choice.mode === "records" && !includedField(collection, accessId)) await addIncluded(collection, accessId);
    if (choice.mode === "collection") {
      const chosen = access.find((item) => item.id === choice.access);
      if (!chosen) throw new Error(word("gate.chooseOpener"));
      const list = chosen.collections ?? [];
      if (!list.includes(collection.slug)) await call(`${records(ACCESS)}/${chosen.id}`, { method: "PATCH", body: { collections: [...list, collection.slug] } });
    }
    await putRules(collection, (rule) => gated(rule, choice.mode, collection.slug));
    setChoice({ slug: "", mode: "records", access: null });
  });

  const ungate = (collection: Collection) => action.run(async () => {
    await putRules(collection, (rule) => ungated(rule, collection.slug));
    for (const item of access.filter((candidate) => candidate.collections?.includes(collection.slug))) {
      await call(`${records(ACCESS)}/${item.id}`, { method: "PATCH", body: { collections: (item.collections ?? []).filter((slug) => slug !== collection.slug) } });
    }
  });

  return (
    <section className="cms-panel cms-cell cms-stack-4">
      <div>
        <h2 className="cms-section-title">{t("gate.title")}</h2>
        <p className="cms-muted cms-text-sm">{t("gate.intro")}</p>
      </div>
      {action.error && <Alert>{action.error}</Alert>}
      {gatedOnes.length > 0 && (
        <div className="cms-table-wrap">
          <table className="cms-table">
            <thead><tr><th>{t("columns.collection")}</th><th>{t("columns.how")}</th><th /></tr></thead>
            <tbody>
              {gatedOnes.map((collection) => (
                <tr key={collection.id}>
                  <td>{collection.name} <span className="cms-muted cms-text-sm">{collection.slug}</span></td>
                  <td className="cms-text-sm">{modeOf(collection) === "records"
                    ? t("gate.byRecords")
                    : t("gate.whole", { access: access.filter((item) => item.collections?.includes(collection.slug)).map((item) => item.name).join(t("gate.or")) || t("gate.anAccess") })}</td>
                  <td className="cms-right"><Button type="button" variant="secondary" disabled={action.busy} onClick={() => {
                    if (window.confirm(t("gate.confirmRemove", { collection: collection.name }))) void ungate(collection);
                  }}>{t("gate.remove")}</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="cms-stack-4">
        <Field label={t("gate.label")}>
          <select className="cms-input" value={choice.slug} onChange={(event) => setChoice({ ...choice, slug: event.target.value })}>
            <option value="">{t("gate.choose")}</option>
            {open.map((collection) => <option key={collection.id} value={collection.slug}>{collection.name}</option>)}
          </select>
        </Field>
        {choice.slug && (
          <>
            <fieldset className="cms-stack-2" style={{ border: 0, padding: 0 }}>
              <label className="cms-check-label">
                <input type="radio" checked={choice.mode === "records"} onChange={() => setChoice({ ...choice, mode: "records" })} />
                <span>{t("gate.someRecords")}</span>
              </label>
              <label className="cms-check-label">
                <input type="radio" checked={choice.mode === "collection"} onChange={() => setChoice({ ...choice, mode: "collection" })} />
                <span>{t("gate.wholeOption")}</span>
              </label>
            </fieldset>
            {choice.mode === "collection" && (
              <Field label={t("gate.openedBy")}>
                <select className="cms-input" value={choice.access ?? ""} onChange={(event) => setChoice({ ...choice, access: event.target.value ? Number(event.target.value) : null })}>
                  <option value="">{t("gate.chooseAccess")}</option>
                  {access.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </Field>
            )}
            <div><Button type="button" loading={action.busy} onClick={() => void gate()}>{t("gate.gateIt")}</Button></div>
          </>
        )}
      </div>
    </section>
  );
}

function AccessForm({ item, busy, onSave, onCancel }: { item?: Access; busy: boolean; onSave(values: Record<string, unknown>): Promise<boolean>; onCancel?(): void }) {
  const { t } = useWords();
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await onSave({ name: name.trim(), description: description.trim() || null, ...(item ? {} : { collections: [], status: "published" }) }) && !item) { setName(""); setDescription(""); }
  };
  return (
    <form onSubmit={submit} className="cms-stack-4">
      <Field label={t("access.name")} hint={t("access.nameHint")}><Input required value={name} onChange={(event) => setName(event.target.value)} /></Field>
      <Field label={t("access.descriptionLabel")} hint={t("access.descriptionHint")}><Input value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
      <div className="cms-row cms-gap-2">
        <Button type="submit" loading={busy}>{item ? t("common.save") : t("access.add")}</Button>
        {onCancel && <Button type="button" variant="secondary" onClick={onCancel}>{t("common.cancel")}</Button>}
      </div>
    </form>
  );
}

export function AccessManager() {
  const { t } = useWords();
  const load = useCallback(async () => {
    const [access, plans, collections] = await Promise.all([
      listRecords<Access>(ACCESS, ACCESS_FIELDS),
      listRecords<Plan>(PLANS, "id,name,includes"),
      call<Collection[]>("/collections"),
    ]);
    return { access, plans, collections };
  }, []);
  const { data, error, reload } = useLoad(load);
  const action = useAction(reload);
  const [editing, setEditing] = useState<number | null>(null);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <DataTable label={t("columns.access")} rows={null} empty={{ title: "" }} columns={[{ id: "access", label: t("columns.access") }, { id: "whole", label: t("columns.opensWhole") }, { id: "plans", label: t("columns.inPlans") }]} />;
  return (
    <div className="cms-stack-6">
      {action.error && <Alert>{action.error}</Alert>}
      <div className="cms-panel cms-table-wrap">
        <table className="cms-table">
          <thead><tr><th>{t("columns.access")}</th><th>{t("columns.opensWhole")}</th><th>{t("columns.inPlans")}</th><th /></tr></thead>
          <tbody>
            {data.access.length === 0 && <tr><td colSpan={4} className="cms-muted">{t("access.empty")}</td></tr>}
            {data.access.map((item) => editing === item.id ? (
              <tr key={item.id}><td colSpan={4}>
                <AccessForm item={item} busy={action.busy} onCancel={() => setEditing(null)}
                  onSave={(values) => action.run(async () => { await call(`${records(ACCESS)}/${item.id}`, { method: "PATCH", body: values }); setEditing(null); })} />
              </td></tr>
            ) : (
              <tr key={item.id}>
                <td><strong>{item.name}</strong>{item.description ? <div className="cms-muted cms-text-sm">{item.description}</div> : null}</td>
                <td className="cms-text-sm">{item.collections?.length ? item.collections.join(", ") : <span className="cms-muted">{t("access.onlyRecords")}</span>}</td>
                <td className="cms-text-sm">{data.plans.filter((plan) => ids(plan.includes).includes(item.id)).map((plan) => plan.name).join(", ") || <span className="cms-muted">{t("common.noneYet")}</span>}</td>
                <td className="cms-right cms-nowrap">
                  <Button type="button" variant="secondary" onClick={() => setEditing(item.id)}>{t("common.edit")}</Button>{" "}
                  <Button type="button" variant="secondary" disabled={action.busy} onClick={() => {
                    if (window.confirm(t("access.confirmDelete", { name: item.name }))) void action.run(() => call(`${records(ACCESS)}/${item.id}`, { method: "DELETE" }));
                  }}>{t("common.delete")}</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="cms-panel cms-cell">
        <h2 className="cms-section-title cms-mb-4">{t("access.newAccess")}</h2>
        <AccessForm busy={action.busy} onSave={(values) => action.run(() => call(records(ACCESS), { method: "POST", body: values }))} />
      </section>
      <GatePanel collections={data.collections} access={data.access} reload={reload} />
    </div>
  );
}

// ---------------------------------------------------------------- Members

interface Member { user: string; name: string; email: string; plans: string[]; updatedAt: string | null; grants: Array<{ id: number; plan: string; state: string; periodEnd: string | null }> }

export function MembersManager() {
  const { t, formatDate } = useWords();
  const load = useCallback(async () => {
    const [{ members }, plans] = await Promise.all([call<{ members: Member[] }>("/ext/subscriptions/members"), listRecords<Plan>(PLANS, "id,name")]);
    return { members, plans };
  }, []);
  const { data, error, reload } = useLoad(load);
  const action = useAction(reload);
  const [grant, setGrant] = useState({ email: "", plan: "", until: "" });
  const [query, setQuery] = useState("");
  if (error) return <Alert>{error}</Alert>;
  const columns = [{ id: "person", label: t("columns.person") }, { id: "plans", label: t("columns.plansNow") }, { id: "free", label: t("columns.givenFree") }, { id: "changed", label: t("columns.changed") }];
  if (!data) return <DataTable label={t("columns.person")} rows={null} empty={{ title: "" }} columns={columns} />;
  const shown = data.members.filter((member) => !query || `${member.email} ${member.name} ${member.plans.join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void action.run(async () => {
      await call("/ext/subscriptions/grant", { method: "POST", body: { email: grant.email, plan: grant.plan, until: grant.until ? new Date(`${grant.until}T23:59:59`).toISOString() : null } });
      setGrant({ email: "", plan: "", until: "" });
    });
  };
  return (
    <div className="cms-stack-6">
      {action.error && <Alert>{action.error}</Alert>}
      <section className="cms-panel cms-cell">
        <h2 className="cms-section-title cms-mb-2">{t("members.give")}</h2>
        <p className="cms-muted cms-text-sm cms-mb-4">{t("members.giveIntro")}</p>
        <form onSubmit={submit} style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))", alignItems: "end" }}>
          <Field label={t("members.email")}><Input required type="email" value={grant.email} onChange={(event) => setGrant({ ...grant, email: event.target.value })} /></Field>
          <Field label={t("members.plan")}>
            <select className="cms-input" required value={grant.plan} onChange={(event) => setGrant({ ...grant, plan: event.target.value })}>
              <option value="">{t("members.choose")}</option>
              {data.plans.map((plan) => <option key={plan.id} value={plan.name}>{plan.name}</option>)}
            </select>
          </Field>
          <Field label={t("members.until")} hint={t("members.untilHint")}><Input type="date" value={grant.until} onChange={(event) => setGrant({ ...grant, until: event.target.value })} /></Field>
          <div><Button type="submit" loading={action.busy}>{t("members.givePlan")}</Button></div>
        </form>
      </section>
      <DataTable
        label={t("columns.person")}
        columns={columns}
        rows={shown.map((member) => ({
          id: member.user,
          cells: {
            person: <span className="cms-stack-1"><span className="cms-truncate">{member.email || member.user}</span>{member.name && <span className="cms-hint">{member.name}</span>}</span>,
            plans: member.plans.length ? <span className="cms-tags">{member.plans.map((plan) => <Badge key={plan} tone="info">{plan}</Badge>)}</span> : null,
            free: member.grants.some((item) => item.state === "active") ? (
              <span className="cms-stack-1">
                {member.grants.filter((item) => item.state === "active").map((item) => (
                  <span key={item.id} className="cms-inline-row cms-gap-2">
                    <span>{item.periodEnd ? t("members.untilDate", { plan: item.plan, date: formatDate(item.periodEnd) }) : item.plan}</span>
                    <button type="button" className="cms-row-action cms-row-action-danger" disabled={action.busy} onClick={() => {
                      if (window.confirm(t("members.confirmEnd", { who: member.email || t("members.their"), plan: item.plan }))) void action.run(() => call(`/ext/subscriptions/grants/${item.id}/end`, { method: "POST" }));
                    }}>{t("members.end")}</button>
                  </span>
                ))}
              </span>
            ) : null,
            changed: member.updatedAt ? formatDate(member.updatedAt) : null,
          },
        }))}
        toolbar={<Toolbar><SearchInput placeholder={t("members.search")} value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t("members.searchLabel")} /></Toolbar>}
        empty={{ title: data.members.length ? t("members.noMatch") : t("members.empty") }}
      />
    </div>
  );
}
