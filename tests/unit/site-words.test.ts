/**
 * The words on public pages: CMS, plugin, theme and owner words layered per language, links
 * in the page's language, emails in the reader's, every plugin's site words in English and
 * Arabic, and synced streams lined up with the default language.
 */
import { describe, expect, it } from "vitest";
import { messageProblems, type Messages } from "@/core/i18n/messages";
import { alignStream, isSyncedStream } from "@/core/i18n/synced";
import { diffFields } from "@/core/schema/diff";
import { contentLocale, pageWords, pickWords, sitePath, siteWords, wordsIn, type SiteWords } from "@/core/site/words";
import { pluginRenderers } from "@/components/stream/StreamField";
import { siteMessages as blog } from "../../plugins/blog/site-messages";
import { siteMessages as forms } from "../../plugins/forms/site-messages";
import { siteMessages as lms } from "../../plugins/lms/site-messages";
import { siteMessages as payments } from "../../plugins/payments/site-messages";
import { siteMessages as shop } from "../../plugins/shop/site-messages";

const PLUGINS: Record<string, Record<string, Messages>> = { blog, forms, lms, payments, shop };

function keys(messages: Messages, prefix = ""): string[] {
  return Object.entries(messages).flatMap(([key, value]) => (typeof value === "string" ? [`${prefix}${key}`] : keys(value as Messages, `${prefix}${key}.`))).sort();
}

describe.each(Object.entries(PLUGINS))("the %s plugin's site words", (name, messages) => {
  it("come in English and Arabic, with the same keys, under the plugin's name", () => {
    expect(Object.keys(messages).sort()).toEqual(["ar", "en"]);
    expect(Object.keys(messages.en)).toEqual([name]);
    expect(keys(messages.ar)).toEqual(keys(messages.en));
  });

  it("are valid ICU, and pass the check renderers get", () => {
    for (const locale of ["en", "ar"]) expect(messageProblems(messages[locale]), `${name} ${locale}`).toEqual([]);
    expect(() => pluginRenderers(name, { messages })).not.toThrow();
  });
});

describe("site words", () => {
  const plugins = { en: { shop: { cart: "Cart", empty: "Empty" } }, ar: { shop: { cart: "السلة" } } };

  it("layer the CMS's, plugins', the theme's and the owner's, falling back to the default language", () => {
    const words = pageWords("ar", ["ar", "en"], { plugins, theme: { ar: { shop: { cart: "عربة" } } }, owner: { en: { shop: { empty: "Nothing here" } } } });
    const { t } = siteWords(words);
    expect(t("shop.cart")).toBe("عربة");
    expect(t("shop.empty")).toBe("Nothing here");
    expect(t("cms.next")).toBe(siteWords(pageWords("ar", ["ar"], {})).t("cms.next"));
    expect(t("cms.next")).not.toBe("Next");
  });

  it("work without any, in English", () => {
    expect(siteWords(undefined).t("cms.next")).toBe("Next");
  });

  it("are picked per plugin, keeping the site's languages", () => {
    const site = { locale: "ar", defaultLocale: "en", routing: { mode: "prefix" as const, prefixDefault: false, domains: {} } };
    const picked = pickWords(pageWords("ar", ["ar", "en"], { plugins: { ...plugins, en: { ...plugins.en, blog: { home: "Blog" } } } }, site), "shop");
    expect(Object.keys(picked.messages)).toEqual(["shop"]);
    expect(picked.site).toEqual(site);
  });

  it("link and read records in the page's language only on a site with several", () => {
    const routing = { mode: "prefix" as const, prefixDefault: false, domains: {} };
    const arabic: SiteWords = { locale: "ar", messages: {}, site: { locale: "ar", defaultLocale: "en", routing } };
    const english: SiteWords = { locale: "en", messages: {}, site: { locale: "en", defaultLocale: "en", routing } };
    expect(sitePath(arabic, "/cart")).toBe("/ar/cart");
    expect(sitePath(english, "/cart")).toBe("/cart");
    expect(sitePath({ locale: "en", messages: {} }, "/cart")).toBe("/cart");
    expect(contentLocale(arabic)).toBe("ar");
    expect(contentLocale({ locale: "en", messages: {} })).toBeUndefined();
  });

  it("write an email in the reader's language, or in English", () => {
    expect(wordsIn(shop, "ar").t("shop.mail.paidSubject", { id: 7 })).not.toBe(wordsIn(shop, "en").t("shop.mail.paidSubject", { id: 7 }));
    expect(wordsIn(lms, "fr-CA").t("lms.passed")).toBe("Passed.");
    expect(wordsIn(lms, null).t("lms.passed")).toBe("Passed.");
  });

  it("can't word another plugin's pages", () => {
    expect(() => pluginRenderers("shop", { messages: { en: { blog: { home: "Mine" } } } })).toThrow(/nest under its name/);
  });
});

describe("synced streams", () => {
  const catalog = new Map([
    ["hero", { fields: [{ name: "heading", type: "text" }, { name: "image", type: "image" }, { name: "body", type: "stream" }] }],
    ["para", { fields: [{ name: "text", type: "rich_text" }] }],
  ]);
  const block = (id: string, type: string, value: Record<string, unknown>) => ({ id, type, value });
  const source = [
    block("a", "hero", { heading: "Hello", image: "en.png", body: [block("c", "para", { text: "One" }), block("d", "para", { text: "Two" })] }),
    block("b", "para", { text: "World" }),
  ];

  it("keep the source's blocks and order, with the translation's text", () => {
    const translation = [
      block("b", "para", { text: "عالم" }),
      block("a", "hero", { heading: "مرحبا", image: "ar.png", body: [block("d", "para", { text: "اثنان" }), block("x", "para", { text: "extra" })] }),
      block("z", "para", { text: "only here" }),
    ];
    expect(alignStream(source, translation, catalog)).toEqual([
      block("a", "hero", { heading: "مرحبا", image: "en.png", body: [block("c", "para", { text: "One" }), block("d", "para", { text: "اثنان" })] }),
      block("b", "para", { text: "عالم" }),
    ]);
  });

  it("give a new translation the source's blocks, and an empty source an empty stream", () => {
    expect(alignStream(source, null, catalog)).toEqual(source);
    expect(alignStream(null, source, catalog)).toBeNull();
  });

  it("take the source's block where the translation changed its type", () => {
    expect(alignStream([source[1]], [block("b", "hero", { heading: "x" })], catalog)).toEqual([source[1]]);
  });

  it("are only localized streams marked synced", () => {
    expect(isSyncedStream({ type: "stream", config: { localized: true, synced: true } })).toBe(true);
    expect(isSyncedStream({ type: "stream", config: { synced: true } })).toBe(false);
    expect(isSyncedStream({ type: "text", config: { localized: true, synced: true } })).toBe(false);
  });

  it("ask before syncing a stream that already has translations", () => {
    const stored = [{ id: 1, name: "body", type: "stream", config: { localized: true } }];
    const synced = [{ id: 1, name: "body", type: "stream", config: { localized: true, synced: true } }];
    expect(diffFields(stored, synced, true).destructive).toHaveLength(1);
    expect(diffFields(stored, synced, false).destructive).toHaveLength(0);
    expect(diffFields(synced, synced, true).destructive).toHaveLength(0);
  });
});
