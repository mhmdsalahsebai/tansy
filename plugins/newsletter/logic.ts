/** What the newsletter does with addresses, tokens and campaigns. No server imports, so it's easy to test. */

export const str = (value: unknown) => (typeof value === "string" ? value : "");
/** One line of plain text: no control characters, so nothing can become a header or break a layout. */
export const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
export const isAddress = (value: string) => value.length <= 254 && ADDRESS.test(value);

/** The address as stored: trimmed and in lowercase, so one person is one subscriber whatever they typed. */
export const normalizeAddress = (value: unknown) => str(value).trim().toLowerCase();

/** An address with most of its name hidden, for a page anyone holding the link can open. */
export function maskAddress(address: string) {
  const [name, domain] = address.split("@");
  if (!name || !domain) return "";
  return `${name.slice(0, Math.min(2, name.length - 1) || 1)}•••@${domain}`;
}

/** A record id, from a route param or a stored value. Null for anything else. */
export const idOf = (value: unknown) => {
  const id = typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
};

// Tokens. Each is signed with a key kept in the plugin's store, and names what it's for, so one
// can't be used as another. Addresses are part of what's signed, so a token stops working when
// its subscriber's address changes or the record is replaced.

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function sign(key: string, message: string) {
  const imported = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", imported, encoder.encode(message)));
}

/** Both are hex of the same length, so this compares every character whatever matches. */
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

/** A new signing key: 32 random bytes. */
export const newKey = () => hex(crypto.getRandomValues(new Uint8Array(32)).buffer);

const DAY = 86_400_000;
/** How long a confirmation link works. */
export const CONFIRM_DAYS = 7;

/** For the link in a confirmation email. Works for a week. */
export async function confirmToken(key: string, id: number, address: string, now = Date.now()) {
  return `c${id}.${now}.${await sign(key, `confirm:${id}:${address}:${now}`)}`;
}

/** For the unsubscribe link in every campaign. Never expires, as the law in most places requires it to keep working. */
export async function unsubscribeToken(key: string, id: number, address: string) {
  return `u${id}.${await sign(key, `unsubscribe:${id}:${address}`)}`;
}

export type TokenPurpose = "confirm" | "unsubscribe";

/** What a token claims, before it's checked against the subscriber it names. Null when it isn't one of ours in shape. */
export function readToken(token: unknown): { purpose: TokenPurpose; id: number; issued: number | null; signature: string } | null {
  const text = str(token);
  const confirm = /^c(\d{1,15})\.(\d{13})\.([0-9a-f]{64})$/.exec(text);
  if (confirm) return { purpose: "confirm", id: Number(confirm[1]), issued: Number(confirm[2]), signature: confirm[3] };
  const unsubscribe = /^u(\d{1,15})\.([0-9a-f]{64})$/.exec(text);
  if (unsubscribe) return { purpose: "unsubscribe", id: Number(unsubscribe[1]), issued: null, signature: unsubscribe[2] };
  return null;
}

/** "ok", or why the token doesn't do for this subscriber's address. */
export async function tokenProblem(key: string, token: NonNullable<ReturnType<typeof readToken>>, address: string, now = Date.now()): Promise<"ok" | "invalid" | "expired"> {
  const message = token.purpose === "confirm" ? `confirm:${token.id}:${address}:${token.issued}` : `unsubscribe:${token.id}:${address}`;
  if (!same(await sign(key, message), token.signature)) return "invalid";
  if (token.purpose === "confirm" && token.issued !== null) {
    if (token.issued > now + 60_000) return "invalid";
    if (now - token.issued > CONFIRM_DAYS * DAY) return "expired";
  }
  return "ok";
}

/** When a sign-up form was handed out, signed, so a script can't claim a person took their time. */
export async function formToken(key: string, now = Date.now()) {
  return `${now}.${await sign(key, `signup:${now}`)}`;
}

/** The fastest a person fills in an address and presses the button. */
export const MIN_FORM_SECONDS = 2;

export async function formTokenProblem(key: string, token: unknown, now = Date.now(), minSeconds = MIN_FORM_SECONDS): Promise<"ok" | "invalid" | "early" | "expired"> {
  const match = /^(\d{13})\.([0-9a-f]{64})$/.exec(str(token));
  if (!match) return "invalid";
  const issued = Number(match[1]);
  if (!same(await sign(key, `signup:${issued}`), match[2]) || issued > now + 60_000) return "invalid";
  if (now - issued > DAY) return "expired";
  if (now - issued < minSeconds * 1000) return "early";
  return "ok";
}

/** The least time between two confirmation emails to one address. */
export const CONFIRM_RESEND_MS = 60 * 60_000;

