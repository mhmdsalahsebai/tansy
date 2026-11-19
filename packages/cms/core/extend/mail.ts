import "server-only";
import { z } from "zod";
import { audit } from "../audit";
import { loadAuthSettings } from "../auth/settings";
import { extensionEmail, mailConfigured, MAX_BATCH, queueMail, sendMailBatch, type MailMessage } from "../mail";
import { richTextEmail } from "../mail/rich";
import { richTextProblem, type RichNode } from "../fields/rich-text";
import type { AuthSettings } from "../auth/settings-schema";
import type { ExtensionEmail, ExtensionMail } from "./define";
import { canonicalLocale, textDirection } from "../i18n/codes";

/** An http or https address that can go between a header's angle brackets. */
const headerUrl = z.url({ protocol: /^https?$/ }).max(2048).regex(/^[^\s<>"]+$/, "The address can't hold spaces, quotes or angle brackets.");

const email = z.strictObject({
  to: z.email().max(254),
  replyTo: z.email().max(254).optional(),
  // One line, so nothing can be added to the message's headers.
  subject: z.string().trim().min(1).max(200).regex(/^[^\r\n]*$/, "The subject must be one line."),
  body: z.string().trim().min(1).max(20_000).optional(),
  richText: z.unknown().optional(),
  action: z.strictObject({
    label: z.string().trim().min(1).max(100),
    url: z.url({ protocol: /^https?$/ }).max(2048),
  }).optional(),
  locale: z.string().max(35).optional(),
  unsubscribe: z.strictObject({
    url: headerUrl,
    oneClick: headerUrl.optional(),
    label: z.string().trim().min(1).max(100).regex(/^[^\r\n]*$/).optional(),
  }).optional(),
}).superRefine((value, issues) => {
  if ((value.body === undefined) === (value.richText === undefined)) issues.addIssue({ code: "custom", path: ["body"], message: "Give either body or richText." });
  if (value.richText === undefined) return;
  const problem = richTextProblem(value.richText);
  if (problem) issues.addIssue({ code: "custom", path: ["richText"], message: problem });
  else if (JSON.stringify(value.richText).length > 200_000) issues.addIssue({ code: "custom", path: ["richText"], message: "The text is too long." });
});

/** The message core delivers, or an error naming what's wrong with it. */
function prepare(source: string, message: ExtensionEmail, settings: AuthSettings): MailMessage {
  const parsed = email.safeParse(message);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new Error(`${source}: email not sent. ${issue.path.length ? `"${issue.path.join(".")}": ` : ""}${issue.message}`);
  }
  const { to, replyTo, subject, body, richText, action, locale: raw, unsubscribe } = parsed.data;
  const locale = raw === undefined ? null : canonicalLocale(raw);
  if (raw !== undefined && !locale) throw new Error(`${source}: email not sent. "locale": use a language code such as en or ar.`);
  const content = richText === undefined ? body! : richTextEmail(richText as RichNode);
  if (typeof content !== "string" && !content.text) throw new Error(`${source}: email not sent. "richText": the text is empty.`);
  const built = extensionEmail(to, settings.general.appName, subject, content, action, locale ? { locale, direction: textDirection(locale) } : undefined, unsubscribe);
  return { ...built, kind: source, ...(replyTo ? { replyTo } : {}) };
}

/**
 * Email from a plugin or hook file, sent through the same delivery as account email.
 * `send` queues rather than awaits, so a slow mail server never holds up a hook or a request.
 * `sendBatch` waits, for senders that must know what went. Audit entries name the sender and
 * never the content: one per message for `send`, one per batch, without addresses, for `sendBatch`.
 */
export const extensionMail = (source: string): ExtensionMail => ({
  async send(message) {
    const { settings } = await loadAuthSettings();
    const prepared = prepare(source, message, settings);
    queueMail(prepared, settings);
    void audit({ action: "extension.mail_queued", outcome: "success", actorKind: "system", actorEmail: source, targetType: "email", targetId: prepared.to });
  },
  async sendBatch(messages) {
    if (!Array.isArray(messages)) throw new Error(`${source}: emails not sent. Give an array of emails.`);
    if (messages.length > MAX_BATCH) throw new Error(`${source}: emails not sent. A batch takes at most ${MAX_BATCH} emails.`);
    if (!messages.length) return [];
    const { settings } = await loadAuthSettings();
    // Every message is checked before any is sent, so a bad one can't leave a batch half gone.
    const prepared = messages.map((message, index) => {
      try {
        return prepare(source, message, settings);
      } catch (error) {
        throw new Error(`${(error as Error).message} (email ${index + 1} of the batch)`);
      }
    });
    const results = await sendMailBatch(prepared, settings);
    const sent = results.filter((result) => result.ok).length;
    void audit({ action: "extension.mail_batch", outcome: sent === results.length ? "success" : "failure", actorKind: "system", actorEmail: source, targetType: "email", metadata: { count: results.length, sent, failed: results.length - sent } });
    return results;
  },
  async ready() {
    return mailConfigured((await loadAuthSettings()).settings);
  },
});
