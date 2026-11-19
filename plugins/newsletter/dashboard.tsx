"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { adminPath, Alert, apiPath, Badge, Button, ButtonLink, DataTable, Pagination, SearchInput, Toolbar, useT, type BadgeTone } from "tansy/admin";

/** This plugin's dashboard words. */
function useWords() {
  const { t, locale } = useT();
  const words = (key: string, values?: Record<string, string | number>) => t(`ext.newsletter.${key}`, values);
  const date = (value: unknown) => (typeof value === "string" && value ? new Date(value).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : "");
  return { t: words, date, locale };
}

/** Calls one of the plugin's routes, and throws the route's own message when it refuses. */
async function call<T = Record<string, unknown>>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const response = await fetch(apiPath(`/ext/newsletter${path}`), {
    ...rest,
    ...(json !== undefined ? { method: rest.method ?? "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) } : {}),
  });
  const body = await response.json().catch(() => null) as (T & { error?: { message?: string; details?: Array<{ message?: string }> } }) | null;
  if (!response.ok) throw new Error(body?.error?.details?.[0]?.message ?? body?.error?.message ?? `HTTP ${response.status}`);
  return body as T;
}

/** The dashboard ids of the newsletter's collections, for links into the record editor. Null for someone who can't read collections. */
function useCollectionIds() {
  const [ids, setIds] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    let live = true;
    fetch(apiPath("/collections")).then((response) => (response.ok ? response.json() : [])).then((list: Array<{ id: number; slug: string }>) => {
      if (live) setIds(Object.fromEntries(list.filter((item) => item.slug.startsWith("newsletter-")).map((item) => [item.slug, item.id])));
    }).catch(() => { if (live) setIds({}); });
    return () => { live = false; };
  }, []);
  return ids;
}

const editor = (collection: number | undefined, record: number | "new") => (collection ? adminPath(`/collections/${collection}/content/${record}`) : null);

interface Status { mail: boolean; captcha: boolean; page: string | null; counts: { pending: number; confirmed: number; unsubscribed: number } | null }

