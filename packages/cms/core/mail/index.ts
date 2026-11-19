import "server-only";
import nodemailer from "nodemailer";
import { authExtensions } from "../config";
import type { AuthSettings } from "../auth/settings-schema";
import type { ExtensionContext } from "../extend/define";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** What sent it, such as "auth:reset-password", "plugin:blog" or "test", for a delivery log. */
  kind?: string;
  /** Where replies go, such as the visitor who filled in a form. Already checked to be one address. */
  replyTo?: string;
  /**
   * Extra headers core sets, never a plugin: only `List-Unsubscribe` and `List-Unsubscribe-Post`
   * (RFC 2369 and 8058), already checked to hold no line breaks.
   */
  headers?: Record<string, string>;
  /** Sent to many people at once, such as a newsletter, rather than to one person about their account. Providers may route it through their bulk stream. */
  bulk?: boolean;
}

/** One message of a batch: delivered, or not, with a short reason that never quotes the provider. */
export type MailResult = { ok: true } | { ok: false; error: string };

/** Delivers mail instead of SMTP, under a plugin's `auth.mail`, such as @tansy/email. */
export interface MailAdapter {
  /** `context` is the plugin's own, so the adapter can read its settings and keys. */
  send(message: MailMessage, settings: AuthSettings, context: ExtensionContext): Promise<void>;
  /** Whether it can send right now, such as once its keys are set. Until then mail goes through SMTP. Always ready when left out. */
  ready?(context: ExtensionContext): boolean | Promise<boolean>;
  /**
   * Sends up to 100 messages at once, such as through a provider's batch API, and reports each
   * one, in order. Core calls `send` once per message when this is left out.
   */
  sendBatch?(messages: MailMessage[], settings: AuthSettings, context: ExtensionContext): Promise<MailResult[]>;
}

/** The most messages one batch takes. */
export const MAX_BATCH = 100;

function smtpTransport(settings: AuthSettings, pool = false) {
  const { host, port, secure, requireStartTls, username, password } = settings.mail;
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: username ? { user: username, pass: password } : undefined,
    requireTLS: !secure && requireStartTls,
    // A batch reuses a few connections instead of opening one per message.
    ...(pool ? { pool: true, maxConnections: 3 } : {}),
  });
}

function smtpMail(message: MailMessage, settings: AuthSettings) {
  const { fromAddress, fromName } = settings.mail;
  const { to, subject, text, html, replyTo, headers } = message;
  return { to, subject, text, html, from: { name: fromName, address: fromAddress }, ...(replyTo ? { replyTo } : {}), ...(headers ? { headers } : {}) };
}

const smtp = {
  async send(message: MailMessage, settings: AuthSettings) {
    await smtpTransport(settings).sendMail(smtpMail(message, settings));
  },
};

/** Never the server's words, which can quote the account or the recipient. */
const failure = (error: unknown) => {
  const status = error && typeof error === "object" ? (error as { status?: unknown; responseCode?: unknown }).status ?? (error as { responseCode?: unknown }).responseCode : undefined;
  return typeof status === "number" ? `status ${status}` : "not delivered";
};

export type Mailer = { kind: "plugin"; name: string; adapter: MailAdapter; context: ExtensionContext } | { kind: "smtp" };

const pluginContext = (name: string) => import("../extend/hooks").then(({ extensionContext }) => extensionContext(`plugin:${name}`));

/** Who delivers mail now: the first plugin adapter that's ready, then SMTP, or null when neither is set up. */
export async function activeMailer(settings: AuthSettings): Promise<Mailer | null> {
  for (const extension of authExtensions()) {
    if (!extension.mail) continue;
    const context = await pluginContext(extension.name);
    // A plugin whose readiness check fails counts as not set up, so mail falls back instead of stopping.
    const ready = await Promise.resolve(extension.mail.ready ? extension.mail.ready(context) : true).catch((error: unknown) => {
      console.error(`[mail] ${extension.name}: readiness check failed`, error);
      return false;
    });
    if (ready) return { kind: "plugin", name: extension.name, adapter: extension.mail, context };
  }
  return settings.mail.host ? { kind: "smtp" } : null;
}

/** For Settings → Email: the plugins that can deliver mail, and the one delivering it now, if any. */
export async function mailDelivery(settings: AuthSettings): Promise<{ active: string | null; plugins: string[] }> {
  const mailer = await activeMailer(settings);
  return { active: mailer?.kind === "plugin" ? mailer.name : null, plugins: authExtensions().filter((extension) => extension.mail).map((extension) => extension.name) };
}

export async function mailConfigured(settings: AuthSettings): Promise<boolean> {
  return (await activeMailer(settings)) !== null;
}

export async function sendMail(message: MailMessage, settings: AuthSettings): Promise<void> {
  const mailer = await activeMailer(settings);
  if (mailer?.kind === "plugin") return mailer.adapter.send(message, settings, mailer.context);
  if (mailer?.kind === "smtp") return smtp.send(message, settings);
  if (process.env.NODE_ENV === "production") {
    console.error(`[mail] No mail delivery is set up; dropped "${message.subject}"`);
    return;
  }
  // Development only: there is no inbox yet, so links and codes go to the console.
  console.info(`[mail:dev] to=${message.to} subject="${message.subject}"\n${message.text}`);
}

/**
 * Sends a batch now and reports each message, in order, for a sender that must know what went,
 * such as a newsletter. Through the active plugin's `sendBatch` when it has one, else one at a
 * time. With no delivery set up, every message fails, except in development, where they go to
 * the console like any other mail.
 */
