"use client";

import { useState } from "react";
import { CheckBadgeIcon } from "@heroicons/react/24/outline";
import { useAdminLocale, useT } from "../../../components/i18n";
import { Alert, Badge, DataTable, PageHeader, SegmentedControl, Toolbar } from "../../../components/ui/kit";
import { useApi } from "../../../lib/client/api";
import { adminPath, apiPath } from "../../../lib/paths";
import { relativeTime } from "../../../lib/time";

interface QueueItem {
  collectionId: number;
  collection: string;
  recordId: number;
  locale: string | null;
  title: string;
  state: "pending" | "changes";
  note: string | null;
  submittedBy: string | null;
  submittedAt: string;
  reviewNote: string | null;
  reviewedBy: string | null;
  mine: boolean;
  canReview: boolean;
}

/** Changes waiting for a reviewer, and those sent back to their authors. The API decides what each person sees. */
export default function ReviewsPage() {
  const { t } = useT();
  const { locale } = useAdminLocale();
  const [state, setState] = useState<"pending" | "changes">("pending");
  const { data, error } = useApi<{ items: QueueItem[] }>(`${apiPath("/reviews")}?state=${state}`);
  const link = (item: QueueItem) => adminPath(`/collections/${item.collectionId}/content/${item.recordId}${item.locale ? `?locale=${encodeURIComponent(item.locale)}` : ""}`);

  return (
    <div className="cms-gutter">
      <PageHeader title={t("review.queueTitle")} description={t("review.queueDescription")} />
      {error && <div className="cms-mb-4"><Alert>{error}</Alert></div>}
      <DataTable
        label={t("review.queueTitle")}
        columns={[{ id: "record", label: t("review.record") }, { id: "collection", label: t("review.collection") }, { id: "by", label: t("review.submittedByColumn") }, { id: "note", label: t("review.noteColumn") }]}
        rows={data ? data.items.map((item) => ({
          id: `${item.collectionId}:${item.recordId}:${item.locale ?? ""}`,
          href: link(item),
          cells: {
            record: <span className="cms-row cms-gap-2"><span className="cms-medium">{item.title || t("review.untitled")}</span>{item.locale && <Badge tone="neutral" tight>{item.locale}</Badge>}{item.mine && <Badge tone="info" tight>{t("review.yours")}</Badge>}</span>,
            collection: item.collection,
            by: <span>{item.submittedBy ?? t("review.someone")} <span className="cms-muted">· {relativeTime(item.submittedAt, undefined, locale)}</span></span>,
            note: <span className="cms-muted">{(state === "changes" ? item.reviewNote : item.note) ?? ""}</span>,
          },
        })) : null}
        toolbar={<Toolbar><SegmentedControl label={t("review.queueTitle")} value={state} onChange={setState} options={[{ id: "pending", label: t("review.statePending") }, { id: "changes", label: t("review.stateChanges") }]} /></Toolbar>}
        empty={{ icon: <CheckBadgeIcon />, title: t(state === "pending" ? "review.emptyPending" : "review.emptyChanges") }}
      />
    </div>
  );
}
