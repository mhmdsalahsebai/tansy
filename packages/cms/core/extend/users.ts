import "server-only";
import { audit } from "../audit";
import { extensionValues, setExtensionValues } from "../auth/user-fields";
import { recipientLocale } from "../i18n/admin";
import prisma from "../../lib/prisma";
import type { ExtensionUser, ExtensionUsers } from "./define";
import { pluginPrefix } from "./manifest";

/**
 * Which custom user fields an extension may read and set. A plugin gets the fields
 * named with its prefix, as for its field types and blocks, so two plugins can't
 * reach each other's. A hook file is the site owner's own code, and gets them all.
 */
export function ownedUserFields(source: string): (name: string) => boolean {
  if (!source.startsWith("plugin:")) return () => true;
  const prefix = pluginPrefix(source.slice("plugin:".length));
  return (name) => name.startsWith(prefix);
}

const IDENTITY = { id: true, name: true, email: true } as const;

/** With the language to write to them in. */
async function withLocale(user: Omit<ExtensionUser, "locale"> | null): Promise<ExtensionUser | null> {
  return user ? { ...user, locale: await recipientLocale(user.email) } : null;
}

/** Addresses are stored lowercased by better-auth, so this ignores case without a case-insensitive query, which SQLite and Postgres spell differently. */
async function findByEmail(email: string): Promise<ExtensionUser | null> {
  const address = email.trim().toLowerCase();
  if (!address || address.length > 320) return null;
  return withLocale(await prisma.user.findUnique({ where: { email: address }, select: IDENTITY }));
}

/** `source` names the extension, such as plugin:lms, for the audit log and the fields it owns. */
export function extensionUsers(source: string): ExtensionUsers {
  const owns = ownedUserFields(source);
  return {
    get: async (userId) => withLocale(await prisma.user.findUnique({ where: { id: String(userId) }, select: IDENTITY })),
    findByEmail: (email) => findByEmail(String(email)),
    getValues: (userId) => extensionValues(String(userId), owns),
    async setValues(userId, values) {
      const fields = await setExtensionValues(String(userId), values, owns, source);
      // Names only, as for the dashboard's form. Values can be anything.
      if (fields.length) await audit({ action: "user.update_fields", outcome: "success", actorKind: "system", actorEmail: source, targetType: "user", targetId: String(userId), metadata: { fields: fields.slice(0, 100) } });
    },
  };
}
