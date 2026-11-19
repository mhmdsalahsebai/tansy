"use client";

import { InboxIcon, PaperClipIcon, PlusIcon, ViewColumnsIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { cn } from "../../../../lib/utils";
import { useEffect, useState, createElement } from "react";
import { FilterBuilder } from "../../../../components/collections/FilterBuilder";
import type { FieldTypeInfo } from "../../../../components/fields/types";
import { Alert, Badge, Button, ButtonLink, DataTable, Modal, PageHeader, Pagination, SearchInput, Toolbar, type DataColumn, type DataRow } from "../../../../components/ui/kit";
import { isRichDoc, plainText } from "../../../../core/fields/rich-text";
import { useAdminClient, useAdminSlots } from "../../../../components/admin-client";
import { PluginBoundary, runPluginAction } from "../../../../components/PluginBoundary";
import { api, errorText } from "../../../../lib/client/api";
import { useRealtime } from "../../../../lib/client/realtime";
import type { Collection, Field } from "../../../../types/content";
import { adminPath, apiPath } from "../../../../lib/paths";
import type { ReactNode } from "react";
import { TranslationExchange } from "../../../../components/collections/TranslationExchange";
import { useFieldText, usePluginWord, useSchemaText, useT } from "../../../../components/i18n";

type Row = Record<string, unknown> & { id: number; status: string; updatedAt: string | null; summaries?: Record<string, string>; translations?: Array<{ locale: string; status: string; outdated: boolean }> };
interface Language { code: string; label: string }
interface Page { totalItems: number; items: Row[] }

const PER_PAGE = 25;
const DEFAULT_COLUMNS = 4;
const SHORT = 80;
const UNSORTABLE = new Set(["json", "richtext", "stream", "multiselect"]);

const shorten = (text: string) => (text.length > SHORT ? `${text.slice(0, SHORT)}…` : text);

function cellText(input: string | undefined, value: unknown, t: ReturnType<typeof useT>["t"], locale: string) {
  if (value === null || value === undefined || value === "") return "—";
  if (input === "stream" && Array.isArray(value)) return t("grid.blocks", { count: value.length });
  if (isRichDoc(value)) return shorten(plainText(value)) || "—";
  if (input === "datetime") return new Date(value as string).toLocaleString(locale);
  if (typeof value === "boolean") return value ? t("grid.yes") : t("grid.no");
  return shorten(typeof value === "object" ? JSON.stringify(value) : String(value));
}

const isEmpty = (value: unknown) => value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
const MAX_TAGS = 3;

/** A grid cell drawn for its field's input: images as thumbnails, choices as tags, yes or no as a dot. */
function cellValue(input: string | undefined, value: unknown, t: ReturnType<typeof useT>["t"], locale: string): ReactNode {
  if (isEmpty(value)) return <span className="cms-cell-empty">—</span>;
  if (typeof value === "boolean") return <span className={value ? "cms-bool cms-bool-yes" : "cms-bool"}><span className={value ? "cms-dot cms-dot-success" : "cms-dot"} aria-hidden="true" />{value ? t("grid.yes") : t("grid.no")}</span>;
  if ((input === "image" || input === "gallery") && (typeof value === "string" || Array.isArray(value))) {
    const ids = (Array.isArray(value) ? value : [value]).filter((id): id is string => typeof id === "string");
    if (ids.length) {
      return (
        <span className="cms-cell-media">
          <img src={apiPath(`/files/${encodeURIComponent(ids[0])}?thumb=100x100`)} alt="" width={32} height={32} loading="lazy" className="cms-cell-thumb" />
          {ids.length > 1 && <span className="cms-cell-count">+{ids.length - 1}</span>}
        </span>
      );
    }
  }
  if (input === "file" || input === "gallery") {
    const count = Array.isArray(value) ? value.length : 1;
    return <span className="cms-cell-media cms-soft"><PaperClipIcon className="cms-icon-xs" aria-hidden="true" />{t("grid.files", { count })}</span>;
  }
  if (input === "select" && typeof value === "string") return <span className="cms-tag">{shorten(value)}</span>;
  if (Array.isArray(value) && value.every((item) => typeof item === "string" || typeof item === "number")) {
    const shown = value.slice(0, MAX_TAGS);
    return (
      <span className="cms-tags">
        {shown.map((item, index) => <span key={index} className="cms-tag">{input === "reference" ? `#${item}` : shorten(String(item))}</span>)}
        {value.length > MAX_TAGS && <span className="cms-cell-count">+{value.length - MAX_TAGS}</span>}
      </span>
    );
  }
  if (input === "reference" && typeof value === "number") return <span className="cms-tag">#{value}</span>;
  if (input === "date" && typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(locale, { timeZone: "UTC" });
  }
  if (input === "json" && typeof value === "object") return <span className="cms-mono cms-text-xs cms-faded">{Array.isArray(value) ? t("grid.items", { count: value.length }) : "{…}"}</span>;
  return cellText(input, value, t, locale);
}

interface Props {
  collection: Collection;
  fieldTypes: FieldTypeInfo[];
  canCreate: boolean;
  canDelete: boolean;
  /** Offers the links to pages the person may open: the fields or the view's query, and the API rules. */
  canEditSchema?: boolean;
  canEditRules?: boolean;
  /** Where a row opens, under the admin path, with `:id` for the record's id. The record editor when left out. */
  recordPath?: string;
  /** Always applied, alongside the filters the person picks. */
  baseFilter?: string;
  title?: string;
  description?: string;
  /** Replaces the button that opens the new-record form. */
  createAction?: ReactNode;
}

export default function CollectionPage({ collection, fieldTypes, canCreate, canDelete, canEditSchema = false, canEditRules = false, recordPath, baseFilter, title, description, createAction }: Props) {
  const { fieldAdmin } = useAdminClient();
  const { t, locale } = useT();
  const schemaText = useSchemaText();
  const word = usePluginWord();
  const { label: fieldLabel } = useFieldText();
  const { gridColumns, recordActions, bulkActions } = useAdminSlots(collection.slug);
  const slotCollection = { id: collection.id, slug: collection.slug, name: collection.name };
  const refresh = () => setTick((value) => value + 1);
  const inputOf = (field: Field) => fieldTypes.find((type) => type.type === field.type)?.input;
  const columnsKey = `cms:columns:${collection.slug}`;
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("-updatedAt");
  const [filter, setFilter] = useState("");
  const [search, setSearch] = useState("");
  // The search index covers fields marked searchable. Without any, or on a view, which has no index, search looks inside the text fields.
  const indexed = collection.type !== "view" && collection.fields.some((field) => field.config?.searchable && !field.config?.hidden);
  const textFields = collection.fields.filter((field) => !field.config?.hidden && ["text", "email", "url"].includes(inputOf(field) ?? "")).map((field) => field.name);
  const canSearch = indexed || textFields.length > 0;
  // Long text makes a poor column, so the defaults are the first short fields.
  const [columns, setColumnsState] = useState(() => collection.fields.filter((field) => !UNSORTABLE.has(inputOf(field) ?? "") && !field.config?.hidden).slice(0, DEFAULT_COLUMNS).map((field) => field.name));
  const setColumns = (next: string[]) => {
    setColumnsState(next);
    try { localStorage.setItem(columnsKey, JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
  };
  // The columns someone picked come back on their next visit. Read after mount, so the server and browser render alike.
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(columnsKey) ?? "null");
        if (Array.isArray(saved)) setColumnsState(saved.filter((name): name is string => typeof name === "string" && collection.fields.some((field) => field.name === name)));
      } catch { /* Storage may be unavailable or hold something else. */ }
    });
    return () => clearTimeout(timer);
  }, [columnsKey, collection.fields]);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [pending, setPending] = useState<number[] | null>(null);
  const [tick, setTick] = useState(0);
  const localized = collection.localization?.enabled === true;
  const [languages, setLanguages] = useState<{ defaultLocale: string; locales: Language[] } | null>(null);
  const [translationFilter, setTranslationFilter] = useState("");
  useEffect(() => {
    if (!localized) return;
    api<{ localization: { defaultLocale: string; locales: Language[] } | null }>(apiPath(`/collections/${collection.id}/localization`)).then((result) => setLanguages(result.localization), () => setLanguages(null));
  }, [localized, collection.id]);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ page: String(page), perPage: String(PER_PAGE), sort, summaries: "1" });
    const term = search.trim();
    const contains = term && !indexed ? `(${textFields.map((name) => `${name} ~ "${term.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(" || ")})` : "";
    const where = [baseFilter && `(${baseFilter})`, filter && `(${filter})`, contains].filter(Boolean).join(" && ");
    if (where) query.set("filter", where);
    if (term && indexed) query.set("search", term);
    if (localized) query.set("translations", "1");
    if (translationFilter) query.set("translation", translationFilter);
    api<Page>(apiPath(`/collections/${collection.slug}/records?${query}`)).then(
      (result) => { if (active) { setData(result); setError(null); setSelected([]); } },
      (err) => { if (active) setError(errorText(err)); },
    );
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- textFields and indexed follow the collection.
  }, [collection.slug, page, sort, baseFilter, filter, search, tick, localized, translationFilter]);

  const isView = collection.type === "view";
  useRealtime(isView ? null : `${collection.slug}/*`, () => setTick((value) => value + 1));

  const removeRecords = async () => {
    if (!pending) return;
    const failures: string[] = [];
    for (const id of pending) {
      await api(apiPath(`/collections/${collection.id}/content/${id}`), { method: "DELETE" }).catch((err) => failures.push(`#${id}: ${errorText(err)}`));
    }
    setPending(null);
    setTick((value) => value + 1);
    if (failures.length) setError(failures.join("\n"));
  };

  const visible = collection.fields.filter((field) => columns.includes(field.name));
  const items = data?.items ?? [];
  const recordHref = (item: Row) => adminPath(recordPath ? recordPath.replaceAll(":id", String(item.id)) : `/collections/${collection.id}/content/${item.id}`);
  const newRecord = createAction ?? (canCreate && !isView ? (
    <ButtonLink href={adminPath(`/collections/${collection.id}/content/new`)}>
      <PlusIcon className="cms-icon" aria-hidden="true" />{t("grid.newItem")}
    </ButtonLink>
  ) : undefined);
  const cellOf = (field: Field, item: Row) => {
    const admin = fieldAdmin.find((definition) => definition.type === field.type);
    return admin?.Cell ? <PluginBoundary plugin={admin.plugin}>{createElement(admin.Cell, { value: item[field.name] })}</PluginBoundary> : (item.summaries?.[field.name] || cellValue(inputOf(field), item[field.name], t, locale));
  };

  const showLanguages = Boolean(languages && languages.locales.length > 1);
  const columns_: DataColumn[] = [
    ...visible.map((field) => ({ id: field.name, label: fieldLabel(field), sortable: !UNSORTABLE.has(inputOf(field) ?? ""), numeric: inputOf(field) === "number" })),
    ...gridColumns.map((column) => ({ id: `slot:${column.id}`, label: word(column.plugin, `columns.${column.id}`, column.title) })),
    { id: "status", label: t("grid.status"), sortable: true },
    ...(showLanguages ? [{ id: "languages", label: t("grid.languages") }] : []),
    { id: "updatedAt", label: t("grid.updated"), sortable: true },
  ];
  // Without a field shown, the row's title is its id, so every row still has something to open.
  if (!visible.length) columns_.unshift({ id: "id", label: "#", sortable: true });
  const rows: DataRow[] = items.map((item) => ({
    id: item.id,
    href: isView ? undefined : recordHref(item),
    cells: {
      id: `#${item.id}`,
      ...Object.fromEntries(visible.map((field) => [field.name, cellOf(field, item)])),
      ...Object.fromEntries(gridColumns.map((column) => [`slot:${column.id}`, <PluginBoundary key={column.id} plugin={column.plugin}>{createElement(column.component, { collection: slotCollection, record: item })}</PluginBoundary>])),
      status: <Badge tone={item.status === "published" ? "success" : "warning"}>{item.status === "published" || item.status === "draft" ? t(`editor.status.${item.status}`) : item.status}</Badge>,
      languages: showLanguages && languages ? (
        <span className="cms-tags" data-no-open>
          {languages.locales.map((language) => {
            const translation = item.translations?.find((entry) => entry.locale === language.code);
            const state = !translation ? "missing" : translation.outdated ? "outdated" : translation.status;
            const tone = state === "published" ? "success" : state === "draft" ? "warning" : state === "outdated" ? "danger" : "info";
            return (
              <Badge key={language.code} tight tone={tone} className="cms-upper" href={`${recordHref(item)}?locale=${encodeURIComponent(language.code)}`} title={`${language.label}: ${t(`editorLanguages.states.${state as "missing" | "draft" | "published" | "outdated"}`)}`}>
                {language.code}{state === "missing" ? " –" : state === "outdated" ? " !" : ""}
              </Badge>
            );
          })}
        </span>
      ) : null,
      updatedAt: item.updatedAt ? <span className="cms-nowrap" title={new Date(item.updatedAt).toLocaleString(locale)}>{new Date(item.updatedAt).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" })}</span> : null,
    },
    actions: recordActions.length || canDelete ? (
      <>
        {recordActions.map((action) => <button key={action.id} type="button" className="cms-row-action" onClick={() => void runPluginAction(action.plugin, () => action.run({ collection: slotCollection, record: item, refresh }), () => setError(t("pluginErrors.couldntFinish", { plugin: action.plugin })))}>{word(action.plugin, `actions.${action.id}`, action.label)}</button>)}
        {canDelete && <button type="button" className="cms-row-action cms-row-action-danger" onClick={() => setPending([item.id])}>{t("grid.delete")}</button>}
      </>
    ) : undefined,
  }));

  return (
    <>
      <div className="cms-gutter">
        <PageHeader
          title={title ?? schemaText.collection(collection)}
          description={description}
          meta={(
            <>
              {data && <span>{t("grid.items", { count: data.totalItems })}</span>}
              {canEditSchema && (isView
                ? <Link className="cms-link-quiet" href={adminPath(`/collections/${collection.id}/view`)}>{t("grid.editQuery")}</Link>
                : <Link className="cms-link-quiet" href={adminPath(`/collections/${collection.id}/schema`)}>{t("grid.editFields")}</Link>)}
              {canEditRules && <Link className="cms-link-quiet" href={adminPath(`/collections/${collection.id}/rules`)}>{t("grid.apiRules")}</Link>}
              {canCreate && !isView && <Link className="cms-link-quiet" href={adminPath(`/collections/${collection.id}/import`)}>{t("grid.import")}</Link>}
            </>
          )}
          actions={newRecord}
        />

        {error && <div className="cms-mb-4"><Alert>{error}</Alert></div>}

        <DataTable
          label={title ?? schemaText.collection(collection)}
          testId="record-grid"
          columns={columns_}
          rows={data ? rows : null}
          sort={{ value: sort, onChange: (value) => { setPage(1); setSort(value); } }}
          selection={canDelete ? { selected, onChange: (ids) => setSelected(ids as number[]) } : undefined}
          toolbar={(
            <Toolbar end={(
              <>
                {languages && languages.locales.length > 1 && <TranslationExchange collectionId={collection.id} defaultLocale={languages.defaultLocale} locales={languages.locales} selected={selected} onImported={refresh} />}
                <details className="cms-relative">
                  <summary className="cms-btn cms-btn-secondary"><ViewColumnsIcon className="cms-icon" aria-hidden="true" />{t("grid.columns")}</summary>
                  <div className="cms-popover cms-popover-menu cms-scroll-96">
                    {collection.fields.map((field) => (
                      <label key={field.id} className="cms-check-label">
                        <input type="checkbox" className="cms-check" checked={columns.includes(field.name)} onChange={(e) => setColumns(e.target.checked ? [...columns, field.name] : columns.filter((name) => name !== field.name))} />
                        {fieldLabel(field)}
                      </label>
                    ))}
                  </div>
                </details>
              </>
            )}>
              {canSearch && <SearchInput aria-label={t("grid.search")} placeholder={t("grid.search")} value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} />}
              <FilterBuilder fields={collection.fields} fieldTypes={fieldTypes} onChange={(next) => { setPage(1); setFilter(next); }} />
              {languages && languages.locales.length > 1 && (
                <select aria-label={t("grid.translation")} className="cms-input cms-input-auto" value={translationFilter} onChange={(e) => { setPage(1); setTranslationFilter(e.target.value); }}>
                  <option value="">{t("grid.everyTranslation")}</option>
                  {languages.locales.filter((language) => language.code !== languages.defaultLocale).flatMap((language) => [
                    <option key={`${language.code}:missing`} value={`${language.code}:missing`}>{t("grid.missingIn", { language: language.label })}</option>,
                    <option key={`${language.code}:draft`} value={`${language.code}:draft`}>{t("grid.draftIn", { language: language.label })}</option>,
                    <option key={`${language.code}:published`} value={`${language.code}:published`}>{t("grid.publishedIn", { language: language.label })}</option>,
                  ])}
                </select>
              )}
            </Toolbar>
          )}
          bulk={(
            <>
              <span>{t("grid.selectedCount", { count: selected.length })}</span>
              <button type="button" className="cms-row-action" onClick={() => setSelected([])}>{t("grid.clearSelection")}</button>
              <span className="cms-grow" />
              {bulkActions.map((action) => <Button key={action.id} variant="secondary" onClick={() => void runPluginAction(action.plugin, () => action.run({ collection: slotCollection, ids: selected, refresh }), () => setError(t("pluginErrors.couldntFinish", { plugin: action.plugin })))}>{word(action.plugin, `actions.${action.id}`, action.label)}</Button>)}
              {canDelete && <Button variant="danger" onClick={() => setPending(selected)}>{t("grid.deleteCount", { count: selected.length })}</Button>}
            </>
          )}
          empty={{
            icon: <InboxIcon />,
            title: filter || search || translationFilter ? t("grid.noMatches") : t("grid.empty"),
            hint: filter || search || translationFilter ? t("grid.noMatchesHint") : t("grid.emptyHint"),
            action: !(filter || search || translationFilter) ? newRecord : undefined,
          }}
          footer={data && data.totalItems > 0 ? <Pagination page={page} perPage={PER_PAGE} total={data.totalItems} onPage={setPage} /> : undefined}
        />
      </div>

      <Modal open={pending !== null} onClose={() => setPending(null)} title={pending?.length === 1 ? t("grid.deleteOne") : t("grid.deleteMany", { count: pending?.length ?? 0 })}>
        <p className="cms-mb-4 cms-text-sm cms-body">{t("grid.cannotUndo")}</p>
        <div className="cms-flex cms-end cms-gap-2">
          <Button variant="secondary" onClick={() => setPending(null)}>{t("grid.cancel")}</Button>
          <Button variant="danger" onClick={() => void removeRecords()}>{t("grid.delete")}</Button>
        </div>
      </Modal>
    </>
  );
}
