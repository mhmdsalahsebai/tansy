import { z } from "zod";
import { route } from "../../../../../core/authz/guard";
import { settingsPermission } from "../../../../../core/extend/admin-nav";
import { dashboardPluginSettings, writePluginSettings } from "../../../../../core/extend/settings";
import { forbidden, notFound } from "../../../../../core/http/errors";
import type { Principal } from "../../../../../core/authz/principal";

/** Each plugin names its own permission, so the guard checks for staff and this for the plugin's. */
function assertCanManage(principal: Principal, plugin: string) {
  const permission = settingsPermission(plugin);
  if (!permission) throw notFound("Plugin settings");
  if (!principal.permissions.has(permission)) throw forbidden();
}

export const GET = route({ access: "permission", permission: "dashboard:access" }, async ({ params, principal }) => {
  assertCanManage(principal, params.name);
  return { values: (await dashboardPluginSettings(params.name)).values };
});

const body = z.strictObject({ values: z.record(z.string().max(40), z.unknown()) });

export const PUT = route(
  { access: "permission", permission: "dashboard:access", body, audit: "plugin.settings_update" },
  async ({ params, principal, body, auditTarget }) => {
    assertCanManage(principal, params.name);
    const { values, changed } = await writePluginSettings(params.name, body.values);
    // Names only: secret settings must never reach the log, and the rest needn't.
    auditTarget("plugin", params.name, { changed });
    return { values };
  },
);
