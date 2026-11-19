import "server-only";
import { describeCollection } from "../schema/portable";
import { localeCatalog, localizationSettings } from "../i18n/locales";
import { hrefFor, localizePath } from "../i18n/routing";
import type { CmsPlugin, ExtensionSchema, SiteLanguages } from "./define";

async function languages(): Promise<SiteLanguages> {
  const [catalog, settings] = await Promise.all([localeCatalog(), localizationSettings()]);
  const items = catalog.locales.filter((locale) => locale.public).sort((a, b) => Number(b.code === catalog.defaultLocale) - Number(a.code === catalog.defaultLocale));
  return {
    defaultLocale: catalog.defaultLocale,
    items: items.map(({ code, label, direction }) => ({ code, label, direction })),
    href: (path, locale) => (items.length < 2 ? path : hrefFor(localizePath(path, locale, settings.routing, catalog.defaultLocale))),
  };
}

/** Read-only. Changing the schema stays with migrations and the dashboard. */
export const extensionSchema: ExtensionSchema = { describe: describeCollection, languages };

/**
 * What's wrong with the collections a plugin's code relies on, one sentence each.
 * Owners may edit these collections, so a missing or retyped field is reported
 * rather than put back.
 */
export async function contractProblems(plugin: Pick<CmsPlugin, "contract">): Promise<string[]> {
  const problems: string[] = [];
  for (const [slug, fields] of Object.entries(plugin.contract ?? {})) {
    const collection = await describeCollection(slug);
    if (!collection) {
      problems.push(`The "${slug}" collection is missing.`);
      continue;
    }
    for (const [name, type] of Object.entries(fields)) {
      const field = collection.fields.find((f) => f.name === name);
      if (!field) problems.push(`"${slug}" has no "${name}" field.`);
      else if (field.type !== type) problems.push(`"${slug}.${name}" is a ${field.type} field, and should be ${type}.`);
    }
  }
  return problems;
}
