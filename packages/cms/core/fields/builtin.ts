import { z } from "zod";
import { checked, configNumber, defineField, storedJson, storedString } from "./define";
import { featureSet, richTextProblem, richTextWords } from "./rich-text";
import { MAX_PATTERN_INPUT, patternProblem } from "./safe-pattern";

const MAX_ID = 2147483647;
const MAX_REFERENCES = 1000;
const length = configNumber(z.number().int().min(0));
const domains = z.array(z.string().trim().toLowerCase().min(1).max(253)).max(500).optional();
const options = z.array(z.object({
  label: z.string().max(200),
  /** The label in other interface languages, by language code, such as { "ar": "مسودة" }. `label` covers any language missing. */
  labels: z.record(z.string().max(35), z.string().max(200)).optional(),
  value: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  disabled: z.boolean().optional(),
})).min(1).max(1000).meta({ widget: "options" });
const fileConfig = {
  /** In bytes. */
  maxSize: configNumber(z.number().min(0)),
  allowedTypes: z.array(z.string().max(200)).max(200).optional(),
};
const fileId = () => storedString().min(1).max(255);
/** Ids, dates and numbers aren't words anyone searches for. */
const notText = () => [];

const selectable = (choices: z.output<typeof options>) => new Set(choices.filter((o) => !o.disabled).map((o) => o.value));
/** A string limited to the choices. The list also reaches the field's JSON Schema, so API clients and AI models are told the values. */
const choice = (allowed: Set<string>) => (allowed.size ? z.string().meta({ enum: [...allowed] }) : z.string());

function bounded(schema: z.ZodString, minimum?: number, maximum?: number) {
  const low = minimum === undefined ? schema : schema.min(minimum);
  return maximum === undefined ? low : low.max(maximum);
}

const domainOf = (host: string) => host.toLowerCase();
const matchesDomain = (host: string, list: string[]) => list.some((d) => host === d || host.endsWith(`.${d}`));

function domainProblem(host: string, allowed?: string[], blocked?: string[]) {
  if (allowed?.length && !matchesDomain(host, allowed)) return "This domain is not allowed.";
  if (blocked?.length && matchesDomain(host, blocked)) return "This domain is blocked.";
  return null;
}

const FORBIDDEN_PROTOCOLS = new Set(["javascript", "data", "vbscript", "file"]);
const protocol = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9+.-]*$/, "Use a protocol name such as https.")
  .refine((value) => !FORBIDDEN_PROTOCOLS.has(value), "This protocol is unsafe in links.");

const BLOCK_NAME = /^[a-z][a-z0-9_]{0,39}$/;
export const blockNameSchema = z.string().regex(BLOCK_NAME, "Use lowercase letters, numbers and underscores, starting with a letter.");
// Only the envelope. core/blocks/stream.ts checks each block against its definition.
export const storedBlock = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Use up to 64 letters, numbers, hyphens and underscores."),
  type: blockNameSchema,
  v: z.number().int().min(1).max(MAX_ID),
  value: z.record(z.string(), z.unknown()),
});

const isoDate = () => z.iso.date();
const isoDateTime = () => z.iso.datetime({ offset: true });

