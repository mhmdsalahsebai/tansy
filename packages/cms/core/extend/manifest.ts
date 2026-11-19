import { z } from "zod";
import { TANSY_VERSION } from "../version";
import { defineCsp } from "./csp";
import { PLUGIN_API_VERSION, type CmsPlugin, type ExtensionRoute, type PluginMigration } from "./define";
import { isVersion, satisfies } from "./semver";
import { settingsProblem } from "./settings-schema";

const PLUGIN_NAME = /^[a-z][a-z0-9-]{0,39}$/;
// Written into generated import statements, so nothing but a module path gets through.
const MODULE = /^(?:\.{1,2}\/|(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*\/?)[A-Za-z0-9._/-]*$/;
const ROOT_FILE = /^\/[A-Za-z0-9._~-]+\.[A-Za-z0-9]+$/;
const AUTH_PATH = /^(?:\/[A-Za-z0-9._~:-]+)+$/;

const COLLECTION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MIGRATION_ID = /^[A-Za-z0-9._-]{1,100}$/;

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

const EVERY_PAGE_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/** Core's agent tools, which no plugin's tool may be named. `core/extend/tools.ts` defines them. */
export const CORE_TOOL_NAMES = ["list_collections", "describe_collection", "list_records", "get_record", "create_record", "update_record", "delete_record"];

/** What's left to run, in order. A migration added before one already run would run out of the order its author wrote, so that stops startup. */
export function pendingMigrations(plugin: Pick<CmsPlugin, "name" | "migrations">, applied: string[]): PluginMigration[] {
  const migrations = plugin.migrations ?? [];
  const seen = new Set<string>();
  for (const { id } of migrations) {
    if (!MIGRATION_ID.test(id)) throw new Error(`Plugin "${plugin.name}": invalid migration id "${id}".`);
    if (seen.has(id)) throw new Error(`Plugin "${plugin.name}": migration "${id}" is listed twice.`);
    seen.add(id);
  }
  const firstPending = migrations.findIndex(({ id }) => !applied.includes(id));
  if (firstPending === -1) return [];
  const outOfOrder = migrations.slice(firstPending).find(({ id }) => applied.includes(id));
  if (outOfOrder) throw new Error(`Plugin "${plugin.name}": migration "${migrations[firstPending].id}" comes before "${outOfOrder.id}", which has already run. Add new migrations at the end.`);
  return migrations.slice(firstPending);
}

/** What this plugin's field types and blocks start with, so two plugins can't reach for the same name. */
export const pluginPrefix = (name: string) => `${name.replaceAll("-", "_")}_`;

/** Stops startup with a message naming the plugin and what to do. */
export function assertPluginManifest(plugin: CmsPlugin, cmsVersion: string = TANSY_VERSION) {
  const label = `Plugin "${plugin.name}"`;
  const fail = (problem: string): never => { throw new Error(`${label}: ${problem}`); };

  if (!PLUGIN_NAME.test(plugin.name)) fail("the name must be lowercase letters, digits and hyphens, starting with a letter.");
  if (typeof plugin.version !== "string" || !isVersion(plugin.version)) fail(`version must look like 1.2.0. Got "${plugin.version}".`);
  if (plugin.apiVersion !== PLUGIN_API_VERSION) fail(`it was built for plugin API ${plugin.apiVersion}, and this CMS provides API ${PLUGIN_API_VERSION}. Install a version of the plugin made for it.`);

  const wanted = plugin.requires?.cms;
  if (wanted !== undefined) {
    let matches = false;
    try {
      matches = satisfies(cmsVersion, wanted);
    } catch (error) {
      fail(`requires.cms is not usable. ${(error as Error).message}`);
    }
    if (!matches) fail(`it requires tansy ${wanted}, and this is ${cmsVersion}. Upgrade one of them, or remove the plugin from tansy.config.ts.`);
  }

  for (const [slot, specifier] of Object.entries(plugin.admin ?? {})) {
    if (!MODULE.test(specifier)) fail(`admin.${slot} must be a module path such as "@acme/plugin/admin". Got "${specifier}".`);
  }
  try {
    defineCsp(plugin.csp ?? {});
  } catch (error) {
    fail((error as Error).message);
  }

  pendingMigrations(plugin, []);

  const prefix = pluginPrefix(plugin.name);
  for (const field of plugin.fields ?? []) {
    if (!field.type.startsWith(prefix)) fail(`field type "${field.type}" must start with "${prefix}".`);
  }
  for (const block of plugin.blocks ?? []) {
    if (!block.name.startsWith(prefix)) fail(`block "${block.name}" must start with "${prefix}".`);
  }
  for (const [name, props] of Object.entries(plugin.everyPage ?? {})) {
    if (!name.startsWith(`${plugin.name}-`) || !EVERY_PAGE_NAME.test(name)) fail(`everyPage "${name}" must be lowercase letters, digits and hyphens, starting with "${plugin.name}-".`);
    if (typeof props !== "function") fail(`everyPage "${name}" needs a function returning its props.`);
  }
  for (const [slug, fields] of Object.entries(plugin.contract ?? {})) {
    if (!COLLECTION_SLUG.test(slug)) fail(`contract names "${slug}", which isn't a collection slug.`);
    for (const [name, type] of Object.entries(fields)) {
      if (typeof type !== "string" || !type) fail(`contract field "${slug}.${name}" needs a field type, such as "text".`);
    }
  }
  for (const tool of plugin.tools ?? []) {
    const name = typeof tool?.name === "string" ? tool.name : "";
    if (!TOOL_NAME.test(name)) fail(`tool "${name}" needs a name of lowercase letters, digits and underscores.`);
    if (!name.startsWith(prefix)) fail(`tool "${name}" must start with "${prefix}".`);
    if (CORE_TOOL_NAMES.includes(name)) fail(`tool "${name}" has the name of one of core's tools.`);
    if (typeof tool.description !== "string" || !tool.description.trim() || tool.description.length > 2000) fail(`tool "${name}" needs a description of up to 2,000 characters, for the model choosing a tool.`);
    if (!tool.input || typeof (tool.input as { safeParse?: unknown }).safeParse !== "function") fail(`tool "${name}" needs a zod schema as its input.`);
    let schema: { type?: unknown } = {};
    try {
      schema = z.toJSONSchema(tool.input, { unrepresentable: "throw", io: "input" });
    } catch {
      fail(`tool "${name}" has an input JSON Schema can't express, which MCP clients would get wrong. Keep to objects, strings, numbers, booleans, arrays and enums.`);
    }
    if (schema.type !== "object") fail(`tool "${name}" must take an object, such as z.object({ ... }).`);
    if (typeof tool.write !== "boolean") fail(`tool "${name}" must say whether it writes, with write: true or false.`);
    if (tool.write && !tool.audit) fail(`tool "${name}" writes, so it must declare an audit action.`);
    if (typeof tool.handler !== "function") fail(`tool "${name}" needs a handler.`);
  }
  if (plugin.translator !== undefined) {
    const { label, translate } = plugin.translator ?? {};
    if (typeof label !== "string" || !label.trim() || label.length > 60) fail("translator needs a label of up to 60 characters, such as \"DeepL\".");
    if (typeof translate !== "function") fail("translator needs a translate(segments, { from, to }) function.");
  }
  for (const route of plugin.routes ?? []) {
    if (route.root && !ROOT_FILE.test(route.path)) fail(`route ${route.path} can't use root: true. Only a single file name, such as /sitemap.xml, is served at the site root.`);
  }

  for (const path of plugin.auth?.serverOnlyPaths ?? []) {
    if (typeof path !== "string" || !AUTH_PATH.test(path)) fail(`auth.serverOnlyPaths must list better-auth paths such as "/acme/portal". Got "${String(path)}".`);
  }

  for (const slug of plugin.systemCollections ?? []) {
    if (typeof slug !== "string" || !slug.startsWith(`${plugin.name}-`)) fail(`systemCollections must list the plugin's own collections, starting with "${plugin.name}-". Got "${String(slug)}".`);
  }

  for (const permission of plugin.scopedPermissions ?? []) {
    const [resource, action] = typeof permission === "string" ? permission.split(":") : [];
    if (!resource || !action || !(plugin.permissions?.[resource] ?? []).includes(action)) fail(`scopedPermissions must list the plugin's own permissions. Got "${String(permission)}".`);
    if (action === "all") fail(`"${permission}" reaches every scope value, so it can't be in scopedPermissions.`);
  }

  if (plugin.settings) {
    const problem = Array.isArray(plugin.settings.fields) ? settingsProblem(plugin.settings.fields) : "settings.fields must be a list.";
    if (problem) fail(problem);
    for (const field of plugin.settings.fields) {
      if (field.type !== "text" || !field.suggestions) continue;
      if (!(plugin.routes ?? []).some((route) => route.method === "GET" && route.path === field.suggestions!.route)) fail(`setting "${field.name}": suggestions.route ${field.suggestions.route} isn't one of the plugin's GET routes.`);
    }
  }

  if (plugin.options) {
    const parsed = plugin.options.schema.safeParse(plugin.options.value);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      fail(`invalid option${issue.path.length ? ` "${issue.path.join(".")}"` : ""}: ${issue.message}`);
    }
  }
}

/**
 * Where a plugin's routes are served: under /api/ext/<plugin>/, and at the root of
 * the extension API too when a route declares a root file such as /sitemap.xml.
 */
export function pluginRoutes(plugin: CmsPlugin): ExtensionRoute[] {
  return (plugin.routes ?? []).flatMap((route) => [
    { ...route, path: `/${plugin.name}${route.path}` },
    ...(route.root ? [route] : []),
  ]);
}
