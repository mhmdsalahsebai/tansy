"use client";

import { ArrowDownIcon, ArrowUpIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { errorText, uploadFile, useApi } from "../../lib/client/api";
import { formatBytes, type FileInfo, type FileListItem } from "./types";
import { apiPath } from "../../lib/paths";
import { useT } from "../i18n";
import { Skeleton } from "../ui/kit";
import { DescribeFile } from "./DescribeFile";

interface Props {
  id: string;
  kind: "image" | "file" | "gallery";
  value: unknown;
  onChange: (value: unknown) => void;
  allowedTypes?: string[];
}

const RASTER = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];

function SelectedFile({ fileId, onRemove, onMove }: { fileId: string; onRemove: () => void; onMove?: { up?: () => void; down?: () => void } }) {
  const { t } = useT();
  const { data, error, reload } = useApi<FileInfo>(apiPath(`/files/${encodeURIComponent(fileId)}/info`));
  const [describing, setDescribing] = useState(false);
  const image = data && RASTER.includes(data.type);
  return (
    <li className="cms-list-row cms-list-row-start">
      {image
        // eslint-disable-next-line @next/next/no-img-element -- access-checked API URL, which next/image can't fetch with the viewer's session
        ? <img src={apiPath(`/files/${data.id}?thumb=100x100&v=${data.size}`)} alt={data.alt} width={48} height={48} className="cms-thumb cms-thumb-12" />
        : <span className="cms-thumb cms-thumb-12 cms-thumb-empty" />}
      <span className="cms-min-0 cms-grow">
        {data && <a className="cms-block cms-truncate cms-medium cms-strong cms-hover-underline" href={apiPath(`/files/${data.id}`)} target="_blank" rel="noreferrer">{data.name}</a>}
        {data && <span className="cms-faded">{t("pickers.fileMeta", { type: data.type, size: formatBytes(data.size) })}</span>}
        {/* What a reader who can't see the image is told. Empty means it is decoration. */}
        {image && <span className="cms-block cms-truncate cms-faded">{data.alt || t("files.noAlt")}</span>}
        {error && <span className="cms-faded">{t("pickers.fileUnavailable")}</span>}
        {!data && !error && <Skeleton width="8rem" />}
      </span>
      {data && <button type="button" className="cms-row-action" onClick={() => setDescribing(true)}>{t("files.describe")}</button>}
      {data && <DescribeFile file={describing ? { id: data.id, name: data.name, type: data.type, size: data.size, focus: data.focus } : null} onClose={() => setDescribing(false)} onSaved={reload} />}
      {onMove && (
        <span className="cms-flex">
          <button type="button" aria-label={t("pickers.moveUp")} disabled={!onMove.up} onClick={onMove.up} className="cms-icon-btn"><ArrowUpIcon className="cms-icon" /></button>
          <button type="button" aria-label={t("pickers.moveDown")} disabled={!onMove.down} onClick={onMove.down} className="cms-icon-btn"><ArrowDownIcon className="cms-icon" /></button>
        </span>
      )}
      <button type="button" className="cms-danger" onClick={onRemove}>{t("pickers.remove")}</button>
    </li>
  );
}

/** The library, for reusing a file. The save decides whether this person may attach it. */
function Library({ kind, exclude, onPick }: { kind: Props["kind"]; exclude: string[]; onPick: (fileId: string) => void }) {
  const { t } = useT();
  const { data, error } = useApi<{ items: FileListItem[] }>(apiPath("/files?perPage=60"));
  if (error) return <p className="cms-muted">{t("pickers.libraryUnavailable")}</p>;
  if (!data) return <div className="cms-skeleton-cards" aria-busy="true">{[0, 1, 2, 3].map((tile) => <Skeleton key={tile} height="block" />)}</div>;
  const files = data.items.filter((file) => !exclude.includes(file.id) && (kind !== "image" || RASTER.includes(file.type)));
  if (!files.length) return <p className="cms-muted">{t("pickers.noOtherFiles")}</p>;
  return (
    <ul className="cms-file-grid">
      {files.map((file) => (
        <li key={file.id}>
          <button type="button" onClick={() => onPick(file.id)} className="cms-file-tile">
            {RASTER.includes(file.type)
              // eslint-disable-next-line @next/next/no-img-element -- access-checked API URL, which next/image can't fetch with the viewer's session
              ? <img src={apiPath(`/files/${file.id}?thumb=100x100&v=${file.size}`)} alt="" width={64} height={64} className="cms-thumb-wide" />
              : <span className="cms-thumb-wide cms-thumb-empty" />}
            <span className="cms-block cms-truncate cms-strong">{file.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function FileValueInput({ id, kind, value, onChange, allowedTypes }: Props) {
  const { t } = useT();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const multiple = kind === "gallery";
  const selected = (Array.isArray(value) ? value : value ? [value] : []) as string[];
  const accept = allowedTypes?.length ? allowedTypes.join(",") : kind === "image" ? "image/*" : undefined;

  const upload = async (chosen: FileList | null) => {
    if (!chosen?.length) return;
    setUploading(true);
    setError(null);
    const added: string[] = [];
    try {
      for (const file of Array.from(chosen)) added.push((await uploadFile(file, { temporary: true })).id);
    } catch (err) {
      setError(errorText(err));
    }
    if (added.length) onChange(multiple ? [...selected, ...added] : added[0]);
    setUploading(false);
  };

  const remove = (fileId: string) => {
    const rest = selected.filter((item) => item !== fileId);
    onChange(multiple && rest.length ? rest : "");
  };

  const swap = (index: number, other: number) => {
    const next = [...selected];
    [next[index], next[other]] = [next[other], next[index]];
    onChange(next);
  };
  const pick = (fileId: string) => {
    onChange(multiple ? [...selected, fileId] : fileId);
    if (!multiple) setBrowsing(false);
  };

  return (
    <div className="cms-mt-1 cms-stack-2">
      {selected.length > 0 && (
        <ul className="cms-stack-2">
          {selected.map((fileId, index) => (
            <SelectedFile key={fileId} fileId={fileId} onRemove={() => remove(fileId)}
              onMove={multiple && selected.length > 1 ? { up: index > 0 ? () => swap(index, index - 1) : undefined, down: index < selected.length - 1 ? () => swap(index, index + 1) : undefined } : undefined} />
          ))}
        </ul>
      )}
      {(multiple || selected.length === 0 || uploading) && (
        <input
          id={id}
          type="file"
          multiple={multiple}
          accept={accept}
          disabled={uploading}
          className="cms-file-input"
          onChange={(e) => { void upload(e.target.files); e.target.value = ""; }}
        />
      )}
      {(multiple || selected.length === 0) && (
        <button type="button" className="cms-text-sm cms-link" aria-expanded={browsing} onClick={() => setBrowsing(!browsing)}>{browsing ? t("pickers.hideLibrary") : t("pickers.chooseFromLibrary")}</button>
      )}
      {browsing && (multiple || selected.length === 0) && <Library kind={kind} exclude={selected} onPick={pick} />}
      {uploading && <p className="cms-muted">{t("pickers.uploading")}</p>}
      {error && <p className="cms-error">{error}</p>}
    </div>
  );
}
