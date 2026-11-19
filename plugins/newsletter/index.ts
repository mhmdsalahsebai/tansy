import { z } from "zod";
import { afterResponse, apiPath, definePlugin, defineRoute, wordsIn, type BeforeHookContext, type ExtensionContext, type ExtensionEmail, type ExtensionRouteContext, type RecordValues } from "tansy/plugin";
import {
  absolute, BATCH, campaignFromRecord, campaignProblem, confirmToken, csvCell, formToken, formTokenProblem, hasWords, idOf, isAddress, maskAddress,
  mayResendConfirmation, newKey, normalizeAddress, oneLine, pagePath, parseImport, perMinuteOf, readToken, str, tokenProblem, unsubscribeToken,
} from "./logic";
import { CAMPAIGN_PROGRESS, CAMPAIGNS, COLLECTIONS, CONTRACT, newsletterRoles, newsletterSchema, PAGE, PAGE_PATH, SIGNUP_BLOCK, SUBSCRIBERS, type CampaignState } from "./schema";
import { COLLECTION_LABELS, FIELD_LABELS, messages } from "./messages";
import { siteMessages } from "./site-messages";

export { campaignFromRecord, parseImport } from "./logic";

export interface NewsletterOptions {
  /** The public site's address, such as https://example.com. Links in the newsletter's emails start with it. */
  siteUrl: string;
  /** Whether new subscribers confirm their address by email first, until changed under Newsletter → Settings. On by default. */
  doubleOptIn?: boolean;
  /** How many emails go out a minute, until changed under Newsletter → Settings. */
  perMinute?: number;
}

const optionsSchema = z.strictObject({
  siteUrl: z.url({ protocol: /^https?$/ }),
  doubleOptIn: z.boolean(),
  perMinute: z.number().int().min(1).max(10_000),
});

interface NewsletterSettings { doubleOptIn: boolean; captcha: boolean; perMinute: number; pendingDays: number }
const settingsOf = async (context: ExtensionContext) => (await context.settings.get()) as unknown as NewsletterSettings;

const refuse = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
const now = () => new Date().toISOString();
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The key that signs every token, made once and kept in the plugin's store. Of two first requests, one key wins. */
async function signingKey(context: ExtensionContext) {
  const existing = await context.store.get("signing-key");
  if (typeof existing === "string") return existing;
  await context.store.claim("signing-key", newKey());
  return String(await context.store.get("signing-key"));
}

/** The visitor's language when the site has it, else the default, and the newsletter's words in it. */
async function languageOf(context: ExtensionContext, asked: string | null | undefined) {
  const languages = await context.schema.languages();
  const locale = asked && languages.items.some((item) => item.code === asked) ? asked : languages.defaultLocale;
  return { locale, t: wordsIn(siteMessages, locale).t };
}

/** The subscriber with this address, which is stored in lowercase. Addresses are checked before they get here, so they hold no quotes. */
async function findSubscriber(context: ExtensionContext, address: string) {
  if (!isAddress(address)) return null;
  const { items } = await context.system.records.list(SUBSCRIBERS, { filter: `email = "${address}"`, perPage: 1 });
  return items[0] ?? null;
}

/**
 * Where the site's pages start: a tenant's own domain when it has one, its path prefix on the
 * instance's address until then (core/scope), otherwise the address the plugin was given. It
 * can hold a path, so `absolute()` writes a path after it rather than joining with new URL().
 */
const siteOf = async (context: ExtensionContext, siteUrl: string) => (await context.scope.siteUrl()) ?? siteUrl;

/** Where a page of the site is, from its path: the address, in a language, on a site with more than one. */
async function siteLinks(context: ExtensionContext, given: string) {
  const [shape, languages, siteUrl] = await Promise.all([context.schema.describe(PAGE), context.schema.languages(), siteOf(context, given)]);
  const path = pagePath(shape?.urlPattern, PAGE_PATH);
  return {
    defaultLocale: languages.defaultLocale,
    /** The newsletter page, with a token after `#`, which browsers never send to a server or pass on to another site. */
    page: (locale: string, hash = "") => `${absolute(siteUrl, languages.items.length > 1 ? languages.href(path, locale) : path)}${hash}`,
    /** RFC 8058's one-click address, which mail clients POST to. The API is never under a tenant's path prefix, so this starts at the origin. */
    oneClick: (token: string) => absolute(new URL(siteUrl).origin, apiPath(`/ext/newsletter/unsubscribe/${token}`)),
  };
}

type Links = Awaited<ReturnType<typeof siteLinks>>;

/** The email asking someone to confirm. Only ever sent to an address someone just signed up, at most once an hour. */
async function confirmation(context: ExtensionContext, links: Links, subscriber: RecordValues): Promise<ExtensionEmail> {
  const id = Number(subscriber.id);
  const address = normalizeAddress(subscriber.email);
  const locale = str(subscriber.language) || links.defaultLocale;
  const { t } = wordsIn(siteMessages, locale);
  const token = await confirmToken(await signingKey(context), id, address);
  return {
    to: address,
    locale,
    subject: t("newsletter.mail.confirmSubject"),
    body: t("newsletter.mail.confirmBody"),
    action: { label: t("newsletter.mail.confirmAction"), url: links.page(locale, `#confirm=${token}`) },
  };
}

