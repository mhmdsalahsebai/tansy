/**
 * Localization end to end: languages, localized fields in one record, publishing per
 * language, fallback chains, translator permissions, and the security invariants in
 * internal/LOCALIZATION_PLAN.md section 9. Runs after auth.test.ts, which made the root user.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const base = inject("baseUrl");
const PASSWORD = "correct-horse-battery-staple-9431";

interface Actor { id: string; cookie: string; email: string }
let root: Actor, translator: Actor, member: Actor;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- API responses have many shapes
async function call(path: string, { method = "GET", body, as }: { method?: string; body?: unknown; as?: Actor | null } = {}): Promise<{ status: number; json: any; text: string; headers: Headers }> {
  const response = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: { origin: base, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(as ? { cookie: as.cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, text, headers: response.headers };
}

async function signIn(email: string): Promise<Actor> {
  const response = await fetch(`${base}/api/auth/sign-in/email`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie().map((c) => c.split(";")[0]).filter((pair) => !pair.endsWith("=")).join("; ");
  return { id: (await response.json()).user.id, cookie, email };
}

async function makeUser(name: string, role: string) {
  const email = `${name}@example.test`;
  const r = await call("/api/users", { method: "POST", as: root, body: { name, email, password: PASSWORD, role } });
  expect(r.status, r.text).toBe(200);
  return signIn(email);
}

const ok = (r: { status: number; text: string }) => expect(r.status, r.text).toBeLessThan(300);

let articles: { id: number; fields: Array<{ id: number; name: string }> };
let first: number;
const A = "/api/collections/i18n-articles/records";

beforeAll(async () => {
  root = await signIn("root@example.test");
  for (const locale of [{ code: "fr", public: true }, { code: "fr-CA", fallback: "fr", public: true }, { code: "de", public: false }, { code: "ar", public: true }]) {
    const r = await call("/api/settings/locales", { method: "POST", as: root, body: locale });
    ok(r);
  }
  const created = await call("/api/collections", {
    method: "POST",
    as: root,
    body: {
      name: "I18n articles",
      slug: "i18n-articles",
      localization: { enabled: true },
      fields: [
        { name: "title", type: "text", config: { localized: true, required: true, unique: true, searchable: true } },
        { name: "price", type: "number", config: {} },
        { name: "body", type: "stream", config: { localized: true } },
      ],
    },
  });
  ok(created);
  articles = created.json;
  ok(await call(`/api/collections/${articles.id}/rules`, { method: "PUT", as: root, body: { listRule: 'status = "published"', viewRule: 'status = "published"', createRule: null, updateRule: null, deleteRule: null } }));

  const role = await call("/api/roles", { method: "POST", as: root, body: { name: "translator-fr", label: "French translator", permissions: ["dashboard:access", "collection:read", "record:list", "record:read", "record:update", "locale:edit@fr"] } });
  ok(role);
  translator = await makeUser("translator-fr", "translator-fr");
  member = await makeUser("i18n-member", "user");
});

afterAll(async () => {
  if (!root) return;
  if (articles) await call("/api/collections", { method: "DELETE", as: root, body: { ids: [articles.id] } });
});

describe("languages", () => {
  it("lists only public ones to visitors, with their chains", async () => {
    const r = await call("/api/locales");
    expect(r.status).toBe(200);
    expect(r.json.defaultLocale).toBe("en");
    const codes = r.json.items.map((item: { code: string }) => item.code);
    expect(codes).toEqual(expect.arrayContaining(["en", "fr", "fr-CA", "ar"]));
    expect(codes).not.toContain("de");
    expect(r.json.items.find((item: { code: string }) => item.code === "fr-CA").chain).toEqual(["fr-CA", "fr", "en"]);
    expect(r.json.items.find((item: { code: string }) => item.code === "ar").direction).toBe("rtl");
  });

  it("refuses bad codes, duplicates and loops", async () => {
    expect((await call("/api/settings/locales", { method: "POST", as: root, body: { code: "not a code" } })).status).toBe(400);
    expect((await call("/api/settings/locales", { method: "POST", as: root, body: { code: "fr" } })).status).toBe(409);
    expect((await call("/api/settings/locales/fr", { method: "PATCH", as: root, body: { fallback: "fr-CA" } })).status).toBe(400);
    expect((await call("/api/settings/locales", { method: "POST", as: member, body: { code: "it" } })).status).toBe(403);
  });

  it("can't remove the default, or a language another falls back to", async () => {
    expect((await call("/api/settings/locales/en", { method: "DELETE", as: root })).status).toBe(400);
    expect((await call("/api/settings/locales/fr", { method: "DELETE", as: root })).status).toBe(400);
  });
});

describe("a localized record", () => {
  it("is written in one language, and its shared fields in all", async () => {
    const r = await call(`${A}?locale=en`, { method: "POST", as: root, body: { title: "Hello", price: 10, status: "published" } });
    ok(r);
    expect(r.json).toMatchObject({ title: "Hello", price: 10, locale: "en", status: "published" });
    first = r.json.id;
    const fr = await call(`${A}/${first}?locale=fr`, { method: "PATCH", as: root, body: { title: "Bonjour brouillon", status: "draft" } });
    ok(fr);
    expect(fr.json).toMatchObject({ title: "Bonjour brouillon", price: 10, locale: "fr", status: "draft" });
  });

  it("shows a visitor the published English, never the French draft", async () => {
    const r = await call(`${A}?locale=fr`);
    expect(r.status).toBe(200);
    expect(r.json.items).toEqual([expect.objectContaining({ id: first, title: "Hello", locale: "en" })]);
    const strict = await call(`${A}?locale=fr&fallback=none`);
    expect(strict.json.items).toEqual([]);
    expect((await call(`${A}/${first}?locale=fr&fallback=none`)).status).toBe(404);
  });

  it("shows the translator the French draft", async () => {
    const r = await call(`${A}/${first}?locale=fr&fallback=none`, { as: root });
    expect(r.json).toMatchObject({ title: "Bonjour brouillon", locale: "fr", status: "draft" });
  });

  it("can't be found by words that only a draft translation holds", async () => {
    expect((await call(`${A}?locale=fr&search=brouillon`)).json.items).toEqual([]);
    expect((await call(`${A}?locale=fr&search=hello`)).json.items.map((item: { id: number }) => item.id)).toEqual([first]);
    expect((await call(`${A}?locale=fr&search=brouillon&fallback=none`, { as: root })).json.items.map((item: { id: number }) => item.id)).toEqual([first]);
  });

  it("goes live in French on its own, and fr-CA falls back to it", async () => {
    ok(await call(`${A}/${first}?locale=fr`, { method: "PATCH", as: root, body: { title: "Bonjour", status: "published" } }));
    expect((await call(`${A}/${first}?locale=fr`)).json).toMatchObject({ title: "Bonjour", locale: "fr" });
    expect((await call(`${A}/${first}?locale=fr-CA`)).json).toMatchObject({ title: "Bonjour", locale: "fr" });
    expect((await call(`${A}/${first}?locale=en`)).json).toMatchObject({ title: "Hello", locale: "en" });
  });

  it("shows every language a visitor may see with locale=*", async () => {
    const r = await call(`${A}/${first}?locale=*`);
    expect(r.json.title).toEqual({ en: "Hello", fr: "Bonjour" });
    expect(r.json.locales).toEqual(["en", "fr"]);
  });

  it("keeps hidden languages from visitors, and refuses unknown ones", async () => {
    expect((await call(`${A}?locale=de`)).json.error.code).toBe("INVALID_LOCALE");
    expect((await call(`${A}?locale=xx-YY`)).status).toBe(400);
    expect((await call(`${A}?locale=de`, { as: root })).status).toBe(200);
  });

  it("keeps unique values unique within each language", async () => {
    const r = await call(`${A}?locale=fr`, { method: "POST", as: root, body: { title: "Hello", status: "published" } });
    ok(r);
    const clash = await call(`${A}?locale=fr`, { method: "POST", as: root, body: { title: "Bonjour" } });
    expect(clash.status).toBe(400);
    expect(clash.json.error.details[0].path).toBe("title");
    // Only in French, so English readers who don't fall back don't see it.
    expect((await call(`${A}?locale=en&fallback=none`)).json.items.map((item: { id: number }) => item.id)).toEqual([first]);
  });

  it("requires a new translation's required fields", async () => {
    const r = await call(`${A}/${first}?locale=ar`, { method: "PATCH", as: root, body: { status: "draft" } });
    expect(r.status).toBe(400);
    expect(r.json.error.details[0].path).toBe("title");
  });

  it("keeps a history for each language", async () => {
    const fr = await call(`/api/collections/${articles.id}/content/${first}/revisions?locale=fr`, { as: root });
    const en = await call(`/api/collections/${articles.id}/content/${first}/revisions?locale=en`, { as: root });
    expect(fr.json.items.length).toBe(2);
    expect(en.json.items.length).toBe(1);
  });

  it("lists every record's translations for the grid", async () => {
    const r = await call(`/api/collections/${articles.id}/content?locale=en`, { as: root });
    const row = r.json.items.find((item: { id: number }) => item.id === first);
    expect(row.translations.map((t: { locale: string }) => t.locale).sort()).toEqual(["en", "fr"]);
  });

  it("reads a rule's @request.locale and the record's language", async () => {
    ok(await call(`/api/collections/${articles.id}/rules`, { method: "PUT", as: root, body: { listRule: 'status = "published" && (locale = "en" || @request.locale = "fr")', viewRule: 'status = "published"', createRule: null, updateRule: null, deleteRule: null } }));
    expect((await call(`${A}?locale=fr`)).json.items.length).toBe(2);
    expect((await call(`${A}?locale=fr-CA`)).json.items.length).toBe(0);
    ok(await call(`/api/collections/${articles.id}/rules`, { method: "PUT", as: root, body: { listRule: 'status = "published"', viewRule: 'status = "published"', createRule: null, updateRule: null, deleteRule: null } }));
  });

  it("sorts text in the language read: by its collation on Postgres, by code point on SQLite", async () => {
    const created = await call("/api/collections", {
      method: "POST",
      as: root,
      body: { name: "I18n words", slug: "i18n-words", localization: { enabled: true }, fields: [{ name: "word", type: "text", config: { localized: true } }] },
    });
    ok(created);
    try {
      for (const word of ["zèbre", "école", "abricot", "eau"]) ok(await call(`/api/collections/i18n-words/records?locale=fr`, { method: "POST", as: root, body: { word, status: "published" } }));
      const sorted = await call("/api/collections/i18n-words/records?locale=fr&fallback=none&sort=word", { as: root });
      const postgres = /^postgres/.test(process.env.TEST_DATABASE_URL ?? "");
      expect(sorted.json.items.map((item: { word: string }) => item.word)).toEqual(postgres ? ["abricot", "eau", "école", "zèbre"] : ["abricot", "eau", "zèbre", "école"]);
    } finally {
      await call("/api/collections", { method: "DELETE", as: root, body: { ids: [created.json.id] } });
    }
  });
});

describe("translators", () => {
  it("edit their own language", async () => {
    const r = await call(`${A}/${first}?locale=fr`, { method: "PATCH", as: translator, body: { title: "Bonjour à tous" } });
    ok(r);
    expect(r.json.title).toBe("Bonjour à tous");
  });

  it("can't touch another language or a shared field", async () => {
    expect((await call(`${A}/${first}?locale=en`, { method: "PATCH", as: translator, body: { title: "Hi" } })).json.error.code).toBe("LOCALE_FORBIDDEN");
    expect((await call(`${A}/${first}?locale=fr`, { method: "PATCH", as: translator, body: { price: 1 } })).json.error.code).toBe("LOCALE_FORBIDDEN");
    expect((await call(`${A}/${first}?locale=en`, { as: root })).json).toMatchObject({ title: "Hello", price: 10 });
  });

  it("can't grant a language that doesn't exist", async () => {
    expect((await call("/api/roles", { method: "POST", as: root, body: { name: "translator-zz", label: "x", permissions: ["locale:edit@it"] } })).status).toBe(400);
  });

  it("existing writers kept every language", async () => {
    const roles = await call("/api/roles", { as: root });
    const editor = roles.json.roles.find((role: { name: string }) => role.name === "editor");
    expect(editor.permissions).toContain("locale:edit");
  });
});

describe("a translation", () => {
  it("can be removed on its own, but not the last one", async () => {
    const solo = await call(`${A}?locale=de`, { method: "POST", as: root, body: { title: "Nur Deutsch" } });
    ok(solo);
    expect((await call(`/api/collections/${articles.id}/content/${solo.json.id}/translations/de`, { method: "DELETE", as: root })).status).toBe(409);
    ok(await call(`/api/collections/${articles.id}/content/${first}/translations/fr`, { method: "DELETE", as: root }));
    expect((await call(`${A}/${first}?locale=fr`)).json).toMatchObject({ title: "Hello", locale: "en" });
  });
});

describe("turning localization on and off", () => {
  let pages: { id: number; fields: Array<{ id: number; name: string; type: string; config: Record<string, unknown> }> };
  let record: number;
  const P = "/api/collections/i18n-pages/records";

  it("keeps every value when it turns on", async () => {
    const created = await call("/api/collections", { method: "POST", as: root, body: { name: "I18n pages", slug: "i18n-pages", fields: [{ name: "heading", type: "text", config: { unique: true } }, { name: "views", type: "number", config: {} }] } });
    ok(created);
    pages = created.json;
    ok(await call(`/api/collections/${pages.id}/rules`, { method: "PUT", as: root, body: { listRule: 'status = "published"', viewRule: 'status = "published"', createRule: null, updateRule: null, deleteRule: null } }));
    const r = await call(P, { method: "POST", as: root, body: { heading: "About", views: 3, status: "published" } });
    ok(r);
    record = r.json.id;

    const heading = pages.fields.find((field) => field.name === "heading")!;
    ok(await call(`/api/collections/${pages.id}/fields`, { method: "PUT", as: root, body: { fields: pages.fields.map((field) => (field.id === heading.id ? { ...field, config: { ...field.config, localized: true } } : field)) } }));
    ok(await call(`/api/collections/${pages.id}/localization`, { method: "PUT", as: root, body: { enabled: true } }));

    expect((await call(`${P}/${record}?locale=en`)).json).toMatchObject({ heading: "About", views: 3, locale: "en", status: "published" });
    expect((await call(`${P}?locale=fr&fallback=none`)).json.items).toEqual([]);
    ok(await call(`${P}/${record}?locale=fr`, { method: "PATCH", as: root, body: { heading: "À propos", status: "published" } }));
    expect((await call(`${P}/${record}?locale=fr`)).json).toMatchObject({ heading: "À propos", views: 3 });
  });

  it("asks before turning off, then keeps the default language", async () => {
    expect((await call(`/api/collections/${pages.id}/localization`, { method: "PUT", as: root, body: { enabled: false } })).status).toBe(409);
    ok(await call(`/api/collections/${pages.id}/localization`, { method: "PUT", as: root, body: { enabled: false, confirm: true } }));
    const r = await call(`${P}/${record}`);
    expect(r.json).toMatchObject({ heading: "About", views: 3, status: "published" });
    expect(r.json.locale).toBeUndefined();
    await call("/api/collections", { method: "DELETE", as: root, body: { ids: [pages.id] } });
  });
});

describe("names in interface languages", () => {
  const RULES = { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null };
  // Block types and schema imports need a fresh sign-in.
  beforeAll(async () => { root = await signIn(root.email); });

  it("are kept beside a collection's name, and cleared with null", async () => {
    const created = await call("/api/collections", { method: "POST", as: root, body: { name: "Labelled", labels: { ar: "مُعنوَنة", fr: "  " }, slug: "i18n-labelled", fields: [{ name: "title", type: "text" }] } });
    ok(created);
    // An empty name is dropped, so an untouched input stores nothing.
    expect(created.json.labels).toEqual({ ar: "مُعنوَنة" });
    const renamed = await call(`/api/collections/${created.json.id}`, { method: "PATCH", as: root, body: { name: "Labelled again" } });
    expect(renamed.json.labels).toEqual({ ar: "مُعنوَنة" });
    expect((await call(`/api/collections/${created.json.id}`, { method: "PATCH", as: root, body: { labels: { "not a code": "x" } } })).status).toBe(400);
    expect((await call(`/api/collections/${created.json.id}`, { method: "PATCH", as: root, body: { labels: null } })).json.labels).toBeNull();
    await call("/api/collections", { method: "DELETE", as: root, body: { ids: [created.json.id] } });
  });

  it("go with a block type, and leave it as it is when a change leaves them out", async () => {
    const created = await call("/api/block-types", { method: "POST", as: root, body: { name: "i18n_quote", label: "Quote", labels: { ar: "اقتباس" }, fields: [{ name: "text", type: "text" }] } });
    ok(created);
    expect(created.json.labels).toEqual({ ar: "اقتباس" });
    const updated = await call(`/api/block-types/${created.json.id}`, { method: "PUT", as: root, body: { label: "Pull quote", fields: [{ name: "text", type: "text" }] } });
    ok(updated);
    expect(updated.json.labels).toEqual({ ar: "اقتباس" });
    ok(await call(`/api/block-types/${created.json.id}`, { method: "DELETE", as: root }));
  });

  it("travel through a schema file, and an import that leaves them out keeps them", async () => {
    const document = { version: 1, collections: [{ slug: "i18n-imported", name: "Imported", labels: { ar: "مستوردة" }, rules: RULES, fields: [{ name: "title", type: "text" }] }], blocks: [{ name: "i18n_card", label: "Card", labels: { ar: "بطاقة" }, fields: [{ name: "text", type: "text" }] }] };
    ok(await call("/api/schema/import", { method: "POST", as: root, body: { document } }));
    const exported = (await call("/api/schema/export", { as: root })).json;
    expect(exported.collections.find((c: { slug: string }) => c.slug === "i18n-imported").labels).toEqual({ ar: "مستوردة" });
    expect(exported.blocks.find((b: { name: string }) => b.name === "i18n_card").labels).toEqual({ ar: "بطاقة" });
    // Applying it again changes nothing.
    expect((await call("/api/schema/import", { method: "POST", as: root, body: { document } })).json.steps).toEqual([]);

    const renamed = { ...document, collections: [{ ...document.collections[0], labels: { ar: "مستوردة مجددًا" } }], blocks: [{ ...document.blocks[0], labels: undefined }] };
    const plan = await call("/api/schema/import", { method: "POST", as: root, body: { document: renamed, dryRun: true } });
    expect(plan.json.steps.map((s: { action: string; target: string }) => `${s.action} ${s.target}`)).toEqual(["update details i18n-imported"]);
    ok(await call("/api/schema/import", { method: "POST", as: root, body: { document: renamed } }));
    const after = (await call("/api/schema/export", { as: root })).json;
    expect(after.collections.find((c: { slug: string }) => c.slug === "i18n-imported").labels).toEqual({ ar: "مستوردة مجددًا" });
    expect(after.blocks.find((b: { name: string }) => b.name === "i18n_card").labels).toEqual({ ar: "بطاقة" });

    const collection = after.collections.find((c: { slug: string }) => c.slug === "i18n-imported");
    const id = (await call("/api/collections", { as: root })).json.find((c: { slug: string }) => c.slug === collection.slug).id;
    await call("/api/collections", { method: "DELETE", as: root, body: { ids: [id] } });
    const block = (await call("/api/block-types", { as: root })).json.find((b: { name: string }) => b.name === "i18n_card");
    ok(await call(`/api/block-types/${block.id}`, { method: "DELETE", as: root }));
  });
});

describe("a synced stream", () => {
  const S = "/api/collections/i18n-synced/records";
  const card = (id: string, text: string, size: number) => ({ id, type: "i18n_synced_card", v: 1, value: { text, size } });
  let collection: { id: number; fields: Array<{ id: number; name: string; type: string; config: Record<string, unknown> }> };
  let blockId: number;
  let record: number;

  it("lines every translation up with the default language's blocks", async () => {
    const block = await call("/api/block-types", { method: "POST", as: root, body: { name: "i18n_synced_card", label: "Card", fields: [{ name: "text", type: "text" }, { name: "size", type: "number" }] } });
    ok(block);
    blockId = block.json.id;
    const created = await call("/api/collections", { method: "POST", as: root, body: { name: "I18n synced", slug: "i18n-synced", localization: { enabled: true }, fields: [{ name: "body", type: "stream", config: { localized: true } }] } });
    ok(created);
    collection = created.json;
    const r = await call(`${S}?locale=en`, { method: "POST", as: root, body: { body: [card("a", "One", 1), card("b", "Two", 2)] } });
    ok(r);
    record = r.json.id;
    // Before syncing, a translation keeps blocks of its own.
    ok(await call(`${S}/${record}?locale=fr`, { method: "PATCH", as: root, body: { body: [card("b", "Deux", 20), card("z", "Seulement ici", 26)] } }));

    const syncing = { fields: collection.fields.map((field) => (field.name === "body" ? { ...field, config: { ...field.config, synced: true } } : field)) };
    expect((await call(`/api/collections/${collection.id}/fields`, { method: "PUT", as: root, body: syncing })).status).toBe(409);
    ok(await call(`/api/collections/${collection.id}/fields`, { method: "PUT", as: root, body: { ...syncing, confirm: true } }));

    const fr = await call(`${S}/${record}?locale=fr&fallback=none`, { as: root });
    expect(fr.json.body.map((b: { id: string; value: { text: string; size: number } }) => [b.id, b.value.text, b.value.size])).toEqual([["a", "One", 1], ["b", "Deux", 2]]);
  });

  it("keeps only a translation's text, and brings new blocks to every language", async () => {
    ok(await call(`${S}/${record}?locale=fr`, { method: "PATCH", as: root, body: { body: [card("b", "Deux bis", 99), card("a", "Un", 10), card("y", "Nouveau", 25)] } }));
    ok(await call(`${S}/${record}?locale=en`, { method: "PATCH", as: root, body: { body: [card("c", "Three", 3), card("a", "One", 1), card("b", "Two", 2)] } }));
    const fr = await call(`${S}/${record}?locale=fr&fallback=none`, { as: root });
    expect(fr.json.body.map((b: { id: string; value: { text: string; size: number } }) => [b.id, b.value.text, b.value.size])).toEqual([["c", "Three", 3], ["a", "Un", 1], ["b", "Deux bis", 2]]);
    await call("/api/collections", { method: "DELETE", as: root, body: { ids: [collection.id] } });
    ok(await call(`/api/block-types/${blockId}`, { method: "DELETE", as: root }));
  });
});
