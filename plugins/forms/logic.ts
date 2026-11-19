import { english } from "./site-messages";
/** What Forms does with a form's fields and a visitor's answers. No server imports, so it's easy to test. */

export type FieldKind = "text" | "email" | "textarea" | "select" | "checkbox" | "number";

/** One field, as the browser gets it. Everything here is public. */
export interface FormField {
  kind: FieldKind;
  name: string;
  label: string;
  required: boolean;
  help: string;
  placeholder: string;
  maxLength?: number;
  options?: string[];
  min?: number;
  max?: number;
}

const KINDS: Record<string, FieldKind> = { forms_text: "text", forms_email: "email", forms_textarea: "textarea", forms_select: "select", forms_checkbox: "checkbox", forms_number: "number" };
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** The most fields one form takes, so a submission's size stays bounded. */
export const MAX_FIELDS = 50;

const str = (value: unknown) => (typeof value === "string" ? value : "");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
/** One line of plain text: no control characters, so nothing can become a header or break a layout. */
export const oneLine = (value: string) => value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * A form's fields from its `fields` stream. Blocks of other types are skipped, and so is a
 * second field with a name already used: the first one wins, as the owner was told when saving.
 */
export function fieldsOf(stream: unknown): FormField[] {
  if (!Array.isArray(stream)) return [];
  const fields: FormField[] = [];
  const seen = new Set<string>();
  for (const block of stream as Array<{ type?: unknown; value?: Record<string, unknown> }>) {
    const kind = KINDS[str(block?.type)];
    const value = block?.value ?? {};
    const name = str(value.name);
    if (!kind || !NAME.test(name) || seen.has(name) || fields.length >= MAX_FIELDS) continue;
    seen.add(name);
    const field: FormField = { kind, name, label: oneLine(str(value.label)) || name, required: value.required === true, help: oneLine(str(value.help)), placeholder: oneLine(str(value.placeholder)) };
    if (kind === "text") field.maxLength = Math.min(num(value.maxLength) ?? 200, 1000);
    if (kind === "textarea") field.maxLength = Math.min(num(value.maxLength) ?? 5000, 10000);
    if (kind === "email") field.maxLength = 254;
    if (kind === "select") field.options = [...new Set(str(value.options).split("\n").map(oneLine).filter(Boolean))].slice(0, 100);
    if (kind === "number") Object.assign(field, num(value.min) === undefined ? {} : { min: num(value.min) }, num(value.max) === undefined ? {} : { max: num(value.max) });
    fields.push(field);
  }
  return fields;
}

/** Names used by more than one field, for the owner to fix before saving. */
export function duplicateNames(stream: unknown): string[] {
  if (!Array.isArray(stream)) return [];
  const names = (stream as Array<{ type?: unknown; value?: Record<string, unknown> }>).filter((block) => KINDS[str(block?.type)]).map((block) => str(block.value?.name));
  return [...new Set(names.filter((name, index) => name && names.indexOf(name) !== index))];
}

const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
export const isAddress = (value: string) => value.length <= 254 && ADDRESS.test(value);

export type Answer = string | number | boolean;

export interface Checked {
  /** The answers to keep, by field name. Empty optional fields are left out. */
  data: Record<string, Answer>;
  /** By field name, what to fix. */
  errors: Record<string, string>;
  /** The first email field's answer, for replies. */
  replyTo: string | null;
}

/** Words by key under `forms`, such as the visitor's from the page, or English. */
export type Words = (key: string, values?: Record<string, string | number>) => string;

/**
 * Checks answers against the form's own fields, the way the browser should have. Problems are
 * worded with `t`, in the visitor's language when the route knows it. Anything
 * the form doesn't ask is dropped, so a submission can only hold what the owner asked for.
 */