interface NewSubscriber { email: string; name: string; language: string; source: string }

/**
 * Signs someone up, or asks them again. `direct` skips the confirmation email, for an owner's
 * import of people who already agreed, or a signed-in person's own verified address. Someone
 * who unsubscribed is never put back without confirming. Returns what became of them.
 */
async function signUp(context: ExtensionContext, links: Links, entry: NewSubscriber, direct: boolean, { confirmLater = false } = {}): Promise<"added" | "confirmed" | "asked" | "unchanged"> {
  const { system } = context;
  let subscriber = await findSubscriber(context, entry.email);
  if (!subscriber) {
    try {
      subscriber = await system.records.create(SUBSCRIBERS, {
        email: entry.email,
        name: entry.name || null,
        language: entry.language || null,
        source: entry.source || null,
        state: direct ? "confirmed" : "pending",
        confirmedAt: direct ? now() : null,
        // A later import's confirmations go out from the job, in batches. A visitor's goes now.
        confirmSentAt: direct || confirmLater ? null : now(),
      });
    } catch (error) {
      // Two sign-ups of one address at once: the database lets one in, and the other finds it.
      subscriber = await findSubscriber(context, entry.email);
      if (!subscriber) throw error;
      return signUp(context, links, entry, direct, { confirmLater });
    }
    if (!direct && !confirmLater) await context.mail.send(await confirmation(context, links, subscriber));
    return "added";
  }
  const id = Number(subscriber.id);
  if (subscriber.state === "confirmed") return "unchanged";
  if (direct) {
    await system.records.update(SUBSCRIBERS, id, { state: "confirmed", confirmedAt: now(), unsubscribedAt: null, ...(entry.name && !str(subscriber.name) ? { name: entry.name } : {}) });
    return "confirmed";
  }
  if (confirmLater || !mayResendConfirmation(subscriber.confirmSentAt)) return "unchanged";
  // Their state stays as it was until they confirm, so asking again can't undo an unsubscribe.
  const updated = await system.records.update(SUBSCRIBERS, id, { confirmSentAt: now(), ...(entry.language ? { language: entry.language } : {}) });
  await context.mail.send(await confirmation(context, links, updated));
  return "asked";
}

/** The subscriber a confirm or unsubscribe token names, once its signature checks out for their address. */
async function holderOf(context: ExtensionContext, token: unknown, purpose: "confirm" | "unsubscribe") {
  const parsed = readToken(token);
  if (!parsed || parsed.purpose !== purpose) return { problem: "invalid" as const };
  const subscriber = await context.system.records.get(SUBSCRIBERS, parsed.id).catch(() => null);
  if (!subscriber) return { problem: "invalid" as const };
  const problem = await tokenProblem(await signingKey(context), parsed, normalizeAddress(subscriber.email));
  return problem === "ok" ? { subscriber } : { problem };
}

/** The values of two field versions, compared the way they're stored. */
function same(a: unknown, b: unknown) {
  const empty = (value: unknown) => value === null || value === undefined || value === "";
  if (empty(a) && empty(b)) return true;
  if (typeof a === "string" && typeof b === "string" && /^\d{4}-\d\d-\d\dT/.test(a) && /^\d{4}-\d\d-\d\dT/.test(b)) return new Date(a).getTime() === new Date(b).getTime();
  return JSON.stringify(a) === JSON.stringify(b);
}

const CONTENT = ["subject", "body", "link", "linkLabel"];

/**
 * People write a campaign's words. Its progress is the plugin's alone: someone with record
 * permissions can't mark a campaign as sending, rewind it or rewrite one that has gone out.
 */
function guardCampaign(context: BeforeHookContext) {
  // A system write is the plugin's own.
  if (context.userId === null) return;
  const { values, record, event, reject } = context;
  if (event === "record.beforeCreate") {
    for (const name of CAMPAIGN_PROGRESS) delete values[name];
    values.state = "draft";
    return values;
  }
  if (event === "record.beforeDelete") {
    if (record?.state === "sending") reject("This campaign is sending. Cancel it on the Newsletter page first.");
    return;
  }
  for (const name of CAMPAIGN_PROGRESS) {
    if (name in values && !same(values[name], record?.[name])) reject("Send, schedule and cancel campaigns from the Newsletter page.", name);
  }
  if (record?.state !== "draft" && CONTENT.some((name) => name in values && !same(values[name], record?.[name]))) {
    reject("This campaign has been sent or scheduled, so it can't change. Cancel it, or copy it from the Newsletter page.");
  }
}

