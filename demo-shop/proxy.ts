import { createCmsProxy } from "tansy/proxy";
import cspAdditions from "./.tansy/csp";

// Your own proxy goes in the second argument, as createCmsProxy(cspAdditions, { proxy: yourProxy }).
export const proxy = createCmsProxy(cspAdditions);

// Uploads skip the proxy because Next.js buffers bodies it proxies and silently cuts them off
// at 10 MB. This only sets headers and grants nothing: the route is still fully guarded.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/files/upload$).*)"],
};
