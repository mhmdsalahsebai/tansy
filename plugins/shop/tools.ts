import { z } from "zod";
import { defineTool, type AgentToolContext, type RecordValues } from "tansy/plugin";
import { idOf } from "./logic";
import { PRODUCTS, VARIANTS } from "./schema";

const money = (what: string) => z.number().positive().max(1_000_000_000).describe(`${what}, in the shop's currency as people pay it, such as 19.99`);
const stock = z.number().int().min(0).max(1_000_000_000).describe("How many are left. Leave out for no count");

const productInput = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().max(500).optional().describe("One or two sentences for product lists"),
  price: money("The price"),
  compareAtPrice: money("An earlier, higher price shown struck through").optional(),
  sku: z.string().max(64).optional(),
  stock: stock.optional(),
  shipping: z.boolean().optional().describe("Sent by post. False for downloads and services"),
  weightGrams: z.number().int().min(0).max(10_000_000).optional(),
  categories: z.array(z.number().int().positive()).max(50).optional().describe("Category record ids, from list_records on shop-categories"),
  variants: z.array(z.object({
    title: z.string().min(1).max(120).describe("What buyers choose, such as Medium / Blue"),
    sku: z.string().max(64).optional(),
    price: money("This variant's price, when it differs from the product's").optional(),
    stock: stock.optional(),
  })).max(100).optional(),
});

/** Owners can remove fields, so only the ones the collection still has are written. */
async function keep(context: AgentToolContext, slug: string, values: RecordValues) {
  const names = new Set((await context.schema.describe(slug))?.fields.map((field) => field.name) ?? []);
  return Object.fromEntries(Object.entries(values).filter(([name, value]) => value !== undefined && names.has(name)));
}

const create = async (context: AgentToolContext, slug: string, values: RecordValues) =>
  (await context.tools.call("create_record", { collection: slug, data: await keep(context, slug, values) })) as RecordValues;

/** What an AI agent can do with the catalogue, as whoever asked. */
export const shopTools = [
  defineTool({
    name: "shop_create_product",
    description: "Create a product and its variants (sizes, colours) in one step, saved as drafts for a person to review and publish. Add images and a description afterwards in the dashboard, or with update_record.",
    input: productInput,
    access: { access: "authenticated" },
    write: true,
    audit: "shop.create_product",
    handler: async (context) => {
      const { variants = [], ...product } = context.input;
      const created = await create(context, PRODUCTS, { ...product, status: "draft" });
      const productId = idOf(created.id);
      if (productId === null) throw new Error("The product was created without an id.");
      const made: RecordValues[] = [];
      for (const [position, variant] of variants.entries()) made.push(await create(context, VARIANTS, { ...variant, product: productId, position, status: "draft" }));
      return { product: { id: productId, title: created.title, slug: created.slug }, variants: made.map((variant) => ({ id: variant.id, title: variant.title })) };
    },
  }),
];
