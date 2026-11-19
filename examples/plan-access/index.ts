import { definePlugin, type PluginMigrationContext } from "tansy/plugin";

const ACCESS = "payments-access";
const PLANS = "payments-plans";
export const ARTICLES = "plan-access-articles";
export const LIBRARY = "plan-access-library";

const LOCKED = { createRule: null, updateRule: null, deleteRule: null };

/**
 * A record in no access is free, and one in an access opens to people whose plans include it.
 * `included:length = 0` is what makes the empty case free on purpose: without it, an empty
 * list compares as "" and matches everyone with no access too. See docs/plugins/payments.md §8.
 */
export const ARTICLE_RULE = 'status = "published" && (included:length = 0 || included ?= @request.auth.payments_access)';
/** Opens the whole collection to people whose plans include an access that lists it. */
export const LIBRARY_RULE = `status = "published" && @request.auth.payments_access ?= "${LIBRARY}"`;

/** Plans need an id in the chosen provider's form. These suit Stripe, the default, and only matter once someone pays. */
async function plan(context: PluginMigrationContext, name: string, priceId: string, includes: number[]) {
  try {
    await context.system.records.create(PLANS, { status: "published", name, priceId, includes });
  } catch (error) {
    console.warn(`[plan-access example] Couldn't add the "${name}" plan, probably because the payment provider takes another kind of id. Add it under Collections → Plans and include its access.`, error instanceof Error ? error.message : error);
  }
}

/**
 * Example of plan access from the Payments plugin: what a site sets up so subscriptions open
 * some articles and a whole library. Needs Payments, listed before it. To try it, add a
 * membership under Collections → Memberships, as a provider's webhook would, for plan pro or
 * library and state active. See docs/plugins/payments.md §8.
 */
export const planAccessExample = () => definePlugin({
  name: "plan-access-example",
  version: "0.1.0",
  apiVersion: 1,
  requires: { cms: "^0.1.0" },
  migrations: [{
    id: "001-demo",
    up: async (context) => {
      const { schema, system } = context;
      if (!(await schema.describe(ACCESS))) throw new Error("The plan access example needs the Payments plugin, listed before it in tansy.config.ts.");
      for (const slug of [ARTICLES, LIBRARY]) {
        if (await schema.describe(slug)) throw new Error(`A collection called "${slug}" already exists, and the plan access example didn't create it. Rename it under Dashboard → Collections, then start again.`);
      }
      await schema.apply({
        version: 1,
        collections: [
          {
            slug: ARTICLES,
            name: "Articles",
            description: "Free unless put in an access. Premium ones open to people whose plan includes their access.",
            rules: { listRule: ARTICLE_RULE, viewRule: ARTICLE_RULE, ...LOCKED },
            fields: [
              { name: "title", type: "text", config: { required: true, maxLength: 200 } },
              { name: "body", type: "text", config: { maxLength: 5000 } },
              { name: "included", type: "reference", config: { collection: ACCESS, displayField: "name", allowMultiple: true, label: "Included in", description: "Leave empty for everyone." } },
            ],
          },
          {
            slug: LIBRARY,
            name: "Library",
            description: `Only for people whose plan includes an access that opens ${LIBRARY}.`,
            rules: { listRule: LIBRARY_RULE, viewRule: LIBRARY_RULE, ...LOCKED },
            fields: [
              { name: "title", type: "text", config: { required: true, maxLength: 200 } },
              { name: "body", type: "text", config: { maxLength: 5000 } },
            ],
          },
        ],
      });
      const premium = await system.records.create(ACCESS, { status: "published", name: "Premium articles", description: "Articles put in it.", collections: [] });
      const library = await system.records.create(ACCESS, { status: "published", name: "The whole library", description: "Everything in the Library.", collections: [LIBRARY] });
      await plan(context, "pro", "price_demo_pro", [premium.id as number]);
      await plan(context, "library", "price_demo_library", [premium.id as number, library.id as number]);
      await system.records.create(ARTICLES, { status: "published", title: "Welcome", body: "In no access, so everyone can read it.", included: [] });
      await system.records.create(ARTICLES, { status: "published", title: "The premium deep dive", body: "In Premium articles, so it opens with the pro or library plan.", included: [premium.id] });
      await system.records.create(LIBRARY, { status: "published", title: "The complete guide", body: "The library plan opens everything here." });
    },
  }],
});
