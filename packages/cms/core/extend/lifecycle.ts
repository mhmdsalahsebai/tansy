import "server-only";
import type { Prisma } from "../../generated/client-sqlite";
import prisma from "../../lib/prisma";
import { getCmsConfig } from "../config";
import { addBlockFieldLabels, addCollectionFields, addCollectionLabels, addFieldLabels, addFieldOptions, applySchema, exportSchema, schemaDocument } from "../schema/portable";
import { themeAdditions, themeParts } from "../theme/schema";
import { installedThemes } from "../theme/installed";
import type { ThemeManifest } from "../theme/define";
import type { CmsPlugin, PluginMigrationContext } from "./define";
import { emitEvent } from "./events";
import { extensionContext } from "./hooks";
import { ensurePluginRole } from "../authz/role-admin";
import { pendingMigrations, pluginPrefix } from "./manifest";
import { isOlder } from "./semver";

function migrationContext(plugin: CmsPlugin): PluginMigrationContext {
  const context = extensionContext(`plugin:${plugin.name}`);
  return {
    ...context,
    schema: {
      ...context.schema,
      // Additive: the same import as an operator's schema file, so it never drops anything.
      apply: async (document) => {
        const parsed = schemaDocument.parse(document);
        // Named with the plugin's prefix, or system.users wouldn't let it set them.
        const prefix = pluginPrefix(plugin.name);
        const foreign = (parsed.userFields ?? []).filter((field) => !field.name.startsWith(prefix)).map((field) => field.name);
        if (foreign.length) throw new Error(`user fields must start with "${prefix}": ${foreign.join(", ")}.`);
        await applySchema(parsed, { actorId: null, confirm: false, deleteMissing: false });
      },
      addFields: (slug, fields) => addCollectionFields(slug, fields, null),
      addOptions: (slug, field, options) => addFieldOptions(slug, field, options, null),
      addLabels: (slug, labels) => addCollectionLabels(slug, labels, null),
      addFieldLabels: (slug, fields) => addFieldLabels(slug, fields, null),
      addBlockFieldLabels: (block, fields) => addBlockFieldLabels(block, fields),
    },
    roles: { ensure: (role) => ensurePluginRole(plugin.name, role) },
  };
}

/** A validation error's field paths, so a plugin author sees which part of their schema was refused. */
function issuesOf(error: unknown) {
  const details = (error as { details?: unknown }).details;
  if (!Array.isArray(details)) return "";
  return details.slice(0, 10).map((issue: { path?: unknown; message?: unknown }) => ` ${String(issue.path)}: ${String(issue.message)}`).join("");
}

const appliedIds = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);

async function upgrade(plugin: CmsPlugin) {
  const state = await prisma.pluginState.findUnique({ where: { name: plugin.name } });
  if (state && isOlder(plugin.version, state.version)) throw new Error(`Plugin "${plugin.name}" is ${plugin.version}, but this database was already upgraded to ${state.version}. Install ${state.version} or later.`);

  const applied = appliedIds(state?.applied);
  const save = (version: string) => {
    const data = { version, applied: applied as Prisma.InputJsonValue };
    return prisma.pluginState.upsert({ where: { name: plugin.name }, create: { name: plugin.name, ...data }, update: data });
  };

  for (const migration of pendingMigrations(plugin, applied)) {
    try {
      await migration.up(migrationContext(plugin));
    } catch (error) {
      throw new Error(`Plugin "${plugin.name}": migration "${migration.id}" failed. ${(error as Error).message}${issuesOf(error)}`, { cause: error });
    }
    // After each one, so a later failure doesn't repeat what already worked.
    applied.push(migration.id);
    await save(state?.version ?? plugin.version);
  }

  if (!state) {
    await save(plugin.version);
    emitEvent("plugin.afterInstall", { plugin: { name: plugin.name, version: plugin.version } });
  } else if (state.version !== plugin.version) {
    await save(plugin.version);
    emitEvent("plugin.afterUpgrade", { plugin: { name: plugin.name, version: plugin.version }, previousVersion: state.version });
  }
}

/** Runs in the order plugins are listed. A failure stops startup, as the plugin's code expects these changes to be there. */
export async function runPluginMigrations() {
  for (const plugin of getCmsConfig().plugins ?? []) await upgrade(plugin);
}

const THEME_STATE = "theme:";

/**
 * Applies what a new theme version adds, once per version, for every installed theme. See
 * themeAdditions. A build with several themes seeds them all, because any tenant may choose any
 * of them, and each remembers what it named under its own key.
 */
export async function seedTheme() {
  for (const theme of installedThemes()) await seedOneTheme(theme);
}

async function seedOneTheme(theme: ThemeManifest) {
  if (!theme.schema) return;
  const name = `${THEME_STATE}${theme.name}`;
  const state = await prisma.pluginState.findUnique({ where: { name } });
  if (state?.version === theme.version) return;
  const document = schemaDocument.parse(theme.schema);
  const current = await exportSchema({ userFields: false });
  const seen = new Set(appliedIds(state?.applied));
  // Seeded before themes remembered what they named. A field missing from a collection it made may
  // be one the owner removed, so those collections are left as they are, as they were before.
  if (state && !seen.size) {
    for (const c of document.collections) if (current.collections.some((e) => e.slug === c.slug)) for (const f of c.fields) seen.add(`field:${c.slug}.${f.name}`);
  }
  try {
    await applySchema(themeAdditions(document, current, seen), { actorId: null, confirm: false, deleteMissing: false });
  } catch (error) {
    throw new Error(`Theme "${theme.name}": its schema could not be applied. ${(error as Error).message}${issuesOf(error)}`, { cause: error });
  }
  const applied = [...new Set([...seen, ...themeParts(document)])] as Prisma.InputJsonValue;
  await prisma.pluginState.upsert({ where: { name }, create: { name, version: theme.version, applied }, update: { version: theme.version, applied } });
}

export const listPluginStates = () => prisma.pluginState.findMany({ where: { name: { not: { startsWith: THEME_STATE } } }, select: { name: true, version: true } });
