import { z } from "zod";
import { route } from "../../../../core/authz/guard";
import { parseId } from "../../../../core/content/ids";
import { deleteFieldPreset, updateFieldPreset } from "../../../../core/fields/presets";

const body = z.object({
  name: z.string().trim().min(1).max(100),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const PUT = route(
  { access: "permission", permission: "collection:update", body, audit: "field_preset.update", fresh: true },
  async ({ params, body, auditTarget }) => {
    const preset = await updateFieldPreset(parseId(params.id), body);
    auditTarget("field_preset", params.id, { name: preset.name });
    return preset;
  },
);

export const DELETE = route(
  { access: "permission", permission: "collection:delete", audit: "field_preset.delete", fresh: true },
  async ({ params, auditTarget }) => {
    const name = await deleteFieldPreset(parseId(params.id));
    auditTarget("field_preset", params.id, { name });
    return null;
  },
);
