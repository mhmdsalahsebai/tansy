import { z } from "zod";
import { definePlugin, defineRoute, wordsIn, type AfterHookContext, type BeforeHookContext, type ExtensionContext, type ExtensionRouteContext } from "tansy/plugin";
import { check, duplicateNames, fieldsOf, issueToken, newKey, notification, pageOf, recipients, tokenProblem } from "./logic";
import { COLLECTIONS, CONTRACT, FIELD_BLOCKS, FORMS, formsSchema, SUBMISSIONS } from "./schema";
import { BLOCK_FIELD_LABELS, COLLECTION_LABELS, FIELD_LABELS, messages } from "./messages";
import { siteMessages } from "./site-messages";

export { fieldsOf, type FormField } from "./logic";

export interface FormsOptions {
  /** Who gets each submission, separated by commas, until changed under Forms → Settings. A form can name its own. */
  notify?: string;
}

const optionsSchema = z.strictObject({ notify: z.string().max(1000) });

interface FormsSettings { notify: string; minSeconds: number; keepDays: number }
const settingsOf = async (context: ExtensionContext) => (await context.settings.get()) as unknown as FormsSettings;

const idOf = (value: unknown) => {
  const id = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
};
const str = (value: unknown) => (typeof value === "string" ? value : "");

const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => Response.json({ error: { code, message }, ...extra }, { status });

/** The key that signs forms' tokens, made once and kept in the plugin's store. Of two first requests, one key wins. */
async function signingKey(context: ExtensionContext) {
  const existing = await context.store.get("signing-key");
  if (typeof existing === "string") return existing;
  await context.store.claim("signing-key", newKey());
  return String(await context.store.get("signing-key"));
}

/**
 * The visitor's language, from `locale`, when the site is published in more than one: the
 * form is read in it and its answers checked in it. Otherwise the default language, in English words.
 */
async function visitorLanguage(context: ExtensionRouteContext, asked: string | null | undefined) {
  const languages = await context.schema.languages();
  const locale = asked && languages.items.length > 1 && languages.items.some((item) => item.code === asked) ? asked : null;
  return { read: locale ? { locale } : {}, t: wordsIn(siteMessages, locale ?? "en").t };
}

/** The form as the caller may see it, in their language: published, unless they're staff who can read drafts. Null when they can't. */
async function readForm(context: ExtensionRouteContext, id: number, read: { locale?: string } = {}) {
  return context.records.get(FORMS, id, read).catch(() => null);
}

const FORM_REASON = "Visitors fill in forms signed out. It serves only a form the collection's view rule shows the caller, without its hidden fields.";
const SUBMIT_REASON = "Visitors send forms signed out. It accepts only a form the view rule shows them, checks every answer against the form, and is rate limited per address.";

const submitBody = z.strictObject({
  values: z.record(z.string().max(40), z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()])).refine((values) => Object.keys(values).length <= 60, "Too many answers."),
  token: z.string().max(200),
  answer: z.string().max(4096).optional(),
  /** The trap: a field people never see. Anything in it is a script. */
  website: z.string().max(2000).optional(),
  page: z.string().max(2000).optional(),
  /** The page's language, on a site with more than one. */
  locale: z.string().min(2).max(35).optional(),
});

/** Before a form is saved: every field's name is its own, and the addresses to notify are addresses. */
function checkForm(context: BeforeHookContext) {
  const { values, reject } = context;
  if (Object.hasOwn(values, "fields")) {
    const twice = duplicateNames(values.fields);
    if (twice.length) reject(`Two fields are named "${twice[0]}". Give each field its own name.`, "fields");
  }
  if (Object.hasOwn(values, "notify") && str(values.notify).trim()) {
    const given = str(values.notify).split(/[,;\s]+/).filter(Boolean);
    if (recipients(values.notify, "").length !== given.length) reject("List email addresses separated by commas.", "notify");
  }
}

