import "server-only";
import { Prisma, type UserField } from "../../generated/client-sqlite";
import { AUTH_RULE_FIELDS } from "../authz/rules/evaluate";
import { editorInput, fieldCatalogue, getFieldDefinition, isKnownFieldType, resolveFieldConfig, type Issue } from "../fields/registry";
import { validateValues } from "../fields/validate";
import { LOCK, serializeWrites } from "../content/locks";
import { getCmsConfig } from "../config";
import { pluginPrefix } from "../extend/manifest";
import { HttpError } from "../http/errors";
import { fieldNameProblem } from "../schema/names";
import { assertRulesHold } from "../schema/service";
import prisma from "../../lib/prisma";
import { isPostgres } from "../../lib/prisma/kind";

export const MAX_USER_FIELDS = 100;

/** Columns of the user table, so a custom field can never pass for one in a rule. */
const RESERVED = new Set([...AUTH_RULE_FIELDS, "image", "banned", "banReason", "banExpires", "password"].map((name) => name.toLowerCase()));

/** These need a column or per-record handling, so here they would look enforced without being so. */
const UNSUPPORTED_OPTIONS = ["unique", "readonly", "searchable", "showIf"];

export interface RequestedUserField {
  id?: number;
  name: string;
  type: string;
  config?: Record<string, unknown>;
  selfEditable?: boolean;
}

type Stored = Record<string, unknown>;

const canHoldUserValues = (type: string, config: Record<string, unknown>) => {
  const storage = getFieldDefinition(type).storage(config);
  // Startup upgrades rewrite records and blocks, not user profiles.
  return type !== "stream" && !storage.files && !storage.references && (getFieldDefinition(type).version ?? 1) === 1;
};

const configOf = (field: UserField) => (field.config ?? {}) as Record<string, unknown> & { hidden?: boolean; defaultValue?: unknown };

const listDefinitions = () => prisma.userField.findMany({ orderBy: { id: "asc" } });

export const userFieldNames = async () => (await prisma.userField.findMany({ select: { name: true } })).map((field) => field.name);

const present = (field: UserField) => ({ id: field.id, name: field.name, type: field.type, input: editorInput(field.type), config: configOf(field), selfEditable: field.selfEditable });

export const listUserFields = async () => (await listDefinitions()).map(present);

/** Field types the dashboard can offer, each with its generated config form. */
export const userFieldCatalogue = () => fieldCatalogue().filter(({ type }) => canHoldUserValues(type, {}) && type !== "reference");

const readProfile = async (userId: string) => ((await prisma.userProfile.findUnique({ where: { userId } }))?.values ?? {}) as Stored;

const valueOf = (field: UserField, stored: Stored) => (Object.hasOwn(stored, field.id) ? stored[field.id] : (configOf(field).defaultValue ?? null));

/**
 * Every custom value by name, for evaluating API rules, including hidden ones.
 * Rules run on the server, but this must never be serialized to a response.
 */
export async function ruleValues(userId: string): Promise<Record<string, unknown>> {
  const fields = await listDefinitions();
  if (!fields.length) return {};
  const stored = await readProfile(userId);
  return Object.fromEntries(fields.map((field) => [field.name, valueOf(field, stored) ?? ""]));
}

/** With no value yet, each field shows its default. Hidden fields are for those who manage users. */
export async function userFieldValues(userId: string, { includeHidden }: { includeHidden: boolean }) {
  const [fields, stored] = await Promise.all([listDefinitions(), readProfile(userId)]);
  return fields.filter((field) => includeHidden || !configOf(field).hidden).map((field) => ({ ...present(field), value: valueOf(field, stored) }));
}

/** What someone may see of their own account, by name. */
export async function visibleValues(userId: string) {
  return Object.fromEntries((await userFieldValues(userId, { includeHidden: false })).map(({ name, value }) => [name, value]));
}

const invalid = (issues: Issue[]) => new HttpError(400, "VALIDATION_FAILED", "Request validation failed.", issues);

