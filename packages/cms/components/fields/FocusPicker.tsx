"use client";

import { useRef } from "react";
import { Button, Field, Input } from "../ui/kit";
import { apiPath } from "../../lib/paths";
import { useT } from "../i18n";

export interface Focus {
  x: number;
  y: number;
}

const clamp = (value: number) => Math.min(100, Math.max(0, Math.round(value)));

/**
 * Where the subject of a picture is. Clicking the picture places the point, and the two boxes
 * set it exactly, so it can be placed without a mouse. Null means the middle, which is what a
 * thumbnail crops to when nothing is placed.
 */
export function FocusPicker({ id, version, focus, onChange }: { id: string; version?: number; focus: Focus | null; onChange: (focus: Focus | null) => void }) {
  const { t } = useT();
  const frame = useRef<HTMLButtonElement>(null);
  const shown = focus ?? { x: 50, y: 50 };

  const place = (event: React.MouseEvent) => {
    const box = frame.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return;
    onChange({ x: clamp(((event.clientX - box.left) / box.width) * 100), y: clamp(((event.clientY - box.top) / box.height) * 100) });
  };

  return (
    <Field label={t("files.focus")} hint={t("files.focusHint")}>
      <div className="cms-stack-2">
        <button
          ref={frame}
          type="button"
          className="cms-focus-frame"
          onClick={place}
          aria-label={t("files.focusPlace")}
        >
          {/* The whole picture, never a cropped thumbnail, so the point is placed on what the file holds. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- access-checked API URL, which next/image can't fetch with the viewer's session */}
          <img src={apiPath(`/files/${encodeURIComponent(id)}?thumb=800x0${version ? `&v=${version}` : ""}`)} alt="" className="cms-focus-image" />
          <span className="cms-focus-dot" style={{ left: `${shown.x}%`, top: `${shown.y}%` }} aria-hidden="true" />
        </button>
        <div className="cms-row cms-gap-2">
          <Field label={t("files.focusX")}>
            <Input type="number" min={0} max={100} value={String(shown.x)} onChange={(e) => onChange({ ...shown, x: clamp(Number(e.target.value)) })} />
          </Field>
          <Field label={t("files.focusY")}>
            <Input type="number" min={0} max={100} value={String(shown.y)} onChange={(e) => onChange({ ...shown, y: clamp(Number(e.target.value)) })} />
          </Field>
          <Button variant="secondary" disabled={!focus} onClick={() => onChange(null)}>{t("files.focusReset")}</Button>
        </div>
      </div>
    </Field>
  );
}
