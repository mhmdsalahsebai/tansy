import { z } from "zod";
import { route } from "../../../../../core/authz/guard";
import { canDescribeFile, describeFile, requireFile } from "../../../../../core/files/service";
import { fileTextLocale, fileTextOverrides, ownFileText, FILE_TEXT_KEYS } from "../../../../../core/files/text";
import { notFound } from "../../../../../core/http/errors";
import { listLocales, defaultLocale } from "../../../../../core/i18n/locales";

/**
 * What a file is described as, for editing: each language's own words, never a fallback's, so
 * saving one language can't copy another's words into it. Readers of a record get the resolved
 * words with the record, or from `/files/:id/info`.
 *
 * Anyone with `file:update` may describe any file, and whoever uploaded one may describe theirs,
 * since they can already read it. The guard can't know who uploaded it, so this is checked here.
 */
async function describable(id: string, principal: Parameters<typeof canDescribeFile>[1]) {
  const file = await requireFile(id);
  // The same answer as a file that isn't there, so this can't be used to probe for ids, as
  // reading a file's bytes doesn't either.
  if (!canDescribeFile(file, principal)) throw notFound("File");
  return file;
}

export const GET = route({ access: "authenticated", apiKey: true }, async ({ params, principal }) => {
  const file = await describable(params.id, principal);
  const [primary, locales] = await Promise.all([defaultLocale(), listLocales()]);
  const overrides = fileTextOverrides(file.text);
  return {
    primary,
    languages: locales.map(({ code, label, direction }) => ({ code, label, direction })),
    // The default language's words are the file's own columns; every other language's are its own.
    words: { [primary]: ownFileText(file), ...Object.fromEntries(Object.entries(overrides).filter(([code]) => code !== primary)) },
  };
});

const body = z.object({
  alt: z.string().trim().max(1000).optional(),
  caption: z.string().trim().max(2000).optional(),
  credit: z.string().trim().max(500).optional(),
  /** The language these words are for. The default language when left out. */
  locale: z.string().max(35).optional(),
}).refine((value) => FILE_TEXT_KEYS.some((key) => value[key] !== undefined), "Send at least one of alt, caption or credit.");

export const PATCH = route(
  { access: "authenticated", apiKey: true, body, audit: "file.describe" },
  async ({ params, body, principal, auditTarget }) => {
    const file = await describable(params.id, principal);
    const primary = await defaultLocale();
    const locale = await fileTextLocale(body.locale, principal.permissions.has("file:update"));
    auditTarget("file", file.id, { name: file.name, locale });
    const updated = await describeFile(file, locale, primary, body);
    const overrides = fileTextOverrides(updated.text);
    return { locale, words: locale === primary ? ownFileText(updated) : { alt: "", caption: "", credit: "", ...overrides[locale] } };
  },
);
