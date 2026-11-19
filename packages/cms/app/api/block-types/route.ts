import { z } from "zod";
import { labelsSchema } from "../../../core/i18n/labels-schema";
import { route } from "../../../core/authz/guard";
import { createBlockType, listBlockTypes } from "../../../core/blocks/service";
import { blockNameSchema } from "../../../core/fields/builtin";

const body = z.object({
  name: blockNameSchema,
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

export const GET = route({ access: "permission", permission: "collection:read" }, async () => listBlockTypes());

export const POST = route(
  { access: "permission", permission: "collection:create", body, audit: "block_type.create", fresh: true },
  async ({ body, principal, auditTarget }) => {
    const blockType = await createBlockType(body, principal.user.id);
    auditTarget("block_type", String(blockType.id), { name: blockType.name });
    return blockType;
  },
);