/** What's missing for the newsletter to reach anyone, and how many people it reaches. */
export function NewsletterStatus() {
  const { t } = useWords();
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => { call<Status>("/status").then(setStatus).catch(() => {}); }, []);
  if (!status) return null;
  return (
    <div className="cms-stack-4 cms-mb-6">
      {(!status.mail || !status.page || !status.captcha) && (
        <div className="cms-stack-2">
          {!status.mail && <Alert kind="warning">{t("status.noMail")}</Alert>}
          {!status.page && <Alert kind="warning">{t("status.noPage")}</Alert>}
          {!status.captcha && <Alert kind="info">{t("status.noCaptcha")}</Alert>}
        </div>
      )}
      {status.counts && (
        <div className="cms-grid cms-gap-3 cms-sm-3">
          {(["confirmed", "pending", "unsubscribed"] as const).map((state) => (
            <div key={state} className="cms-stat">
              <div className="cms-stat-label">{t(`counts.${state}`)}</div>
              <div className="cms-stat-value">{status.counts![state]}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface CampaignRow { id: number; state: string; subject: string; scheduledAt: string | null; startedAt: string | null; finishedAt: string | null; recipients: number; sent: number; failed: number }

const TONES: Record<string, BadgeTone> = { draft: "neutral", scheduled: "info", sending: "warning", sent: "success", cancelled: "danger" };

/** Test, send, schedule, cancel and copy one campaign. `onChange` reloads whatever shows it. */
export function CampaignActions({ campaign, onChange, onCopied }: { campaign: Pick<CampaignRow, "id" | "state" | "subject">; onChange(): void; onCopied?(id: number): void }) {
  const { t } = useWords();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [when, setWhen] = useState("");

  async function run(action: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setNote(null);
    try {
      await action();
      if (done) setNote({ kind: "success", text: done });
      onChange();
    } catch (error) {
      setNote({ kind: "error", text: (error as Error).message || t("errors.failed") });
    } finally {
      setBusy(false);
    }
  }

  const test = () => run(async () => {
    const result = await call<{ ok: boolean; to: string }>(`/campaigns/${campaign.id}/test`, { method: "POST" });
    if (!result.ok) throw new Error(t("campaigns.testFailed"));
    setNote({ kind: "success", text: t("campaigns.tested", { email: result.to }) });
  });
  const send = () => {
    if (window.confirm(t("campaigns.confirmSend", { subject: campaign.subject }))) void run(() => call(`/campaigns/${campaign.id}/send`, { json: {} }));
  };
  const schedule = (event: FormEvent) => {
    event.preventDefault();
    const at = new Date(when);
    if (!when || Number.isNaN(at.getTime())) return;
    void run(() => call(`/campaigns/${campaign.id}/send`, { json: { at: at.toISOString() } }));
  };
  const cancel = () => {
    if (window.confirm(t("campaigns.confirmCancel"))) void run(() => call(`/campaigns/${campaign.id}/cancel`, { method: "POST" }));
  };
  const copy = () => run(async () => {
    const { id } = await call<{ id: number }>(`/campaigns/${campaign.id}/copy`, { method: "POST" });
    onCopied?.(id);
  });

  const draft = campaign.state === "draft" || campaign.state === "scheduled";
  return (
    <div className="cms-stack-2">
      <div className="cms-row cms-wrap cms-gap-2">
        {draft && <Button variant="secondary" disabled={busy} onClick={test}>{t("campaigns.test")}</Button>}
        {draft && <Button disabled={busy} onClick={send}>{t("campaigns.sendNow")}</Button>}
        {(campaign.state === "sending" || campaign.state === "scheduled") && <Button variant="danger" disabled={busy} onClick={cancel}>{t("campaigns.cancel")}</Button>}
        {!draft && campaign.state !== "sending" && <Button variant="secondary" disabled={busy} onClick={copy}>{t("campaigns.copy")}</Button>}
      </div>
      {draft && (
        <form className="cms-row cms-wrap cms-gap-2" onSubmit={schedule}>
          <label className="cms-text-xs cms-muted" htmlFor={`nl-when-${campaign.id}`}>{t("campaigns.scheduleAt")}</label>
          <input id={`nl-when-${campaign.id}`} className="cms-input cms-w-auto" type="datetime-local" value={when} onChange={(event) => setWhen(event.target.value)} />
          <Button variant="secondary" type="submit" disabled={busy || !when}>{t("campaigns.schedule")}</Button>
        </form>
      )}
      {note && <Alert kind={note.kind}>{note.text}</Alert>}
    </div>
  );
}

/** Every campaign with its progress, refreshed while one is sending. */
export function CampaignList({ canSend }: { canSend: boolean }) {
  const { t, date } = useWords();
  const ids = useCollectionIds();
  const [campaigns, setCampaigns] = useState<CampaignRow[] | null | undefined>(undefined);
  const load = useCallback(() => { call<{ campaigns: CampaignRow[] | null }>("/campaigns").then((json) => setCampaigns(json.campaigns)).catch(() => setCampaigns(null)); }, []);
  useEffect(load, [load]);
  // Progress moves in the background, a batch at a time.
  const active = campaigns?.some((campaign) => campaign.state === "sending" || campaign.state === "scheduled");
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [active, load]);

  if (!canSend) return <p className="cms-empty">{t("campaigns.cantSend")}</p>;
  if (campaigns === null) return <p className="cms-empty">{t("campaigns.cantRead")}</p>;
  const newLink = editor(ids?.["newsletter-campaigns"], "new");
  return (
    <DataTable
      label={t("tabs.campaigns")}
      title={t("tabs.campaigns")}
      actions={newLink && <ButtonLink native href={newLink}>{t("campaigns.new")}</ButtonLink>}
      columns={[{ id: "subject", label: t("campaigns.subject") }, { id: "state", label: t("campaigns.state") }, { id: "progress", label: t("campaigns.progress") }]}
      rows={campaigns === undefined ? null : campaigns.map((campaign) => {
        const when = campaign.state === "scheduled" ? t("campaigns.scheduledFor", { date: date(campaign.scheduledAt) })
          : campaign.finishedAt ? t("campaigns.finishedAt", { date: date(campaign.finishedAt) })
            : campaign.startedAt ? t("campaigns.startedAt", { date: date(campaign.startedAt) }) : "";
        return {
          id: campaign.id,
          href: editor(ids?.["newsletter-campaigns"], campaign.id) ?? undefined,
          cells: {
            subject: <span className="cms-stack-1"><span className="cms-truncate">{campaign.subject}</span>{when && <span className="cms-hint">{when}</span>}</span>,
            state: <Badge tone={TONES[campaign.state] ?? "neutral"}>{t(`campaigns.states.${campaign.state}`)}</Badge>,
            progress: campaign.state === "draft" ? null : (
              <span className="cms-stack-1">
                <span>{t("campaigns.progressText", { sent: campaign.sent, recipients: campaign.recipients })}</span>
                {campaign.failed > 0 && <span className="cms-text-xs cms-danger">{t("campaigns.failedText", { failed: campaign.failed })}</span>}
              </span>
            ),
          },
          actions: <CampaignActions campaign={campaign} onChange={load} onCopied={(id) => { const copy = editor(ids?.["newsletter-campaigns"], id); if (copy) window.location.href = copy; else load(); }} />,
        };
      })}
      empty={{ title: t("campaigns.empty") }}
    />
  );
}

interface SubscriberRow { id: number; email: string; name?: string | null; state: string; confirmedAt?: string | null; createdAt?: string; source?: string | null }

const PER_PAGE = 50;

/** The subscribers, by state and address, with an import box and an export. */
export function SubscriberList({ canManage }: { canManage: boolean }) {
  const { t, date } = useWords();
  const ids = useCollectionIds();
  const [state, setState] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [list, setList] = useState<{ items: SubscriberRow[]; totalPages: number; totalItems: number } | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    // Search terms are quoted with their quotes and backslashes escaped, so they stay one value.
    const term = search.trim().toLowerCase().replace(/["\\]/g, "\\$&");
    const filter = [state && `state = "${state}"`, term && `email ~ "${term}"`].filter(Boolean).join(" && ");
    const query = new URLSearchParams({ page: String(page), perPage: String(PER_PAGE), sort: "-createdAt", fields: "id,email,name,state,confirmedAt,createdAt,source", ...(filter ? { filter } : {}) });
    fetch(apiPath(`/collections/newsletter-subscribers/records?${query}`)).then((response) => (response.ok ? response.json() : null)).then(setList).catch(() => setList(null));
  }, [state, search, page]);
  useEffect(load, [load]);

  async function change(id: number, next: "confirmed" | "unsubscribed") {
    setError(null);
    try {
      await call(`/subscribers/${id}/state`, { json: { state: next } });
      load();
    } catch (failure) {
      setError((failure as Error).message);
    }
  }

  if (list === null) return <p className="cms-empty">{t("subscribers.cantRead")}</p>;
  return (
    <section className="cms-stack-4">
      {error && <Alert>{error}</Alert>}
      <DataTable
        label={t("tabs.subscribers")}
        title={t("tabs.subscribers")}
        actions={canManage && <ButtonLink native variant="secondary" href={apiPath("/ext/newsletter/subscribers.csv")}>{t("subscribers.export")}</ButtonLink>}
        columns={[{ id: "email", label: t("subscribers.email") }, { id: "state", label: t("subscribers.state") }, { id: "since", label: t("subscribers.since") }, { id: "source", label: t("subscribers.source") }]}
        rows={list === undefined ? null : list.items.map((item) => ({
          id: item.id,
          href: editor(ids?.["newsletter-subscribers"], item.id) ?? undefined,
          cells: {
            email: <span className="cms-stack-1"><span className="cms-truncate">{item.email}</span>{item.name && <span className="cms-hint">{item.name}</span>}</span>,
            state: <Badge tone={item.state === "confirmed" ? "success" : item.state === "pending" ? "info" : "neutral"}>{t(`subscribers.states.${item.state}`)}</Badge>,
            since: date(item.confirmedAt ?? item.createdAt),
            source: item.source || null,
          },
          actions: canManage && item.state !== "unsubscribed" ? <button type="button" className="cms-row-action" onClick={() => void change(item.id, "unsubscribed")}>{t("subscribers.unsubscribe")}</button> : undefined,
        }))}
        toolbar={(
          <Toolbar>
            <SearchInput placeholder={t("subscribers.search")} aria-label={t("subscribers.search")} value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
            <select className="cms-input cms-input-auto" aria-label={t("subscribers.state")} value={state} onChange={(event) => { setState(event.target.value); setPage(1); }}>
              <option value="">{t("subscribers.all")}</option>
              {["confirmed", "pending", "unsubscribed"].map((value) => <option key={value} value={value}>{t(`subscribers.states.${value}`)}</option>)}
            </select>
          </Toolbar>
        )}
        empty={{ title: t("subscribers.empty") }}
        footer={list && list.totalItems > 0 ? <Pagination page={page} perPage={PER_PAGE} total={list.totalItems} onPage={setPage} /> : undefined}
      />
      {canManage && <ImportBox onDone={load} />}
    </section>
  );
}

/** Addresses pasted in, one per line, from another list or a spreadsheet. */
function ImportBox({ onDone }: { onDone(): void }) {
  const { t } = useWords();
  const [text, setText] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const result = await call<{ added: number; confirmed: number; unchanged: number; invalid: number; tooMany: boolean }>("/subscribers", { json: { text, confirmed: agreed } });
      setNote({ kind: "success", text: `${t("import.result", { added: result.added, confirmed: result.confirmed, unchanged: result.unchanged, invalid: result.invalid })}${result.tooMany ? ` ${t("import.tooMany")}` : ""}` });
      setText("");
      onDone();
    } catch (error) {
      setNote({ kind: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="cms-panel cms-p-4 cms-stack-2" onSubmit={submit}>
      <h3 className="cms-section-title">{t("import.title")}</h3>
      <p className="cms-text-sm cms-muted">{t("import.help")}</p>
      <textarea className="cms-input" rows={5} value={text} onChange={(event) => setText(event.target.value)} aria-label={t("import.title")} placeholder={t("import.placeholder")} />
      <label className="cms-row cms-gap-2 cms-text-sm">
        <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
        <span>{t("import.agreed")}</span>
      </label>
      <p className="cms-text-xs cms-muted">{agreed ? t("import.agreedHelp") : t("import.confirmHelp")}</p>
      <div><Button type="submit" disabled={busy || !text.trim()}>{t("import.button")}</Button></div>
      {note && <Alert kind={note.kind}>{note.text}</Alert>}
    </form>
  );
}
