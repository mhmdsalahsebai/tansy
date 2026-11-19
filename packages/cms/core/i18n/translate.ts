import "server-only";
import { decideRecord, loadRuleLookups, type RuleRequest } from "../authz/records";
import type { Principal } from "../authz/principal";
import { loadBlockCatalog } from "../blocks/service";
import { getCmsConfig } from "../config";
import type { CollectionWithFields } from "../content/access";
import { requireContent } from "../content/content-service";
import { flattenRecord, readableFields } from "../content/records";
import { HttpError } from "../http/errors";
import { localizedFields } from "./context";
import { applySegments, extractSegments, isTranslatableType, type Translator } from "./segments";

export type { Translator };
import { withLocale } from "./storage";

/** Installed translators, by the name of the plugin providing each. */
export function translators(): Array<{ name: string; label: string; translator: Translator }> {
  return (getCmsConfig().plugins ?? []).flatMap((plugin) => {
    const translator = plugin.translator;
    return translator ? [{ name: plugin.name, label: translator.label, translator }] : [];
  });
}

const MAX_CHARACTERS = 100_000;

/**
 * A suggested translation of one record, not saved: the editor puts it in the form and
 * the person saves it, as they would their own typing. The source is read the way the
 * person may read it in `from`, so a translator never sees a draft they couldn't open.
 */
export async function suggestTranslation(collection: CollectionWithFields, recordId: number, from: string, to: string, principal: Principal, request: RuleRequest, provider?: string) {
  const available = translators();
  const chosen = provider ? available.find((entry) => entry.name === provider) : available[0];
  if (!chosen) throw new HttpError(404, "NO_TRANSLATOR", "No translator is installed. Add a plugin that provides one.");
  if (from === to) throw new HttpError(400, "BAD_REQUEST", "Choose two different languages.");

  const source = withLocale(collection, { code: from, chain: [from], missing: "absent" });
  const row = await requireContent(source, recordId);
  const req = { ...request, lookups: request.lookups ?? (await loadRuleLookups([collection])), locale: from };
  if (decideRecord(principal, source, "view", flattenRecord(row), req) !== "allow") throw new HttpError(404, "NOT_FOUND", "Record not found.");

  const readable = new Set(readableFields(source, principal, row).map((field) => field.name));
  // Hidden fields stay out even for staff: their text would leave the site.
  const fields = localizedFields(source).filter((field) => readable.has(field.name) && isTranslatableType(field.type) && (field.config as { hidden?: boolean } | null)?.hidden !== true);
  const catalog = fields.some((field) => field.type === "stream") ? await loadBlockCatalog() : new Map();
  const segments = extractSegments(fields, row, catalog);
  if (!segments.length) return { provider: chosen.name, fields: [], values: {} };
  if (segments.reduce((total, segment) => total + segment.text.length, 0) > MAX_CHARACTERS) throw new HttpError(413, "TOO_LONG", "This record has too much text to translate in one go.");

  const translated = await chosen.translator.translate(segments, { from, to, collection: collection.slug });
  if (!Array.isArray(translated) || translated.length !== segments.length || translated.some((text) => typeof text !== "string")) {
    throw new HttpError(502, "TRANSLATOR_FAILED", `${chosen.label} returned an answer that doesn't match what was sent.`);
  }
  const values = applySegments(fields, row, catalog, new Map(segments.map((segment, index) => [segment.id, translated[index]])));
  return { provider: chosen.name, fields: fields.map((field) => field.name), values };
}
