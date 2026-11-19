import "server-only";
import { createAccessControl } from "better-auth/plugins/access";
import { allStatements, scopedCollectionId, toStatements } from "../authz/permissions";
import { isLocalePermission } from "../i18n/permissions";
import type { RoleMap } from "../authz/roles";
import { isScopeablePermission } from "../scope/provider";

type AccessControl = ReturnType<typeof createAccessControl>;
type AccessRole = ReturnType<AccessControl["newRole"]>;

export interface AccessControlOptions {
  /**
   * Resources the better-auth plugin checks that core has none of, such as the organization
   * plugin's `member` and `invitation`. They can't reuse a name from the CMS's catalogue.
   */
  statements?: Record<string, readonly string[]>;
  /**
   * Which roles to give it: "instance" for the roles people hold across the site, "scoped"
   * for the roles a scope provider gives within one scope value, capped as core caps them.
   */
  roles: "instance" | "scoped";
  /** What one role may do on `statements`, from the CMS permissions it holds. Nothing when left out. */
  grant?: (permissions: ReadonlySet<string>) => Record<string, readonly string[] | undefined>;
}

/** What a plugin's `auth.plugins` gets to build better-auth plugins that check roles. */
export interface AuthAccess {
  /**
   * Core's roles as better-auth access control, as core's own `admin` plugin gets them, so a
   * better-auth plugin that checks roles agrees with Dashboard → Roles. The plugins are rebuilt
   * whenever roles change, so this is current. Role names are the CMS's.
   */
  accessControl(options: AccessControlOptions): { ac: AccessControl; roles: Record<string, AccessRole> };
}

/** Statements better-auth checks: per-collection and per-language grants stay on core's side. */
const checkable = (permissions: Iterable<string>) => [...permissions].filter((p) => scopedCollectionId(p) === null && !isLocalePermission(p));

export function authAccess(roles: RoleMap, scopedRoles: RoleMap): AuthAccess {
  return {
    accessControl({ statements = {}, roles: kind, grant }) {
      const core = allStatements();
      const clash = Object.keys(statements).find((resource) => resource in core);
      if (clash) throw new Error(`The access control statement "${clash}" is already one of the CMS's permissions.`);
      const ac = createAccessControl({ ...core, ...statements });
      const source = kind === "scoped" ? scopedRoles : roles;
      const out: Record<string, AccessRole> = {};
      for (const [name, held] of source) {
        const permissions = new Set(kind === "scoped" ? [...held].filter(isScopeablePermission) : held);
        const extra: Record<string, readonly string[]> = {};
        for (const [resource, actions] of Object.entries(grant?.(permissions) ?? {})) {
          if (!actions) continue;
          extra[resource] = actions;
          const known = statements[resource];
          const unknown = actions.find((action) => !known?.includes(action));
          if (unknown) throw new Error(`Role "${name}" was granted "${resource}:${unknown}", which isn't among the statements given.`);
        }
        out[name] = ac.newRole({ ...toStatements(checkable(permissions)), ...extra } as never);
      }
      return { ac, roles: out };
    },
  };
}