/** Whether another confirmation email may go to this address now. */
export function mayResendConfirmation(lastSent: unknown, now = Date.now()) {
  const at = lastSent ? new Date(str(lastSent) || (lastSent as Date)).getTime() : NaN;
  return !Number.isFinite(at) || now - at >= CONFIRM_RESEND_MS;
}

// Imports.

/** The most addresses one import takes. */
export const MAX_IMPORT = 5000;

/**
 * Addresses pasted into the dashboard, one per line: `ada@example.com`, `Ada Lovelace <ada@example.com>`
 * or `ada@example.com, Ada Lovelace` as a spreadsheet exports it. A header row and blank lines are
 * skipped, the same address twice counts once, and anything else is counted as not an address.
 */
export function parseImport(text: string): { entries: Array<{ email: string; name: string }>; invalid: number; tooMany: boolean } {
  const entries = new Map<string, string>();
  let invalid = 0;
  let tooMany = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^"?e-?mail"?\s*(,|;|$)/i.test(line)) continue;
    let email = "";
    let name = "";
    const angled = /^(.*?)<([^<>]+)>\s*$/.exec(line);
    if (angled) {
      name = angled[1];
      email = angled[2];
    } else {
      const [first, ...rest] = line.split(/[,;\t]/);
      email = first;
      name = rest.join(" ");
    }
    email = normalizeAddress(email.replace(/^"|"$/g, ""));
    name = oneLine(name.replace(/"/g, "")).slice(0, 100);
    if (!isAddress(email)) { invalid++; continue; }
    if (!entries.has(email) && entries.size >= MAX_IMPORT) { tooMany = true; continue; }
    if (!entries.has(email) || (!entries.get(email) && name)) entries.set(email, name);
  }
  return { entries: [...entries].map(([email, name]) => ({ email, name })), invalid, tooMany };
}

/** A CSV cell. A value a spreadsheet would run as a formula starts with an apostrophe. */
export function csvCell(value: unknown) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Campaigns.

interface RichNode { type: string; text?: string; content?: RichNode[] }

/** Whether a rich text document has any words in it. */
export function hasWords(doc: unknown, depth = 0): boolean {
  if (!doc || typeof doc !== "object" || depth > 32) return false;
  const node = doc as RichNode;
  if (typeof node.text === "string" && node.text.trim()) return true;
  return Array.isArray(node.content) && node.content.some((child) => hasWords(child, depth + 1));
}

/** Plain paragraphs as a rich text document. */
export const textDoc = (paragraphs: string[]): RichNode => ({ type: "doc", content: paragraphs.filter(Boolean).map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })) });

/** What a campaign has to send: its text, a button, or both. */
export function campaignProblem(campaign: Record<string, unknown>): "subject" | "empty" | null {
  if (!oneLine(str(campaign.subject))) return "subject";
  if (!hasWords(campaign.body) && !str(campaign.link)) return "empty";
  return null;
}

/** Fields a record might keep its name and its summary in, by how likely each is. */
const TITLE_FIELDS = ["title", "name", "subject", "heading"];
const SUMMARY_FIELDS = ["excerpt", "summary", "description", "intro", "lead", "teaser", "subtitle"];

/**
 * A draft campaign about a record with an address on the site, such as a blog post: its title as
 * the subject, its summary as the text, and a button to read it there. Only fields the caller could
 * read are given, and owners edit the draft before sending.
 */
export function campaignFromRecord(record: Record<string, unknown>, url: string, label: string): { subject: string; body: RichNode | null; link: string; linkLabel: string } {
  const title = TITLE_FIELDS.map((name) => oneLine(str(record[name]))).find(Boolean) ?? "";
  let body: RichNode | null = null;
  for (const name of SUMMARY_FIELDS) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) { body = textDoc(value.split(/\n{2,}/).map((part) => part.trim())); break; }
    if (value && typeof value === "object" && (value as RichNode).type === "doc" && hasWords(value)) { body = value as RichNode; break; }
  }
  return { subject: title.slice(0, 150), body, link: url, linkLabel: label };
}

/** The site's address and a path on it, as one absolute address. A path that's already absolute, as a language's own domain gives, stays. */
export const absolute = (siteUrl: string, path: string) => (/^https?:\/\//.test(path) ? path : `${siteUrl}${path.startsWith("/") ? path : `/${path}`}`);

/** The newsletter page's address from its URL pattern, when it's a plain path. */
export function pagePath(pattern: unknown, fallback: string) {
  const path = str(pattern);
  return /^\/(?!\/)[A-Za-z0-9/_.~-]*$/.test(path) ? path : fallback;
}

/** How many emails go out in a minute, within what the settings allow. */
export const perMinuteOf = (value: unknown) => (typeof value === "number" && Number.isInteger(value) ? Math.min(Math.max(value, 1), 10_000) : 300);

/** The most emails in one call to the mail service. */
export const BATCH = 100;
