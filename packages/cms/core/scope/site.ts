import "server-only";
import { ANONYMOUS } from "../authz/principal";
import { HttpError } from "../http/errors";
import { insideBasePath } from "../urls/base-path";
import { resolveScope, scopeBasePathOf } from "./provider";
import { ensureScopeRegistry } from "./registry";
import { hostOf } from "./request";

/** The scope a site page is for: its value, and the path prefix this request came in under. */
export interface SiteScope {
  value: string | null;
  /** "/acme" when the value's site is served under a prefix and this address is inside it, else "". */
  basePath: string;
}

/**
 * The scope value a site page is for, such as the tenant whose domain it was asked on: the
 * provider's answer for a signed-out visitor at this host and path, since a site page reads as
 * one. `{ value: null }` when the provider names none, or there is no provider, so the page
 * has no scoped records. Null when the provider names a value that doesn't exist or is closed,
 * which the page answers as missing, the same as an address that never existed.
 *
 * A value whose site has no address of its own is served under a path prefix on the instance's,
 * such as /acme/blog/hello. It is reported only when the address really is inside it, so a
 * request on the value's own domain keeps the plain addresses that domain is canonical for.
 */
export async function siteScope(headers: Headers, path: string): Promise<SiteScope | null> {
  await ensureScopeRegistry();
  try {
    const resolved = await resolveScope({ host: hostOf(headers), headers, path, principal: ANONYMOUS }, new Set());
    const value = resolved?.value ?? null;
    const base = await scopeBasePathOf(value);
    return { value, basePath: insideBasePath(path, base) ? base : "" };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}
