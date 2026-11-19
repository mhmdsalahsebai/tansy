import { z } from "zod";
import { route } from "../../../../../core/authz/guard";
import { holdsRecordPermission } from "../../../../../core/authz/permissions";
import { requireCollection } from "../../../../../core/content/access";
import { assertWritable } from "../../../../../core/content/content-service";
import { parseId } from "../../../../../core/content/ids";
import { importableFields, importRecords, previewImport, MAX_IMPORT_ROWS } from "../../../../../core/content/import";
import { fileActor } from "../../../../../core/files/refs";
import { localeParams, writingLocale } from "../../../../../core/i18n/request";

const body = z.object({
  csv: z.string().max(8 * 1024 * 1024).optional(),
  rows: z.array(z.record(z.string().max(200), z.unknown())).max(MAX_IMPORT_ROWS).optional(),
  mapping: z.record(z.string().max(200), z.string().max(63)).optional(),
  keyField: z.string().max(63).optional(),
  status: z.enum(["draft", "published"]).optional(),
  dryRun: z.boolean().optional(),
  /** Read the file and answer with its columns and first rows, without checking or writing anything. */
  preview: z.boolean().optional(),
  onError: z.enum(["stop", "skip"]).optional(),
});

/** The fields rows can fill, for the dashboard's column mapping. */
export const GET = route(
  { access: "permission", permission: "record:create", scope: "collection" },
  async ({ params }) => {
    const collection = await requireCollection(parseId(params.id));
    assertWritable(collection);
    return { fields: importableFields(collection), maxRows: MAX_IMPORT_ROWS };
  },
);

/**
 * Brings records in from a CSV file or a list of rows. Needs `record:create` for the collection,
 * and `record:update` as well to match and update existing records through `keyField`. Each row
 * is written as a save would be, so validation, hooks, history, search and the review gate all
 * apply; `dryRun` checks every row and writes nothing. `?locale=` imports one language.
 */
export const POST = route(
  { access: "permission", permission: "record:create", scope: "collection", apiKey: true, body, audit: "record.import", maxBodyBytes: 12 * 1024 * 1024 },
  async ({ params, body, principal, request, auditTarget }) => {
    const { collection } = await writingLocale(await requireCollection(parseId(params.id)), principal, localeParams(request));
    assertWritable(collection);
    if (body.preview) return previewImport(collection, body);
    const canUpdate = holdsRecordPermission(principal.permissions, "record:update", collection.id);
    const result = await importRecords(collection, body, principal.user.id, fileActor(principal), canUpdate);
    auditTarget("collection", String(collection.id), { collection: collection.slug, dryRun: result.dryRun, created: result.created, updated: result.updated, failed: result.failed });
    return result;
  },
);
