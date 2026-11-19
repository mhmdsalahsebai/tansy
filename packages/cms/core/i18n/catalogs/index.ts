/** The dashboard's catalogs. No server imports: client components read the chosen one through useT(). */
import { ar } from "./ar";
import { en, type Catalog } from "./en";

export const ADMIN_CATALOGS: Readonly<Record<string, Catalog>> = { en, ar };
export const ADMIN_LOCALES = Object.keys(ADMIN_CATALOGS);
export const ADMIN_DEFAULT = "en";

/** What each interface language calls itself, for the picker. */
export const ADMIN_LOCALE_NAMES: Readonly<Record<string, string>> = { en: "English", ar: "العربية" };

export type { Catalog };
