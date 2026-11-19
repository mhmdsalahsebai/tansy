"use client";

import { useEffect, useState } from "react";
import { api, useApi } from "../../lib/client/api";
import { apiPath } from "../../lib/paths";
import { useT } from "../i18n";

interface Props {
  id: string;
  /** The linked collection's id, from the field's config. */
  collectionId: number;
  multiple: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
  inputClass: string;
}

interface Target { slug: string; fields: Array<{ name: string; type: string; config?: { hidden?: boolean } | null }> }
type Row = Record<string, unknown> & { id: number };

const TEXT_TYPES = new Set(["text", "email", "url"]);
type T = ReturnType<typeof useT>["t"];
const labelOf = (t: T, row: Row, field: string | undefined) => (field && row[field] ? t("pickers.recordLabel", { label: String(row[field]), id: row.id }) : t("pickers.record", { id: row.id }));

function Selected({ slug, recordId, labelField, onRemove }: { slug: string; recordId: number; labelField?: string; onRemove: () => void }) {
  const { t } = useT();
  const { data, error } = useApi<Row>(apiPath(`/collections/${slug}/records/${recordId}`));
  return (
    <li className="cms-list-row">
      <span className="cms-min-0 cms-truncate cms-strong">{data ? labelOf(t, data, labelField) : error ? t("pickers.recordUnavailable", { id: recordId }) : t("pickers.record", { id: recordId })}</span>
      <button type="button" className="cms-danger" onClick={onRemove}>{t("pickers.remove")}</button>
    </li>
  );
}

/** Lists records through the public read API, so a person only ever sees the ones the rules let them read. */
export default function ReferencePicker({ id, collectionId, multiple, value, onChange, inputClass }: Props) {
  const { t } = useT();
  const { data: target, error: targetError } = useApi<Target>(apiPath(`/collections/${collectionId}`));
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Row[]>([]);
  const [failed, setFailed] = useState(false);

  const labelField = target?.fields.find((field) => TEXT_TYPES.has(field.type) && !field.config?.hidden)?.name;
  const selected = (Array.isArray(value) ? value : value ? [value] : []) as number[];

  useEffect(() => {
    if (!target || !open) return;
    let active = true;
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ perPage: "20", sort: "-updatedAt", skipTotal: "true" });
      const term = search.replace(/["\\]/g, "").trim();
      if (term && labelField) query.set("filter", `${labelField} ~ "${term}"`);
      api<{ items: Row[] }>(apiPath(`/collections/${target.slug}/records?${query}`)).then(
        (page) => { if (active) { setResults(page.items); setFailed(false); } },
        () => { if (active) setFailed(true); },
      );
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [target, open, search, labelField]);

  const pick = (recordId: number) => {
    onChange(multiple ? [...selected, recordId] : recordId);
    setSearch("");
    setOpen(false);
  };
  const remove = (recordId: number) => {
    const rest = selected.filter((item) => item !== recordId);
    onChange(multiple && rest.length ? rest : "");
  };

  // Without access to the linked collection there is nothing to list, so ids can still be typed.
  if (targetError || failed) {
    return (
      <div>
        <input id={id} type="text" inputMode="numeric" placeholder={multiple ? t("pickers.idsPlaceholder") : t("pickers.idPlaceholder")} className={inputClass} defaultValue={selected.join(", ")}
          onChange={(e) => {
            const ids = e.target.value.split(",").map((part) => Number(part.trim())).filter((n) => Number.isInteger(n) && n > 0);
            onChange(multiple ? (ids.length ? ids : "") : (ids[0] ?? ""));
          }} />
        <p className="cms-muted cms-mt-1">{t("pickers.notListable")}</p>
      </div>
    );
  }

  const choices = results.filter((row) => !selected.includes(row.id));
  return (
    <div className="cms-mt-1 cms-stack-2">
      {target && selected.length > 0 && (
        <ul className="cms-stack-2">
          {selected.map((recordId) => <Selected key={recordId} slug={target.slug} recordId={recordId} labelField={labelField} onRemove={() => remove(recordId)} />)}
        </ul>
      )}
      {(multiple || selected.length === 0) && (
        <div className="cms-relative">
          <input id={id} type="search" autoComplete="off" placeholder={t("pickers.searchRecords")} className={inputClass} value={search}
            onChange={(e) => setSearch(e.target.value)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} />
          {open && (
            <ul className="cms-popover cms-popover-list">
              {choices.map((row) => (
                <li key={row.id}>
                  {/* mousedown fires before the input's blur closes this list. */}
                  <button type="button" className="cms-menu-item" onMouseDown={(e) => { e.preventDefault(); pick(row.id); }}>{labelOf(t, row, labelField)}</button>
                </li>
              ))}
              {choices.length === 0 && <li className="cms-cell-tight cms-faded">{t("pickers.noRecords")}</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