/** Every address is kept in lowercase, and a person's change of state is dated. */
function tidySubscriber(context: BeforeHookContext) {
  const { values, record, reject } = context;
  if ("email" in values) {
    const address = normalizeAddress(values.email);
    if (!isAddress(address)) reject("Enter an email address.", "email");
    values.email = address;
  }
  if ("state" in values && values.state !== record?.state) {
    if (values.state === "confirmed" && !("confirmedAt" in values)) values.confirmedAt = now();
    if (values.state === "unsubscribed" && !("unsubscribedAt" in values)) values.unsubscribedAt = now();
  }
  return values;
}

// Sending. One run at a time in this process: the job, and a run started by a send, share it.
let running = false;

/** Confirmation emails for imported subscribers, in batches. Returns how many it sent. */
async function sendImportConfirmations(context: ExtensionContext, links: Links, budget: number) {
  const { items } = await context.system.records.list(SUBSCRIBERS, { filter: 'state = "pending" && confirmSentAt = null', sort: "id", perPage: Math.min(BATCH, budget) });
  if (!items.length) return 0;
  // Marked first, so a crash between the two can't send them twice.
  for (const item of items) await context.system.records.update(SUBSCRIBERS, Number(item.id), { confirmSentAt: now() });
  await context.mail.sendBatch(await Promise.all(items.map((item) => confirmation(context, links, item)))).catch((error: unknown) => console.error("[newsletter] confirmations not sent", error));
  return items.length;
}

/** One campaign's email to one subscriber, with their own unsubscribe link. */
async function campaignEmail(campaign: RecordValues, subscriber: RecordValues, key: string, links: Links): Promise<ExtensionEmail> {
  const locale = links.defaultLocale;
  const { t } = wordsIn(siteMessages, locale);
  const token = await unsubscribeToken(key, Number(subscriber.id), normalizeAddress(subscriber.email));
  const link = str(campaign.link);
  return {
    to: normalizeAddress(subscriber.email),
    locale,
    subject: oneLine(str(campaign.subject)),
    ...(hasWords(campaign.body) ? { richText: campaign.body } : { body: oneLine(str(campaign.subject)) }),
    ...(link ? { action: { label: oneLine(str(campaign.linkLabel)) || t("newsletter.mail.readMore"), url: link } } : {}),
    unsubscribe: { url: links.page(locale, `#unsubscribe=${token}`), oneClick: links.oneClick(token), label: t("newsletter.mail.unsubscribe") },
  };
}

/**
 * Sends the next part of a campaign, up to `budget` emails. Each batch is claimed by moving the
 * campaign's cursor in one conditional write before it's sent, so nobody gets an email twice,
 * even when two runs overlap. A crash between the claim and the send skips that batch. Returns
 * how many it sent.
 */
async function sendSome(context: ExtensionContext, links: Links, campaign: RecordValues, budget: number) {
  const id = Number(campaign.id);
  const key = await signingKey(context);
  const until = num(campaign.until);
  let cursor = num(campaign.cursor);
  let sent = num(campaign.sent);
  let failed = num(campaign.failed);
  let used = 0;
  while (used < budget) {
    const { items } = await context.system.records.list(SUBSCRIBERS, { filter: `state = "confirmed" && id > ${cursor} && id <= ${until}`, sort: "id", perPage: Math.min(BATCH, budget - used), fields: "id,email" });
    if (!items.length) {
      await context.system.records.update(CAMPAIGNS, id, { state: "sent", finishedAt: now() }, { if: { state: "sending" } });
      await context.store.delete(`go:${id}`);
      break;
    }
    const last = Number(items[items.length - 1].id);
    const claimed = await context.system.records.update(CAMPAIGNS, id, { cursor: last }, { if: { cursor, state: "sending" } });
    // Cancelled, or another run took this batch.
    if (!claimed) break;
    const emails = await Promise.all(items.map((item) => campaignEmail(campaign, item, key, links)));
    const results = await context.mail.sendBatch(emails).catch((error: unknown) => {
      console.error(`[newsletter] campaign ${id}: a batch wasn't sent`, error);
      return emails.map(() => ({ ok: false as const, error: "not sent" }));
    });
    const delivered = results.filter((result) => result.ok).length;
    sent += delivered;
    failed += results.length - delivered;
    await context.system.records.update(CAMPAIGNS, id, { sent, failed });
    used += items.length;
    cursor = last;
  }
  return used;
}

/** Freezes who a campaign goes to, the subscribers confirmed right now, and starts sending it. */
async function start(context: ExtensionContext, id: number, from: CampaignState) {
  const { items, totalItems } = await context.system.records.list(SUBSCRIBERS, { filter: 'state = "confirmed"', sort: "-id", perPage: 1, fields: "id" });
  const until = items.length ? Number(items[0].id) : 0;
  return context.system.records.update(CAMPAIGNS, id, { state: "sending", startedAt: now(), finishedAt: null, cursor: 0, until, recipients: totalItems, sent: 0, failed: 0 }, { if: { state: from } });
}

