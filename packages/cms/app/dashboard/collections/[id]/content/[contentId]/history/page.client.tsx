"use client";

import { CheckIcon, PencilIcon } from "@heroicons/react/16/solid";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSchemaText, useT } from "../../../../../../../components/i18n";
import { Alert, Badge, Button, Card, Modal, PageHeader, Pagination, Skeleton, Timeline, type BadgeTone } from "../../../../../../../components/ui/kit";
import type { BlockChange, FieldChange } from "../../../../../../../core/content/diff";
import { api, errorText, useApi } from "../../../../../../../lib/client/api";
import { adminPath, apiPath } from "../../../../../../../lib/paths";

interface Props {
  collectionId: number;
  collectionName: string;
  collectionLabels?: Record<string, string> | null;
  recordId: string;
  canRestore: boolean;
}

interface RevisionRow {
  id: number;
  number: number;
  status: string;
  note: string | null;
  author: string | null;
  createdAt: string;
}

interface Diff {
  against: number | "current" | null;
  changes: FieldChange[];
}

const PER_PAGE = 30;

function show(value: unknown, empty: string) {
  if (value === null || value === undefined || value === "") return empty;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

const CHANGE_TONE: Record<BlockChange["change"], BadgeTone> = {
  added: "success",
  removed: "danger",
  changed: "warning",
  moved: "info",
};

function ValueChange({ before, after }: { before: unknown; after: unknown }) {
  const { t } = useT();
  return (
    <dl className="cms-mt-1 cms-grid cms-gap-1 cms-text-sm cms-sm-2">
      <div className="cms-diff cms-diff-removed"><dt className="cms-text-xs cms-medium cms-danger">{t("history.before")}</dt><dd className="cms-break-words cms-mono cms-text-xs cms-strong">{show(before, t("history.emptyValue"))}</dd></div>
      <div className="cms-diff cms-diff-added"><dt className="cms-text-xs cms-medium cms-success">{t("history.after")}</dt><dd className="cms-break-words cms-mono cms-text-xs cms-strong">{show(after, t("history.emptyValue"))}</dd></div>
    </dl>
  );
}

function BlockChanges({ changes }: { changes: BlockChange[] }) {
  const { t } = useT();
  return (
    <ul className="cms-mt-2 cms-stack-2">
      {changes.map((block) => (
        <li key={block.id} className="cms-box cms-box-2">
          <Badge tight tone={CHANGE_TONE[block.change]} className="cms-mr-2">{t(`history.changes.${block.change}`)}</Badge>
          <span className="cms-text-sm cms-medium cms-strong">{block.type}</span>
          {block.fields?.map((field) => (
            <div key={field.name} className="cms-mt-2">
              <p className="cms-text-xs cms-medium cms-soft">{field.name}</p>
              {field.blocks ? <BlockChanges changes={field.blocks} /> : <ValueChange before={field.before} after={field.after} />}
            </div>
          ))}
        </li>
      ))}
    </ul>
  );
}

function DiffView({ url }: { url: string }) {
  const { data, error, loading } = useApi<Diff>(url);
  const { t } = useT();
  if (loading) return <div className="cms-stack-2" aria-busy="true"><Skeleton width="60%" /><Skeleton width="45%" /></div>;
  if (error || !data) return <Alert>{error ?? t("history.compareFailed")}</Alert>;
  if (!data.changes.length) return <p className="cms-muted">{t("history.noChanges")}</p>;
  return (
    <div className="cms-stack-3">
      {data.against === null && <p className="cms-muted">{t("history.earliest")}</p>}
      {data.changes.map((change) => (
        <div key={change.fieldId}>
          <p className="cms-text-sm cms-medium cms-strong">{change.name}</p>
          {change.blocks ? <BlockChanges changes={change.blocks} /> : <ValueChange before={change.beforeSummary ?? change.before} after={change.afterSummary ?? change.after} />}
        </div>
      ))}
    </div>
  );
}

export default function HistoryPage({ collectionId, collectionName, collectionLabels, recordId, canRestore }: Props) {
  const schemaText = useSchemaText();
  const { t, locale: uiLocale } = useT();
  // A localized record's history belongs to one language, the one the editor had open.
  const locale = useSearchParams().get("locale");
  const inLocale = (path: string) => (locale ? `${path}${path.includes("?") ? "&" : "?"}locale=${encodeURIComponent(locale)}` : path);
  const base = apiPath(`/collections/${collectionId}/content/${recordId}`);
  const [page, setPage] = useState(1);
  const { data, error: loadError, loading, reload } = useApi<{ items: RevisionRow[]; totalItems: number }>(inLocale(`${base}/revisions?page=${page}&perPage=${PER_PAGE}`));
  const [open, setOpen] = useState<number | null>(null);
  const [pending, setPending] = useState<RevisionRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restore = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    try {
      await api(inLocale(`${base}/revisions/${pending.id}/restore`), { method: "POST" });
      setOpen(null);
      setPage(1);
      reload();
    } catch (err) {
      setError(errorText(err));
    }
    setBusy(false);
    setPending(null);
  };

  return (
    <div className="cms-gutter">
      <PageHeader
        title={t("history.title")}
        description={schemaText.collection({ name: collectionName, labels: collectionLabels })}
        back={{ href: inLocale(adminPath(`/collections/${collectionId}/content/${recordId}`)), label: t("history.backToItem") }}
      />
      {(error || loadError) && <div className="cms-mb-4"><Alert>{error ?? loadError}</Alert></div>}
      {loading && !data && <div className="cms-panel cms-card-body cms-stack-4" aria-busy="true">{[0, 1, 2].map((row) => <div key={row} className="cms-stack-2"><Skeleton width={["40%", "55%", "35%"][row]} /><Skeleton width="20%" /></div>)}</div>}
      {data && data.items.length === 0 && <p className="cms-empty">{t("history.empty")}</p>}
      {data && data.items.length > 0 && (
        <div className="cms-stack-4">
          <Card flush>
            <Timeline entries={data.items.map((revision) => ({
              id: String(revision.id),
              icon: revision.status === "published" ? <CheckIcon /> : <PencilIcon />,
              tone: revision.status === "published" ? "success" : "neutral",
              title: (
                <>
                  <span className="cms-medium cms-strong">{t("history.revision", { number: revision.number })}</span>
                  {revision.author && <span>{t("history.by", { author: revision.author })}</span>}
                  <Badge tight tone={revision.status === "published" ? "success" : "warning"} className="cms-ml-2">{revision.status === "published" || revision.status === "draft" ? t(`editor.status.${revision.status}`) : revision.status}</Badge>
                </>
              ),
              time: <time dateTime={revision.createdAt}>{new Date(revision.createdAt).toLocaleString(uiLocale)}</time>,
              detail: (
                <>
                  {revision.note && <p className="cms-text-sm cms-body cms-mb-2">{revision.note}</p>}
                  <div className="cms-inline-3 cms-text-sm">
                    <button type="button" className="cms-link" aria-expanded={open === revision.id} onClick={() => setOpen(open === revision.id ? null : revision.id)}>{open === revision.id ? t("history.hideChanges") : t("history.showChanges")}</button>
                    {canRestore && <button type="button" className="cms-link" onClick={() => setPending(revision)}>{t("history.restore")}</button>}
                  </div>
                  {open === revision.id && <div className="cms-divided-top"><DiffView url={inLocale(`${base}/revisions/${revision.id}/diff`)} /></div>}
                </>
              ),
            }))} />
          </Card>
          <Pagination page={page} perPage={PER_PAGE} total={data.totalItems} onPage={setPage} />
        </div>
      )}
      <Modal open={pending !== null} onClose={() => setPending(null)} title={t("history.restoreTitle", { number: pending?.number ?? "" })}>
        <p className="cms-mb-4 cms-text-sm cms-body">{t("history.restoreBody")}</p>
        <div className="cms-flex cms-end cms-gap-2">
          <Button variant="secondary" onClick={() => setPending(null)}>{t("history.cancel")}</Button>
          <Button loading={busy} onClick={() => void restore()}>{t("history.restore")}</Button>
        </div>
      </Modal>
    </div>
  );
}