/** Tells whoever the form names, replying to the visitor. A failed delivery is only logged by core, and the submission is already saved. */
async function announce(context: AfterHookContext) {
  const { record, system, mail } = context;
  if (record.state === "spam") return;
  const formId = idOf(record.form);
  const form = formId === null ? null : await system.records.get(FORMS, formId).catch(() => null);
  if (!form) return;
  const to = recipients(form.notify, (await settingsOf(context)).notify);
  if (!to.length) return;
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : {};
  const replyTo = typeof record.email === "string" && record.email ? record.email : undefined;
  for (const address of to) {
    // In the language of the person it goes to, when they have an account, else the site's default.
    const locale = (await system.users.findByEmail(address))?.locale ?? (await context.schema.languages()).defaultLocale;
    const { subject, body } = notification(str(form.title), fieldsOf(form.fields), data, str(record.page), wordsIn(siteMessages, locale).t);
    await mail.send({ to: address, locale, subject, body, ...(replyTo ? { replyTo } : {}) });
  }
}

/** Removes submissions older than the setting, a page at a time. Nothing when it's 0. */
async function forgetOldSubmissions(context: ExtensionContext) {
  const days = (await settingsOf(context)).keepDays;
  if (!Number.isInteger(days) || days < 1) return;
  const before = new Date(Date.now() - days * 86_400_000).toISOString();
  for (let round = 0; round < 50; round++) {
    const { items } = await context.system.records.list(SUBMISSIONS, { filter: `createdAt < "${before}"`, perPage: 200, fields: "id" });
    if (!items.length) return;
    for (const { id } of items) await context.system.records.delete(SUBMISSIONS, id as number);
  }
}

/**
 * Forms visitors fill in, such as a contact form: built from field blocks, put on any page
 * with the Form block, kept as submissions only staff read, and emailed to whoever the form
 * names. Spam is kept out by a trap field, a minimum time to fill in, a rate limit per
 * address and, once one is set up, the site's CAPTCHA. See docs/plugins/forms.md.
 */
