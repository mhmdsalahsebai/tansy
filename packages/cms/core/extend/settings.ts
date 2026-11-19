import "server-only";
import type { Prisma } from "../../generated/client-sqlite";
import prisma from "../../lib/prisma";
import { getCmsConfig } from "../config";
import { HttpError } from "../http/errors";
import { decryptSecret, encryptSecret } from "../auth/secrets";
import { bumpAuthRevision, SECRET_MASK } from "../auth/settings";
import type { ExtensionSettings, PluginSettingField } from "./define";
import { resolveSettings, settingsSchema } from "./settings-schema";
import { currentScopeValue } from "../scope/context";

// Plugin names can't hold a colon, so no plugin's own store can reach this namespace.
const namespace = (plugin: string) => `settings:${plugin}`;
const KEY = "values";
/**
 * A scope value's own values for the fields marked `perScope` (C29), such as one tenant's. Only
 * those that differ from the instance's are kept, so the rest follow the instance's as it changes.
 */
const scopeKey = (value: string) => `${KEY}@${value}`;

const manifestOf = (plugin: string) => (getCmsConfig().plugins ?? []).find((candidate) => candidate.name === plugin);

export function settingsFields(plugin: string): PluginSettingField[] | null {
  return manifestOf(plugin)?.settings?.fields ?? null;
}

async function saved(plugin: string, key = KEY) {
  return (await prisma.pluginData.findUnique({ where: { plugin_key: { plugin: namespace(plugin), key } } }))?.value ?? null;
}

async function store(plugin: string, key: string, values: Record<string, unknown>) {
  const data = { value: values as Prisma.InputJsonValue };
  await prisma.pluginData.upsert({ where: { plugin_key: { plugin: namespace(plugin), key } }, create: { plugin: namespace(plugin), key, ...data }, update: data });
}

const perScope = (fields: PluginSettingField[]) => fields.filter((field) => field.perScope === true);

/** The current scope value's own stored values, as saved (secrets still encrypted), each still fitting its field. Empty outside a value. */
async function ownValues(plugin: string, fields: PluginSettingField[]): Promise<Record<string, unknown>> {
  const value = currentScopeValue();
  const own = perScope(fields);
  if (value === null || !own.length) return {};
  const stored = await saved(plugin, scopeKey(value));
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const resolved = resolveSettings(own, stored);
  return Object.fromEntries(own.filter((field) => Object.hasOwn(stored, field.name)).map((field) => [field.name, resolved[field.name]]));
}

/** The values that apply here, as stored: the instance's, with the scope value's own over them. */
async function layered(plugin: string, fields: PluginSettingField[]) {
  return { ...resolveSettings(fields, await saved(plugin)), ...(await ownValues(plugin, fields)) };
}

const secrets = (fields: PluginSettingField[]) => fields.filter((field) => field.type === "secret");

/** An environment variable a secret setting names, when it's set. */
const fromEnv = (field: PluginSettingField) => (field.type === "secret" && field.env ? process.env[field.env] || null : null);

/** A stored secret that can no longer be decrypted, such as after the key changed, counts as unset. */
function reveal(stored: unknown) {
  if (typeof stored !== "string" || !stored) return "";
  try {
    return decryptSecret(stored);
  } catch {
    return "";
  }
}

/**
 * Every declared setting, saved or default, with secrets in the clear. For the plugin's own code
 * only. Inside a scope value, its own values for fields marked `perScope` win.
 */
export async function readPluginSettings(plugin: string): Promise<Record<string, unknown>> {
  const fields = settingsFields(plugin);
  if (!fields) return {};
  const values = await layered(plugin, fields);
  for (const field of secrets(fields)) values[field.name] = fromEnv(field) ?? reveal(values[field.name]);
  return values;
}

/**
 * What the dashboard may see: a secret only as whether it's set, and which secrets an
 * environment variable decides.
 */
export async function dashboardPluginSettings(plugin: string): Promise<{ values: Record<string, unknown>; fromEnv: string[] }> {
  const fields = settingsFields(plugin);
  if (!fields) return { values: {}, fromEnv: [] };
  const values = await layered(plugin, fields);
  for (const field of secrets(fields)) values[field.name] = values[field.name] ? SECRET_MASK : "";
  return { values, fromEnv: secrets(fields).filter((field) => fromEnv(field) !== null).map((field) => field.name) };
}

/** One field's next stored value from what the dashboard sent: a masked secret keeps the stored one, and secrets are kept encrypted. */
function settle(field: PluginSettingField, incoming: unknown, current: unknown): { stored: unknown; changed: boolean } {
  if (field.type !== "secret") return { stored: incoming, changed: incoming !== current };
  if (incoming === SECRET_MASK) return { stored: current, changed: false };
  const next = incoming as string;
  return { stored: next ? encryptSecret(next) : "", changed: next !== reveal(current) };
}

const same = (field: PluginSettingField, a: unknown, b: unknown) => (field.type === "secret" ? reveal(a) === reveal(b) : a === b);

/**
 * Replaces every setting, validated against the plugin's declaration. A secret sent back
 * masked keeps its stored value, and an empty one clears it. Inside a scope value, fields
 * marked `perScope` are saved as that value's own, and only where they differ from the
 * instance's, while the rest change for everyone. Returns what the dashboard may see, and
 * the names that changed.
 */
export async function writePluginSettings(plugin: string, input: unknown): Promise<{ values: Record<string, unknown>; changed: string[] }> {
  const fields = settingsFields(plugin);
  if (!fields) throw new HttpError(404, "NOT_FOUND", "This plugin has no settings.");
  const parsed = settingsSchema(fields).safeParse(input);
  if (!parsed.success) {
    throw new HttpError(400, "VALIDATION_FAILED", "Some settings aren't valid.", parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })));
  }
  const incoming = parsed.data as Record<string, unknown>;
  const scope = currentScopeValue();
  const own = new Set(scope === null ? [] : perScope(fields));
  const instance = resolveSettings(fields, await saved(plugin));
  const next = { ...instance };
  const changed: string[] = [];
  for (const field of fields) {
    if (own.has(field)) continue;
    const update = settle(field, incoming[field.name], instance[field.name]);
    if (update.changed) changed.push(field.name);
    next[field.name] = update.stored;
  }
  if (scope === null || changed.length) await store(plugin, KEY, next);
  if (scope !== null && own.size) {
    const before = await ownValues(plugin, fields);
    const mine: Record<string, unknown> = {};
    for (const field of own) {
      const update = settle(field, incoming[field.name], Object.hasOwn(before, field.name) ? before[field.name] : next[field.name]);
      if (update.changed) changed.push(field.name);
      if (!same(field, update.stored, next[field.name])) mine[field.name] = update.stored;
    }
    await store(plugin, scopeKey(scope), mine);
  }
  // better-auth plugins are built from these, and better-auth's options are fixed once built.
  if (changed.length && manifestOf(plugin)?.auth?.plugins) await bumpAuthRevision();
  const values = await layered(plugin, fields);
  for (const field of secrets(fields)) values[field.name] = values[field.name] ? SECRET_MASK : "";
  return { values, changed };
}

/** `source` is plugin:<name> for a plugin, anything else for hook files, which have no settings. */
export const extensionSettings = (source: string): ExtensionSettings => ({
  get: () => (source.startsWith("plugin:") ? readPluginSettings(source.slice("plugin:".length)) : Promise.resolve({})),
});
