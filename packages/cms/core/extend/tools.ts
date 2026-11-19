import "server-only";
import { extensionScope } from "../scope/context";
import { z } from "zod";
import { audit } from "../audit";
import { isLocked } from "../authz/records";
import { systemPrincipal, type Principal } from "../authz/principal";
import { withinRole } from "../authz/roles";
import prisma from "../../lib/prisma";
import { allCollections, requireCollectionBySlug, type CollectionWithFields } from "../content/access";
import { readableFields } from "../content/records";
import { listBlockTypes, loadBlockCatalog } from "../blocks/service";
import { markdownToRichText } from "../fields/markdown";
import { badRequest, HttpError, notFound } from "../http/errors";
import { fieldSchema } from "../schema/describe";
import type { AgentTool, AgentToolContext, ExtensionTools, ToolInfo } from "./define";
import { extensionMail } from "./mail";
import { extensionCaptcha } from "../captcha";
import { scopedRecords } from "./records";
import { extensionTools } from "./registry";
import { extensionSchema } from "./schema";
import { extensionSettings } from "./settings";
import { pluginStore } from "./store";
import { extensionUsers } from "./users";
import { isLocalizedCollection, isLocalizedField, localizationOf } from "../i18n/context";
import { defaultLocale, listLocales } from "../i18n/locales";

const slug = z.string().min(1).max(63).describe("Collection slug, from list_collections");
const recordId = z.number().int().positive().describe("Record id");
const values = z.record(z.string(), z.unknown()).describe("Field values by field name, as describe_collection gives them, and optionally status: \"draft\" or \"published\". Rich text may be Markdown.");
const locale = z.string().max(35).optional().describe("Language code for a localized collection, such as fr. Reads fall back along the language's chain. Writes go to this language. The default language when left out.");

const listQuery = {
  locale,
  page: z.number().int().min(1).optional(),
  perPage: z.number().int().min(1).max(200).optional(),
  sort: z.string().max(500).optional().describe("Field names, comma-separated, with - for descending, such as -createdAt"),
  filter: z.string().max(2000).optional().describe("PocketBase-style filter, such as status = \"published\" && title ~ \"git\""),
  expand: z.string().max(500).optional().describe("Reference fields to include the linked records of"),
  fields: z.string().max(1000).optional().describe("Only these fields, comma-separated"),
};

const config = (field: { config?: unknown }) => (field.config ?? {}) as Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);

/** A collection's fields as the caller may read them, with the JSON Schema of each value. */
async function describe(collection: CollectionWithFields, principal: Principal) {
  const writable = !isLocked(principal, collection, "create") || !isLocked(principal, collection, "update") || principal.permissions.has("collection:read");
  // Block shapes are schema. Only someone who may write the collection, or read its schema, needs them.
  const blockTypes = writable && collection.fields.some((field) => field.type === "stream") ? await listBlockTypes() : [];
  return {
    slug: collection.slug,
    name: collection.name,
    type: collection.type,
    description: collection.description ?? undefined,
    readOnly: collection.type === "view",
    urlPattern: collection.urlPattern ?? undefined,
    ...(isLocalizedCollection(collection) ? { localization: { ...localizationOf(collection), locales: (await listLocales()).filter((entry) => entry.public).map((entry) => entry.code), defaultLocale: await defaultLocale() } } : {}),
    fields: readableFields(collection, principal).map((field) => {
      const options = config(field);
      const allowed = Array.isArray(options.allowedBlocks) ? new Set(options.allowedBlocks as string[]) : null;
      return {
        name: field.name,
        type: field.type,
        label: text(options.label),
        description: text(options.description) ?? text(options.hint),
        required: options.required === true,
        readonly: options.readonly === true || undefined,
        localized: isLocalizedField(collection, field) || undefined,
        schema: fieldSchema(field),
        ...(field.type === "stream" && writable ? {
          blocks: blockTypes.filter((block) => !allowed || allowed.has(block.name)).map((block) => ({
            name: block.name,
            label: block.label,
            version: block.version,
            fields: ((block.fields ?? []) as Array<{ name: string; type: string; config?: unknown }>).map((item) => ({ name: item.name, type: item.type, required: config(item).required === true, schema: fieldSchema({ type: item.type, config: item.config ?? null }) })),
          })),
        } : {}),
      };
    }),
  };
}

type FieldLike = { name: string; type: string; config?: unknown };
type Catalog = Awaited<ReturnType<typeof loadBlockCatalog>>;
const isPlain = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const MAX_DEPTH = 8;

/**
 * What models get wrong when writing records, filled in before the usual validation, which
 * still runs in full: rich text written as Markdown, and blocks without an id or version.
 */
function prepare(fields: FieldLike[], values: Record<string, unknown>, catalog: Catalog, depth = 0): Record<string, unknown> {
  if (depth > MAX_DEPTH) return values;
  const out = { ...values };
  for (const field of fields) {
    const value = out[field.name];
    if (field.type === "rich_text" && typeof value === "string") out[field.name] = markdownToRichText(value);
    if (field.type === "stream" && Array.isArray(value)) {
      out[field.name] = value.map((block) => {
        if (!isPlain(block) || typeof block.type !== "string") return block;
        const definition = catalog.get(block.type);
        const inner = isPlain(block.value) ? block.value : {};
        return {
          ...block,
          id: typeof block.id === "string" ? block.id : crypto.randomUUID(),
          v: typeof block.v === "number" ? block.v : definition?.version ?? 1,
          value: definition ? prepare(definition.fields, inner, catalog, depth + 1) : inner,
        };
      });
    }
  }
  return out;
}

