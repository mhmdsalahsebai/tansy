"use client";

import { useState } from "react";
import { useT } from "../../../components/i18n";
import { BoltIcon, PlusIcon } from "@heroicons/react/24/outline";
import { Alert, Badge, Button, DataTable, Field, Input, Modal, PageHeader, SearchInput, Skeleton, Toolbar } from "../../../components/ui/kit";
import { api, errorText, useApi } from "../../../lib/client/api";
import { apiPath } from "../../../lib/paths";

export interface WebhookRow { id: number; name: string; url: string; events: string[]; collections: string[]; enabled: boolean }
interface Delivery { id: string; event: string; status: string; attempts: number; responseStatus: number | null; error: string | null; createdAt: string }
interface Draft { id?: number; name: string; url: string; events: string[]; collections: string; enabled: boolean }

const EVENTS = ["create", "update", "delete"] as const;
const blank: Draft = { name: "", url: "", events: [...EVENTS], collections: "", enabled: true };

function Deliveries({ id }: { id: number }) {
  const { t, locale } = useT();
  const { data, error, loading } = useApi<Delivery[]>(apiPath(`/webhooks/${id}/deliveries`));
  if (loading) return <div className="cms-stack-2">{[0, 1, 2].map((row) => <Skeleton key={row} width={["70%", "55%", "62%"][row]} />)}</div>;
  if (error) return <Alert>{error}</Alert>;
  if (!data?.length) return <p className="cms-muted">{t("webhooks.noDeliveries")}</p>;
  return (
    <ul className="cms-divide cms-scroll-96 cms-text-sm">
      {data.map((d) => <li key={d.id} className="cms-py-2"><span className="cms-medium cms-strong">{d.event}</span> <span className="cms-faded">{d.status}{d.responseStatus ? ` (${d.responseStatus})` : ""}, {t("webhooks.attempts", { count: d.attempts })}, {new Date(d.createdAt).toLocaleString(locale)}</span>{d.error && <p className="cms-danger">{d.error}</p>}</li>)}
    </ul>
  );
}

export default function WebhooksPage({ initial, canManage }: { initial: WebhookRow[]; canManage: boolean }) {
  const { t } = useT();
  const eventName = (event: string) => ((EVENTS as readonly string[]).includes(event) ? t(`webhooks.eventNames.${event as (typeof EVENTS)[number]}`) : event);
  const [hooks, setHooks] = useState(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [viewing, setViewing] = useState<WebhookRow | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const body = { name: draft.name, url: draft.url, events: draft.events, enabled: draft.enabled, collections: draft.collections.split(",").map((s) => s.trim()).filter(Boolean) };
    try {
      if (draft.id) {
        const saved = await api<WebhookRow>(apiPath(`/webhooks/${draft.id}`), { method: "PATCH", body });
        setHooks(hooks.map((hook) => (hook.id === saved.id ? saved : hook)));
      } else {
        const saved = await api<WebhookRow & { secret: string }>(apiPath("/webhooks"), { method: "POST", body });
        setHooks([...hooks, saved]);
        setSecret(saved.secret);
      }
      setDraft(null);
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
  };

  const remove = async (hook: WebhookRow) => {
    try {
      await api(apiPath(`/webhooks/${hook.id}`), { method: "DELETE" });
      setHooks(hooks.filter((other) => other.id !== hook.id));
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="cms-gutter">
      <PageHeader title={t("webhooks.title")} description={t("webhooks.description")} actions={canManage ? <Button onClick={() => { setError(null); setDraft(blank); }}><PlusIcon className="cms-icon" aria-hidden="true" />{t("webhooks.newWebhook")}</Button> : undefined} />
      {error && !draft && <div className="cms-mb-4"><Alert>{error}</Alert></div>}
      {secret && <div className="cms-mb-4"><Alert kind="success">{t("webhooks.secret")} <code className="cms-break-all cms-mono">{secret}</code></Alert></div>}
      <DataTable
        label={t("webhooks.title")}
        columns={[{ id: "name", label: t("webhooks.name") }, { id: "url", label: t("webhooks.url") }, { id: "events", label: t("webhooks.events") }, { id: "collections", label: t("webhooks.collections") }, { id: "state", label: t("webhooks.state") }]}
        rows={hooks.filter((hook) => !query.trim() || `${hook.name} ${hook.url}`.toLowerCase().includes(query.trim().toLowerCase())).map((hook) => ({
          id: hook.id,
          cells: {
            name: hook.name,
            url: <span className="cms-mono">{hook.url}</span>,
            events: <span className="cms-tags">{hook.events.map((event) => <span key={event} className="cms-tag">{eventName(event)}</span>)}</span>,
            collections: hook.collections.join(", ") || t("webhooks.all"),
            state: hook.enabled ? <Badge tone="success">{t("webhooks.enabled")}</Badge> : <Badge>{t("webhooks.disabled")}</Badge>,
          },
          actions: (
            <>
              <button type="button" className="cms-row-action" onClick={() => setViewing(hook)}>{t("webhooks.deliveries")}</button>
              {canManage && <button type="button" className="cms-row-action" onClick={() => { setError(null); setDraft({ ...hook, collections: hook.collections.join(", ") }); }}>{t("webhooks.edit")}</button>}
              {canManage && <button type="button" className="cms-row-action cms-row-action-danger" onClick={() => void remove(hook)}>{t("webhooks.delete")}</button>}
            </>
          ),
        }))}
        toolbar={<Toolbar><SearchInput aria-label={t("webhooks.search")} placeholder={t("webhooks.search")} value={query} onChange={(e) => setQuery(e.target.value)} /></Toolbar>}
        empty={{ icon: <BoltIcon />, title: query.trim() ? t("grid.noMatches") : t("webhooks.empty") }}
      />
      <Modal open={draft !== null} onClose={() => setDraft(null)} title={t(draft?.id ? "webhooks.editWebhook" : "webhooks.newWebhook")}>
        {draft && (
          <div className="cms-stack-4">
            {error && <Alert>{error}</Alert>}
            <Field label={t("webhooks.name")}><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>
            <Field label={t("webhooks.url")} hint={t("webhooks.urlHint")}><Input type="url" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} /></Field>
            <Field label={t("webhooks.collections")} hint={t("webhooks.collectionsHint")}>
              <Input value={draft.collections} onChange={(e) => setDraft({ ...draft, collections: e.target.value })} />
            </Field>
            <fieldset><legend className="cms-label">{t("webhooks.events")}</legend>
              <div className="cms-mt-1 cms-flex cms-gap-4">{EVENTS.map((event) => <label key={event} className="cms-check-label"><input type="checkbox" className="cms-check" checked={draft.events.includes(event)} onChange={(e) => setDraft({ ...draft, events: e.target.checked ? [...draft.events, event] : draft.events.filter((other) => other !== event) })} />{eventName(event)}</label>)}</div>
            </fieldset>
            <label className="cms-check-label"><input type="checkbox" className="cms-check" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />{t("webhooks.enabled")}</label>
            <div className="cms-flex cms-end cms-gap-2"><Button variant="secondary" onClick={() => setDraft(null)}>{t("webhooks.cancel")}</Button><Button loading={busy} onClick={() => void save()}>{t("webhooks.save")}</Button></div>
          </div>
        )}
      </Modal>
      <Modal open={viewing !== null} onClose={() => setViewing(null)} title={t("webhooks.recentDeliveries")}>{viewing && <Deliveries id={viewing.id} />}</Modal>
    </div>
  );
}
