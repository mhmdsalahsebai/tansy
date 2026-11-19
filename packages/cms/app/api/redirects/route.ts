import { z } from "zod";
import { route } from "../../../core/authz/guard";
import { createRedirect, listRedirects } from "../../../core/urls/redirects";

const query = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().max(500).optional(),
});

export const GET = route({ access: "permission", permission: "redirect:read", query }, ({ query }) => listRedirects(query));

const body = z.object({
  from: z.string().trim().min(1).max(2048),
  to: z.string().trim().min(1).max(2048),
  status: z.literal([301, 302, 307, 308]).default(301),
});

export const POST = route(
  { access: "permission", permission: "redirect:manage", body, audit: "redirect.create" },
  async ({ body, principal, auditTarget }) => {
    const redirect = await createRedirect(body, principal.user.id);
    auditTarget("redirect", String(redirect.id), { from: redirect.from, to: redirect.to });
    return redirect;
  },
);
