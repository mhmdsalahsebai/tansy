"use client";

import { useEffect, useState } from "react";
import { Alert, apiPath, Badge, Button, DataTable, SearchInput, Toolbar, useT, type BadgeTone } from "tansy/admin";
import type { LoggedEntry } from "./logic";

interface Answer { items: LoggedEntry[]; next: string | null; enabled: boolean; database: boolean; destinations: string[] }

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const STATUSES = ["2xx", "3xx", "4xx", "5xx"] as const;
const SELECT = "cms-input cms-input-auto";
const statusTone = (status: number): BadgeTone => (status >= 500 ? "danger" : status >= 400 ? "warning" : "success");

/** Newest first, a page at a time: "Older" follows the cursor, and "Newest" goes back to the start. */
export function RequestLogView() {
  const { t: translate, locale } = useT();
  const t = (key: string, values?: Record<string, string | number>) => translate(`ext.request-logs.${key}`, values);
  const [path, setPath] = useState("");
  const [method, setMethod] = useState("");
  const [status, setStatus] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [failed, setFailed] = useState(false);
  const before = cursors.at(-1);

  useEffect(() => {
    let live = true;
    const query = new URLSearchParams();
    if (path) query.set("path", path);
    if (method) query.set("method", method);
    if (status) query.set("status", status);
    if (before) query.set("before", before);
    fetch(apiPath(`/ext/request-logs/entries?${query}`), { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((value: Answer) => { if (live) { setAnswer(value); setFailed(false); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [path, method, status, before]);

  const filter = (set: (value: string) => void) => (value: string) => { set(value); setCursors([]); };
  const filtered = Boolean(path || method || status);

  return (
    <div className="cms-stack-4">
      {failed && <Alert>{t("failed")}</Alert>}
      {answer && !answer.enabled && <Alert kind="warning">{t("off")}</Alert>}
      {answer?.enabled && !answer.database && <Alert kind="info">{t("notHere")}</Alert>}
      {answer && answer.destinations.length > 0 && <p className="cms-hint">{t("sentTo", { destinations: answer.destinations.join(", ") })}</p>}
      <DataTable
        label={t("pages.request-logs")}
        columns={[{ id: "path", label: t("path") }, { id: "method", label: t("method") }, { id: "status", label: t("status") }, { id: "time", label: t("time"), numeric: true }, { id: "ip", label: t("ip") }, { id: "when", label: t("when") }]}
        rows={answer ? answer.items.map((entry) => ({
          id: entry.id,
          cells: {
            path: <span className="cms-mono cms-text-xs">{entry.path}</span>,
            method: <span className="cms-mono cms-text-xs">{entry.method}</span>,
            status: <Badge tone={statusTone(entry.status)}>{entry.status}</Badge>,
            time: t("ms", { ms: entry.durationMs.toLocaleString(locale) }),
            ip: entry.ipAddress,
            when: <span className="cms-nowrap">{new Date(entry.at).toLocaleString(locale)}</span>,
          },
        })) : null}
        toolbar={(
          <Toolbar>
            <SearchInput aria-label={t("filterPath")} placeholder={t("filterPath")} value={path} onChange={(event) => filter(setPath)(event.target.value)} />
            <select aria-label={t("filterMethod")} className={SELECT} value={method} onChange={(event) => filter(setMethod)(event.target.value)}>
              <option value="">{t("allMethods")}</option>
              {METHODS.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            <select aria-label={t("filterStatus")} className={SELECT} value={status} onChange={(event) => filter(setStatus)(event.target.value)}>
              <option value="">{t("allStatuses")}</option>
              {STATUSES.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </Toolbar>
        )}
        empty={{ title: filtered ? t("noMatches") : t("empty") }}
        footer={answer && (cursors.length > 0 || answer.next) ? (
          <div className="cms-row cms-gap-2">
            <Button variant="secondary" disabled={!cursors.length} onClick={() => setCursors([])}>{t("newest")}</Button>
            <Button variant="secondary" disabled={!answer.next} onClick={() => answer.next && setCursors([...cursors, answer.next])}>{t("older")}</Button>
          </div>
        ) : undefined}
      />
    </div>
  );
}