export async function sendMailBatch(messages: MailMessage[], settings: AuthSettings): Promise<MailResult[]> {
  if (messages.length > MAX_BATCH) throw new Error(`A batch takes at most ${MAX_BATCH} messages.`);
  if (!messages.length) return [];
  const mailer = await activeMailer(settings);
  if (mailer?.kind === "plugin" && mailer.adapter.sendBatch) {
    const results = await mailer.adapter.sendBatch(messages, settings, mailer.context).catch((error: unknown) => {
      console.error(`[mail] ${mailer.name}: batch failed`, error);
      return messages.map((): MailResult => ({ ok: false, error: failure(error) }));
    });
    // An adapter that answers for fewer messages than it was given leaves the rest undelivered.
    return messages.map((_, index) => results[index] ?? { ok: false, error: "not delivered" });
  }
  if (mailer?.kind === "smtp") {
    const transport = smtpTransport(settings, true);
    try {
      const results: MailResult[] = [];
      for (const message of messages) {
        results.push(await transport.sendMail(smtpMail(message, settings)).then((): MailResult => ({ ok: true }), (error: unknown): MailResult => {
          console.error("[mail] delivery failed", error);
          return { ok: false, error: failure(error) };
        }));
      }
      return results;
    } finally {
      transport.close();
    }
  }
  const results: MailResult[] = [];
  for (const message of messages) {
    if (mailer?.kind === "plugin") {
      results.push(await mailer.adapter.send(message, settings, mailer.context).then((): MailResult => ({ ok: true }), (error: unknown): MailResult => {
        console.error(`[mail] ${mailer.name}: delivery failed`, error);
        return { ok: false, error: failure(error) };
      }));
    } else if (process.env.NODE_ENV === "production") {
      results.push({ ok: false, error: "no mail delivery is set up" });
    } else {
      await sendMail(message, settings);
      results.push({ ok: true });
    }
  }
  return results;
}

/** Fire and forget: awaiting delivery would reveal whether an account exists through timing. */
export function queueMail(message: MailMessage, settings: AuthSettings): void {
  void sendMail(message, settings).catch((error) => console.error("[mail] delivery failed", error));
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The language an email is written in, for its HTML. Codes are checked before they get here. */
export interface MailLanguage { locale: string; direction: "ltr" | "rtl" }

const inLanguage = (html: string, language?: MailLanguage) => (language ? `<div lang="${escapeHtml(language.locale)}" dir="${language.direction}">${html}</div>` : html);

/** Where someone stops getting a message sent to many, as the footer link and the List-Unsubscribe headers show it. */
export interface MailUnsubscribe {
  /** A page where the person confirms. In the footer, and in List-Unsubscribe unless `oneClick` is given. */
  url: string;
  /** Takes RFC 8058's one-click POST, so a mail client's unsubscribe button works without opening a page. */
  oneClick?: string;
  /** The footer link's words, in the message's language. "Unsubscribe" when left out. */
  label?: string;
}

/** A plugin's email: plain text, with blank lines between paragraphs, or rich text, and an optional button. */
export function extensionEmail(to: string, appName: string, subject: string, body: string | { html: string; text: string }, action?: { label: string; url: string }, language?: MailLanguage, unsubscribe?: MailUnsubscribe): MailMessage {
  const rich = typeof body === "string" ? null : body;
  const plain = typeof body === "string" ? body : body.text;
  const footer = unsubscribe ? `${unsubscribe.label ?? "Unsubscribe"}: ${unsubscribe.url}` : null;
  const text = [plain, action && `${action.label}: ${action.url}`, footer && `--\n${footer}`].filter(Boolean).join("\n\n");
  const paragraphs = plain.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const html = [
    ...(rich ? [rich.html] : paragraphs.map((part) => `<p>${escapeHtml(part).replaceAll("\n", "<br>")}</p>`)),
    action ? `<p><a href="${escapeHtml(action.url)}">${escapeHtml(action.label)}</a></p>` : "",
    unsubscribe ? `<p style="color:#6b7280;font-size:12px;margin-top:32px"><a href="${escapeHtml(unsubscribe.url)}" style="color:#6b7280">${escapeHtml(unsubscribe.label ?? "Unsubscribe")}</a></p>` : "",
  ].join("");
  const message: MailMessage = { to, subject: `${subject} - ${appName}`, text, html: inLanguage(html, language) };
  if (unsubscribe) {
    message.headers = unsubscribe.oneClick
      ? { "List-Unsubscribe": `<${unsubscribe.oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
      : { "List-Unsubscribe": `<${unsubscribe.url}>` };
    message.bulk = true;
  }
  return message;
}

export function authEmail(
  to: string,
  appName: string,
  subject: string,
  body: string,
  action?: { label: string; url: string },
  code?: string,
  language?: MailLanguage & { ignoreNotice: string },
): MailMessage {
  const fullSubject = `${subject} - ${appName}`;
  const text = [body, code, action && `${action.label}: ${action.url}`].filter(Boolean).join("\n\n");
  const html = [
    `<p>${escapeHtml(body)}</p>`,
    code ? `<p style="font-size:24px;letter-spacing:4px"><strong>${escapeHtml(code)}</strong></p>` : "",
    action ? `<p><a href="${escapeHtml(action.url)}">${escapeHtml(action.label)}</a></p>` : "",
    `<p style="color:#6b7280;font-size:12px">${escapeHtml(language?.ignoreNotice ?? "If you did not request this, you can ignore this email.")}</p>`,
  ].join("");
  return { to, subject: fullSubject, text, html: inLanguage(html, language) };
}
