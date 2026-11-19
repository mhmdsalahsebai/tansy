"use client";

import { useState } from "react";
import type { Block } from "../../core/blocks/limits";
import { api, errorText } from "../../lib/client/api";
import { apiPath } from "../../lib/paths";
import { Button, Input } from "../ui/kit";
import type { BlockLayoutInfo } from "../fields/types";
import { useT } from "../i18n";

/** Saves the current blocks as a layout, which then shows in the block inserter. Starting from a layout happens there. */
export default function SaveLayout({ blocks, onSaved }: { blocks: Block[]; onSaved: (layout: BlockLayoutInfo) => void }) {
  const { t } = useT();
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    try {
      const layout = await api<BlockLayoutInfo>(apiPath("/block-layouts"), { method: "POST", body: { name, blocks } });
      onSaved(layout);
      setName(null);
      setError(null);
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    }
  };

  if (name === null) {
    return (
      <span className="cms-row cms-gap-2">
        {saved && <span className="cms-hint" role="status">{t("stream.layout.saved")}</span>}
        <button type="button" className="cms-quiet-btn" onClick={() => { setName(""); setSaved(false); }}>{t("stream.layout.saveAs")}</button>
      </span>
    );
  }
  return (
    <span className="cms-row cms-wrap cms-gap-2">
      <Input autoFocus aria-label={t("stream.layout.name")} placeholder={t("stream.layout.name")} className="cms-w-auto" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { e.preventDefault(); void save(); } if (e.key === "Escape") setName(null); }} />
      <Button variant="secondary" disabled={!name.trim()} onClick={() => void save()}>{t("stream.layout.save")}</Button>
      <Button variant="secondary" onClick={() => { setName(null); setError(null); }}>{t("stream.layout.cancel")}</Button>
      {error && <span className="cms-error">{error}</span>}
    </span>
  );
}
