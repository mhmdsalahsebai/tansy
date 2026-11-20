import "server-only";
import { authCaptcha } from "../captcha";
import { getCmsConfig } from "../config";
import { authWidgets, oauthProviders } from "./extension-hooks";
import { getRuntime } from "./instance";
import type { AuthSettings } from "./settings";
import { setupRequired } from "./setup";

/**
 * What sign-in screens may know before anyone is signed in: the enabled methods, branding and the
 * CAPTCHA's public half. GET /api/auth-config serves it, and the sign-in pages render with it.
 */
export async function publicAuthConfig(settings: AuthSettings) {
  return {
    appName: settings.general.appName,
    logoUrl: settings.general.logoUrl,
    accentColor: settings.general.accentColor,
    setupRequired: await setupRequired(),
    signUp: settings.signUp.enabled,
    methods: settings.methods,
    password: { minLength: settings.password.minLength, maxLength: settings.password.maxLength },
    oauth: oauthProviders().filter(({ id }) => settings.oauth.providers[id]?.enabled).map(({ id }) => id),
    widgets: authWidgets(settings),
    // Public by design: the site key and script only. The secret never leaves the server.
    captcha: await authCaptcha(),
  };
}

export type PublicAuthConfig = Awaited<ReturnType<typeof publicAuthConfig>>;

/** For the sign-in pages, so they paint whole on the first response. The logo falls back to the admin theme's, as in the dashboard. */
export async function loadPublicAuthConfig(): Promise<PublicAuthConfig> {
  const config = await publicAuthConfig((await getRuntime()).settings);
  return { ...config, logoUrl: config.logoUrl || (getCmsConfig().adminTheme?.logo ?? "") };
}