/** Sends what's due, within the emails a minute allows: imported subscribers' confirmations, scheduled campaigns that have come up, and campaigns part way through. */
async function runCampaigns(context: ExtensionContext, siteUrl: string) {
  if (running) return;
  running = true;
  try {
    const settings = await settingsOf(context);
    const links = await siteLinks(context, siteUrl);
    let budget = perMinuteOf(settings.perMinute);
    budget -= await sendImportConfirmations(context, links, budget);
    const due = await context.system.records.list(CAMPAIGNS, { filter: `state = "scheduled" && scheduledAt <= "${now()}"`, sort: "scheduledAt", perPage: 20 });
    for (const campaign of due.items) {
      if (await context.store.get(`go:${campaign.id}`)) await start(context, Number(campaign.id), "scheduled");
    }
    const sending = await context.system.records.list(CAMPAIGNS, { filter: 'state = "sending"', sort: "startedAt", perPage: 20 });
    for (const campaign of sending.items) {
      if (budget <= 0) break;
      // Only a send from the Newsletter page leaves this mark. Anything else marked as sending is put back.
      if (!(await context.store.get(`go:${campaign.id}`))) {
        await context.system.records.update(CAMPAIGNS, Number(campaign.id), { state: "cancelled", finishedAt: now() }, { if: { state: "sending" } });
        continue;
      }
      budget -= await sendSome(context, links, campaign, budget);
    }
  } finally {
    running = false;
  }
}

/** Removes sign-ups nobody confirmed, after the days in the settings. */
async function forgetUnconfirmed(context: ExtensionContext) {
  const days = (await settingsOf(context)).pendingDays;
  if (!Number.isInteger(days) || days < 1) return;
  const before = new Date(Date.now() - days * 86_400_000).toISOString();
  for (let round = 0; round < 50; round++) {
    const { items } = await context.system.records.list(SUBSCRIBERS, { filter: `state = "pending" && createdAt < "${before}"`, perPage: 200, fields: "id" });
    if (!items.length) return;
    for (const { id } of items) await context.system.records.delete(SUBSCRIBERS, id as number);
  }
}

/** The campaign as the caller may read it, or null. */
const readCampaign = (context: ExtensionRouteContext, id: number | null) => (id === null ? Promise.resolve(null) : context.records.get(CAMPAIGNS, id).catch(() => null));

/** What the Newsletter page shows of a campaign's progress. */
const progress = (campaign: RecordValues) => ({
  id: campaign.id, state: campaign.state, subject: campaign.subject, scheduledAt: campaign.scheduledAt ?? null, startedAt: campaign.startedAt ?? null, finishedAt: campaign.finishedAt ?? null,
  recipients: num(campaign.recipients), sent: num(campaign.sent), failed: num(campaign.failed),
});

const SIGNUP_REASON = "Visitors sign up signed out. It takes one address, behind a trap field, a signed minimum time, a rate limit per address and the CAPTCHA, and never says whether the address was already subscribed.";
const TOKEN_REASON = "Subscribers confirm and unsubscribe from links in email, signed out. Each link carries a token signed for that subscriber's address, and does only what it was issued for.";

const subscribeBody = z.strictObject({
  email: z.string().max(254),
  name: z.string().max(100).optional(),
  token: z.string().max(200),
  answer: z.string().max(4096).optional(),
  /** The trap: a field people never see. Anything in it is a script. */
  website: z.string().max(2000).optional(),
  page: z.string().max(2000).optional(),
  locale: z.string().min(2).max(35).optional(),
});

/** The page someone signed up on, as a path, never another site's address. */
const pageOf = (value: unknown) => {
  const page = str(value).trim();
  return page.startsWith("/") && !page.startsWith("//") ? oneLine(page).slice(0, 300) : "";
};

/**
 * A newsletter: subscribers who sign up on the site and confirm by email, one-click
 * unsubscribe in every email, and campaigns, written in the dashboard or made from any
 * post, sent to every subscriber in batches through the site's email. Everything is on
 * one page of the dashboard. See docs/plugins/newsletter.md.
 */
