import { z } from "zod";
import { MAX_USER_FIELDS, listUserFields, saveUserFields } from "../../../core/auth/user-fields";
import { route } from "../../../core/authz/guard";

export const GET = route({ access: "permission", permission: "user:get" }, async () => listUserFields());

const body = z.object({
  fields: z.array(z.object({
    id: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(120),
    type: z.string().min(1).max(40),
    config: z.record(z.string(), z.unknown()).optional(),
    selfEditable: z.boolean().optional(),
  })).max(MAX_USER_FIELDS),
  confirm: z.boolean().default(false),
});

// Deciding what users can set on themselves is an access decision, so this takes the settings permission.
export const PUT = route(
  { access: "permission", permission: "setting:update", body, audit: "user_fields.update", fresh: true },
  async ({ body, auditTarget }) => {
    auditTarget("user_fields", "all", { fields: body.fields.map(({ name, type, selfEditable }) => ({ name, type, selfEditable: selfEditable === true })) });
    return saveUserFields(body.fields, body.confirm);
  },
);
