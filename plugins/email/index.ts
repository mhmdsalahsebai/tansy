import { z } from "zod";
import { definePlugin, mergeMessagesByLanguage, type ExtensionContext, type PluginSettingField } from "tansy/plugin";
import { failureOf, isAddress, logDaysOf, MESSAGES, outgoing, senderOf } from "./logic";
import { COLLECTION_LABELS, FIELD_LABELS, messages } from "./messages";
import { ProviderError, type BatchResult, type EmailProvider, type EmailSettings, type OutgoingEmail } from "./provider";

export { MESSAGES } from "./logic";
export type { EmailProvider } from "./provider";

export interface EmailOptions {
  /**
   * The providers the site can send with, each from its own package, such as `resend()`
   * from @tansy/email-resend. Owners choose one under Email → Settings.
   */
  providers: EmailProvider[];
  /** Which of them sends until changed under Email → Settings. The first when left out. */
  provider?: string;
}

const PROVIDER_ID = /^[a-z][a-z0-9]{0,19}$/;

const optionsSchema = z.strictObject({
  providers: z.array(z.object({ id: z.string().regex(PROVIDER_ID, "A provider's id is lowercase letters and digits."), label: z.string().min(1) }).loose()).min(1, "Add at least one provider, such as resend() from @tansy/email-resend."),
  provider: z.string(),
}).superRefine((value, issues) => {
  const ids = value.providers.map((provider) => provider.id);
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice) issues.addIssue({ code: "custom", path: ["providers"], message: `The provider "${twice}" is listed twice.` });
  if (!ids.includes(value.provider)) issues.addIssue({ code: "custom", path: ["provider"], message: `"${value.provider}" isn't one of the providers listed.` });
});

const LOCKED = { createRule: null, updateRule: null, deleteRule: null };

const settingsOf = async (context: ExtensionContext) => (await context.settings.get()) as unknown as EmailSettings;

/** Email's own settings. Each provider adds its own after them. */
const sharedSettings = (value: { provider: string }, providers: EmailProvider[]): PluginSettingField[] => [
  { name: "provider", type: "select", default: value.provider, label: "Provider", description: "Who sends the site's email. Fill in that provider's settings below. Until its keys are set, email goes through SMTP under Settings → Email.", options: providers.map((provider) => ({ value: provider.id, label: provider.label })) },
  { name: "fromAddress", type: "text", default: "", maxLength: 254, label: "From address", description: "An address at a domain you've verified with the provider. Empty uses the one under Settings → Email." },
  { name: "fromName", type: "text", default: "", maxLength: 100, label: "From name", description: "Empty uses the one under Settings → Email, then the site's name." },
  { name: "replyTo", type: "text", default: "", maxLength: 254, label: "Reply-to address", description: "Where replies go, unless a message names its own, such as a form notification answering the visitor. Empty sends them to the from address." },
  { name: "log", type: "boolean", default: true, label: "Keep a delivery log", description: "Lists each email's recipient, subject and whether the provider took it, under Email → Messages. Never the body, which can hold sign-in links and codes." },
  { name: "logDays", type: "number", default: 30, min: 1, max: 365, integer: true, label: "Keep log entries for (days)" },
];

/** Every setting's name starts with its provider's id, so two providers can't claim one. */
function providerSettings(providers: EmailProvider[]) {
  return providers.flatMap((provider) => provider.settings().map((field) => {
    if (!field.name.startsWith(provider.id)) throw new Error(`Email provider "${provider.id}": the setting "${field.name}" must start with "${provider.id}".`);
    return field;
  }));
}

/** Writes a log entry. A failed write is only logged: the message has already gone, or already failed. */
async function logMessage(context: ExtensionContext, entry: Record<string, unknown>) {
  try {
    await context.system.records.create(MESSAGES, entry);
  } catch (error) {
    console.error("[email] couldn't log a message", error);
  }
}

/** Removes log entries older than the setting, a page at a time. */
async function forgetOldMessages(context: ExtensionContext) {
  const before = new Date(Date.now() - logDaysOf(await settingsOf(context)) * 86_400_000).toISOString();
  for (let round = 0; round < 50; round++) {
    const { items } = await context.system.records.list(MESSAGES, { filter: `createdAt < "${before}"`, perPage: 200, fields: "id" });
    if (!items.length) return;
    for (const { id } of items) await context.system.records.delete(MESSAGES, id as number);
  }
}

/**
 * Sends the site's email, account email and plugins' alike, through an email API instead
 * of SMTP, with the provider adapters a site installs, such as @tansy/email-resend.
 * Until the chosen provider's keys are set, mail goes through SMTP as before. See
 * docs/plugins/email.md.
 */
