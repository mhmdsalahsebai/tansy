/**
 * Localization's pure parts: site addresses per language, the text a translator sees,
 * XLIFF, theme and dashboard messages. Storage and access are in localization.test.ts
 * and the integration suite.
 */
import { describe, expect, it } from "vitest";
import { ADMIN_CATALOGS, ADMIN_LOCALES } from "@/core/i18n/catalogs";
import { en } from "@/core/i18n/catalogs/en";
import { formatters, mergeMessages, messageProblems, messagesFor } from "@/core/i18n/messages";
import { hrefFor, localizePath, splitLocalePath, type SiteRouting } from "@/core/i18n/routing";
import { applySegments, extractSegments, MAX_SEGMENTS } from "@/core/i18n/segments";
import { readXliff, writeXliff } from "@/core/i18n/xliff";

const prefix: SiteRouting = { mode: "prefix", prefixDefault: false, domains: {} };
const codes = ["en", "fr", "ar"];

describe("site addresses", () => {
  it("read the language from a prefix, with the default unprefixed", () => {
    expect(splitLocalePath("/fr/blog/lancement", prefix, codes, "en")).toEqual({ locale: "fr", path: "/blog/lancement" });
    expect(splitLocalePath("/fr", prefix, codes, "en")).toEqual({ locale: "fr", path: "/" });
    expect(splitLocalePath("/blog/launch", prefix, codes, "en")).toEqual({ locale: "en", path: "/blog/launch" });
    // A first segment that isn't a public language is just part of the address.
    expect(splitLocalePath("/de/x", prefix, codes, "en")).toEqual({ locale: "en", path: "/de/x" });
    // "/en/x" isn't the default language's address when the default has no prefix.
    expect(splitLocalePath("/en/x", prefix, codes, "en")).toEqual({ locale: "en", path: "/en/x" });
    expect(splitLocalePath("/en/x", { ...prefix, prefixDefault: true }, codes, "en")).toEqual({ locale: "en", path: "/x" });
  });

  it("read the language from the host with a domain per language", () => {
    const domains: SiteRouting = { mode: "domains", prefixDefault: false, domains: { fr: "fr.example.com", en: "example.com" } };
    expect(splitLocalePath("/blog/x", domains, codes, "en", "FR.example.com")).toEqual({ locale: "fr", path: "/blog/x" });
    expect(splitLocalePath("/blog/x", domains, codes, "en", "unknown.test")).toEqual({ locale: "en", path: "/blog/x" });
    expect(hrefFor(localizePath("/blog/x", "fr", domains, "en"))).toBe("https://fr.example.com/blog/x");
  });

  it("write a record's address in each language", () => {
    expect(localizePath("/blog/x", "fr", prefix, "en")).toEqual({ path: "/fr/blog/x" });
    expect(localizePath("/", "fr", prefix, "en")).toEqual({ path: "/fr" });
    expect(localizePath("/blog/x", "en", prefix, "en")).toEqual({ path: "/blog/x" });
    expect(localizePath("/blog/x", "en", { ...prefix, prefixDefault: true }, "en")).toEqual({ path: "/en/blog/x" });
    expect(localizePath("/blog/x", "fr", { ...prefix, mode: "none" }, "en")).toEqual({ path: "/blog/x" });
  });
});

describe("translatable text", () => {
  const catalog = new Map([["quote", { fields: [{ name: "text", type: "text" }, { name: "size", type: "number" }] }]]);
  const fields = [{ name: "title", type: "text" }, { name: "body", type: "rich_text" }, { name: "blocks", type: "stream" }, { name: "price", type: "number" }, { name: "slug", type: "url" }];
  const values = {
    title: "Launch",
    body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world", marks: [{ type: "bold" }] }] }] },
    blocks: [{ id: "b1", type: "quote", v: 1, value: { text: "Ship it", size: 3 } }, { id: "b2", type: "missing", value: { text: "kept" } }],
    price: 10,
    slug: "https://example.com",
  };

  it("takes text, rich text nodes and blocks' text apart, with stable ids", () => {
    expect(extractSegments(fields, values, catalog)).toEqual([
      { id: "title", text: "Launch" },
      { id: "body#0.0", text: "Hello " },
      { id: "body#0.1", text: "world" },
      { id: "blocks/b1/text", text: "Ship it" },
    ]);
  });

  it("puts translations back without touching structure, marks or anything that isn't text", () => {
    const translated = new Map([["title", "Lancement"], ["body#0.1", "monde"], ["blocks/b1/text", "Livrez"], ["blocks/b9/text", "invented"], ["price", "999"]]);
    const result = applySegments(fields, values, catalog, translated);
    expect(result.title).toBe("Lancement");
    expect(JSON.stringify(result.body)).toContain('"text":"monde","marks":[{"type":"bold"}]');
    expect(JSON.stringify(result.body)).toContain('"text":"Hello "');
    expect(result.blocks).toEqual([{ id: "b1", type: "quote", v: 1, value: { text: "Livrez", size: 3 } }, values.blocks[1]]);
    expect(result).not.toHaveProperty("price");
  });

  it("stops at a limit, however much text a record holds", () => {
    const many = { blocks: Array.from({ length: MAX_SEGMENTS + 50 }, (_, i) => ({ id: `b${i}`, type: "quote", value: { text: `t${i}` } })) };
    expect(extractSegments([{ name: "blocks", type: "stream" }], many, catalog)).toHaveLength(MAX_SEGMENTS);
  });
});

