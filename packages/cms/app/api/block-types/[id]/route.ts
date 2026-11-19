import { z } from "zod";
import { labelsSchema } from "../../../../core/i18n/labels-schema";
import { route } from "../../../../core/authz/guard";
import { deleteBlockType, requireBlockType, updateBlockType } from "../../../../core/blocks/service";
import { parseId } from "../../../../core/content/ids";

const body = z.object({
  label: z.string().trim().min(1).max(200),
  /** The label in other interface languages, such as { "ar": "صورة" }. Left as it is when absent. */
  labels: labelsSchema(200).nullable().optional(),
  icon: z.string().trim().min(1).max(50).optional(),
  fields: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    type: z.string().min(1).max(40),
    config: z.record(z.string(), z.unknown()).optional(),
  })).max(100),
});

export const GET = route({ access: "permission", permission: "collection:read" }, async ({ params }) => requireBlockType(parseId(params.id)));

export const PUT = route(
  { access: "permission", permission: "collection:update", body, audit: "block_type.update", fresh: true },
  async ({ params, body, auditTarget }) => {
    const blockType = await updateBlockType(parseId(params.id), body);
    auditTarget("block_type", params.id, { name: blockType.name, version: blockType.version });
    return blockType;
  },
);

export const DELETE = route(
  { access: "permission", permission: "collection:delete", audit: "block_type.delete", fresh: true },
  async ({ params, auditTarget }) => {
    const name = await deleteBlockType(parseId(params.id));
    auditTarget("block_type", params.id, { name });
    return null;
  },
);
