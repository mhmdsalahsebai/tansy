"use client";

import { useState } from "react";
import { useT } from "../../../components/i18n";
import { ClipboardDocumentListIcon } from "@heroicons/react/24/outline";
import { Alert, Badge, ButtonLink, DataTable, PageHeader, Pagination, SearchInput, Toolbar, type BadgeTone } from "../../../components/ui/kit";
import { useApi } from "../../../lib/client/api";
import type { Paginated } from "../../../types/content";
import { adminPath, apiPath } from "../../../lib/paths";

interface Entry { id: string; at: string; action: string; outcome: string; actorEmail: string | null; actorKind: string; targetType: string | null; targetId: string | null; ipAddress: string | null; metadata: unknown }

const outcomeTone: Record<string, BadgeTone> = { success: "success", failure: "warning", denied: "danger" };
const OUTCOMES = ["success", "failure", "denied"] as const;
const isOutcome = (value: string): value is (typeof OUTCOMES)[number] => (OUTCOMES as readonly string[]).includes(value);

export default function AuditClient({ canConfigure = false }: { canConfigure?: boolean }) {
  const { t, locale } = useT();
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [outcome, setOutcome] = useState("");
  const params = new URLSearchParams({ page: String(page), perPage: "50" });
  if (action) params.set("action", action);
  if (actor) params.set("actor", actor);
  if (outcome) params.set("outcome", outcome);
  const { data, error } = useApi<Paginated<Entry>>(apiPath(`/audit?${params}`));
  return (
    <div className="cms-gutter">
      <PageHeader title={t("audit.title")} description={t("audit.description")} actions={canConfigure ? <ButtonLink variant="secondary" href={adminPath("/settings?tab=security")}>{t("audit.settings")}</ButtonLink> : undefined} />
      {error && <div className="cms-mb-4"><Alert>{error}</Alert></div>}
      <DataTable
        label={t("audit.title")}
        columns={[{ id: "action", label: t("audit.action") }, { id: "outcome", label: t("audit.outcome") }, { id: "who", label: t("audit.who") }, { id: "target", label: t("audit.target") }, { id: "ip", label: t("audit.ip") }, { id: "when", label: t("audit.when") }]}
        rows={data ? data.items.map((entry) => ({
          id: entry.id,
          cells: {
            action: <span className="cms-mono cms-text-xs">{entry.action}</span>,
            outcome: <Badge tone={outcomeTone[entry.outcome] ?? "neutral"}>{isOutcome(entry.outcome) ? t(`audit.outcomes.${entry.outcome}`) : entry.outcome}</Badge>,
            who: entry.actorEmail ?? entry.actorKind,
            target: entry.targetType ? `${entry.targetType} ${entry.targetId ?? ""}` : null,
            ip: entry.ipAddress,
            when: <span className="cms-nowrap">{new Date(entry.at).toLocaleString(locale)}</span>,
          },
        })) : null}
        toolbar={(
          <Toolbar>
            <SearchInput aria-label={t("audit.filterAction")} placeholder={t("audit.filterAction")} value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} />
            <SearchInput aria-label={t("audit.filterEmail")} placeholder={t("audit.filterEmail")} value={actor} onChange={(e) => { setActor(e.target.value); setPage(1); }} />
            <select aria-label={t("audit.filterOutcome")} className="cms-input cms-input-auto" value={outcome} onChange={(e) => { setOutcome(e.target.value); setPage(1); }}>
              <option value="">{t("audit.allOutcomes")}</option>{OUTCOMES.map((value) => <option key={value} value={value}>{t(`audit.outcomes.${value}`)}</option>)}
            </select>
          </Toolbar>
        )}
        empty={{ icon: <ClipboardDocumentListIcon />, title: action || actor || outcome ? t("grid.noMatches") : t("audit.empty") }}
        footer={data && data.totalItems > 0 ? <Pagination page={page} perPage={data.perPage} total={data.totalItems} onPage={setPage} /> : undefined}
      />
    </div>
  );
}
