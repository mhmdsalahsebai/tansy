import { route } from "../../../../core/authz/guard";
import { oauthProviders } from "../../../../core/auth/extension-hooks";
import { invalidateRuntime } from "../../../../core/auth/instance";
import { authSettingsSchema, loadAuthSettings, maskSettings, saveAuthSettings } from "../../../../core/auth/settings";
import { baseUrl } from "../../../../core/http/request";
import { mailDelivery } from "../../../../core/mail";

export const GET = route({ access: "permission", permission: "setting:read" }, async () => {
  const { settings } = await loadAuthSettings();
  // Which plugins can deliver mail instead of SMTP, and which one does now.
  return { settings: maskSettings(settings), baseUrl: baseUrl(), oauthProviders: oauthProviders(), mail: await mailDelivery(settings) };
});

export const PUT = route(
  { access: "permission", permission: "setting:update", body: authSettingsSchema, audit: "settings.update", fresh: true, maxBodyBytes: 128 * 1024 },
  async ({ body, principal, runtime, auditTarget }) => {
    if (principal.kind !== "user") return null;
    await saveAuthSettings(body, runtime.roles, principal.user.id);
    invalidateRuntime();
    auditTarget("settings", "auth");
    return null;
  },
);
