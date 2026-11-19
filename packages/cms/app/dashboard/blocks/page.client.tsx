"use client";

import { PlusIcon, Squares2X2Icon } from "@heroicons/react/24/outline";
import { useState } from "react";
import type { BlockLayoutInfo, BlockTypeInfo } from "../../../components/fields/types";
import { useSchemaText, useT } from "../../../components/i18n";
import { Alert, Button, ButtonLink, DataTable, Modal, PageHeader, SearchInput, Toolbar } from "../../../components/ui/kit";
import { api, errorText } from "../../../lib/client/api";
import { adminPath, apiPath } from "../../../lib/paths";

interface Props {
  initial: BlockTypeInfo[];
  initialLayouts: BlockLayoutInfo[];
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

export default function BlocksPage({ initial, initialLayouts, canCreate, canEdit, canDelete }: Props) {
  const { t } = useT();
  const schemaText = useSchemaText();
  const [query, setQuery] = useState("");
  const [blocks, setBlocks] = useState(initial);
  const [pending, setPending] = useState<BlockTypeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layouts, setLayouts] = useState(initialLayouts);

  const removeLayout = async (id: number) => {
    try {
      await api(apiPath(`/block-layouts/${id}`), { method: "DELETE" });
      setLayouts(layouts.filter((layout) => layout.id !== id));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const remove = async () => {
    if (!pending) return;
    try {
      await api(apiPath(`/block-types/${pending.id}`), { method: "DELETE" });
      setBlocks(blocks.filter((block) => block.id !== pending.id));
    } catch (err) {
      setError(errorText(err));
    }
    setPending(null);
  };

  return (
    <div className="cms-gutter">
      <PageHeader
        title={t("blocks.title")}
        description={t("blocks.description")}
        actions={canCreate ? <ButtonLink href={adminPath("/blocks/new")}><PlusIcon className="cms-icon" aria-hidden="true" />{t("blocks.newBlock")}</ButtonLink> : undefined}
      />
      {error && <div className="cms-mb-4"><Alert>{error}</Alert></div>}
      <div className="cms-stack-6">
        <DataTable
          label={t("blocks.title")}
          columns={[{ id: "label", label: t("blocks.label") }, { id: "name", label: t("blocks.name") }, { id: "fields", label: t("blocks.fields") }, { id: "version", label: t("blocks.version"), numeric: true }]}
          rows={blocks.filter((block) => !query.trim() || `${schemaText.block(block)} ${block.name}`.toLowerCase().includes(query.trim().toLowerCase())).map((block) => ({
            id: block.id,
            href: canEdit ? adminPath(`/blocks/${block.id}`) : undefined,
            cells: {
              label: schemaText.block(block),
              name: <span className="cms-mono">{block.name}</span>,
              fields: block.fields.length ? <span className="cms-tags">{block.fields.slice(0, 4).map((field) => <span key={field.name} className="cms-tag cms-mono">{field.name}</span>)}{block.fields.length > 4 && <span className="cms-cell-count">+{block.fields.length - 4}</span>}</span> : null,
              version: block.version,
            },
            actions: canDelete && !block.managedBy ? <button type="button" className="cms-row-action cms-row-action-danger" onClick={() => setPending(block)}>{t("blocks.delete")}</button> : undefined,
          }))}
          toolbar={<Toolbar><SearchInput aria-label={t("blocks.search")} placeholder={t("blocks.search")} value={query} onChange={(e) => setQuery(e.target.value)} /></Toolbar>}
          empty={{ icon: <Squares2X2Icon />, title: query.trim() ? t("grid.noMatches") : t("blocks.empty"), action: !query.trim() && canCreate ? <ButtonLink href={adminPath("/blocks/new")}><PlusIcon className="cms-icon" aria-hidden="true" />{t("blocks.newBlock")}</ButtonLink> : undefined }}
        />
        {layouts.length > 0 && (
          <DataTable
            label={t("blocks.savedLayouts")}
            columns={[{ id: "name", label: t("blocks.savedLayouts") }, { id: "count", label: t("blocks.fields") }]}
            rows={layouts.map((layout) => ({
              id: layout.id,
              cells: { name: layout.name, count: t("blocks.blockCount", { count: layout.blocks.length }) },
              actions: canDelete ? <button type="button" className="cms-row-action cms-row-action-danger" onClick={() => void removeLayout(layout.id)}>{t("blocks.delete")}</button> : undefined,
            }))}
            empty={{ title: "" }}
          />
        )}
      </div>
      <Modal open={pending !== null} onClose={() => setPending(null)} title={t("blocks.confirmDelete", { label: pending?.label ?? "" })}>
        <p className="cms-mb-4 cms-text-sm cms-body">{t("blocks.deleteExplained")}</p>
        <div className="cms-flex cms-end cms-gap-2">
          <Button variant="secondary" onClick={() => setPending(null)}>{t("blocks.cancel")}</Button>
          <Button variant="danger" onClick={() => void remove()}>{t("blocks.deleteBlock")}</Button>
        </div>
      </Modal>
    </div>
  );
}
