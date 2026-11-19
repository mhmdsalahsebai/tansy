import { z } from "zod";
import { route } from "../../../../core/authz/guard";
import { presentFile, saveUpload } from "../../../../core/files/service";

const query = z.object({
  name: z.string().trim().min(1).max(1024),
  /** Set by form fields. The file is removed later if no record ever uses it. */
  temporary: z.enum(["true"]).optional(),
});

/** The body is the file's raw bytes, so large files stream to disk instead of being parsed in memory. */
export const POST = route(
  { access: "permission", permission: "file:create", apiKey: true, query, audit: "file.upload" },
  async ({ request, query, principal, auditTarget }) => {
    const file = await saveUpload(request, query.name, principal.user.id, query.temporary === "true");
    auditTarget("file", file.id, { name: file.name, type: file.type, size: file.size });
    return presentFile(file);
  },
);
