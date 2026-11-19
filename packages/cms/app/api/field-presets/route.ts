import { z } from "zod";
import { route } from "../../../core/authz/guard";
import { createFieldPreset, listFieldPresets } from "../../../core/fields/presets";

const body = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.string().min(1).max(40),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const GET = route({ access: "permission", permission: "collection:read" }, async () => listFieldPresets());

export const POST = route(
  { access: "permission", permission: "collection:create", body, audit: "field_preset.create", fresh: true },
  async ({ body, principal, auditTarget }) => {
    const preset = await createFieldPreset(body, principal.user.id);
    auditTarget("field_preset", String(preset.id), { name: preset.name, type: preset.type });
    return preset;
  },
);