export const builtinFields = [
  defineField({
    type: "text",
    admin: { label: "Text", description: "Single or multi-line text", input: "text" },
    config: {
      minLength: length,
      maxLength: length,
      pattern: z.string().optional().superRefine((value, ctx) => {
        const message = value ? patternProblem(value) : null;
        if (message) ctx.addIssue({ code: "custom", message });
      }),
      patternError: z.string().max(500).optional(),
      multiline: z.boolean().optional(),
      rows: configNumber(z.number().int().min(1).max(100)),
    },
    value: ({ minLength, maxLength, pattern, patternError }) => {
      const text = bounded(storedString(), minLength, maxLength);
      if (!pattern) return text;
      const regex = new RegExp(pattern);
      return checked(text.max(MAX_PATTERN_INPUT), (value) => (regex.test(value) ? null : (patternError ?? "Does not match the required format.")));
    },
    storage: () => ({ sql: "text" }),
  }),
  defineField({
    type: "rich_text",
    admin: { label: "Rich text", description: "Formatted text, stored as structured JSON", input: "richtext" },
    config: { allowedFeatures: z.union([z.array(z.string().max(50)).max(50), z.record(z.string().max(50), z.boolean())]).optional() },
    // Structured editor JSON, never HTML (internal/NEXT_GEN_CMS_PLAN.md section 5).
    value: ({ allowedFeatures }) => {
      const allowed = featureSet(allowedFeatures);
      return storedJson(checked(z.record(z.string(), z.unknown()), (doc) => richTextProblem(doc, allowed)));
    },
    search: (doc) => richTextWords(doc),
    storage: () => ({ sql: "json" }),
  }),
  defineField({
    type: "stream",
    admin: { label: "Stream", description: "An ordered list of typed blocks", input: "stream" },
    config: {
      allowedBlocks: z.array(blockNameSchema).max(200).optional(),
      min: length,
      max: length,
      blockLimits: z.record(blockNameSchema, z.number().int().min(0)).optional(),
      /**
       * On a localized stream: the default language owns the blocks and their order, and other
       * languages only word them. See core/i18n/synced.ts.
       */
      synced: z.boolean().optional(),
    },
    value: ({ allowedBlocks, min, max, blockLimits }) => {
      let list = z.array(storedBlock).max(MAX_REFERENCES);
      if (min !== undefined) list = list.min(min);
      if (max !== undefined) list = list.max(max);
      return storedJson(checked(list, (blocks) => {
        const counts = new Map<string, number>();
        for (const { type } of blocks) {
          if (allowedBlocks && !allowedBlocks.includes(type)) return `Block "${type}" is not allowed here.`;
          const count = (counts.get(type) ?? 0) + 1;
          counts.set(type, count);
          const limit = blockLimits && Object.hasOwn(blockLimits, type) ? blockLimits[type] : Infinity;
          if (count > limit) return `Use block "${type}" at most ${limit} times.`;
        }
        return null;
      }));
    },
    storage: () => ({ sql: "json" }),
  }),
  defineField({
    type: "code",
    admin: { label: "Code", description: "Source code or preformatted text", input: "code" },
    config: {
      language: z.string().max(50).optional(),
      theme: z.enum(["light", "dark"]).optional(),
      lineNumbers: z.boolean().optional(),
      minLines: length,
      maxLines: length,
    },
    value: ({ minLines, maxLines }) => checked(storedString(), (value) => {
      const lines = value.split("\n").length;
      if (minLines !== undefined && lines < minLines) return `Must have at least ${minLines} lines.`;
      if (maxLines !== undefined && lines > maxLines) return `Must have at most ${maxLines} lines.`;
      return null;
    }),
    storage: () => ({ sql: "text" }),
  }),
  defineField({
    type: "number",
    admin: { label: "Number", description: "Integers and decimals", input: "number" },
    config: {
      min: configNumber(),
      max: configNumber(),
      step: configNumber(z.number().positive()),
      format: z.union([
        z.enum(["decimal", "integer", "percentage", "currency"]),
        z.object({ type: z.enum(["decimal", "integer", "percentage", "currency"]), precision: configNumber(z.number().int().min(0).max(20)), currency: z.string().max(10).optional(), locale: z.string().max(35).optional() }),
      ]).optional(),
    },
    value: ({ min, max, format }) => {
      const integer = format === "integer" || (typeof format === "object" && format.type === "integer");
      let number = integer ? z.number().int() : z.number();
      if (min !== undefined) number = number.min(min);
      if (max !== undefined) number = number.max(max);
      return number;
    },
    search: notText,
    storage: () => ({ sql: "real" }),
  }),
  defineField({
    type: "email",
    admin: { label: "Email", description: "A validated email address", input: "email" },
    config: { allowedDomains: domains, blockDomains: domains, confirmEmail: z.boolean().optional() },
    value: ({ allowedDomains, blockDomains }) =>
      checked(z.email().max(320), (value) => domainProblem(domainOf(value.split("@").pop()!), allowedDomains, blockDomains)),
    storage: () => ({ sql: "text" }),
  }),
  defineField({
    type: "url",
    admin: { label: "URL", description: "A validated link", input: "url" },
    config: { allowedProtocols: z.array(protocol).max(20).optional(), allowedDomains: domains, validateOnBlur: z.boolean().optional(), openInNewTab: z.boolean().optional() },
    value: ({ allowedProtocols, allowedDomains }) => {
      const protocols = allowedProtocols?.length ? allowedProtocols : ["http", "https"];
      return checked(z.url().max(2048), (value) => {
        const url = new URL(value);
        if (!protocols.includes(url.protocol.slice(0, -1))) return "This URL protocol is not allowed.";
        return domainProblem(domainOf(url.hostname), allowedDomains);
      });
    },
    storage: () => ({ sql: "text" }),
  }),
  defineField({
    type: "date",
    admin: { label: "Date", description: "A calendar date", input: "date" },
    config: {
      format: z.string().max(50).optional(),
      min: isoDate().optional(),
      max: isoDate().optional(),
      disabledDates: z.array(isoDate()).max(5000).optional(),
      disabledDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
      weekStartsOn: configNumber(z.number().int().min(0).max(6)),
    },
    value: ({ min, max, disabledDates, disabledDays }) => checked(isoDate(), (value) => {
      if (min && value < min) return `Must be on or after ${min}.`;
      if (max && value > max) return `Must be on or before ${max}.`;
      if (disabledDates?.includes(value)) return "This date is not available.";
      if (disabledDays?.includes(new Date(`${value}T00:00:00Z`).getUTCDay())) return "This day of the week is not available.";
      return null;
    }),
    search: notText,
    storage: () => ({ sql: "date" }),
  }),
  defineField({
    type: "datetime",
    admin: { label: "Date and time", description: "A moment in time", input: "datetime" },
    config: {
      format: z.string().max(50).optional(),
      min: isoDateTime().optional(),
      max: isoDateTime().optional(),
      weekStartsOn: configNumber(z.number().int().min(0).max(6)),
      timeFormat: z.enum(["12h", "24h"]).optional(),
      timeStep: configNumber(z.number().positive()),
      showTimeZone: z.boolean().optional(),
      defaultTimeZone: z.string().max(100).optional(),
    },
    value: ({ min, max }) => checked(isoDateTime(), (value) => {
      const at = Date.parse(value);
      if (min && at < Date.parse(min)) return `Must be at or after ${min}.`;
      if (max && at > Date.parse(max)) return `Must be at or before ${max}.`;
      return null;
    }),
    search: notText,
    storage: () => ({ sql: "datetime" }),
  }),
  // Values are file ids. The record service checks that each file exists and fits maxSize and allowedTypes.
  defineField({ type: "image", admin: { label: "Image", description: "One uploaded image", input: "image" }, config: fileConfig, value: fileId, search: notText, storage: () => ({ sql: "text", files: true }) }),
  defineField({ type: "file", admin: { label: "File", description: "One uploaded file", input: "file" }, config: fileConfig, value: fileId, search: notText, storage: () => ({ sql: "text", files: true }) }),
  defineField({
    type: "gallery",
    admin: { label: "Gallery", description: "A list of uploaded images or files", input: "gallery" },
    config: { ...fileConfig, minItems: length, maxItems: length, layout: z.enum(["grid", "list"]).optional() },
    value: ({ minItems, maxItems }) => {
      let list = z.array(fileId()).max(1000);
      if (minItems !== undefined) list = list.min(minItems);
      if (maxItems !== undefined) list = list.max(maxItems);
      return list;
    },
    search: notText,
    storage: () => ({ sql: "json", files: true }),
  }),
  defineField({
    type: "checkbox",
    admin: { label: "Checkboxes", description: "Pick several from a list", input: "multiselect" },
    config: { options, layout: z.enum(["vertical", "horizontal", "grid"]).optional(), minSelect: length, maxSelect: length },
    value: ({ options: choices, minSelect, maxSelect }) => {
      const allowed = selectable(choices);
      return checked(z.array(choice(allowed)), (value) => {
        if (new Set(value).size !== value.length) return "Choose each option only once.";
        if (value.some((item) => !allowed.has(item))) return "Contains an option that is not available.";
        if (minSelect !== undefined && value.length < minSelect) return `Choose at least ${minSelect}.`;
        if (maxSelect !== undefined && value.length > maxSelect) return `Choose at most ${maxSelect}.`;
        return null;
      });
    },
    storage: () => ({ sql: "json" }),
  }),
  defineField({
    type: "radio",
    admin: { label: "Single choice", description: "Pick one from a list", input: "select" },
    config: { options, layout: z.enum(["vertical", "horizontal"]).optional() },
    value: ({ options: choices }) => {
      const allowed = selectable(choices);
      return checked(choice(allowed), (value) => (allowed.has(value) ? null : "This option is not available."));
    },
    storage: () => ({ sql: "text" }),
  }),
  defineField({
    type: "reference",
    admin: { label: "Reference", description: "Link to a record in another collection", input: "reference" },
    config: {
      collection: z.preprocess((value) => (typeof value === "string" ? Number(value) : value), z.number().int().positive().max(MAX_ID)).meta({ widget: "collection" }),
      displayField: z.string().max(63).optional(),
      allowMultiple: z.boolean().optional(),
      minSelect: length,
      maxSelect: length,
    },
    value: ({ allowMultiple, minSelect, maxSelect }): z.ZodType<number | number[]> => {
      const id = z.number().int().positive().max(MAX_ID);
      if (!allowMultiple) return id;
      return checked(z.array(id).max(MAX_REFERENCES), (value) => {
        if (new Set(value).size !== value.length) return "Choose each record only once.";
        if (minSelect !== undefined && value.length < minSelect) return `Choose at least ${minSelect}.`;
        if (maxSelect !== undefined && value.length > maxSelect) return `Choose at most ${maxSelect}.`;
        return null;
      });
    },
    search: notText,
    // A list of record ids in one column, as PocketBase stores multi-value relations.
    storage: ({ collection, allowMultiple }) => ({ sql: allowMultiple ? "json" : "integer", references: collection }),
  }),
  defineField({
    type: "boolean",
    admin: { label: "Boolean", description: "True or false", input: "boolean" },
    config: { trueLabel: z.string().max(100).optional(), falseLabel: z.string().max(100).optional(), style: z.enum(["checkbox", "switch", "radio"]).optional() },
    value: () => z.boolean(),
    search: notText,
    storage: () => ({ sql: "boolean" }),
  }),
  defineField({
    type: "json",
    admin: { label: "JSON", description: "Any JSON value", input: "json" },
    config: { formatOnSave: z.boolean().optional(), height: configNumber(z.number().positive()), foldLevel: configNumber(z.number().int().min(0)) },
    value: () => storedJson(z.unknown()),
    search: notText,
    storage: () => ({ sql: "json" }),
  }),
];
