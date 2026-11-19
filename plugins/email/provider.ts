import type { Messages, PluginSettingField } from "tansy/plugin";

/**
 * What an email provider adapter implements, such as @tansy/email-resend. Email keeps
 * everything providers share: choosing one, the sender, the delivery log. An adapter only
 * turns one message into one API call. See docs/plugins/email.md.
 */

/** Email's own settings, and each installed provider's, by name. */
export interface EmailSettings {
  /** The id of the provider sending mail. */
  provider: string;
  fromAddress: string;
  fromName: string;
  replyTo: string;
  log: boolean;
  logDays: number;
  [name: string]: unknown;
}

/** One message, ready to send. Every address has been checked, and no value holds a line break where a header would break. */
export interface OutgoingEmail {
  from: { address: string; name: string };
  to: string;
  replyTo: string | null;
  subject: string;
  text: string;
  html: string;
  /** Only List-Unsubscribe and List-Unsubscribe-Post, on mail sent to many. Send them as headers. Empty otherwise. */
  headers: Record<string, string>;
  /** Mail to many people at once, such as a newsletter. A provider with a separate bulk stream sends it there. */
  bulk: boolean;
}

/** What became of one message of a batch: its id at the provider, or the refusal. */
export type BatchResult = { id: string | null } | ProviderError;

export interface EmailProvider {
  /** Lowercase letters and digits, such as "resend". Every setting's name starts with it. */
  id: string;
  label: string;
  /** Its keys and options on Email → Settings. */
  settings(): PluginSettingField[];
  /**
   * Its settings' words in other interface languages, by language code, as
   * `{ ar: { settings: { <name>: { label, description } } } }`. Email adds them to its own
   * `messages`, and the setting's `label` and `description` cover any language missing.
   */
  messages?: Record<string, Messages>;
  /** Whether the keys it needs are set. */
  ready(settings: EmailSettings): boolean;
  /** Sends one message. Returns the provider's id for it, when it gives one. Throw `ProviderError` on a refusal. */
  send(email: OutgoingEmail, settings: EmailSettings): Promise<{ id: string | null }>;
  /**
   * Sends up to 100 messages in one call, through the provider's batch API, and answers for
   * each in order. Throw `ProviderError` when the whole call is refused. Email sends one at a
   * time when it's left out.
   */
  sendBatch?(emails: OutgoingEmail[], settings: EmailSettings): Promise<BatchResult[]>;
}

/** Types an adapter. */
export const defineEmailProvider = (provider: EmailProvider): EmailProvider => provider;

/**
 * A provider refused or failed to take a message. Only the status reaches the message and
 * the log: a provider's answer can quote the site's account, keys or the recipient.
 */
export class ProviderError extends Error {
  constructor(readonly provider: string, readonly status: number | null) {
    super(status ? `${provider} answered ${status}` : `${provider} couldn't be reached`);
    this.name = "ProviderError";
  }
}

const TIMEOUT_MS = 15_000;

/**
 * Calls a provider's API and returns its JSON answer, or `{}` when it has none. Times out
 * after 15 seconds. Anything but a 2xx throws a `ProviderError` with only the status.
 */
export async function callProvider(provider: string, url: string, init: RequestInit, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderError(provider, null);
  }
  if (!response.ok) {
    // Read and dropped, so the connection can be reused. What it said stays out of logs.
    await response.body?.cancel().catch(() => {});
    throw new ProviderError(provider, response.status);
  }
  const body = await response.text().catch(() => "");
  try {
    const parsed: unknown = body ? JSON.parse(body) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** "Name <address>", quoting the name when it needs it. */
export function mailbox({ address, name }: { address: string; name: string }): string {
  if (!name) return address;
  const plain = /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]+$/.test(name);
  return `${plain ? name : `"${name.replace(/["\\]/g, "\\$&")}"`} <${address}>`;
}

export const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
export const idOf = (value: unknown) => (typeof value === "string" && value ? value.slice(0, 255) : null);
