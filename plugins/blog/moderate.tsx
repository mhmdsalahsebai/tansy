"use client";

import { useState } from "react";
import { apiPath, Button, useT } from "tansy/admin";

type T = (key: string, values?: Record<string, string | number>) => string;

export type CommentState = "approved" | "spam" | "pending";

/** Sets each comment's state through the records API, which checks the caller's own permission on Comments. */
export async function setCommentState(ids: number[], state: CommentState, t: T) {
  const failed: number[] = [];
  for (const id of ids) {
    const response = await fetch(apiPath(`/collections/blog-comments/records/${id}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state }),
    });
    if (!response.ok) failed.push(id);
  }
  if (failed.length) window.alert(t("ext.blog.moderate.failed", { count: failed.length }));
}

export function ModerateButtons({ id }: { id: number }) {
  const { t } = useT();
  const [done, setDone] = useState<CommentState | null>(null);
  const [busy, setBusy] = useState(false);
  if (done) return <span className="cms-faded">{done === "approved" ? t("ext.blog.moderate.approved") : t("ext.blog.moderate.markedSpam")}</span>;
  const set = async (state: CommentState) => {
    setBusy(true);
    await setCommentState([id], state, t);
    // Shown as done only if it stuck: the page reloads its list on the next visit either way.
    const check = await fetch(apiPath(`/collections/blog-comments/records/${id}?fields=state`)).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { state?: string } | null;
    setBusy(false);
    if (check?.state === state) setDone(state);
  };
  return (
    <span className="cms-flex cms-gap-2">
      <Button variant="primary" loading={busy} onClick={() => set("approved")}>{t("ext.blog.moderate.approve")}</Button>
      <Button variant="secondary" disabled={busy} onClick={() => set("spam")}>{t("ext.blog.moderate.spam")}</Button>
    </span>
  );
}
