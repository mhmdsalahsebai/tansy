import { z } from "zod";
import { route } from "../../../../core/authz/guard";
import { parseId } from "../../../../core/content/ids";
import { deleteRedirect, updateRedirect } from "../../../../core/urls/redirects";

const body = z.object({
  from: z.string().trim().min(1).max(2048).optional(),
  to: z.string().trim().min(1).max(2048).optional(),
  status: z.literal([301, 302, 307, 308]).optional(),
});

export const PATCH = route(
  { access: "permission", permission: "redirect:manage", body, audit: "redirect.update" },
  async ({ params, body, auditTarget }) => {
    const redirect = await updateRedirect(parseId(params.id), body);
    auditTarget("redirect", String(redirect.id), { from: redirect.from, to: redirect.to });
    return redirect;
  },
);

export const DELETE = route(
  { access: "permission", permission: "redirect:manage", audit: "redirect.delete" },
  async ({ params, auditTarget }) => {
    auditTarget("redirect", params.id);
    await deleteRedirect(parseId(params.id));
    return null;
  },
);
