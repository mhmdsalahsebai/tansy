import { route } from "../../../../../core/authz/guard";
import { fileScopeOf, presentFile, replaceFileBytes, requireFile } from "../../../../../core/files/service";
import { notFound } from "../../../../../core/http/errors";

/**
 * Replaces a file's bytes under its own id, so a corrected picture reaches every record, block
 * and address that already uses it, with no re-pointing and no second file to clean up.
 *
 * `file:update`, never the uploader alone: these bytes are already published wherever the file
 * is used, which is more than whoever uploaded it can see. The body is the raw bytes, as an
 * upload's is, so a large file streams to disk instead of being parsed in memory.
 */
export const PUT = route(
  { access: "permission", permission: "file:update", apiKey: true, audit: "file.replace" },
  async ({ request, params, auditTarget }) => {
    const file = await requireFile(params.id);
    // Every scope value can read the instance's shared files, so replacing one is the instance's own work.
    if (file.scope !== fileScopeOf()) throw notFound("File");
    const updated = await replaceFileBytes(file, request);
    auditTarget("file", file.id, { name: file.name, type: updated.type, size: updated.size, was: { type: file.type, size: file.size } });
    return presentFile(updated);
  },
);