describe("XLIFF", () => {
  const records = [{ collection: "posts", id: 12, sourceHash: "abc", segments: [{ id: "title", text: "Fish & <chips>", target: "Poisson" }, { id: "body#0.0", text: "Hi \"there\"" }] }];

  it("round-trips sources, targets and escaping", () => {
    const xml = writeXliff(records, "en", "fr");
    expect(xml).toContain('srcLang="en" trgLang="fr"');
    expect(xml).toContain("Fish &amp; &lt;chips&gt;");
    const parsed = readXliff(xml.replace("<target>Poisson</target>", "<target>Poisson &amp; frites</target>").replace("</source>\n        </segment>\n      </unit>\n    </file>", "</source>\n          <target>Salut <ph id=\"1\"/>toi</target>\n        </segment>\n      </unit>\n    </file>"));
    expect(parsed).toMatchObject({ from: "en", to: "fr" });
    expect(parsed.records[0]).toMatchObject({ collection: "posts", id: 12, sourceHash: "abc" });
    expect(Object.fromEntries(parsed.records[0].targets)).toEqual({ title: "Poisson & frites", "body#0.0": "Salut toi" });
  });

  it("refuses DTDs and entities, so a file can't expand or reach out", () => {
    expect(() => readXliff('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><xliff version="2.0"></xliff>')).toThrow(/DTD/);
    expect(() => readXliff("<xliff version=\"1.2\"></xliff>")).toThrow(/XLIFF 2/);
  });

  it("ignores files that don't name a record", () => {
    const parsed = readXliff('<xliff version="2.0" srcLang="en" trgLang="fr"><file id="../../etc"><unit id="x"><segment><target>y</target></segment></unit></file></xliff>');
    expect(parsed.records).toEqual([]);
  });
});

describe("messages", () => {
  it("fall back key by key along a language's chain", () => {
    const merged = messagesFor({ en: { a: "A", group: { b: "B", c: "C" } }, fr: { group: { b: "Bé" } } }, ["fr-CA", "fr", "en"]);
    expect(merged).toEqual({ a: "A", group: { b: "Bé", c: "C" } });
  });

  it("never merge prototype keys", () => {
    const merged = mergeMessages({ a: "x" }, JSON.parse('{"__proto__": {"polluted": "yes"}, "b": "y"}'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(merged).toEqual({ a: "x", b: "y" });
  });

  it("format ICU plurals, show the key for a missing message, and format dates and numbers by language", () => {
    const { t, formatNumber, formatDate } = formatters("ar", { posts: "{count, plural, one {مقال واحد} other {# مقالات}}" });
    expect(t("posts", { count: 1 })).toBe("مقال واحد");
    expect(t("missing.key")).toBe("missing.key");
    expect(formatNumber(1234.5)).toBe(new Intl.NumberFormat("ar").format(1234.5));
    expect(formatDate("2026-01-02T00:00:00Z", "long")).toBe(new Intl.DateTimeFormat("ar", { dateStyle: "long", timeZone: "UTC" }).format(new Date("2026-01-02T00:00:00Z")));
  });

  it("report invalid ICU and dotted keys", () => {
    expect(messageProblems({ ok: "Hi {name}", nested: { fine: "{n, plural, one {#} other {#}}" } })).toEqual([]);
    expect(messageProblems({ bad: "Hi {name" })).toHaveLength(1);
    expect(messageProblems({ "a.b": "x" })[0]).toMatch(/dots/);
  });
});

describe("dashboard catalogs", () => {
  const keys = (value: unknown, prefix = ""): string[] => Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => (typeof inner === "string" ? [`${prefix}${key}`] : keys(inner, `${prefix}${key}.`)));

  it.each(ADMIN_LOCALES)("%s has every English key and valid ICU", (code) => {
    const catalog = ADMIN_CATALOGS[code];
    expect(keys(catalog).sort()).toEqual(keys(en).sort());
    expect(messageProblems(catalog as never)).toEqual([]);
  });
});
