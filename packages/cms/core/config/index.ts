import type { AuthExtension, CmsConfig } from "../auth/extensions";
import type { AdminConfig } from "../extend/admin";

declare const globalThis: { cmsConfig?: CmsConfig; cmsAdminConfig?: AdminConfig } & typeof global;

/**
 * Hands the app's tansy.config.ts to core. App-owned entry files call this, so core
 * never imports a file from the app it is installed in.
 *
 * On globalThis because Next.js gives routes and instrumentation separate copies of a module.
 */
export function provideCmsConfig(config: CmsConfig) {
  globalThis.cmsConfig = config;
}

/** Throws when nothing has provided a config, so a missing setup can't look like a site with no plugins. */
export function getCmsConfig(): CmsConfig {
  if (!globalThis.cmsConfig) throw new Error("The CMS config has not been provided. Call provideCmsConfig(config) from instrumentation.ts.");
  return globalThis.cmsConfig;
}

/** The authentication features of every plugin, each named after its plugin. */
export const authExtensions = (): Array<AuthExtension & { name: string }> =>
  (getCmsConfig().plugins ?? []).flatMap((plugin) => (plugin.auth ? [{ ...plugin.auth, name: plugin.name }] : []));

/** The server-rendered admin half of plugins. Only dashboard entry files provide it, so API routes never import React. */
export function provideAdminConfig(config: AdminConfig) {
  globalThis.cmsAdminConfig = config;
}

/** The admin config, or null where the host didn't pass it, as an older account page entry doesn't. */
export function adminConfigIfProvided(): AdminConfig | null {
  return globalThis.cmsAdminConfig ?? null;
}

export function getAdminConfig(): AdminConfig {
  if (!globalThis.cmsAdminConfig) throw new Error("The admin config has not been provided. Pass it to createDashboardPage and createDashboardLayout.");
  return globalThis.cmsAdminConfig;
}
