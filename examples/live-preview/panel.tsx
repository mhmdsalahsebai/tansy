"use client";

import { useEffect, useRef, useState } from "react";
import type { RecordPanelProps } from "tansy/admin";

const PREVIEW_URL = process.env.NEXT_PUBLIC_TANSY_PREVIEW_URL;

/**
 * Example of a record editor panel: shows your front end beside the form and sends
 * it the unsaved values as you type. Nothing is stored and no record is served, as
 * the values go straight from this browser to the one origin configured here.
 *
 * Your page listens for them:
 *   addEventListener("message", (e) => { if (e.origin === TANSY_ORIGIN && e.data.type === "cms:preview") render(e.data.values); });
 */
export function LivePreview({ collection, recordId, values }: RecordPanelProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || !PREVIEW_URL) return;
    frame.current?.contentWindow?.postMessage({ type: "cms:preview", collection: collection.slug, id: recordId ?? null, values }, new URL(PREVIEW_URL).origin);
  }, [open, values, collection.slug, recordId]);

  if (!PREVIEW_URL) return null;
  const send = () => frame.current?.contentWindow?.postMessage({ type: "cms:preview", collection: collection.slug, id: recordId ?? null, values }, new URL(PREVIEW_URL).origin);
  return (
    <div>
      <button type="button" className="cms-text-sm cms-link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide preview" : "Show live preview"}</button>
      {open && <iframe ref={frame} title="Live preview" src={`${PREVIEW_URL}/${collection.slug}/${recordId ?? "new"}`} onLoad={send} sandbox="allow-scripts allow-same-origin" className="cms-preview-frame" />}
    </div>
  );
}