export function newsletter(options: NewsletterOptions) {
  const value = optionsSchema.parse({ doubleOptIn: true, perMinute: 300, ...Object.fromEntries(Object.entries(options ?? {}).filter(([, option]) => option !== undefined)) });
  const siteUrl = value.siteUrl.replace(/\/+$/, "");
  const kick = (context: ExtensionContext) => afterResponse("newsletter", () => runCampaigns(context, siteUrl));

  return definePlugin({
    name: "newsletter",
    version: "0.1.0",
    apiVersion: 1,
    requires: { cms: "^0.1.0" },
    admin: { server: "@tansy/newsletter/admin", client: "@tansy/newsletter/client", render: "@tansy/newsletter/render" },
    options: { schema: optionsSchema, value },
    messages,
    permissions: { "ext.newsletter": ["send", "manage"] },
    settings: {
      fields: [
        { name: "doubleOptIn", type: "boolean", perScope: true, default: value.doubleOptIn, label: "Ask new subscribers to confirm", description: "They get an email with a link, and get nothing else until they follow it. Turning this off lets anyone sign up any address." },
        { name: "captcha", type: "boolean", perScope: true, default: true, label: "Ask for the CAPTCHA on sign-up", description: "Once one is set up under the CAPTCHA plugin." },
        { name: "perMinute", type: "number", integer: true, min: 1, max: 10_000, default: value.perMinute, label: "Emails sent a minute", description: "Campaigns go out in batches, this many a minute. Keep it under your email provider's limit." },
        { name: "pendingDays", type: "number", perScope: true, integer: true, min: 0, max: 365, default: 7, label: "Forget unconfirmed sign-ups after (days)", description: "0 keeps them." },
      ],
    },
    contract: CONTRACT,
    blocks: [SIGNUP_BLOCK],
    hooks: {
      "record.beforeCreate": (context) => (context.collection.slug === SUBSCRIBERS ? tidySubscriber(context) : context.collection.slug === CAMPAIGNS ? guardCampaign(context) : undefined),
      "record.beforeUpdate": (context) => (context.collection.slug === SUBSCRIBERS ? tidySubscriber(context) : context.collection.slug === CAMPAIGNS ? guardCampaign(context) : undefined),
      "record.beforeDelete": (context) => { if (context.collection.slug === CAMPAIGNS) guardCampaign(context); },
    },
    routes: [
      // The public half: signing up, confirming and leaving.
      defineRoute({
        method: "GET",
        path: "/signup",
        access: "public",
        reason: SIGNUP_REASON,
        handler: async (context) => {
          const settings = await settingsOf(context);
          return Response.json({ captcha: settings.captcha ? await context.captcha.widget() : null, token: await formToken(await signingKey(context)) }, { headers: { "cache-control": "no-store" } });
        },
      }),
      defineRoute({
        method: "POST",
        path: "/subscribe",
        access: "public",
        reason: SIGNUP_REASON,
        audit: "newsletter.subscribe",
        body: subscribeBody,
        // Per address: a person signs up once, a script that floods someone's inbox hundreds of times.
        rateLimit: { window: 600, max: 5 },
        handler: async (context) => {
          const body = context.body as z.output<typeof subscribeBody>;
          const { locale, t } = await languageOf(context, body.locale);
          const settings = await settingsOf(context);
          const answer = (key: "checkInbox" | "subscribed") => ({ ok: true, message: t(`newsletter.${key}`) });
          // Answer a filled trap as if it worked, so the script learns nothing.
          if (body.website?.trim()) return answer(settings.doubleOptIn ? "checkInbox" : "subscribed");

          const timing = await formTokenProblem(await signingKey(context), body.token);
          if (timing === "early") return refuse(400, "TOO_FAST", t("newsletter.refusals.tooFast"));
          if (timing !== "ok") return refuse(400, "FORM_EXPIRED", t("newsletter.refusals.expired"));
          const address = normalizeAddress(body.email);
          if (!isAddress(address)) return refuse(400, "INVALID_EMAIL", t("newsletter.refusals.invalidEmail"));
          if (settings.captcha && (await context.captcha.widget())) {
            if (!body.answer) return refuse(400, "CAPTCHA_REQUIRED", t("newsletter.refusals.captchaRequired"));
            if (!(await context.captcha.verify(body.answer, { ip: context.ip }))) return refuse(403, "CAPTCHA_FAILED", t("newsletter.refusals.captchaFailed"));
          }

          // Someone signed in, subscribing the address they've already verified, has nothing to confirm.
          const { principal } = context;
          const own = principal.kind === "user" && principal.user.emailVerified && normalizeAddress(principal.user.email) === address;
          const direct = !settings.doubleOptIn || own;
          await signUp(context, await siteLinks(context, siteUrl), { email: address, name: oneLine(body.name ?? "").slice(0, 100), language: locale, source: pageOf(body.page) }, direct);
          // The same answer whether the address was new, waiting or subscribed already, so nobody learns who's on the list.
          return answer(direct ? "subscribed" : "checkInbox");
        },
      }),
      defineRoute({
        method: "POST",
        path: "/confirm",
        access: "public",
        reason: TOKEN_REASON,
        audit: "newsletter.confirm",
        body: z.strictObject({ token: z.string().max(200), locale: z.string().min(2).max(35).optional() }),
        handler: async (context) => {
          const body = context.body as { token: string; locale?: string };
          const { t } = await languageOf(context, body.locale);
          const held = await holderOf(context, body.token, "confirm");
          if (!held.subscriber) return held.problem === "expired" ? refuse(400, "LINK_EXPIRED", t("newsletter.refusals.expiredLink")) : refuse(400, "INVALID_LINK", t("newsletter.refusals.invalidLink"));
          const id = Number(held.subscriber.id);
          if (held.subscriber.state !== "confirmed") await context.system.records.update(SUBSCRIBERS, id, { state: "confirmed", confirmedAt: now(), unsubscribedAt: null });
          context.auditTarget(SUBSCRIBERS, String(id));
          return { ok: true, message: t("newsletter.confirmed") };
        },
      }),
      defineRoute({
        method: "GET",
        path: "/unsubscribe/:token",
        access: "public",
        reason: TOKEN_REASON,
        handler: async (context) => {
          const { t } = await languageOf(context, new URL(context.request.url).searchParams.get("locale"));
          const held = await holderOf(context, context.params.token, "unsubscribe");
          if (!held.subscriber) return refuse(400, "INVALID_LINK", t("newsletter.refusals.invalidLink"));
          // Only enough of the address for its owner to recognise it, as anyone holding the link can open this.
          return Response.json({ email: maskAddress(normalizeAddress(held.subscriber.email)), unsubscribed: held.subscriber.state === "unsubscribed" }, { headers: { "cache-control": "no-store" } });
        },
      }),
      defineRoute({
        method: "POST",
        path: "/unsubscribe/:token",
        access: "public",
        reason: `${TOKEN_REASON} Mail clients POST here for RFC 8058's one-click unsubscribe, with no body this route needs.`,
        audit: "newsletter.unsubscribe",
        // The token is in the path, so this is per link: a mail provider unsubscribing many people from one address isn't held up.
        rateLimit: { window: 600, max: 10 },
        handler: async (context) => {
          const { t } = await languageOf(context, new URL(context.request.url).searchParams.get("locale"));
          const held = await holderOf(context, context.params.token, "unsubscribe");
          if (!held.subscriber) return refuse(400, "INVALID_LINK", t("newsletter.refusals.invalidLink"));
          const id = Number(held.subscriber.id);
          if (held.subscriber.state !== "unsubscribed") await context.system.records.update(SUBSCRIBERS, id, { state: "unsubscribed", unsubscribedAt: now() });
          context.auditTarget(SUBSCRIBERS, String(id));
          return { ok: true, message: t("newsletter.unsubscribed") };
        },
      }),

      // The dashboard half.
      defineRoute({
        method: "GET",
        path: "/status",
        access: "permission",
        permission: "dashboard:access",
        handler: async (context) => {
          const count = (state: string) => context.records.list(SUBSCRIBERS, { filter: `state = "${state}"`, perPage: 1, fields: "id" }).then((list) => list.totalItems).catch(() => null);
          const [pending, confirmed, unsubscribed, page] = await Promise.all([count("pending"), count("confirmed"), count("unsubscribed"), context.schema.describe(PAGE)]);
          return {
            mail: await context.mail.ready(),
            captcha: (await context.captcha.widget()) !== null,
            page: page ? pagePath(page.urlPattern, PAGE_PATH) : null,
            counts: confirmed === null ? null : { pending, confirmed, unsubscribed },
          };
        },
      }),
      defineRoute({
        method: "POST",
        path: "/subscribers",
        access: "permission",
        permission: "ext.newsletter:manage",
        audit: "newsletter.import",
        body: z.strictObject({ text: z.string().max(500_000), confirmed: z.boolean() }),
        handler: async (context) => {
          const body = context.body as { text: string; confirmed: boolean };
          // Only someone who may read the list through the collection imports into it.
          if (!(await context.records.list(SUBSCRIBERS, { perPage: 1, fields: "id" }).then(() => true, () => false))) return refuse(403, "FORBIDDEN", "You need permissions on the Subscribers collection to import.");
          const { entries, invalid, tooMany } = parseImport(body.text);
          const links = await siteLinks(context, siteUrl);
          const tally = { added: 0, confirmed: 0, unchanged: 0 };
          for (const entry of entries) {
            const existing = await findSubscriber(context, entry.email);
            // An import never brings back someone who unsubscribed.
            if (existing?.state === "unsubscribed") { tally.unchanged++; continue; }
            const result = await signUp(context, links, { ...entry, language: "", source: "import" }, body.confirmed, { confirmLater: true });
            if (result === "added") tally.added++;
            else if (result === "confirmed") tally.confirmed++;
            else tally.unchanged++;
          }
          context.auditTarget(SUBSCRIBERS, "import", { ...tally, invalid, agreed: body.confirmed });
          if (!body.confirmed && tally.added) kick(context);
          return { ...tally, invalid, tooMany };
        },
      }),
      defineRoute({
        method: "POST",
        path: "/subscribers/:id/state",
        access: "permission",
        permission: "ext.newsletter:manage",
        audit: "newsletter.subscriber_state",
        body: z.strictObject({ state: z.enum(["confirmed", "unsubscribed"]) }),
        handler: async (context) => {
          const id = idOf(context.params.id);
          // Through the collection as the caller, so their record permissions decide.
          const subscriber = id === null ? null : await context.records.get(SUBSCRIBERS, id).catch(() => null);
          if (!subscriber || id === null) return refuse(404, "NOT_FOUND", "There's no such subscriber.");
          const { state } = context.body as { state: "confirmed" | "unsubscribed" };
          const updated = await context.records.update(SUBSCRIBERS, id, { state });
          context.auditTarget(SUBSCRIBERS, String(id), { state });
          return { id, state: updated.state };
        },
      }),
      defineRoute({
        method: "GET",
        path: "/subscribers.csv",
        access: "permission",
        permission: "ext.newsletter:manage",
        audit: "newsletter.export",
        handler: async (context) => {
          const rows = [["email", "name", "state", "confirmedAt", "source"].join(",")];
          for (let page = 1; page <= 500; page++) {
            // As the caller, so only what their record permissions show them.
            const list = await context.records.list(SUBSCRIBERS, { page, perPage: 200, sort: "id", fields: "id,email,name,state,confirmedAt,source" });
            for (const item of list.items) rows.push([item.email, item.name, item.state, item.confirmedAt, item.source].map(csvCell).join(","));
            if (page >= list.totalPages) break;
          }
          context.auditTarget(SUBSCRIBERS, "export", { rows: rows.length - 1 });
          return new Response(`${rows.join("\r\n")}\r\n`, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="subscribers.csv"', "cache-control": "no-store" } });
        },
      }),
      defineRoute({
        method: "GET",
        path: "/campaigns",
        access: "permission",
        permission: "ext.newsletter:send",
        handler: async (context) => {
          const list = await context.records.list(CAMPAIGNS, { perPage: 50, sort: "-createdAt", fields: "id,subject,state,scheduledAt,startedAt,finishedAt,recipients,sent,failed" }).catch(() => null);
          return { campaigns: list ? list.items.map(progress) : null };
        },
      }),
      defineRoute({
        method: "POST",
        path: "/campaigns/:id/test",
        access: "permission",
        permission: "ext.newsletter:send",
        audit: "newsletter.test",
        handler: async (context) => {
          const campaign = await readCampaign(context, idOf(context.params.id));
          if (!campaign) return refuse(404, "NOT_FOUND", "There's no such campaign.");
          if (campaignProblem(campaign)) return refuse(400, "NOTHING_TO_SEND", "Give the campaign a subject and some text or a link first.");
          const { principal } = context;
          if (principal.kind === "anonymous") return refuse(401, "UNAUTHORIZED", "Sign in first.");
          // Only ever to the person asking, so a test can't send the campaign to anyone else.
          const to = normalizeAddress(principal.user.email);
          const links = await siteLinks(context, siteUrl);
          const email = await campaignEmail(campaign, { id: 0, email: to }, await signingKey(context), links);
          const [result] = await context.mail.sendBatch([{ ...email, subject: `[Test] ${email.subject}`.slice(0, 200), unsubscribe: { url: links.page(links.defaultLocale), label: email.unsubscribe!.label } }]);
          context.auditTarget(CAMPAIGNS, String(campaign.id));
          return { ok: result.ok, to };
        },
      }),
      defineRoute({
        method: "POST",
        path: "/campaigns/:id/send",
        access: "permission",
        permission: "ext.newsletter:send",
        audit: "newsletter.send",
        body: z.strictObject({ at: z.iso.datetime({ offset: true }).optional() }),
        handler: async (context) => {
          const id = idOf(context.params.id);
          const campaign = await readCampaign(context, id);
          if (!campaign || id === null) return refuse(404, "NOT_FOUND", "There's no such campaign.");
          const state = campaign.state as CampaignState;
          if (state !== "draft" && state !== "scheduled") return refuse(409, "ALREADY_SENT", "This campaign has already been sent or cancelled. Copy it to send it again.");
          if (campaignProblem(campaign)) return refuse(400, "NOTHING_TO_SEND", "Give the campaign a subject and some text or a link first.");
          if (process.env.NODE_ENV === "production" && !(await context.mail.ready())) return refuse(409, "MAIL_NOT_READY", "Email isn't set up. Set up SMTP under Settings → Email, or an email plugin, first.");
          const { at } = context.body as { at?: string };
          // Marked before it's sending, so the job never meets a campaign without it.
          await context.store.set(`go:${id}`, { at: now() });
          const later = at && new Date(at).getTime() > Date.now() + 60_000;
          const updated = later
            ? await context.system.records.update(CAMPAIGNS, id, { state: "scheduled", scheduledAt: new Date(at).toISOString() }, { if: { state } })
            : await start(context, id, state);
          if (!updated) return refuse(409, "CHANGED", "Someone else changed this campaign. Reload the page.");
          context.auditTarget(CAMPAIGNS, String(id), { scheduled: Boolean(later) });
          if (!later) kick(context);
          return progress(updated);
        },
      }),
      defineRoute({
        method: "POST",
        path: "/campaigns/:id/cancel",
        access: "permission",
        permission: "ext.newsletter:send",
        audit: "newsletter.cancel",
        handler: async (context) => {
          const id = idOf(context.params.id);
          const campaign = await readCampaign(context, id);
          if (!campaign || id === null) return refuse(404, "NOT_FOUND", "There's no such campaign.");
          const state = campaign.state as CampaignState;
          if (state !== "sending" && state !== "scheduled") return refuse(409, "NOT_SENDING", "Only a campaign that's sending or scheduled can be cancelled.");
          const updated = await context.system.records.update(CAMPAIGNS, id, { state: "cancelled", finishedAt: now() }, { if: { state } });
          if (!updated) return refuse(409, "CHANGED", "It finished or changed in the meantime. Reload the page.");
          await context.store.delete(`go:${id}`);
          context.auditTarget(CAMPAIGNS, String(id));
          return progress(updated);
        },
      }),
      defineRoute({
        method: "POST",
        path: "/campaigns/:id/copy",
        access: "permission",
        permission: "ext.newsletter:send",
        audit: "newsletter.copy",
        handler: async (context) => {
          const campaign = await readCampaign(context, idOf(context.params.id));
          if (!campaign) return refuse(404, "NOT_FOUND", "There's no such campaign.");
          // As the caller, so it needs their permission to create campaigns.
          const copy = await context.records.create(CAMPAIGNS, { subject: campaign.subject, body: campaign.body ?? null, link: campaign.link ?? null, linkLabel: campaign.linkLabel ?? null, source: campaign.source ?? null });
          context.auditTarget(CAMPAIGNS, String(copy.id), { from: campaign.id });
          return { id: copy.id };
        },
      }),
      defineRoute({
        method: "GET",
        path: "/sources/:slug",
        access: "permission",
        permission: "ext.newsletter:send",
        handler: async (context) => {
          const slug = context.params.slug;
          const shape = /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) && !COLLECTIONS.includes(slug as typeof COLLECTIONS[number]) ? await context.schema.describe(slug) : null;
          return { eligible: Boolean(shape?.urlPattern) && shape?.type !== "singleton" };
        },
      }),
      defineRoute({
        method: "POST",
        path: "/campaigns/from-record",
        access: "permission",
        permission: "ext.newsletter:send",
        audit: "newsletter.draft",
        body: z.strictObject({ collection: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), id: z.number().int().positive() }),
        handler: async (context) => {
          const { collection, id } = context.body as { collection: string; id: number };
          const shape = COLLECTIONS.includes(collection as typeof COLLECTIONS[number]) ? null : await context.schema.describe(collection);
          if (!shape?.urlPattern) return refuse(400, "NO_ADDRESS", "Only records with a page on the site can be sent as a campaign.");
          // As the caller, so they can only send what they can read, and only the fields they can read go into it.
          const record = await context.records.get(collection, id, { urls: "1" }).catch(() => null);
          if (!record) return refuse(404, "NOT_FOUND", "There's no such record.");
          if (record.status !== "published" || !str(record.recordPath)) return refuse(409, "NOT_PUBLISHED", "Publish it first, so subscribers can open it.");
          const { defaultLocale } = await context.schema.languages();
          const draft = campaignFromRecord(record, absolute(await siteOf(context, siteUrl), str(record.recordPath)), wordsIn(siteMessages, defaultLocale).t("newsletter.mail.readMore"));
          const campaign = await context.records.create(CAMPAIGNS, { ...draft, subject: draft.subject || shape.name, source: `${collection}/${id}` });
          context.auditTarget(CAMPAIGNS, String(campaign.id), { from: `${collection}/${id}` });
          return { id: campaign.id };
        },
      }),
    ],
    jobs: [
      // Each tenant's campaigns, subscribers and settings are its own, so these run in each.
      { name: "newsletter-send", cron: "* * * * *", perScope: true, handler: (context) => runCampaigns(context, siteUrl) },
      { name: "newsletter-forget-unconfirmed", cron: "17 4 * * *", perScope: true, handler: forgetUnconfirmed },
    ],
    migrations: [
      {
        id: "001-collections",
        up: async ({ schema, system, roles }) => {
          for (const slug of COLLECTIONS) {
            if (await schema.describe(slug)) throw new Error(`A collection called "${slug}" already exists, and the newsletter plugin didn't create it. Rename it under Dashboard → Collections, then start again.`);
          }
          await schema.apply(newsletterSchema());
          await system.records.create(PAGE, { status: "published", title: "Newsletter" });
          for (const role of newsletterRoles()) await roles.ensure(role);
        },
      },
      {
        id: "002-words-in-languages",
        up: async ({ schema }) => {
          for (const [slug, labels] of Object.entries(COLLECTION_LABELS)) await schema.addLabels(slug, labels);
          for (const [slug, fields] of Object.entries(FIELD_LABELS)) await schema.addFieldLabels(slug, fields);
        },
      },
    ],
  });
}
