/**
 * better-auth endpoints closed to direct HTTP. They stay callable as
 * `auth.api.*`, which the guarded routes wrap with the checks better-auth can't
 * know about (hierarchy, last superadmin, fresh session, audit).
 *
 * tests/contract fails if a better-auth upgrade adds an admin or API-key
 * endpoint that isn't listed here.
 */
export const SERVER_ONLY_PATHS = [
  "/admin/set-role", "/admin/get-user", "/admin/create-user", "/admin/update-user", "/admin/list-users",
  "/admin/list-user-sessions", "/admin/unban-user", "/admin/ban-user", "/admin/impersonate-user",
  "/admin/revoke-user-session", "/admin/revoke-user-sessions", "/admin/remove-user", "/admin/set-user-password",
  "/admin/has-permission", "/api-key/create", "/api-key/get", "/api-key/update", "/api-key/delete", "/api-key/list",
];

/** Only ever ends the caller's own impersonation session. */
export const ALLOWED_ADMIN_HTTP_PATHS = ["/admin/stop-impersonating"];
