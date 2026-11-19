import Database from "better-sqlite3";
import { Kysely, PostgresDialect, SqliteDialect, sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalLocale, chainProblem, fallbackChain, negotiateLocale, textDirection } from "@/core/i18n/codes";
import { isLocalizedField, localizationOf, refLocale } from "@/core/i18n/context";
import { localizedSource } from "@/core/i18n/storage";
import { setScopedTablesForTests } from "@/core/scope/registry";
import { hashValue, outdatedFields, parseSource } from "@/core/i18n/outdated";
import { assertLocaleWritable, canEditLocale, editableLocales } from "@/core/i18n/permissions";
import { grants, isKnownPermission } from "@/core/authz/permissions";
import * as ddl from "@/core/schema/ddl";
import { diffFields } from "@/core/schema/diff";
import { fieldNameProblem, localeTableName } from "@/core/schema/names";

describe("language codes", () => {
  it.each([["en", "en"], ["EN-us", "en-US"], ["zh-hant", "zh-Hant"], ["sr-Latn-RS", "sr-Latn-RS"], ["es-419", "es-419"]])("canonicalizes %s", (input, output) => {
    expect(canonicalLocale(input)).toBe(output);
  });
  it.each(["", "x", "en_US", "en-US-u-ca-buddhist", "i-klingon", "en-x-private", "a".repeat(40), 42, null])("refuses %j", (input) => {
    expect(canonicalLocale(input)).toBeNull();
  });
  it("knows which scripts run right to left", () => {
    expect(textDirection("ar")).toBe("rtl");
    expect(textDirection("he")).toBe("rtl");
    expect(textDirection("fa-IR")).toBe("rtl");
    expect(textDirection("fr")).toBe("ltr");
    expect(textDirection("zh-Hant")).toBe("ltr");
  });
});

