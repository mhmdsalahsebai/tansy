import { createCmsProxy, mergeCsp } from "tansy/proxy";
import { pluginCsp, siteCsp } from "./.tansy/csp";

// The maps list every plugin tansy sync saw, so the CAPTCHA's providers are only allowed while it's switched on.
const running = Object.entries(pluginCsp).filter(([plugin]) => plugin !== "captcha" || process.env.TANSY_PLUGIN_CAPTCHA === "true");

export const proxy = createCmsProxy(mergeCsp(siteCsp, ...running.map(([, additions]) => additions)));

// Uploads skip the proxy because Next.js buffers bodies it proxies and silently cuts them off
// at 10 MB. This only sets headers and grants nothing: the route is still fully guarded.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/files/upload$).*)"],
};
