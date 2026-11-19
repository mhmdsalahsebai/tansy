import { z } from "zod";
import { route } from "../../../../core/authz/guard";
import { HttpError } from "../../../../core/http/errors";
import { applySchema, planImport, schemaDocument } from "../../../../core/schema/portable";

const body = z.object({
  document: schemaDocument,
  dryRun: z.boolean().default(false),
  deleteMissing: z.boolean().default(false),
  confirm: z.boolean().default(false),
});

// An import can do anything the schema screens can, so it needs each permission its own changes would need.
export const POST = route(
  { access: "permission", permission: "collection:update", body, audit: "schema.import", fresh: true, maxBodyBytes: 8 * 1024 * 1024 },
  async ({ body, principal, auditTarget }) => {
    const { steps, required } = await planImport(body.document, { deleteMissing: body.deleteMissing });
    const missing = required.filter((permission) => !principal.permissions.has(permission));
    if (missing.length) throw new HttpError(403, "FORBIDDEN", `This import also needs: ${missing.join(", ")}.`);
    auditTarget("schema", "import", { dryRun: body.dryRun, deleteMissing: body.deleteMissing, steps: steps.length });
    if (body.dryRun) return { dryRun: true, steps };
    return { dryRun: false, steps: await applySchema(body.document, { actorId: principal.user.id, confirm: body.confirm, deleteMissing: body.deleteMissing }) };
  },
);
