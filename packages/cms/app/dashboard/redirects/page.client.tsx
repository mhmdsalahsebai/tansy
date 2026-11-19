"use client";

import { useT } from "../../../components/i18n";
import { useState } from "react";
import { issuesOf, type IssueMap } from "../../../components/fields/types";
import { ArrowsRightLeftIcon, PlusIcon } from "@heroicons/react/24/outline";
import { Alert, Badge, Button, DataTable, Field, Input, Modal, PageHeader, SearchInput, Toolbar } from "../../../components/ui/kit";
import { api, errorText, useApi } from "../../../lib/client/api";
import { apiPath } from "../../../lib/paths";

interface Redirect { id: number; from: string; to: string; status: number }

const STATUSES = [[301, "permanent301"], [302, "temporary302"], [307, "temporary307"], [308, "permanent308"]] as const;
const blank = { from: "", to: "", status: 301 };

export default function RedirectsPage({ canManage }: { canManage: boolean }) {
  const { t } = useT();
  const [version, setVersion] = useState(0);
  const { data, error: loadError } = useApi<{ items: Redirect[] }>(`${apiPath("/redirects")}?perPage=200&v=${version}`);
  const [draft, setDraft] = useState(blank);
  const [issues, setIssues] = useState<IssueMap>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setIssues({});
    try {
      await work();
      setVersion((current) => current + 1);
      return true;
    } catch (err) {
      setIssues(issuesOf(err));
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await run(() => api(apiPath("/redirects"), { method: "POST", body: draft }))) { setDraft(blank); setCreating(false); }
  };
  const term = query.trim().toLowerCase();
  const shown = data?.items.filter((redirect) => !term || redirect.from.toLowerCase().includes(term) || redirect.to.toLowerCase().includes(term)) ?? null;
  const statusLabel = (status: number) => STATUSES.find(([value]) => value === status)?.[1];

  return (
    <div className="cms-gutter">
      <PageHeader title={t("redirects.title")} description={t("redirects.description")}
        actions={canManage && <Button onClick={() => { setCreating(true); setError(null); setIssues({}); }}><PlusIcon className="cms-icon" aria-hidden="true" />{t("redirects.add")}</Button>} />
      {(error ?? loadError) && !creating && <div className="cms-mb-4"><Alert>{error ?? loadError}</Alert></div>}
      <DataTable
        label={t("redirects.title")}
        columns={[{ id: "from", label: t("redirects.from") }, { id: "to", label: t("redirects.to") }, { id: "status", label: t("redirects.status") }]}
        rows={shown && shown.map((redirect) => {
          const label = statusLabel(redirect.status);
          return {
            id: redirect.id,
            cells: {
              from: <span className="cms-mono">{redirect.from}</span>,
              to: <span className="cms-mono">{redirect.to}</span>,
              status: <Badge tone={redirect.status === 301 || redirect.status === 308 ? "info" : "neutral"}>{label ? t(`redirects.${label}`) : redirect.status}</Badge>,
            },
            actions: canManage ? <button type="button" className="cms-row-action cms-row-action-danger" disabled={busy} onClick={() => void run(() => api(apiPath(`/redirects/${redirect.id}`), { method: "DELETE" }))}>{t("redirects.delete")}</button> : undefined,
          };
        })}
        toolbar={<Toolbar><SearchInput aria-label={t("redirects.search")} placeholder={t("redirects.search")} value={query} onChange={(e) => setQuery(e.target.value)} /></Toolbar>}
        empty={{ icon: <ArrowsRightLeftIcon />, title: term ? t("grid.noMatches") : t("redirects.empty") }}
      />
      <Modal open={creating} onClose={() => setCreating(false)} title={t("redirects.add")}>
        <form onSubmit={add} className="cms-stack-4">
          {error && <Alert>{error}</Alert>}
          <Field label={t("redirects.from")}><Input required value={draft.from} placeholder="/old-page" onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></Field>
          {issues.from && <p className="cms-error">{issues.from}</p>}
          <Field label={t("redirects.to")}><Input required value={draft.to} placeholder="/new-page" onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></Field>
          {issues.to && <p className="cms-error">{issues.to}</p>}
          <Field label={t("redirects.type")}>
            <select aria-label={t("redirects.type")} className="cms-input" value={draft.status} onChange={(e) => setDraft({ ...draft, status: Number(e.target.value) })}>
              {STATUSES.map(([value, label]) => <option key={value} value={value}>{t(`redirects.${label}`)}</option>)}
            </select>
          </Field>
          <div className="cms-flex cms-end cms-gap-2">
            <Button variant="secondary" onClick={() => setCreating(false)}>{t("grid.cancel")}</Button>
            <Button type="submit" loading={busy}>{t("redirects.add")}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
