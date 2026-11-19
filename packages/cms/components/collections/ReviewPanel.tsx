"use client";

import { useState } from "react";
import { useAdminLocale, useT } from "../i18n";
import { Alert, Badge, Button } from "../ui/kit";
import { api, errorText, useApi } from "../../lib/client/api";
import { relativeTime } from "../../lib/time";

export interface Review {
  state: "pending" | "changes";
  note: string | null;
  submittedBy: string | null;
  submittedAt: string;
  reviewNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

/**
 * Where a record stands in review, in the editor's side panel. Authors withdraw from here;
 * reviewers send changes back with a note. Approving is the editor's Publish button, which
 * closes the review as it publishes. The routes decide who may do what.
 */
export function ReviewPanel({ path, version, canReview, busy, onChanged }: { path: string; version: number; canReview: boolean; busy: boolean; onChanged: () => void }) {
  const { t } = useT();
  const { locale } = useAdminLocale();
  const { data: review, error: loadError } = useApi<Review | null>(`${path}${path.includes("?") ? "&" : "?"}v=${version}`);
  const [writing, setWriting] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const act = async (work: () => Promise<unknown>) => {
    setWorking(true);
    setError(null);
    try {
      await work();
      setWriting(false);
      setNote("");
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setWorking(false);
    }
  };
  const changesPath = path.replace(/\/review(\?|$)/, "/review/changes$1");

  if (loadError) return <Alert>{loadError}</Alert>;
  if (review === undefined) return null;
  if (review === null) return <p className="cms-hint">{t(canReview ? "review.noneReviewer" : "review.none")}</p>;
  return (
    <div className="cms-stack-3">
      {error && <Alert>{error}</Alert>}
      <div className="cms-row cms-wrap cms-gap-2">
        <Badge tone={review.state === "pending" ? "info" : "warning"}>{t(review.state === "pending" ? "review.statePending" : "review.stateChanges")}</Badge>
        <span className="cms-hint">{t("review.submittedBy", { name: review.submittedBy ?? t("review.someone"), when: relativeTime(review.submittedAt, undefined, locale) })}</span>
      </div>
      {review.note && <p className="cms-text-sm">{review.note}</p>}
      {review.state === "changes" && review.reviewNote && (
        <Alert kind="warning">
          <strong>{t("review.changesFrom", { name: review.reviewedBy ?? t("review.someone") })}</strong> {review.reviewNote}
        </Alert>
      )}
      {review.state === "pending" && canReview && <p className="cms-hint">{t("review.approveHint")}</p>}
      {writing ? (
        <form className="cms-stack-2" onSubmit={(event) => { event.preventDefault(); void act(() => api(changesPath, { method: "POST", body: { note } })); }}>
          <label className="cms-label" htmlFor="review-note">{t("review.changesNote")}</label>
          <textarea id="review-note" className="cms-input" rows={3} required maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
          <div className="cms-row cms-gap-2">
            <Button type="submit" variant="secondary" loading={working} disabled={!note.trim()}>{t("review.sendBack")}</Button>
            <Button variant="ghost" onClick={() => setWriting(false)}>{t("grid.cancel")}</Button>
          </div>
        </form>
      ) : (
        <div className="cms-row cms-wrap cms-gap-2">
          {review.state === "pending" && canReview && <Button variant="secondary" disabled={busy} onClick={() => setWriting(true)}>{t("review.requestChanges")}</Button>}
          <Button variant="ghost" loading={working} disabled={busy} onClick={() => void act(() => api(path, { method: "DELETE" }))}>{t("review.withdraw")}</Button>
        </div>
      )}
    </div>
  );
}
