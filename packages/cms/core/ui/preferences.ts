import "server-only";
import { cookies } from "next/headers";
import { SIDEBAR_COOKIE } from "../../lib/preferences";

/** A display preference, not identity: it changes nothing a request may do. */
export async function sidebarCollapsed() {
  return (await cookies()).get(SIDEBAR_COOKIE)?.value === "collapsed";
}