async function prepared(slug: string, data: Record<string, unknown>) {
  const collection = await requireCollectionBySlug(slug);
  const catalog: Catalog = collection.fields.some((field) => field.type === "stream") ? await loadBlockCatalog() : new Map();
  return prepare(collection.fields, data, catalog);
}

/** Readable through the API at all: the same test list_collections uses. */
const visible = (principal: Principal, collection: CollectionWithFields) => principal.permissions.has("collection:read") || !isLocked(principal, collection, "list");

const builtIn = (tool: AgentTool): AgentTool => tool;

/** Core's own tools. Each runs through scopedRecords as the caller, so an agent gets exactly what the same person or key gets over REST. */
export const CORE_TOOLS: AgentTool[] = [
  builtIn({
    name: "list_collections",
    description: "List the collections you can read, with their fields. Call describe_collection for a collection's full field schemas before writing to it.",
    input: z.object({}),
    access: { access: "authenticated" },
    write: false,
    handler: async ({ principal }) => (await allCollections())
      .filter((collection) => visible(principal, collection))
      .map((collection) => ({ slug: collection.slug, name: collection.name, readOnly: collection.type === "view", singleton: collection.type === "singleton" || undefined, fields: readableFields(collection, principal).map((field) => ({ name: field.name, type: field.type, required: config(field).required === true })) })),
  }),
  builtIn({
    name: "describe_collection",
    description: "A collection's fields with the JSON Schema each value must match, and for stream fields the blocks they accept. Write a block as { type, value }, with value holding its fields, and rich text as Markdown. Records you read show blocks as { id, type, v, value }: keep id and v when changing a block.",
    input: z.object({ collection: slug }),
    access: { access: "authenticated" },
    write: false,
    handler: async ({ principal, input }) => {
      const collection = await requireCollectionBySlug((input as { collection: string }).collection);
      if (!visible(principal, collection)) throw notFound("Collection");
      return describe(collection, principal);
    },
  }),
  builtIn({
    name: "list_records",
    description: "List records in a collection. Results follow the collection's API rules.",
    input: z.object({ collection: slug, ...listQuery }),
    access: { access: "authenticated" },
    write: false,
    handler: ({ records, input }) => {
      const { collection, ...query } = input as { collection: string };
      return records.list(collection, query);
    },
  }),
  builtIn({
    name: "get_record",
    description: "Read one record.",
    input: z.object({ collection: slug, id: recordId, locale, expand: listQuery.expand, fields: listQuery.fields }),
    access: { access: "authenticated" },
    write: false,
    handler: ({ records, input }) => {
      const { collection, id, ...query } = input as { collection: string; id: number };
      return records.get(collection, id, query);
    },
  }),
  builtIn({
    name: "create_record",
    description: "Create a record. New records are drafts unless data.status is \"published\".",
    input: z.object({ collection: slug, data: values, locale }),
    access: { access: "authenticated" },
    write: true,
    audit: "record.create",
    handler: async ({ records, input }) => {
      const { collection, data, locale: code } = input as { collection: string; data: Record<string, unknown>; locale?: string };
      return records.create(collection, await prepared(collection, data), code ? { locale: code } : undefined);
    },
  }),
  builtIn({
    name: "update_record",
    description: "Change fields on a record. Fields not given stay as they are.",
    input: z.object({ collection: slug, id: recordId, data: values, locale }),
    access: { access: "authenticated" },
    write: true,
    audit: "record.update",
    handler: async ({ records, input }) => {
      const { collection, id, data, locale: code } = input as { collection: string; id: number; data: Record<string, unknown>; locale?: string };
      return records.update(collection, id, await prepared(collection, data), code ? { locale: code } : undefined);
    },
  }),
  builtIn({
    name: "delete_record",
    description: "Delete a record. This can't be undone.",
    input: z.object({ collection: slug, id: recordId }),
    access: { access: "authenticated" },
    write: true,
    audit: "record.delete",
    handler: async ({ records, input }) => {
      const { collection, id } = input as { collection: string; id: number };
      await records.delete(collection, id);
      return { deleted: true };
    },
  }),
];

interface Entry { source: string; tool: AgentTool }

const allTools = (): Entry[] => [...CORE_TOOLS.map((tool) => ({ source: "core", tool })), ...extensionTools().map(({ source, value }) => ({ source, tool: value }))];

const mayUse = (principal: Principal, tool: AgentTool) =>
  principal.kind !== "anonymous" && (tool.access.access === "authenticated" || principal.permissions.has(tool.access.permission));

const schemas = new WeakMap<AgentTool, Record<string, unknown>>();

