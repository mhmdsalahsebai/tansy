"use client";

import { useT } from "../../../components/i18n";
import { useState } from "react";
import { formatBytes, type FileListItem } from "../../../components/fields/types";
import { PhotoIcon } from "@heroicons/react/24/outline";
import { Alert, Badge, Button, DataTable, Modal, PageHeader, Pagination, SearchInput, Toolbar } from "../../../components/ui/kit";
import { api, errorText, uploadFile } from "../../../lib/client/api";
import { DescribeFile } from "../../../components/fields/DescribeFile";
import { apiPath } from "../../../lib/paths";

interface Props {
  initial: FileListItem[];
  initialTotal: number;
  perPage: number;
  canUpload: boolean;
  canDelete: boolean;
}

const hasThumb = (type: string) => ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(type);

export default function FilesPage({ initial, initialTotal, perPage, canUpload, canDelete }: Props) {
  const { t } = useT();
  const [files, setFiles] = useState(initial);
  const [total, setTotal] = useState(initialTotal);
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<FileListItem | null>(null);
  const [describing, setDescribing] = useState<FileListItem | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const load = async (next: number, search = query) => {
    try {
      const result = await api<{ items: FileListItem[]; totalItems: number }>(apiPath(`/files?page=${next}&perPage=${perPage}${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ""}`));
      setFiles(result.items);
      setTotal(result.totalItems);
      setPage(next);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const upload = async (chosen: FileList | null) => {
    if (!chosen?.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(chosen)) await uploadFile(file);
    } catch (err) {
      setError(errorText(err));
    }
    await load(1);
    setUploading(false);
  };

  const remove = async () => {
    if (!pending) return;
    try {
      await api(apiPath(`/files/${pending.id}`), { method: "DELETE" });
      await load(files.length === 1 && page > 1 ? page - 1 : page);
    } catch (err) {
      setError(errorText(err));
    }
    setPending(null);
  };

  return (
    <div className="cms-gutter">
      <PageHeader
        title={t("files.title")}
        description={t("files.description")}
        actions={canUpload ? (
          <label className={`cms-btn cms-btn-primary cms-btn-label ${uploading ? "cms-dimmed" : ""}`}>
            {uploading ? t("files.uploading") : t("files.upload")}
            <input type="file" multiple className="cms-sr-only" disabled={uploading} onChange={(e) => { void upload(e.target.files); e.target.value = ""; }} />
          </label>
        ) : undefined}
      />
      {error && <div className="cms-mb-4"><Alert>{error}</Alert></div>}
      <DataTable
        label={t("files.title")}
        columns={[{ id: "name", label: t("files.name") }, { id: "alt", label: t("files.alt") }, { id: "type", label: t("files.type") }, { id: "size", label: t("files.size"), numeric: true }, { id: "usedBy", label: t("files.usedBy") }]}
        rows={files.map((file) => ({
          id: file.id,
          cells: {
            name: (
              <span className="cms-inline-row cms-gap-3">
                {hasThumb(file.type)
                  // eslint-disable-next-line @next/next/no-img-element -- access-checked API URL, which next/image can't fetch with the viewer's session
                  ? <img src={apiPath(`/files/${file.id}?thumb=100x100&v=${file.size}`)} alt="" width={32} height={32} className="cms-cell-thumb" />
                  : <span className="cms-cell-thumb cms-thumb-empty" aria-hidden="true" />}
                <a className="cms-hover-underline cms-truncate" href={apiPath(`/files/${file.id}`)} target="_blank" rel="noreferrer">{file.name}</a>
              </span>
            ),
            alt: file.alt ? <span className="cms-truncate">{file.alt}</span> : <span className="cms-muted">{t("files.noAlt")}</span>,
            type: <span className="cms-mono cms-text-xs">{file.type}</span>,
            size: formatBytes(file.size),
            usedBy: file.usedBy ? <Badge tone="info">{t("files.uses", { count: file.usedBy })}</Badge> : <Badge>{t("files.uses", { count: 0 })}</Badge>,
          },
          actions: (
            <>
              <button type="button" className="cms-row-action" onClick={() => setDescribing(file)}>{t("files.describe")}</button>
              {canDelete && file.usedBy === 0 && <button type="button" className="cms-row-action cms-row-action-danger" onClick={() => setPending(file)}>{t("files.delete")}</button>}
            </>
          ),
        }))}
        toolbar={<Toolbar><SearchInput aria-label={t("files.search")} placeholder={t("files.search")} value={query} onChange={(e) => { setQuery(e.target.value); void load(1, e.target.value); }} /></Toolbar>}
        empty={{ icon: <PhotoIcon />, title: query.trim() ? t("grid.noMatches") : t("files.empty") }}
        footer={total > 0 ? <Pagination page={page} perPage={perPage} total={total} onPage={(next) => void load(next)} /> : undefined}
      />
      <DescribeFile file={describing} onClose={() => setDescribing(null)} onSaved={() => void load(page)} />
      <Modal open={pending !== null} onClose={() => setPending(null)} title={t("files.deleteTitle", { name: pending?.name ?? t("files.file") })}>
        <p className="cms-mb-4 cms-text-sm cms-body">{t("files.deleteBody")}</p>
        <div className="cms-flex cms-end cms-gap-2">
          <Button variant="secondary" onClick={() => setPending(null)}>{t("files.cancel")}</Button>
          <Button variant="danger" onClick={() => void remove()}>{t("files.deleteFile")}</Button>
        </div>
      </Modal>
    </div>
  );
}
