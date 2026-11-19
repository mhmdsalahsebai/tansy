import "server-only";
import { HttpError, notFound } from "../http/errors";
import { passwordProblem } from "./extension-hooks";
import type { AuthRuntime } from "./instance";
import type { UserPrincipal } from "../authz/principal";
import { isSubset, parseRoleNames, permissionsForRole, SUPERADMIN } from "../authz/roles";
import prisma from "../../lib/prisma";

/** Rules better-auth's admin plugin cannot express. Every user-management route uses them. */
export async function assertCanManage(actor: UserPrincipal, targetId: string, runtime: AuthRuntime) {
  if (actor.user.id === targetId) throw new HttpError(400, "CANNOT_TARGET_SELF", "You cannot perform this action on your own account.");
  const target = await prisma.user.findUnique({ where: { id: targetId } });
  if (!target) throw notFound("User");
  // Horizontal escalation: nobody manages an account more privileged than their own.
  if (!isSubset(permissionsForRole(runtime.roles, target.role), actor.permissions)) {
    throw new HttpError(403, "TARGET_MORE_PRIVILEGED", "You cannot manage an account with more privileges than your own.");
  }
  return target;
}

export function assertRoleAssignable(actor: UserPrincipal, roleName: string, runtime: AuthRuntime) {
  const permissions = runtime.roles.get(roleName);
  if (!permissions) throw new HttpError(400, "UNKNOWN_ROLE", "That role does not exist.");
  // Vertical escalation: nobody grants what they do not hold themselves.
  if (!isSubset(permissions, actor.permissions)) {
    throw new HttpError(403, "ROLE_EXCEEDS_ACTOR", "You cannot assign a role with more privileges than your own.");
  }
}

export async function assertNotLastSuperadmin(target: { id: string; role: string | null }) {
  if (!parseRoleNames(target.role).includes(SUPERADMIN)) return;
  const others = await prisma.user.count({
    where: { id: { not: target.id }, role: { contains: SUPERADMIN }, OR: [{ banned: false }, { banned: null }] },
  });
  if (others === 0) throw new HttpError(400, "LAST_SUPERADMIN", "This is the last active superadmin.");
}

/** Applied where better-auth does not run its own password policy (admin and setup flows). */
export async function assertPasswordAcceptable(password: string, runtime: AuthRuntime) {
  const { minLength, maxLength } = runtime.settings.password;
  if (password.length < minLength || password.length > maxLength) {
    throw new HttpError(400, "PASSWORD_LENGTH", `Passwords must be ${minLength} to ${maxLength} characters long.`);
  }
  const problem = await passwordProblem(password, runtime.settings);
  if (problem) throw new HttpError(400, "PASSWORD_REJECTED", problem);
}