async function writeValues(userId: string, fields: UserField[], clean: Stored) {
  const named = new Map(fields.map((field) => [field.name, field.id]));
  await prisma.$transaction(async (tx) => {
    // So two saves can't lose each other's values.
    await serializeWrites(tx, LOCK.userFields);
    const row = await tx.userProfile.findUnique({ where: { userId } });
    const merged: Stored = { ...((row?.values ?? {}) as Stored) };
    for (const [name, value] of Object.entries(clean)) {
      const id = named.get(name)!;
      if (value === null) delete merged[id];
      else merged[id] = value;
    }
    const values = merged as Prisma.InputJsonValue;
    await tx.userProfile.upsert({ where: { userId }, create: { userId, values }, update: { values } });
  });
}

function validated(fields: UserField[], submitted: Stored) {
  const names = new Set(fields.map((field) => field.name));
  const unknown = Object.keys(submitted).filter((name) => !names.has(name));
  if (unknown.length) throw invalid(unknown.map((name) => ({ path: name.slice(0, 100), message: "There is no such field." })));
  return validateValues(fields, submitted, {});
}

/** For someone who manages this user. The route has already called assertCanManage. */
export async function setUserValues(userId: string, submitted: Stored) {
  const fields = await listDefinitions();
  await writeValues(userId, fields, validated(fields, submitted));
}

/**
 * For a person editing their own account. A field they can't edit is refused,
 * because rules may rely on it: being able to set your own department or plan
 * would mean granting yourself whatever those rules protect.
 */
export async function setOwnValues(userId: string, submitted: Stored) {
  const fields = await listDefinitions();
  const locked = fields.filter((field) => !field.selfEditable && Object.hasOwn(submitted, field.name) && !configOf(field).hidden);
  if (locked.length) throw invalid(locked.map((field) => ({ path: field.name, message: "Only an administrator can change this field." })));
  // Hidden fields are refused as unknown, so this can't reveal that one exists.
  const editable = fields.filter((field) => field.selfEditable);
  const visible = fields.filter((field) => !configOf(field).hidden);
  const unknown = Object.keys(submitted).filter((name) => !visible.some((field) => field.name === name));
  if (unknown.length) throw invalid(unknown.map((name) => ({ path: name.slice(0, 100), message: "There is no such field." })));
  await writeValues(userId, fields, validated(editable, submitted));
}

/** The running plugin whose prefix a field name starts with, such as "lms" for lms_courses. That plugin may set it. */
export function pluginOwning(name: string): string | null {
  return (getCmsConfig().plugins ?? []).find((plugin) => name.startsWith(pluginPrefix(plugin.name)))?.name ?? null;
}

/**
 * The values of the fields `owns` accepts, by name, hidden ones included, for an
 * extension's server code. Null when there's no such user.
 */
export async function extensionValues(userId: string, owns: (name: string) => boolean): Promise<Record<string, unknown> | null> {
  const [user, fields, stored] = await Promise.all([prisma.user.findUnique({ where: { id: userId }, select: { id: true } }), listDefinitions(), readProfile(userId)]);
  if (!user) return null;
  return Object.fromEntries(fields.filter((field) => owns(field.name)).map((field) => [field.name, valueOf(field, stored)]));
}

/**
 * For an extension's server code, which has no person behind it to pass assertCanManage.
 * Only fields `owns` accepts, and never one users can edit themselves: rules rely on
 * these values, and the user could overwrite whatever the extension decided.
 * Returns the names written, for the audit log.
 */
export async function setExtensionValues(userId: string, submitted: Stored, owns: (name: string) => boolean, actor: string): Promise<string[]> {
  if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) throw new Error(`${actor}: setValues takes an object of values by field name.`);
  const names = Object.keys(submitted);
  if (!names.length) return [];
  const [user, fields] = await Promise.all([prisma.user.findUnique({ where: { id: userId }, select: { id: true } }), listDefinitions()]);
  if (!user) throw new HttpError(404, "NOT_FOUND", "User not found.");
  const byName = new Map(fields.map((field) => [field.name, field]));
  for (const name of names) {
    const field = byName.get(name);
    if (!owns(name)) throw new Error(`${actor} can't set the user field "${name.slice(0, 100)}". Extensions set only fields named with their own prefix.`);
    if (!field) throw new Error(`${actor}: there is no user field "${name.slice(0, 100)}". Declare it in a migration with schema.apply({ userFields }).`);
    if (field.selfEditable) throw new Error(`${actor}: users can edit "${name}" themselves, so an extension can't rely on it. Turn that off under Users → Fields.`);
  }
  const own = fields.filter((field) => names.includes(field.name));
  await writeValues(userId, fields, validated(own, submitted));
  return names;
}

