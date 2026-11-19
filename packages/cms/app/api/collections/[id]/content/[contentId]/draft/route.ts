import { z } from "zod";
import { route } from "../../../../../../../core/authz/guard";
import { discardDraft, getDraft, requireRecord, saveDraft } from "../../../../../../../core/content/revisions";
import { versionStamp } from "../../../../../../../core/content/records";
import { fileActor } from "../../../../../../../core/files/refs";

const body = z.object({
  values: z.array(z.object({ fieldId: z.number().int().positive(), value: z.unknown() })).max(500),
  expectedUpdatedAt: versionStamp.optional(),
  /** The draft this save replaces, or null when the editor loaded none. */
  expectedDraftAt: versionStamp.nullable().optional(),
});

export const GET = route({ access: "permission", permission: "record:read", scope: "record", apiKey: true }, async ({ params, principal, request }) => {
  const { collection, item } = await requireRecord(params, principal, request, "view");
  return getDraft(collection, item.id);
});

export const PUT = route(
  { access: "permission", permission: ["record:read", "record:update"], scope: "record", apiKey: true, body, audit: "record.draft_save" },
  async ({ params, body, principal, request, auditTarget }) => {
    const { collection, item } = await requireRecord(params, principal, request, "update");
    auditTarget("record", String(item.id), { collection: collection.slug });
    await saveDraft(collection, item, body, fileActor(principal), { updatedAt: body.expectedUpdatedAt, draftAt: body.expectedDraftAt });
    return getDraft(collection, item.id);
  },
);

export const DELETE = route(
  { access: "permission", permission: "record:update", scope: "record", apiKey: true, audit: "record.draft_discard" },
  async ({ params, principal, request, auditTarget }) => {
    const { collection, item } = await requireRecord(params, principal, request, "update");
    auditTarget("record", String(item.id), { collection: collection.slug });
    await discardDraft(collection, item.id);
    return null;
  },
);
