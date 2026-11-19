import { HttpError } from "../http/errors";
import { holdsRecordPermissionForSome } from "../authz/permissions";
import { isLocalizedCollection } from "./context";

/** `locale:edit` covers every language, `locale:edit@fr` only French. */
export const localeEditPermission = (code: string) => `locale:edit@${code}`;

const LOCALE_SCOPED = /^locale:edit@[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|\d{3}))?$/;
export const isLocalePermission = (value: string) => LOCALE_SCOPED.test(value);

export function canEditLocale(permissions: ReadonlySet<string>, code: string) {
  return permissions.has("locale:edit") || permissions.has(localeEditPermission(code));
}

/** The languages a role may edit, for the editor's switcher. `null` means all of them. */
export function editableLocales(permissions: ReadonlySet<string>): string[] | null {
  if (permissions.has("locale:edit")) return null;
  return [...permissions].filter(isLocalePermission).map((permission) => permission.slice("locale:edit@".length));
}

/**
 * Language rights apply to writes made with a role's record permissions: staff. A write
 * a collection's API rule allows (a member's comment, a signup form) is up to that rule,
 * which can read `@request.locale`. System writes carry no permissions and aren't limited.
 */
export function assertLocaleWritable(collection: { id: number; localization?: unknown }, actor: { permissions?: ReadonlySet<string> }, code: string, touchesShared: boolean, defaultLocale: string) {
  const permissions = actor.permissions;
  if (!permissions || !isLocalizedCollection(collection)) return;
  const staff = holdsRecordPermissionForSome(permissions, "record:update", collection.id) || holdsRecordPermissionForSome(permissions, "record:create", collection.id);
  if (!staff) return;
  if (!canEditLocale(permissions, code)) throw new HttpError(403, "LOCALE_FORBIDDEN", `You can't edit content in ${code}.`);
  if (touchesShared && !canEditLocale(permissions, defaultLocale)) {
    throw new HttpError(403, "LOCALE_FORBIDDEN", `Fields shared by every language can only be changed by people who edit ${defaultLocale}.`);
  }
}