describe("fallback chains", () => {
  const locales = [
    { code: "en", fallback: null },
    { code: "fr", fallback: null },
    { code: "fr-CA", fallback: "fr" },
    { code: "de", fallback: null },
  ];
  it("ends at the default", () => {
    expect(fallbackChain("fr-CA", locales, "en")).toEqual(["fr-CA", "fr", "en"]);
    expect(fallbackChain("en", locales, "en")).toEqual(["en"]);
    expect(fallbackChain("de", locales, "en")).toEqual(["de", "en"]);
  });
  it("stops at a loop or an unknown language however the data got there", () => {
    const looped = [{ code: "en", fallback: null }, { code: "a", fallback: "b" }, { code: "b", fallback: "a" }];
    expect(fallbackChain("a", looped, "en")).toEqual(["a", "b", "en"]);
    expect(fallbackChain("a", [{ code: "en", fallback: null }, { code: "a", fallback: "gone" }], "en")).toEqual(["a", "en"]);
  });
  it("never joins more than four languages", () => {
    const long = [{ code: "en", fallback: null }, ...["a", "b", "c", "d", "e"].map((code, index, all) => ({ code, fallback: all[index + 1] ?? null }))];
    const chain = fallbackChain("a", long, "en");
    expect(chain).toHaveLength(4);
    expect(chain.at(-1)).toBe("en");
  });
  it("refuses loops, unknown targets and chains that are too long when saved", () => {
    expect(chainProblem(locales, "en")).toBeNull();
    expect(chainProblem([{ code: "en", fallback: null }, { code: "a", fallback: "b" }, { code: "b", fallback: "a" }], "en")).toMatch(/loop/);
    expect(chainProblem([{ code: "en", fallback: null }, { code: "a", fallback: "zz" }], "en")).toMatch(/isn't a language/);
    expect(chainProblem([{ code: "en", fallback: "en" }], "en")).toMatch(/itself/);
    expect(chainProblem([{ code: "en", fallback: null }, ...["a", "b", "c", "d"].map((code, index, all) => ({ code, fallback: all[index + 1] ?? null }))], "en")).toMatch(/longer/);
  });
});

describe("Accept-Language", () => {
  it("picks by quality, then shorter forms", () => {
    expect(negotiateLocale("fr-CA,fr;q=0.9,en;q=0.8", ["en", "fr"])).toBe("fr");
    expect(negotiateLocale("de;q=0.1, ar", ["en", "ar", "de"])).toBe("ar");
    expect(negotiateLocale("pt-BR", ["en", "pt-BR"])).toBe("pt-BR");
    expect(negotiateLocale("*, ja;q=0", ["en"])).toBeNull();
    expect(negotiateLocale(null, ["en"])).toBeNull();
  });
});

describe("localized fields", () => {
  const collection = { localization: { enabled: true }, fields: [] };
  it("count only in a collection with localization on", () => {
    expect(isLocalizedField(collection, { config: { localized: true } })).toBe(true);
    expect(isLocalizedField({ localization: null }, { config: { localized: true } })).toBe(false);
    expect(isLocalizedField(collection, { config: {} })).toBe(false);
    expect(localizationOf({ localization: { enabled: true, fallback: "none" } })).toEqual({ enabled: true, fallback: "none", fieldFallback: false });
    expect(refLocale(collection, { config: { localized: true } }, "fr")).toBe("fr");
    expect(refLocale(collection, { config: {} }, "fr")).toBe("");
  });
  it("reserves `locale` for new fields only", () => {
    expect(fieldNameProblem("locale")).not.toBeNull();
    const kept = diffFields([{ id: 1, name: "locale", type: "text", config: {} }], [{ id: 1, name: "locale", type: "text", config: {} }]);
    expect(kept.issues).toEqual([]);
    const added = diffFields([], [{ name: "locale", type: "text", config: {} }]);
    expect(added.issues[0].path).toBe("fields.0.name");
  });
  it("asks before sharing a localized field, and only in a localized collection", () => {
    const before = [{ id: 1, name: "title", type: "text", config: { localized: true } }];
    const after = [{ id: 1, name: "title", type: "text", config: {} }];
    expect(diffFields(before, after, true).destructive).toHaveLength(1);
    expect(diffFields(before, after, false).destructive).toHaveLength(0);
  });
  it("finds the field behind a per-language unique violation", () => {
    expect(ddl.columnFromUniqueError("UNIQUE constraint failed: loc_posts.locale, loc_posts.slug")).toBe("slug");
    expect(ddl.columnFromUniqueError("UNIQUE constraint failed: rec_posts.code")).toBe("code");
  });
});

describe("outdated translations", () => {
  it("hashes values the same whatever their key order", () => {
    expect(hashValue({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(hashValue({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(hashValue("x")).not.toBe(hashValue("y"));
  });
  it("names fields whose source changed since the translation was saved", () => {
    const fields = [{ id: 1, name: "title" }, { id: 2, name: "body" }];
    const source = parseSource(JSON.stringify({ locale: "en", hashes: { 1: hashValue("Hello"), 2: hashValue("Body") } }));
    expect(outdatedFields(source, fields, { title: "Hello", body: "Body" })).toEqual([]);
    expect(outdatedFields(source, fields, { title: "Hello!", body: "Body" })).toEqual(["title"]);
    expect(outdatedFields(null, fields, { title: "x" })).toEqual([]);
    expect(parseSource("not json")).toBeNull();
  });
});

describe("language permissions", () => {
  const collection = { id: 3, localization: { enabled: true } };
  const translator = new Set(["record:update", "locale:edit@fr"]);
  it("are known, scoped and covered by locale:edit", () => {
    expect(isKnownPermission("locale:edit")).toBe(true);
    expect(isKnownPermission("locale:edit@fr-CA")).toBe(true);
    expect(isKnownPermission("locale:edit@not a code")).toBe(false);
    expect(grants(new Set(["locale:edit"]), "locale:edit@de")).toBe(true);
    expect(grants(new Set(["locale:edit@fr"]), "locale:edit@de")).toBe(false);
    expect(canEditLocale(translator, "fr")).toBe(true);
    expect(editableLocales(translator)).toEqual(["fr"]);
    expect(editableLocales(new Set(["locale:edit"]))).toBeNull();
  });
  it("keep translators in their language and off shared fields", () => {
    expect(() => assertLocaleWritable(collection, { permissions: translator }, "fr", false, "en")).not.toThrow();
    expect(() => assertLocaleWritable(collection, { permissions: translator }, "de", false, "en")).toThrow(/can't edit content in de/);
    expect(() => assertLocaleWritable(collection, { permissions: translator }, "fr", true, "en")).toThrow(/shared/);
  });
  it("leave rule-based writers and system writes to their rules", () => {
    expect(() => assertLocaleWritable(collection, { permissions: new Set() }, "de", true, "en")).not.toThrow();
    expect(() => assertLocaleWritable(collection, {}, "de", true, "en")).not.toThrow();
    expect(() => assertLocaleWritable({ id: 3, localization: null }, { permissions: translator }, "de", true, "en")).not.toThrow();
  });
});

/**
 * The read source on a real database: which translation a record shows, per chain,
 * and that a draft never shows through a published fallback.
 */
const collection = {
  id: 7,
  slug: "posts",
  type: "base",
  localization: { enabled: true, fallback: "chain", fieldFallback: true },
  fields: [
    { id: 1, name: "title", type: "text", config: { localized: true } },
    { id: 2, name: "price", type: "number", config: {} },
    { id: 3, name: "summary", type: "text", config: { localized: true } },
  ],
};

type Db = Kysely<Record<string, Record<string, unknown>>>;

function suite(name: string, postgres: boolean, open: () => Promise<{ db: Db; close: () => Promise<void> }>) {
  describe(`read source on ${name}`, () => {
    let db: Db;
    let close: () => Promise<void>;
    let previous: string | undefined;

    const read = async (chain: string[], missing: "absent" | "empty" = "absent", extra = collection) => {
      const source = localizedSource(extra, { code: chain[0], chain, missing });
      const result = await sql<Record<string, unknown>>`SELECT * FROM ${source} AS "rec_posts" ORDER BY "id"`.execute(db);
      return result.rows.map((row) => ({ id: Number(row.id), locale: row.locale, status: row.status, title: row.title, summary: row.summary, price: row.price === null ? null : Number(row.price) }));
    };

    beforeAll(async () => {
      // No collection here is scoped (core/scope), and there's no database for the registry to read.
      setScopedTablesForTests([]);
      ({ db, close } = await open());
      previous = process.env.DATABASE_URL;
      // The DDL helpers write each database's own column types.
      if (postgres) process.env.DATABASE_URL = process.env.TEST_POSTGRES_URL;
      const run = (statement: string) => sql.raw(statement).execute(db);
      await run(`DROP TABLE IF EXISTS "loc_posts"`);
      await run(`DROP TABLE IF EXISTS "rec_posts"`);
      for (const statement of ddl.createTable("rec_posts", 7)) await run(statement.replace(/,\s*"createdById" TEXT REFERENCES "user" \("id"\) ON DELETE SET NULL/, `, "createdById" TEXT`).replace(/CREATE INDEX "ix_7_(status|created_by)"/, `CREATE INDEX "ix_t_$1"`));
      await run(ddl.addColumn("rec_posts", "price", "real"));
      for (const statement of ddl.createLocaleTable(localeTableName("posts"), 7)) await run(statement.replace(`"lx_7_status"`, `"lx_t_status"`));
      await run(ddl.addColumn("loc_posts", "title", "text"));
      await run(ddl.addColumn("loc_posts", "summary", "text"));
      await run(ddl.createUniqueIndex("loc_posts", "title", 7, 1, true).replace(`"uq_7_1"`, `"uq_t_1"`));
      await run(`INSERT INTO "rec_posts" ("id", "status", "price") VALUES (1, 'published', 10), (2, 'published', 20), (3, 'draft', 30), (4, 'published', 40)`);
      // 1: published in en and fr. 2: published in en, draft in fr. 3: draft in en only. 4: published in fr only, en summary empty.
      await run(`INSERT INTO "loc_posts" ("recordId", "locale", "status", "title", "summary") VALUES
        (1, 'en', 'published', 'Hello', 'An intro'),
        (1, 'fr', 'published', 'Bonjour', NULL),
        (2, 'en', 'published', 'Launch', 'Launch summary'),
        (2, 'fr', 'draft', 'Lancement secret', 'Brouillon'),
        (3, 'en', 'draft', 'Draft', NULL),
        (4, 'fr', 'published', 'Seulement', 'Résumé')`);
    });

    afterAll(async () => {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      await close?.();
    });

    it("prefers a published translation, then the nearest in the chain", async () => {
      expect(await read(["fr", "en"])).toEqual([
        { id: 1, locale: "fr", status: "published", title: "Bonjour", summary: "An intro", price: 10 },
        // The French draft never shows through: the published English one does.
        { id: 2, locale: "en", status: "published", title: "Launch", summary: "Launch summary", price: 20 },
        { id: 3, locale: "en", status: "draft", title: "Draft", summary: null, price: 30 },
        { id: 4, locale: "fr", status: "published", title: "Seulement", summary: "Résumé", price: 40 },
      ]);
    });

    it("leaves out records with no translation in a chain with no fallback", async () => {
      expect((await read(["fr"])).map((row) => [row.id, row.locale, row.status])).toEqual([[1, "fr", "published"], [2, "fr", "draft"], [4, "fr", "published"]]);
      expect((await read(["en"])).map((row) => row.id)).toEqual([1, 2, 3]);
    });

    it("fills empty fields only into a published translation, and only from published ones", async () => {
      const [first] = await read(["fr", "en"]);
      expect(first.summary).toBe("An intro");
      const strict = { ...collection, localization: { enabled: true, fallback: "chain", fieldFallback: false } };
      expect((await read(["fr", "en"], "absent", strict))[0].summary).toBeNull();
    });

    it("reads every record for a write, with empty values where a language has no translation", async () => {
      const rows = await read(["de"], "empty");
      expect(rows).toEqual([1, 2, 3, 4].map((id) => ({ id, locale: "de", status: "draft", title: null, summary: null, price: id * 10 })));
    });

    it("keeps localized unique values unique per language", async () => {
      await expect(sql.raw(`INSERT INTO "loc_posts" ("recordId", "locale", "title") VALUES (3, 'fr', 'Hello')`).execute(db)).resolves.toBeDefined();
      await expect(sql.raw(`INSERT INTO "loc_posts" ("recordId", "locale", "title") VALUES (4, 'en', 'Hello')`).execute(db)).rejects.toThrow();
    });
  });
}

suite("SQLite", false, async () => {
  const database = new Database(":memory:");
  return { db: new Kysely({ dialect: new SqliteDialect({ database }) }), close: async () => { database.close(); } };
});

if (process.env.TEST_POSTGRES_URL) {
  suite("Postgres", true, async () => {
    const pool = new pg.Pool({ connectionString: process.env.TEST_POSTGRES_URL, max: 2 });
    return { db: new Kysely({ dialect: new PostgresDialect({ pool }) }), close: () => pool.end() };
  });
}
