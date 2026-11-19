import { z } from "zod";
import { route } from "../../../../../core/authz/guard";
import { canDescribeFile, requireFile, setFileFocus } from "../../../../../core/files/service";
import { notFound } from "../../../../../core/http/errors";

/**
 * Where the subject of a picture is, so a thumbnail that has to crop keeps it instead of the
 * middle. Whoever may describe a file may place its focal point: the two say what the picture
 * is, not who may see it, and the uploader can already read their own (core/files/service.ts).
 */
const body = z.object({
  /** Whole percentages from the left and from the top. Null clears it, which means the middle. */
  focus: z.object({ x: z.number().int().min(0).max(100), y: z.number().int().min(0).max(100) }).nullable(),
});

export const PATCH = route(
  { access: "authenticated", apiKey: true, body, audit: "file.focus" },
  async ({ params, body, principal, auditTarget }) => {
    const file = await requireFile(params.id);
    // The same answer as a file that isn't there, so this can't be used to probe for ids.
    if (!canDescribeFile(file, principal)) throw notFound("File");
    auditTarget("file", file.id, { name: file.name, focus: body.focus });
    const updated = await setFileFocus(file, body.focus);
    return { focus: body.focus ? { x: updated.focusX, y: updated.focusY } : null };
  },
);