export function check(fields: FormField[], values: Record<string, unknown>, t: Words = english): Checked {
  const data: Record<string, Answer> = {};
  const errors: Record<string, string> = {};
  let replyTo: string | null = null;
  for (const field of fields) {
    const raw = values[field.name];
    if (field.kind === "checkbox") {
      const ticked = raw === true || raw === "on" || raw === "true";
      if (field.required && !ticked) errors[field.name] = t("forms.errors.tick");
      data[field.name] = ticked;
      continue;
    }
    if (field.kind === "number") {
      const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : undefined;
      if (value === undefined) { if (field.required) errors[field.name] = t("forms.errors.fill"); continue; }
      if (!Number.isFinite(value)) errors[field.name] = t("forms.errors.number");
      else if (field.min !== undefined && value < field.min) errors[field.name] = t("forms.errors.min", { min: field.min });
      else if (field.max !== undefined && value > field.max) errors[field.name] = t("forms.errors.max", { max: field.max });
      else data[field.name] = value;
      continue;
    }
    if (raw !== undefined && raw !== null && typeof raw !== "string") { errors[field.name] = t("forms.errors.text"); continue; }
    // Long answers keep their line breaks. Everything else is one line.
    const text = field.kind === "textarea" ? str(raw).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim() : oneLine(str(raw));
    if (!text) { if (field.required) errors[field.name] = t("forms.errors.fill"); continue; }
    if (field.maxLength !== undefined && text.length > field.maxLength) { errors[field.name] = t("forms.errors.tooLong", { limit: field.maxLength + 1 }); continue; }
    if (field.kind === "email" && !isAddress(text)) { errors[field.name] = t("forms.errors.email"); continue; }
    if (field.kind === "select" && !field.options?.includes(text)) { errors[field.name] = t("forms.errors.option"); continue; }
    data[field.name] = text;
    if (field.kind === "email" && replyTo === null) replyTo = text;
  }
  return { data, errors, replyTo };
}

/** The addresses to notify: the form's own, else the settings'. At most ten, each checked. */
export function recipients(own: unknown, fallback: unknown): string[] {
  const parse = (value: unknown) => str(value).split(/[,;\s]+/).map((item) => item.trim()).filter((item) => isAddress(item));
  const list = parse(own);
  return [...new Set(list.length ? list : parse(fallback))].slice(0, 10);
}

const MAX_ANSWER = 2000;
const MAX_BODY = 18000;

/** The email the owner gets: each question and answer, plain text, with nothing that could become markup or a link. Worded with `t`, in the owner's language. */
export function notification(title: string, fields: FormField[], data: Record<string, unknown>, page: string, t: Words = english) {
  const named = oneLine(title) || t("forms.mail.aForm");
  const subject = t("forms.mail.subject", { title: named }).slice(0, 150);
  const shown = (value: unknown) => (value === true ? t("forms.mail.yes") : value === false ? t("forms.mail.no") : String(value ?? ""));
  const answers = fields.filter((field) => field.name in data).map((field) => {
    const answer = shown(data[field.name]);
    return `${field.label}\n${answer.length > MAX_ANSWER ? `${answer.slice(0, MAX_ANSWER)}…` : answer}`;
  });
  const intro = page ? t("forms.mail.introOn", { title: named, page: oneLine(page).slice(0, 300) }) : t("forms.mail.intro", { title: named });
  let body = [intro, ...answers, t("forms.mail.outro")].join("\n\n");
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}…\n\n${t("forms.mail.rest")}`;
  return { subject, body };
}

/** Only a site path, such as /contact, so a submission can't carry a link to somewhere else. */
export const pageOf = (value: unknown) => {
  const path = oneLine(str(value)).slice(0, 300);
  return /^\/(?!\/)[^\s\\]*$/.test(path) ? path : "";
};

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function sign(key: string, message: string) {
  const imported = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", imported, encoder.encode(message)));
}

/** When the form was handed out, signed, so a script can't claim it waited. */
export async function issueToken(key: string, formId: number, now = Date.now()) {
  return `${now}.${await sign(key, `${formId}.${now}`)}`;
}

const DAY = 86_400_000;

/** "ok", or why the token doesn't do: not signed by us for this form, too fresh, or a day old. */
export async function tokenProblem(key: string, formId: number, token: unknown, minSeconds: number, now = Date.now()): Promise<"ok" | "invalid" | "early" | "expired"> {
  const match = /^(\d{13})\.([0-9a-f]{64})$/.exec(str(token));
  if (!match) return "invalid";
  const issued = Number(match[1]);
  const expected = await sign(key, `${formId}.${issued}`);
  // Both are hex of the same length, so this compares every character whatever matches.
  let difference = 0;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ match[2].charCodeAt(index);
  if (difference !== 0 || issued > now + 60_000) return "invalid";
  if (now - issued > DAY) return "expired";
  if (now - issued < minSeconds * 1000) return "early";
  return "ok";
}

/** A new signing key: 32 random bytes. */
export const newKey = () => hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
