import { route } from "../../../core/authz/guard";
import { handleMcp, mcpRequest } from "../../../core/extend/mcp";

export const POST = route(
  { access: "authenticated", apiKey: true, body: mcpRequest, audit: "mcp.call", maxBodyBytes: 4 * 1024 * 1024 },
  async ({ body, principal, request, auditTarget }) => {
    const response = await handleMcp(body, principal, request.headers, auditTarget);
    return response ?? new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
  },
);
