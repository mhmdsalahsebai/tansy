"use client";

import { useSchemaText, useT } from "../../../components/i18n";
import { useState, useEffect } from "react";
import { PlusIcon, RectangleStackIcon } from "@heroicons/react/24/outline";
import { Alert, Badge, Button, ButtonLink, DataTable, Modal, PageHeader, SearchInput, Toolbar } from "../../../components/ui/kit";
import { useRecordAccess } from "../../../components/admin-client";
import { api, errorText } from "../../../lib/client/api";
import { adminPath, apiPath } from "../../../lib/paths";

interface Collection {
  id: string;
  name: string;
  labels?: Record<string, string> | null;
  description: string;
  fields: Field[];
  createdAt: string;
  updatedAt: string;
  slug: string;
}

interface Field {
  name: string;
  type: string;
  required: boolean;
}

/** A plugin whose collections start with `prefix`, listed under its own heading. */
interface Owner { plugin: string; prefix: string; title: string }

/** `canCreate` and `canDelete` only decide what to offer: the routes check for themselves. */
export default function CollectionsPage({ owners = [], canCreate = false, canDelete = false }: { owners?: Owner[]; canCreate?: boolean; canDelete?: boolean }) {
  const { t, locale } = useT();
  const schemaText = useSchemaText();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCollections, setSelectedCollections] = useState<string[]>([]);

  const canRecords = useRecordAccess();
  const [tick, setTick] = useState(0);
  const fetchCollections = () => setTick((t) => t + 1);

  useEffect(() => {
    let active = true;
    api<Collection[]>(apiPath("/collections")).then(
      (data) => {
        if (!active) return;
        setCollections(data);
        setLoading(false);
      },
      (err) => {
        if (!active) return;
        setError(errorText(err));
        setLoading(false);
      },
    );
    return () => { active = false; };
  }, [tick]);

  const handleBulkDelete = async () => {
    if (!selectedCollections.length) return;

    try {
      await api(apiPath("/collections"), { method: "DELETE", body: { ids: selectedCollections } });
      setSelectedCollections([]);
      fetchCollections();
    } catch (err) {
      setError(err instanceof Error ? errorText(err) : t("collectionsPage.failed"));
    }
  };

  const ownerOf = (collection: Collection) => owners.find((owner) => collection.slug.startsWith(owner.prefix));
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [confirming, setConfirming] = useState(false);
  const term = query.trim().toLowerCase();
  const shown = collections.filter((collection) => {
    const owner = ownerOf(collection);
    if (source === "own" ? owner : source !== "all" && owner?.plugin !== source) return false;
    return !term || [schemaText.collection(collection), collection.slug, collection.description].some((text) => text?.toLowerCase().includes(term));
  });
  const sources = owners.filter((owner) => collections.some((collection) => ownerOf(collection) === owner));
  const opens = (collection: Collection) => canRecords("record:list", collection.id);

  return (
    <>
      <div className="cms-gutter">
        <PageHeader
          title={t("collectionsPage.title")}
          meta={!loading && <span>{t("grid.items", { count: collections.length })}</span>}
          actions={canCreate && <ButtonLink href={adminPath("/collections/create")}><PlusIcon className="cms-icon" aria-hidden="true" />{t("collectionsPage.create")}</ButtonLink>}
        />

        {error && <div className="cms-mb-4"><Alert>{error}</Alert></div>}

        <DataTable
          label={t("collectionsPage.title")}
          rows={loading ? null : shown.map((collection) => {
            const owner = ownerOf(collection);
            return {
              id: collection.id,
              href: opens(collection) ? adminPath(`/collections/${collection.id}`) : undefined,
              cells: {
                name: (
                  <span className="cms-stack-1">
                    <span className="cms-truncate">{schemaText.collection(collection)}</span>
                    {collection.description && <span className="cms-hint cms-truncate cms-max-md">{collection.description}</span>}
                  </span>
                ),
                source: owner ? <Badge tone="info">{owner.title}</Badge> : <Badge>{t("collectionsPage.yours")}</Badge>,
                fields: (
                  <span className="cms-tags" title={collection.fields.map((field) => field.name).join(", ")}>
                    {collection.fields.slice(0, 4).map((field) => <span key={field.name} className="cms-tag cms-mono">{field.name}</span>)}
                    {collection.fields.length > 4 && <span className="cms-cell-count">+{collection.fields.length - 4}</span>}
                  </span>
                ),
                createdAt: <span className="cms-nowrap">{new Date(collection.createdAt).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" })}</span>,
              },
            };
          })}
          columns={[
            { id: "name", label: t("collectionsPage.name") },
            ...(sources.length ? [{ id: "source", label: t("collectionsPage.source") }] : []),
            { id: "fields", label: t("collectionsPage.fields") },
            { id: "createdAt", label: t("collectionsPage.createdAt") },
          ]}
          selection={canDelete ? { selected: selectedCollections, onChange: (ids) => setSelectedCollections(ids as string[]) } : undefined}
          bulk={(
            <>
              <span>{t("grid.selectedCount", { count: selectedCollections.length })}</span>
              <button type="button" className="cms-row-action" onClick={() => setSelectedCollections([])}>{t("grid.clearSelection")}</button>
              <span className="cms-grow" />
              <Button variant="danger" onClick={() => setConfirming(true)}>{t("collectionsPage.deleteSelected", { count: selectedCollections.length })}</Button>
            </>
          )}
          toolbar={(
            <Toolbar>
              <SearchInput aria-label={t("collectionsPage.search")} placeholder={t("collectionsPage.search")} value={query} onChange={(event) => setQuery(event.target.value)} />
              {sources.length > 0 && (
                <select aria-label={t("collectionsPage.source")} className="cms-input cms-input-auto" value={source} onChange={(event) => setSource(event.target.value)}>
                  <option value="all">{t("collectionsPage.allSources")}</option>
                  <option value="own">{t("collectionsPage.yours")}</option>
                  {sources.map((owner) => <option key={owner.plugin} value={owner.plugin}>{owner.title}</option>)}
                </select>
              )}
            </Toolbar>
          )}
          empty={{
            icon: <RectangleStackIcon />,
            title: term || source !== "all" ? t("grid.noMatches") : t("collectionsPage.empty"),
            hint: term || source !== "all" ? t("grid.noMatchesHint") : t("collectionsPage.emptyHint"),
            action: !term && source === "all" && canCreate ? <ButtonLink href={adminPath("/collections/create")}><PlusIcon className="cms-icon" aria-hidden="true" />{t("collectionsPage.create")}</ButtonLink> : undefined,
          }}
        />
      </div>

      <Modal open={confirming} onClose={() => setConfirming(false)} title={t("collectionsPage.deleteSelected", { count: selectedCollections.length })}>
        <p className="cms-mb-4 cms-text-sm cms-body">{t("collectionsPage.deleteWarning")}</p>
        <div className="cms-flex cms-end cms-gap-2">
          <Button variant="secondary" onClick={() => setConfirming(false)}>{t("grid.cancel")}</Button>
          <Button variant="danger" onClick={() => { setConfirming(false); void handleBulkDelete(); }}>{t("grid.delete")}</Button>
        </div>
      </Modal>
    </>
  );
}
