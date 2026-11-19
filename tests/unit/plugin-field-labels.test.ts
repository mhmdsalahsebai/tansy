/**
 * First-party plugins' field words in Arabic: every field, block field and choice they make
 * has a label in Arabic, and every word they add names a field or choice that exists. A field
 * renamed without its words would otherwise go back to English without anyone noticing.
 */
import { describe, expect, it } from "vitest";
import type { CmsPlugin, FieldLabels, PluginMigrationContext } from "@/core/extend/define";
import { blog } from "../../plugins/blog/index";
import { email } from "../../plugins/email/index";
import { forms } from "../../plugins/forms/index";
import { lms } from "../../plugins/lms/index";
import { payments } from "../../plugins/payments/index";
import { shop } from "../../plugins/shop/index";
import { resend } from "../../plugins/email-resend/index";
import { stripe } from "../../plugins/payments-stripe/index";

interface Field { name: string; type: string; config?: Record<string, unknown> & { options?: Array<{ label: string; value: string; labels?: Record<string, string> }> } }

/** What a plugin's migrations make, replayed without a database. */
async function replay(plugins: CmsPlugin[]) {
  const collections = new Map<string, Field[]>();
  const blocks = new Map<string, Field[]>();
  const words: Array<{ kind: "collection" | "block"; target: string; fields: Record<string, FieldLabels> }> = [];
  const fieldsOf = (slug: string) => collections.get(slug) ?? [];
  const context = {
    schema: {
      describe: async (slug: string) => (collections.has(slug) ? { slug, fields: fieldsOf(slug) } : null),
      apply: async (document: { collections?: Array<{ slug: string; fields: Field[] }>; blocks?: Array<{ name: string; fields: Field[] }> }) => {
        for (const collection of document.collections ?? []) collections.set(collection.slug, structuredClone(collection.fields));
        for (const block of document.blocks ?? []) blocks.set(block.name, structuredClone(block.fields));
      },
      addFields: async (slug: string, fields: Field[]) => { collections.set(slug, [...fieldsOf(slug), ...structuredClone(fields)]); return true; },
      addOptions: async (slug: string, name: string, options: Array<{ label: string; value: string }>) => {
        const field = fieldsOf(slug).find((candidate) => candidate.name === name)!;
        field.config = { ...field.config, options: [...(field.config?.options ?? []), ...options] };
        return true;
      },
      addLabels: async () => true,
      addFieldLabels: async (target: string, fields: Record<string, FieldLabels>) => { words.push({ kind: "collection", target, fields }); return true; },
      addBlockFieldLabels: async (target: string, fields: Record<string, FieldLabels>) => { words.push({ kind: "block", target, fields }); return true; },
    },
    system: { records: { create: async () => ({}), list: async () => ({ items: [], totalItems: 0 }) } },
    roles: { ensure: async () => true },
  } as unknown as PluginMigrationContext;
  for (const plugin of plugins) for (const migration of plugin.migrations ?? []) await migration.up(context);
  return { collections, blocks, words };
}

/** Every label each field and choice would show in Arabic, after the migrations' words. */
function arabicGaps(fields: Field[], given: Record<string, FieldLabels> = {}): string[] {
  return fields.flatMap((field) => {
    const words = given[field.name];
    const gaps = field.config?.labels && "ar" in (field.config.labels as object) ? [] : words?.labels?.ar ? [] : [field.name];
    for (const option of field.config?.options ?? []) {
      if (!option.labels?.ar && !words?.options?.[option.value]?.ar) gaps.push(`${field.name}.${option.value}`);
    }
    if (field.config?.description && !(field.config.descriptions as Record<string, string> | undefined)?.ar && !words?.descriptions?.ar) gaps.push(`${field.name} (description)`);
    return gaps;
  });
}

/** Words that name a field or choice the plugin doesn't make. */
function strays(fields: Field[], given: Record<string, FieldLabels>): string[] {
  return Object.entries(given).flatMap(([name, words]) => {
    const field = fields.find((candidate) => candidate.name === name);
    if (!field) return [name];
    const values = new Set((field.config?.options ?? []).map((option) => option.value));
    return Object.keys(words.options ?? {}).filter((value) => !values.has(value)).map((value) => `${name}.${value}`);
  });
}

const SITE = "https://example.com";
const CASES: Array<[string, CmsPlugin[], string]> = [
  ["blog", [blog({ siteUrl: SITE })], "blog-"],
  ["email", [email({ providers: [resend()] })], "email-"],
  ["forms", [forms()], "forms-"],
  ["lms", [lms()], "lms-"],
  ["payments", [payments({ providers: [stripe()], siteUrl: SITE })], "payments-"],
  // The shop needs Payments' collections, so it's replayed after them.
  ["shop", [payments({ providers: [stripe()], siteUrl: SITE }), shop({ siteUrl: SITE })], "shop-"],
];

describe.each(CASES)("the %s plugin's fields", (_name, plugins, prefix) => {
  it("name only fields and choices it makes", async () => {
    const { collections, blocks, words } = await replay(plugins);
    for (const { kind, target, fields } of words.filter((entry) => entry.target.startsWith(prefix) || entry.kind === "block")) {
      const made = (kind === "collection" ? collections : blocks).get(target);
      expect(made, `${kind} ${target}`).toBeDefined();
      expect(strays(made!, fields), `${kind} ${target}`).toEqual([]);
    }
  });

  it("all have a label in Arabic, as do their choices and descriptions", async () => {
    const plugin = plugins.at(-1)!;
    const { collections, blocks, words } = await replay(plugins);
    const given = (kind: "collection" | "block", target: string) => Object.assign({}, ...words.filter((entry) => entry.kind === kind && entry.target === target).map((entry) => entry.fields)) as Record<string, FieldLabels>;
    for (const [slug, fields] of collections) if (slug.startsWith(prefix)) expect(arabicGaps(fields, given("collection", slug)), slug).toEqual([]);
    for (const [name, fields] of blocks) expect(arabicGaps(fields, given("block", name)), name).toEqual([]);
    for (const block of plugin.blocks ?? []) expect(arabicGaps(block.fields as Field[]), block.name).toEqual([]);
  });
});
