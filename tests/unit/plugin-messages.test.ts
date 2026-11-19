/**
 * First-party plugins' dashboard words: English and Arabic each, with the same keys, valid
 * ICU, and names in other languages only for collections the plugin makes.
 */
import { describe, expect, it } from "vitest";
import { messageProblems, type Messages } from "@/core/i18n/messages";
import * as ai from "../../plugins/ai/messages";
import * as blog from "../../plugins/blog/messages";
import * as forms from "../../plugins/forms/messages";
import * as lms from "../../plugins/lms/messages";
import * as payments from "../../plugins/payments/messages";
import * as shop from "../../plugins/shop/messages";
import * as subscriptions from "../../plugins/subscriptions/messages";

const PLUGINS: Record<string, { messages: Record<string, Messages>; COLLECTION_LABELS?: Record<string, Record<string, string>> }> = { ai, blog, forms, lms, payments, shop, subscriptions };

function keys(messages: Messages, prefix = ""): string[] {
  return Object.entries(messages).flatMap(([key, value]) => (typeof value === "string" ? [`${prefix}${key}`] : keys(value as Messages, `${prefix}${key}.`))).sort();
}

describe.each(Object.entries(PLUGINS))("the %s plugin's messages", (name, plugin) => {
  it("come in English and Arabic, with the same keys", () => {
    expect(Object.keys(plugin.messages).sort()).toEqual(["ar", "en"]);
    expect(keys(plugin.messages.ar)).toEqual(keys(plugin.messages.en));
  });

  it("are valid ICU", () => {
    for (const locale of ["en", "ar"]) expect(messageProblems(plugin.messages[locale]), `${name} ${locale}`).toEqual([]);
  });

  it("name only the plugin's own collections", () => {
    for (const slug of Object.keys(plugin.COLLECTION_LABELS ?? {})) expect(slug.startsWith(`${name}-`), slug).toBe(true);
  });
});
