import "server-only";
import { ANONYMOUS } from "../authz/principal";
import { HttpError } from "../http/errors";
import { resolveScope } from "./provider";
import { ensureScopeRegistry } from "./registry";
import { hostOf } from "./request";

/**
 * The scope value a site page is for, such as the tenant whose domain it was asked on: the
 * provider's answer for a signed-out visitor at this host and path, since a site page reads as
 * one. `{ value: null }` when the provider names none, or there is no provider, so the page
 * has no scoped records. Null when the provider names a value that doesn't exist or is closed,
 * which the page answers as missing, the same as an address that never existed.
 */
export async function siteScope(headers: Headers, path: string): Promise<{ value: string | null } | null> {
  await ensureScopeRegistry();
  try {
    const resolved = await resolveScope({ host: hostOf(headers), headers, path, principal: ANONYMOUS }, new Set());
    return { value: resolved?.value ?? null };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}
