import { headers } from "next/headers";
import { route } from "../../../../../core/authz/guard";
import { assertCanManage } from "../../../../../core/auth/users";
import { HttpError } from "../../../../../core/http/errors";

export const POST = route(
  { access: "permission", permission: "user:impersonate", audit: "user.impersonate", fresh: true },
  async ({ params, principal, runtime, auditTarget }) => {
    if (principal.kind !== "user") return null;
    const target = await assertCanManage(principal, params.id, runtime);
    if (runtime.roles.get(target.role ?? "")?.has("dashboard:access")) {
      throw new HttpError(403, "CANNOT_IMPERSONATE_STAFF", "Dashboard users cannot be impersonated.");
    }
    auditTarget("user", params.id, { email: target.email });
    const { headers: responseHeaders } = await runtime.auth.api.impersonateUser({
      headers: await headers(),
      body: { userId: params.id },
      returnHeaders: true,
    });
    const response = new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    for (const cookie of responseHeaders.getSetCookie()) response.headers.append("set-cookie", cookie);
    return response;
  },
);