/** JSON Schema of a tool's input, without the $schema line, which some clients refuse. */
export function inputSchemaOf(tool: AgentTool) {
  let schema = schemas.get(tool);
  if (!schema) {
    schema = z.toJSONSchema(tool.input, { unrepresentable: "any", io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    schemas.set(tool, schema);
  }
  return schema;
}

/** The tools this caller may run. */
export const toolsFor = (principal: Principal): Array<ToolInfo & { tool: AgentTool }> =>
  allTools().filter(({ tool }) => mayUse(principal, tool)).map(({ tool }) => ({ name: tool.name, description: tool.description, inputSchema: inputSchemaOf(tool), write: tool.write, tool }));

/** A plugin tool gets the same context as the plugin's routes. Core's tools only need records. */
function contextFor(source: string, principal: Principal, headers: Headers, input: unknown, auditTarget: AgentToolContext["auditTarget"]): AgentToolContext {
  return {
    input,
    principal,
    auditTarget,
    tools: extensionToolsFor(principal, headers, source),
    records: scopedRecords(principal, headers),
    system: { records: scopedRecords(systemPrincipal(source), new Headers(), source), users: extensionUsers(source) },
    store: pluginStore(source.replace(/^plugin:/, "")),
    mail: extensionMail(source),
    captcha: extensionCaptcha,
    schema: extensionSchema,
    scope: extensionScope(source),
    settings: extensionSettings(source),
  };
}

const issuesOf = (error: z.ZodError) => error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");

/** Ids an audit entry may name. Never field values, which can be anything the model wrote. */
function target(input: unknown, result: unknown) {
  const given = (input ?? {}) as { collection?: unknown; id?: unknown };
  const made = result && typeof result === "object" ? (result as { id?: unknown }).id : undefined;
  return {
    collection: typeof given.collection === "string" ? given.collection.slice(0, 63) : undefined,
    record: typeof given.id === "number" ? given.id : typeof made === "number" ? made : undefined,
  };
}

/**
 * Runs one tool as the caller. An unknown tool and one the caller may not run get the same
 * answer. Each call is audited on its own, so calls made while an answer streams are logged
 * too: `tool.call` for reads, the tool's own action for writes. `via` names the surface,
 * such as "mcp" or "plugin:ai".
 */
export async function callTool(name: string, raw: unknown, principal: Principal, headers: Headers, via: string, role?: string): Promise<unknown> {
  const entry = allTools().find(({ tool }) => tool.name === name);
  if (!entry || !mayUse(principal, entry.tool)) throw new HttpError(400, "UNKNOWN_TOOL", `Unknown tool "${String(name).slice(0, 100)}".`);
  const { source, tool } = entry;
  const parsed = tool.input.safeParse(raw ?? {});
  if (!parsed.success) throw badRequest(issuesOf(parsed.error));
  const actor = principal.kind === "anonymous" ? {} : { actorId: principal.user.id, actorEmail: principal.user.email, actorKind: principal.kind };
  // What the tool itself says it touched, such as a tenant. The tool's name stays in the entry either way.
  let named: { type: string; id: string; metadata?: Record<string, unknown> } | null = null;
  const log = (outcome: "success" | "failure", result?: unknown, code?: string) => audit({
    action: tool.write ? tool.audit! : "tool.call",
    outcome,
    ...actor,
    targetType: named?.type ?? "tool",
    targetId: named?.id ?? tool.name,
    metadata: { via, tool: tool.name, ...(role ? { role } : {}), ...target(parsed.data, result), ...named?.metadata, ...(code ? { reason: code } : {}) },
  });
  try {
    const result = await tool.handler(contextFor(source, principal, headers, parsed.data, (type, id, metadata) => { named = { type, id, metadata }; }));
    await log("success", result);
    return result ?? null;
  } catch (error) {
    await log("failure", undefined, error instanceof HttpError ? error.code : "ERROR");
    throw error;
  }
}

/**
 * What `context.tools` gives a plugin's route: every tool, as the route's caller. `withRole`
 * narrows them to what a role also grants, still as the caller, so records keep their owner
 * and nothing the caller lacks is ever added.
 */
export const extensionToolsFor = (principal: Principal, headers: Headers, source: string, role?: string): ExtensionTools => ({
  list: async () => toolsFor(principal).map(({ name, description, inputSchema, write }) => ({ name, description, inputSchema, write })),
  call: (name, input) => callTool(name, input, principal, headers, source, role),
  withRole: async (name) => {
    const { getRuntime } = await import("../auth/instance");
    const granted = (await getRuntime()).roles.get(name);
    if (!granted) throw new HttpError(400, "UNKNOWN_ROLE", `There's no role "${String(name).slice(0, 40)}". Choose one under Dashboard → Roles.`);
    return extensionToolsFor({ ...principal, permissions: withinRole(principal.permissions, granted) }, headers, source, name);
  },
  roles: async () => (await prisma.role.findMany({ orderBy: { createdAt: "asc" }, select: { name: true, label: true, description: true, scope: true } }))
    .map((role) => ({ name: role.name, label: role.label, ...(role.description ? { description: role.description } : {}), scope: role.scope === "scoped" ? "scoped" as const : "instance" as const })),
});
