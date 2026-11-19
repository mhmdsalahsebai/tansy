import { headers } from "next/headers";
import { z } from "zod";
import { route } from "../../../../core/authz/guard";
import { fromStatements, isKnownPermission, toStatements } from "../../../../core/authz/permissions";
import { isSubset } from "../../../../core/authz/roles";
import { HttpError } from "../../../../core/http/errors";

const assertEnabled = (enabled: boolean) => {
  if (!enabled) throw new HttpError(403, "API_KEYS_DISABLED", "API keys are disabled.");
};

export const GET = route({ access: "permission", permission: "api-key:list" }, async ({ runtime }) => {
  const result = await runtime.auth.api.listApiKeys({ headers: await headers() });
  return result.apiKeys.map((key) => ({
    id: key.id,
    name: key.name,
    start: key.start,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    lastRequest: key.lastRequest,
    permissions: [...fromStatements(key.permissions as Record<string, string[]> | null)],
    scope: boundScope(key.metadata),
  }));
});

const body = z.object({
  name: z.string().trim().min(1).max(80),
  permissions: z.array(z.string()).min(1).max(200),
  expiresInDays: z.number().int().min(1).max(3650),
  /** Binds the key to this request's row scope value, such as a tenant: it works there and nowhere else. */
  scope: z.boolean().optional(),
});

const boundScope = (metadata: unknown) => {
  const scope = (metadata as { scope?: unknown } | null | undefined)?.scope;
  return typeof scope === "string" ? scope : null;
};

export const POST = route(
  { access: "permission", permission: "api-key:create", body, audit: "api_key.create", fresh: true },
  async ({ body, principal, runtime, auditTarget }) => {
    assertEnabled(runtime.settings.apiKeys.enabled);
    if (body.expiresInDays > runtime.settings.apiKeys.maxLifetimeDays) {
      throw new HttpError(400, "KEY_LIFETIME", `Keys can last at most ${runtime.settings.apiKeys.maxLifetimeDays} days.`);
    }
    if (!body.permissions.every(isKnownPermission) || !isSubset(body.permissions, principal.permissions)) {
      throw new HttpError(403, "KEY_EXCEEDS_ACTOR", "A key cannot have permissions you do not hold.");
    }
    // Permissions held only within a scope value count only for a key bound to it.
    const scope = body.scope ? principal.scope ?? null : null;
    if (body.scope && scope === null) throw new HttpError(400, "SCOPE_REQUIRED", "Choose where the key is for before binding it.");
    const created = await runtime.auth.api.createApiKey({
      body: { userId: principal.user.id, name: body.name, expiresIn: body.expiresInDays * 86_400, permissions: toStatements(body.permissions), ...(scope ? { metadata: { scope } } : {}) },
    });
    auditTarget("api_key", created.id, { name: body.name, permissions: body.permissions, ...(scope ? { scope } : {}) });
    return { id: created.id, key: created.key, name: created.name };
  },
);
