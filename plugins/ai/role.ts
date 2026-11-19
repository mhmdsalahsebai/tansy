import type { PluginRole } from "tansy/plugin";
import type { AiSettings } from "./provider";

/** The role the AI acts with until an owner chooses another. */
export const ASSISTANT_ROLE = "ai-assistant";

/** A role's name, as the CMS stores them. */
export const ROLE_NAME = /^[a-z][a-z0-9_-]{1,39}$/;

/**
 * Created once, and then the owner's to change under Dashboard → Roles like any other. It
 * reads and drafts content, and nothing else: no deleting, no schemas, users, settings,
 * roles or keys. The AI never gets more than the person using it either, and every change
 * still waits for that person to approve it.
 */
export const assistantRole: PluginRole = {
  name: ASSISTANT_ROLE,
  label: "AI assistant",
  description: "What the AI may do for the person using it, never more than their own access: read and draft content. It can't delete, or change schemas, users, settings or roles.",
  permissions: ["collection:read", "record:list", "record:read", "record:create", "record:update", "file:list", "file:read", "locale:edit"],
};

/**
 * Who may give the AI a role other than the site's: whoever may give people roles, admins by
 * default. Anyone else's assistant acts with the role chosen under AI → Settings.
 */
export const GIVE_ROLE = "user:set-role";

/** Whether this caller may choose the AI's role. */
export const givesRoles = (principal: { permissions: ReadonlySet<string> }) => principal.permissions.has(GIVE_ROLE);

/** The role the AI acts with: the one chosen in the chat while people may choose, else the settings', else its own. */
export const roleFor = (settings: Pick<AiSettings, "role" | "chooseRole">, picked?: string | null) =>
  (settings.chooseRole !== false && picked) || (typeof settings.role === "string" && settings.role.trim()) || ASSISTANT_ROLE;
