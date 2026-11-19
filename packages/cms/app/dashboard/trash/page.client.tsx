"use client";

import { useState } from "react";
import { useT } from "../../../components/i18n";
import { TrashIcon } from "@heroicons/react/24/outline";
import { Alert, Badge, Button, DataTable, Modal, PageHeader, Pagination } from "../../../components/ui/kit";
import { api, errorText, useApi } from "../../../lib/client/api";
import type { Paginated } from "../../../types/content";
import { apiPath } from "../../../lib/paths";

interface Entry {
  id: number;
  collectionId: number;
  collection: string;
  recordId: number;
  label: string;
  status: string;
  deletedBy: string | null;
  deletedAt: string;
  expiresAt: string;
  canRestore: boolean;
}

export default function TrashPage() {
  const { t, locale } = useT();
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const { data, error: loadError, reload } = useApi<Paginated<Entry>>(apiPath(`/trash?page=${page}&perPage=50&v=${version}`));
  const [purging, setPurging] = useState<Entry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (path: string, method: "POST" | "DELETE") => {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method });
      setVersion((current) => current + 1);
      reload();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const entryPath = (entry: Entry) => apiPath(`/collections/${entry.collectionId}/trash/${entry.id}`);
  const restore = (entry: Entry) => void run(`${entryPath(entry)}/restore`, "POST");
  const purge = async () => {
    if (purging && (await run(entryPath(purging), "DELETE"))) setPurging(null);
  };

  return (
    <div className="cms-gutter">
      <PageHeader title={t("trash.title")} description={t("trash.description")} />
      {(error ?? loadError) && <div className="cms-mb-4"><Alert>{error ?? loadError}</Alert></div>}
      <DataTable
        label={t("trash.title")}
        columns={[
          { id: "label", label: t("trash.record") },
          { id: "collection", label: t("trash.collection") },
          { id: "status", label: t("trash.status") },
          { id: "deletedBy", label: t("trash.deletedBy") },
          { id: "deletedAt", label: t("trash.deletedAt") },
          { id: "expiresAt", label: t("trash.expires") },
        ]}
        rows={data ? data.items.map((entry) => ({
          id: entry.id,
          cells: {
            label: entry.label || <span className="cms-muted">{t("trash.untitled", { id: entry.recordId })}</span>,
            collection: entry.collection,
            status: <Badge tone={entry.status === "published" ? "success" : "warning"} tight>{t(`trash.statuses.${entry.status === "published" ? "published" : "draft"}`)}</Badge>,
            deletedBy: entry.deletedBy ?? <span className="cms-muted">{t("trash.unknownActor")}</span>,
            deletedAt: <span className="cms-nowrap">{new Date(entry.deletedAt).toLocaleString(locale)}</span>,
            expiresAt: <span className="cms-nowrap">{new Date(entry.expiresAt).toLocaleDateString(locale)}</span>,
          },
          actions: (
            <>
              {entry.canRestore && <button type="button" className="cms-row-action" disabled={busy} onClick={() => restore(entry)}>{t("trash.restore")}</button>}
              <button type="button" className="cms-row-action cms-row-action-danger" disabled={busy} onClick={() => { setPurging(entry); setError(null); }}>{t("trash.purge")}</button>
            </>
          ),
        })) : null}
        empty={{ icon: <TrashIcon />, title: t("trash.empty"), hint: t("trash.emptyHelp") }}
        footer={data && data.totalItems > 0 ? <Pagination page={page} perPage={data.perPage} total={data.totalItems} onPage={setPage} /> : undefined}
      />
      <Modal open={purging !== null} onClose={() => setPurging(null)} title={t("trash.purgeTitle")}>
        <div className="cms-stack-4">
          {error && <Alert>{error}</Alert>}
          <p>{t("trash.purgeWarning", { label: purging?.label || String(purging?.recordId ?? "") })}</p>
          <div className="cms-flex cms-end cms-gap-2">
            <Button variant="secondary" onClick={() => setPurging(null)}>{t("grid.cancel")}</Button>
            <Button variant="danger" loading={busy} onClick={() => void purge()}>{t("trash.purge")}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
