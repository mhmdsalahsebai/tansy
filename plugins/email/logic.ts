import type { EmailSettings, OutgoingEmail } from "./provider";

export const MESSAGES = "email-messages";

const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
export const isAddress = (value: string) => value.length <= 254 && ADDRESS.test(value);

/** A display name with line breaks and control characters taken out, so it can't start a new header. */
export const cleanName = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);

/** Who mail comes from: this plugin's sender, else the one under Settings → Email, else nothing. */
export function senderOf(settings: EmailSettings, fallback: { fromAddress: string; fromName: string; appName: string }) {
  const address = [settings.fromAddress, fallback.fromAddress].map((value) => (typeof value === "string" ? value.trim() : "")).find(Boolean) ?? "";
  if (!isAddress(address)) return null;
  const name = cleanName([settings.fromName, fallback.fromName, fallback.appName].map((value) => (typeof value === "string" ? value.trim() : "")).find(Boolean) ?? "");
  return { address, name };
}

/** One message from core as a provider takes it. Null when the recipient isn't an address. */
/** The only headers a message may carry to a provider, each one line. */
const HEADERS = new Set(["List-Unsubscribe", "List-Unsubscribe-Post"]);

export function outgoing(message: { to: string; subject: string; text: string; html: string; replyTo?: string; headers?: Record<string, string>; bulk?: boolean }, from: { address: string; name: string }, settings: EmailSettings): OutgoingEmail | null {
  const to = message.to.trim();
  if (!isAddress(to)) return null;
  // The message's own reply-to, such as a form's visitor, wins over the site-wide one.
  const replyTo = [message.replyTo, settings.replyTo].map((value) => (typeof value === "string" ? value.trim() : "")).find((value) => value && isAddress(value)) ?? null;
  const headers = Object.fromEntries(Object.entries(message.headers ?? {}).filter(([name, value]) => HEADERS.has(name) && typeof value === "string" && !/[\r\n]/.test(value)));
  return { from, to, replyTo, subject: cleanName(message.subject).slice(0, 200) || "(no subject)", text: message.text, html: message.html, headers, bulk: message.bulk === true };
}

/** What the log keeps of a failure: the status, never the provider's words. */
export function failureOf(error: unknown): string {
  if (error && typeof error === "object" && (error as { name?: unknown }).name === "ProviderError") {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? `HTTP ${status}` : "unreachable";
  }
  return "error";
}

/** Log entries are kept this many days. */
export const logDaysOf = (settings: EmailSettings) => (Number.isInteger(settings.logDays) && settings.logDays >= 1 ? Math.min(settings.logDays, 365) : 30);
