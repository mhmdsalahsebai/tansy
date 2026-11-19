import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { requestAllowed } from "../auth/extension-hooks";
import { getRuntime } from "../auth/instance";
import { clientIp } from "../http/request";
import { HttpError } from "../http/errors";
import { ensureScopeRegistry } from "../scope/registry";
import { scopePrincipal } from "../scope/request";
import { holdsRecordPermission, holdsRecordPermissionForSome, type Permission, type RecordPermission } from "./permissions";
import { principalFromSession, type UserPrincipal } from "./principal";
import { accountPath, adminPath, authPath } from "../../lib/paths";

/** Signed-in check for pages. Use requirePage for anything under /dashboard. */
export async function requireUser(): Promise<UserPrincipal> {
  const runtime = await getRuntime();
  const principal = await principalFromSession(await headers(), runtime);
  if (principal.kind !== "user") redirect(authPath("signin"));
  return principal;
}

/**
 * The signed-in person as they act in the scope value this request resolves to (core/scope),
 * as `route()` does for API routes: their instance permissions plus their capped scoped roles
 * there. A value the provider can't confirm, or one they have no place in, gives no value
 * rather than an error page, so the dashboard still opens and the switcher can choose another.
 * Once per request, however many layouts and pages ask.
 */
const scopedUser = cache(async (): Promise<UserPrincipal | null> => {
  const runtime = await getRuntime();
  const requestHeaders = await headers();
  const principal = await principalFromSession(requestHeaders, runtime);
  if (principal.kind !== "user") return null;
  await ensureScopeRegistry();
  const path = requestHeaders.get("x-pathname") ?? adminPath();
  try {
    return (await scopePrincipal({ headers: requestHeaders, path }, principal, runtime, false)) as UserPrincipal;
  } catch (error) {
    if (error instanceof HttpError && error.status < 500) return { ...principal, scope: null };
    throw error;
  }
});

/** The signed-in person in this request's scope value. Signs a visitor in first. */
export async function requireScopedUser(): Promise<UserPrincipal> {
  const principal = await scopedUser();
  if (!principal) redirect(authPath("signin"));
  return principal;
}

/**
 * A page about one collection, whose `record:*` permissions may be held for that collection alone.
 * `own`: an own grant passes too. Only for pages that load records through the guarded API,
 * which then decides record by record.
 */
export interface PageScope { collection: string | number; own?: boolean }

function holdsFor(principal: UserPrincipal, permission: Permission, collectionId: number | null, own: boolean) {
  if (collectionId === null || !/^record:[a-z]+$/.test(permission)) return principal.permissions.has(permission);
  const check = own ? holdsRecordPermissionForSome : holdsRecordPermission;
  return check(principal.permissions, permission as RecordPermission, collectionId);
}

/**
 * Page-level gate. Next.js can render a page without re-running its layout, so
 * each dashboard page.tsx calls this itself. tests/contract enforces that.
 */
export async function requirePage(...args: [PageScope, ...Permission[]] | Permission[]): Promise<UserPrincipal> {
  const runtime = await getRuntime();
  const principal = await requireScopedUser();
  const [scope, permissions] = typeof args[0] === "object" ? [args[0], args.slice(1) as Permission[]] : [null, args as Permission[]];
  const id = scope ? String(scope.collection) : "";
  const collectionId = /^[1-9]\d{0,15}$/.test(id) ? Number(id) : null;
  const required: Permission[] = ["dashboard:access", ...permissions];
  if (!required.every((permission) => holdsFor(principal, permission, collectionId, scope?.own === true))) redirect(accountPath("?denied=1"));
  if (runtime.settings.mfa.requireForDashboard && !principal.user.twoFactorEnabled && !principal.session.impersonatedBy) {
    redirect(accountPath("?enroll=mfa"));
  }
  const requestHeaders = await headers();
  if (!(await requestAllowed({ surface: "page", principal, ip: clientIp(requestHeaders, runtime.settings), method: "GET", path: requestHeaders.get("x-pathname") ?? adminPath(), headers: requestHeaders }))) {
    redirect(accountPath("?denied=1"));
  }
  return principal;
}

/** Where "/" sends a visitor, based on who they are. */
export async function resolveLanding(): Promise<string> {
  const principal = await scopedUser();
  if (!principal) return authPath("signin");
  return principal.permissions.has("dashboard:access") ? adminPath() : accountPath();
}
