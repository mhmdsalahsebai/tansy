/**
 * The only place the CMS's own addresses are written. withCms() sets these from
 * its `routes` option at build time, so they are the same in the browser and on the server.
 */
const ADMIN = process.env.NEXT_PUBLIC_TANSY_ADMIN_PATH || "/dashboard";
const API = process.env.NEXT_PUBLIC_TANSY_API_PATH || "/api";

/** adminPath("/users") is "/dashboard/users" by default. */
export const adminPath = (path = "") => `${ADMIN}${path}`;

/** Sign-in, sign-up and the other pages shown before there is a session. */
export const authPath = (page: string) => `${ADMIN}/auth/${page}`;

export const accountPath = (suffix = "") => `${ADMIN}/account${suffix}`;

export const apiPath = (path = "") => `${API}${path}`;

/** Whether a request needs a session cookie to be worth rendering. Only a convenience: pages and routes check for themselves. */
export function needsSession(pathname: string) {
  const inAdmin = pathname === ADMIN || pathname.startsWith(`${ADMIN}/`);
  return inAdmin && pathname !== `${ADMIN}/auth` && !pathname.startsWith(`${ADMIN}/auth/`);
}
