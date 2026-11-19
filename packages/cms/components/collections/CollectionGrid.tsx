import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requirePage } from "../../core/authz/page";
import { holdsRecordPermissionForSome, type RecordPermission } from "../../core/authz/permissions";
import { requireCollectionBySlug } from "../../core/content/access";
import { hasRecords } from "../../core/content/content-service";
import { loadSchema } from "../../app/dashboard/collections/[id]/load";
import type ClientType from "../../app/dashboard/collections/[id]/page.client";
import { clientPage } from "../../routes/client-page";

const Client = clientPage<typeof ClientType>("collections/[id]");

export interface CollectionGridProps {
  /** The collection's slug. */
  collection: string;
  /** Where a row opens, under the admin path, with `:id` for the record's id, such as "/ext/lms/courses/:id". The record editor when left out. */
  recordPath?: string;
  /** Narrows the list for everyone, alongside the filters the person picks. Only a view: the API rules still decide what each person may read. */
  filter?: string;
  /** The collection's name when left out. */
  title?: string;
  description?: string;
  /** Replaces the button that opens the new-record form, such as one that opens the plugin's own editor. Shown to everyone who may open the page. */
  createAction?: ReactNode;
}

/**
 * A collection's record grid, the one on its page under Collections, with its search, filters,
 * columns, sorting, bulk actions and paging, for a plugin page to show instead of a table of its own.
 * It checks the same permissions that page does, and loads records through the guarded API.
 */
export async function CollectionGrid({ collection: slug, recordPath, filter, title, description, createAction }: CollectionGridProps) {
  const { id } = await requireCollectionBySlug(slug).catch(() => notFound());
  const principal = await requirePage({ collection: id, own: true }, "collection:read", "record:list");
  const { collection, catalog } = await loadSchema(String(id));
  const can = (permission: RecordPermission) => holdsRecordPermissionForSome(principal.permissions, permission, collection.id);
  const singleton = collection.type === "singleton";
  const full = singleton && await hasRecords(collection.slug);
  const canCreate = !full && can("record:create");
  return <Client collection={collection} fieldTypes={catalog.fieldTypes} canCreate={canCreate} canDelete={!singleton && collection.type !== "view" && can("record:delete")}
    canEditSchema={principal.permissions.has(collection.type === "view" ? "collection:manage-views" : "collection:update")}
    canEditRules={principal.permissions.has("collection:manage-rules")}
    recordPath={recordPath} baseFilter={filter} title={title} description={description} createAction={canCreate ? createAction : undefined} />;
}
