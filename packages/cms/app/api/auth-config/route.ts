import { route } from "../../../core/authz/guard";
import { setupRequired } from "../../../core/auth/setup";
import { authWidgets, oauthProviders } from "../../../core/auth/extension-hooks";
import { authCaptcha } from "../../../core/captcha";

// PocketBase's listAuthMethods: lets sign-in screens show only what is enabled.
export const GET = route({ access: "public", reason: "Sign-in screens need the enabled methods before authentication" }, async ({ runtime: { settings: s } }) => ({
  appName: s.general.appName,
  logoUrl: s.general.logoUrl,
  accentColor: s.general.accentColor,
  setupRequired: await setupRequired(),
  signUp: s.signUp.enabled,
  methods: s.methods,
  password: { minLength: s.password.minLength, maxLength: s.password.maxLength },
  oauth: oauthProviders().filter(({ id }) => s.oauth.providers[id]?.enabled).map(({ id }) => id),
  widgets: authWidgets(s),
  // Public by design: the site key and script only. The secret never leaves the server.
  captcha: await authCaptcha(),
}));
