import { headers } from "next/headers";
import { route } from "../../../../../core/authz/guard";

export const DELETE = route(
  { access: "permission", permission: "api-key:revoke", audit: "api_key.revoke" },
  async ({ params, runtime, auditTarget }) => {
    auditTarget("api_key", params.id);
    // better-auth scopes this to the session's own keys.
    await runtime.auth.api.deleteApiKey({ headers: await headers(), body: { keyId: params.id } });
    return null;
  },
);