/** Applies a full list: entries with an id are kept, the rest are added, and any not listed are removed along with their values. */
export function saveUserFields(requested: RequestedUserField[], confirm: boolean) {
  return prisma.$transaction(async (tx) => {
    await serializeWrites(tx, LOCK.userFields);
    const existing = await tx.userField.findMany();
    const byId = new Map(existing.map((field) => [field.id, field]));
    const issues: Issue[] = [];
    const seen = new Set<string>();
    const kept = new Set<number>();
    const resolved: Array<{ id?: number; name: string; type: string; config: Record<string, unknown>; selfEditable: boolean }> = [];

    requested.forEach((field, index) => {
      const at = `fields.${index}`;
      const lower = field.name.toLowerCase();
      const nameProblem = fieldNameProblem(field.name) ?? (RESERVED.has(lower) ? "This name is reserved for a built-in user field." : seen.has(lower) ? "Another field already uses this name." : null);
      if (nameProblem) issues.push({ path: `${at}.name`, message: nameProblem });
      seen.add(lower);

      const current = field.id === undefined ? undefined : byId.get(field.id);
      if (field.id !== undefined) {
        if (!current || kept.has(field.id)) return void issues.push({ path: `${at}.id`, message: "This field does not exist." });
        kept.add(field.id);
        // Stored values were validated for the old type, and nothing could convert them.
        if (current.type !== field.type) return void issues.push({ path: `${at}.type`, message: "A field's type can't change. Add a new field instead." });
      }

      // Its plugin is gone, so its config can't be checked. It can stay as it is, or be removed.
      if (current && !isKnownFieldType(current.type)) return void resolved.push({ id: current.id, name: current.name, type: current.type, config: configOf(current), selfEditable: current.selfEditable });

      const config = resolveFieldConfig(field.type, field.config);
      if (!config.ok) return void issues.push(...config.issues.map((issue) => ({ path: `${at}.${issue.path}`, message: issue.message })));
      if (!canHoldUserValues(field.type, config.config)) return void issues.push({ path: `${at}.type`, message: "User fields can't hold blocks, files or links to records." });
      for (const option of UNSUPPORTED_OPTIONS) {
        if (config.config[option]) issues.push({ path: `${at}.config.${option}`, message: "User fields do not support this option." });
      }
      if (config.config.hidden && field.selfEditable) issues.push({ path: `${at}.selfEditable`, message: "A hidden field can't be edited by the user it belongs to." });
      const owner = field.selfEditable ? pluginOwning(field.name) : null;
      if (owner) issues.push({ path: `${at}.selfEditable`, message: `The ${owner} plugin sets this field, so users can't edit it themselves.` });
      resolved.push({ id: field.id, name: field.name, type: field.type, config: config.config, selfEditable: field.selfEditable === true });
    });
    if (issues.length) throw invalid(issues);

    const removed = existing.filter((field) => !kept.has(field.id));
    if (removed.length && !confirm) {
      throw new HttpError(409, "CONFIRMATION_REQUIRED", "This change would lose data. Resend with confirm set to true.", removed.map((field) => ({ path: field.name, message: `Removing ${field.name} deletes every user's value.` })));
    }

    await assertRulesHold(tx, "An API rule uses a user field this change removes or renames. Update the rule first.", () => {}, [], resolved.map((field) => field.name));

    for (const field of removed) {
      await tx.userField.delete({ where: { id: field.id } });
      if (isPostgres()) await tx.$executeRaw`UPDATE "UserProfile" SET "values" = "values" - ${String(field.id)}`;
      else await tx.$executeRaw`UPDATE "UserProfile" SET "values" = json_remove("values", ${`$."${field.id}"`})`;
    }
    // Names free up before they're reused, and a temporary name lets two fields swap.
    for (const field of resolved) {
      if (field.id !== undefined && byId.get(field.id)!.name !== field.name) await tx.userField.update({ where: { id: field.id }, data: { name: `__renaming_${field.id}` } });
    }
    for (const { id, name, type, config, selfEditable } of resolved) {
      const data = { name, type, config: config as Prisma.InputJsonValue, selfEditable };
      if (id === undefined) await tx.userField.create({ data });
      else await tx.userField.update({ where: { id }, data });
    }
    return (await tx.userField.findMany({ orderBy: { id: "asc" } })).map(present);
  });
}