export function email(options: EmailOptions) {
  const value = optionsSchema.parse({ provider: options.providers?.[0]?.id, ...Object.fromEntries(Object.entries(options).filter(([, option]) => option !== undefined)) });
  const providers = options.providers;
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const fields = [...sharedSettings(value, providers), ...providerSettings(providers)];

  /** The chosen provider and the from address, or an error saying what to set up. */
  async function sender(context: ExtensionContext, authSettings: { mail: { fromAddress: string; fromName: string }; general: { appName: string } }) {
    const settings = await settingsOf(context);
    const provider = byId.get(settings.provider);
    if (!provider?.ready(settings)) throw new Error("[email] The provider isn't set up.");
    const from = senderOf(settings, { ...authSettings.mail, appName: authSettings.general.appName });
    if (!from) throw new Error("[email] Set a from address under Email → Settings.");
    return { settings, provider, from };
  }

  return definePlugin({
    name: "email",
    version: "0.1.1",
    apiVersion: 1,
    requires: { cms: "^0.1.1" },
    admin: { server: "@tansy/email/admin" },
    options: { schema: optionsSchema, value },
    messages: mergeMessagesByLanguage(messages, ...providers.map((provider) => provider.messages)),
    settings: { fields },
    contract: {
      [MESSAGES]: { recipient: "email", subject: "text", kind: "text", provider: "text", state: "text", providerId: "text", error: "text" },
    },
    auth: {
      mail: {
        async ready(context) {
          const settings = await settingsOf(context);
          const provider = byId.get(settings.provider);
          if (!provider?.ready(settings)) return false;
          // The fallback sender is checked when sending, as it lives in the auth settings.
          return !settings.fromAddress || isAddress(settings.fromAddress.trim());
        },
        async send(message, authSettings, context) {
          const { settings, provider, from } = await sender(context, authSettings);
          const email = outgoing(message, from, settings);
          if (!email) throw new Error("[email] The recipient isn't an email address.");
          const entry = { recipient: email.to, subject: email.subject, kind: (message.kind ?? "").slice(0, 100), provider: provider.id };
          try {
            const { id } = await provider.send(email, settings);
            if (settings.log) await logMessage(context, { ...entry, state: "sent", providerId: id ?? "" });
          } catch (error) {
            if (settings.log) await logMessage(context, { ...entry, state: "failed", error: failureOf(error) });
            throw error;
          }
        },
        async sendBatch(messages, authSettings, context) {
          const { settings, provider, from } = await sender(context, authSettings);
          const emails = messages.map((message) => outgoing(message, from, settings));
          const ready = emails.filter((email): email is OutgoingEmail => email !== null);
          const refusal = (error: unknown) => (error instanceof ProviderError ? error : new ProviderError(provider.label, null));
          // Through the provider's batch API when it has one, else one call after another, as providers limit calls per second.
          let answers: BatchResult[] = [];
          if (provider.sendBatch) answers = ready.length ? await provider.sendBatch(ready, settings).catch((error: unknown) => ready.map(() => refusal(error))) : [];
          else for (const email of ready) answers.push(await provider.send(email, settings).catch(refusal));
          let next = 0;
          const results = emails.map((email, index) => {
            if (!email) return { ok: false as const, error: "not an address", entry: null };
            const answer = answers[next++] ?? new ProviderError(provider.label, null);
            const entry = { recipient: email.to, subject: email.subject, kind: (messages[index].kind ?? "").slice(0, 100), provider: provider.id };
            return answer instanceof ProviderError || !("id" in answer)
              ? { ok: false as const, error: failureOf(answer), entry: { ...entry, state: "failed", error: failureOf(answer) } }
              : { ok: true as const, entry: { ...entry, state: "sent", providerId: answer.id ?? "" } };
          });
          if (settings.log) for (const { entry } of results) if (entry) await logMessage(context, entry);
          return results.map((result) => (result.ok ? { ok: true as const } : { ok: false as const, error: result.error }));
        },
      },
    },
    jobs: [{ name: "email-forget-messages", cron: "23 3 * * *", handler: forgetOldMessages }],
    migrations: [
      {
        id: "001-messages",
        up: async ({ schema }) => {
          if (await schema.describe(MESSAGES)) throw new Error(`A collection called "${MESSAGES}" already exists, and the email plugin didn't create it. Rename it under Dashboard → Collections, then start again.`);
          await schema.apply({
            version: 1,
            collections: [{
              slug: MESSAGES,
              name: "Messages",
              description: "Each email the site sent through the provider, and whether the provider took it. Bodies are never kept: they can hold sign-in links and codes.",
              // Only people with permissions on this collection see it. Only the plugin writes it.
              rules: { listRule: null, viewRule: null, ...LOCKED },
              fields: [
                { name: "recipient", type: "email", config: { required: true } },
                { name: "subject", type: "text", config: { maxLength: 300 } },
                { name: "kind", type: "text", config: { maxLength: 100, description: "What sent it, such as auth:reset-password, plugin:blog or test." } },
                { name: "provider", type: "text", config: { maxLength: 20 } },
                { name: "state", type: "text", config: { required: true, maxLength: 20, description: "sent, when the provider took it, or failed." } },
                { name: "providerId", type: "text", config: { maxLength: 255, description: "The provider's id for the message, to look it up there." } },
                { name: "error", type: "text", config: { maxLength: 100, description: "Only the provider's status code, never what it said." } },
              ],
            }],
          });
        },
      },
      {
        id: "002-names-in-languages",
        up: async ({ schema }) => {
          for (const [slug, labels] of Object.entries(COLLECTION_LABELS)) await schema.addLabels(slug, labels);
          for (const [slug, fields] of Object.entries(FIELD_LABELS)) await schema.addFieldLabels(slug, fields);
        },
      },
    ],
  });
}