export function forms(options: FormsOptions = {}) {
  const value = optionsSchema.parse({ notify: "", ...Object.fromEntries(Object.entries(options).filter(([, option]) => option !== undefined)) });

  return definePlugin({
    name: "forms",
    messages,
    version: "0.1.0",
    apiVersion: 1,
    requires: { cms: "^0.1.0" },
    admin: { server: "@tansy/forms/admin", render: "@tansy/forms/render" },
    options: { schema: optionsSchema, value },
    settings: {
      fields: [
        { name: "notify", type: "text", perScope: true, default: value.notify, maxLength: 1000, label: "Email submissions to", description: "Addresses separated by commas, for forms that don't name their own. Empty sends no email: submissions are still kept." },
        { name: "minSeconds", type: "number", perScope: true, integer: true, min: 0, max: 60, default: 3, label: "Fastest a person fills in a form (seconds)", description: "Anything sent sooner after the form loaded is refused as a script. 0 turns this off." },
        { name: "keepDays", type: "number", perScope: true, integer: true, min: 0, max: 3650, default: 0, label: "Delete submissions after (days)", description: "0 keeps them until someone deletes them." },
      ],
    },
    contract: CONTRACT,
    blocks: FIELD_BLOCKS,
    hooks: {
      "record.beforeCreate": (context) => { if (context.collection.slug === FORMS) checkForm(context); },
      "record.beforeUpdate": (context) => { if (context.collection.slug === FORMS) checkForm(context); },
      "record.afterCreate": async (context) => { if (context.collection.slug === SUBMISSIONS) await announce(context); },
    },
    routes: [
      defineRoute({
        method: "GET",
        path: "/forms/:id",
        access: "public",
        reason: FORM_REASON,
        handler: async (context) => {
          const id = idOf(context.params.id);
          const { read, t } = await visitorLanguage(context, new URL(context.request.url).searchParams.get("locale"));
          const form = id === null ? null : await readForm(context, id, read);
          if (!form || id === null) return refuse(404, "NOT_FOUND", t("forms.refusals.notFound"));
          const captcha = form.captcha === false ? null : await context.captcha.widget();
          return Response.json({
            id,
            title: str(form.title),
            fields: fieldsOf(form.fields),
            submitLabel: str(form.submitLabel).trim() || t("forms.send"),
            captcha,
            token: await issueToken(await signingKey(context), id),
          }, { headers: { "cache-control": "no-store" } });
        },
      }),
      defineRoute({
        method: "POST",
        path: "/forms/:id/submit",
        access: "public",
        reason: SUBMIT_REASON,
        audit: "forms.submit",
        body: submitBody,
        // Per address and form: a person sends one now and then, a script hundreds.
        rateLimit: { window: 600, max: 5 },
        handler: async (context) => {
          const body = context.body as z.output<typeof submitBody>;
          const id = idOf(context.params.id);
          const { read, t } = await visitorLanguage(context, body.locale);
          const form = id === null ? null : await readForm(context, id, read);
          if (!form || id === null) return refuse(404, "NOT_FOUND", t("forms.refusals.notFound"));
          const thanks = { ok: true, message: str(form.successMessage).trim() || t("forms.thanks") };
          // Answer a filled trap as if it worked, so the script learns nothing. Nothing is kept.
          if (body.website?.trim()) return thanks;

          const settings = await settingsOf(context);
          const timing = await tokenProblem(await signingKey(context), id, body.token, settings.minSeconds);
          if (timing === "early") return refuse(400, "TOO_FAST", t("forms.refusals.tooFast"));
          if (timing !== "ok") return refuse(400, "FORM_EXPIRED", t("forms.refusals.expired"));

          const fields = fieldsOf(form.fields);
          const { data, errors, replyTo } = check(fields, body.values, t);
          if (Object.keys(errors).length) return refuse(400, "INVALID_ANSWERS", t("forms.refusals.invalid"), { fields: errors });
          if (!fields.length) return refuse(400, "NO_FIELDS", t("forms.refusals.noFields"));

          // After the answers are checked, as a CAPTCHA's answer works only once.
          if (form.captcha !== false && (await context.captcha.widget())) {
            if (!body.answer) return refuse(400, "CAPTCHA_REQUIRED", t("forms.refusals.captchaRequired"));
            if (!(await context.captcha.verify(body.answer, { ip: context.ip }))) return refuse(403, "CAPTCHA_FAILED", t("forms.refusals.captchaFailed"));
          }

          const submission = await context.system.records.create(SUBMISSIONS, { form: id, data, email: replyTo, page: pageOf(body.page) || null, state: "new" });
          context.auditTarget(SUBMISSIONS, String(submission.id), { form: id });
          return thanks;
        },
      }),
      defineRoute({
        method: "GET",
        path: "/status",
        access: "permission",
        permission: "dashboard:access",
        handler: async ({ mail, captcha }) => ({ mail: await mail.ready(), captcha: (await captcha.widget()) !== null }),
      }),
    ],
    // Each tenant keeps submissions as long as its own setting says.
    jobs: [{ name: "forms-forget-submissions", cron: "41 3 * * *", perScope: true, handler: forgetOldSubmissions }],
    migrations: [{
      id: "001-collections",
      up: async ({ schema }) => {
        for (const slug of COLLECTIONS) {
          if (await schema.describe(slug)) throw new Error(`A collection called "${slug}" already exists, and the forms plugin didn't create it. Rename it under Dashboard → Collections, then start again.`);
        }
        await schema.apply(formsSchema());
      },
    }, {
      id: "002-names-in-languages",
      up: async ({ schema }) => {
        for (const [slug, labels] of Object.entries(COLLECTION_LABELS)) await schema.addLabels(slug, labels);
      },
    }, {
      id: "003-field-names-in-languages",
      up: async ({ schema }) => {
        for (const [slug, fields] of Object.entries(FIELD_LABELS)) await schema.addFieldLabels(slug, fields);
        for (const [block, fields] of Object.entries(BLOCK_FIELD_LABELS)) await schema.addBlockFieldLabels(block, fields);
      },
    }],
  });
}
