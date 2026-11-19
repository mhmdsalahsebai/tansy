/**
 * Localization on the site and in the translation workflow: addresses per language,
 * alternates, the redirect between languages (invariant 7), XLIFF round trips, staff-only
 * translation filters, language rights on drafts, interface language and site text.
 * Leaves the site as it found it: languages it adds are removed afterwards.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

const base = inject("baseUrl");
const PASSWORD = "correct-horse-battery-staple-9431";

interface Actor { id: string; cookie: string; email: string }
let root: Actor, translator: Actor;

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

const ok = (r: { status: number; text: string }) => expect(r.status, r.text).toBeLessThan(300);

let pages: { id: number; fields: Array<{ id: number; name: string }> };
let launch: number;
const added: string[] = [];
const P = "/api/collections/i18n-pages/records";

beforeAll(async () => {
  root = await signIn("root@example.test");
  const existing = (await call("/api/settings/locales", { as: root })).json.items.map((item: { code: string }) => item.code);
  for (const code of ["fr", "ar"]) {
    if (existing.includes(code)) {
      ok(await call(`/api/settings/locales/${code}`, { method: "PATCH", as: root, body: { public: true } }));
      continue;
    }
    ok(await call("/api/settings/locales", { method: "POST", as: root, body: { code, public: true } }));
    added.push(code);
  }
  const created = await call("/api/collections", {
    method: "POST",
    as: root,
    body: {
      name: "I18n pages",
      slug: "i18n-pages",
      urlPattern: "/p/:slug",
      localization: { enabled: true },
      fields: [
        { name: "title", type: "text", config: { localized: true, required: true } },
        { name: "slug", type: "text", config: { localized: true, required: true, unique: true } },
        { name: "price", type: "number", config: {} },
      ],
    },
  });
  ok(created);
  pages = created.json;
  ok(await call(`/api/collections/${pages.id}/rules`, { method: "PUT", as: root, body: { listRule: 'status = "published"', viewRule: 'status = "published"', createRule: null, updateRule: null, deleteRule: null } }));

  const en = await call(P, { method: "POST", as: root, body: { title: "Launch", slug: "launch", price: 5, status: "published" } });
  ok(en);
  launch = en.json.id;
  ok(await call(`${P}/${launch}?locale=fr`, { method: "PATCH", as: root, body: { title: "Lancement", slug: "lancement", status: "published" } }));
  ok(await call(`${P}/${launch}?locale=ar`, { method: "PATCH", as: root, body: { title: "إطلاق", slug: "itlaq", status: "draft" } }));

  ok(await call("/api/roles", { method: "POST", as: root, body: { name: "site-translator-fr", label: "Site translator", permissions: ["dashboard:access", "collection:read", "record:list", "record:read", "record:update", "locale:edit@fr"] } }));
  ok(await call("/api/users", { method: "POST", as: root, body: { name: "site-translator", email: "site-translator@example.test", password: PASSWORD, role: "site-translator-fr" } }));
  translator = await signIn("site-translator@example.test");
});

afterAll(async () => {
  if (!root) return;
  if (pages) await call("/api/collections", { method: "DELETE", as: root, body: { ids: [pages.id] } });
  await call("/api/settings/localization", { method: "PUT", as: root, body: { siteText: { locale: "ar", messages: {} } } });
  for (const code of added.reverse()) await call(`/api/settings/locales/${code}?purge=true`, { method: "DELETE", as: root });
});

describe("site addresses", () => {
  it("serve the default language unprefixed, with every published language as an alternate", async () => {
    const r = await call("/api/resolve?path=/p/launch");
    ok(r);
    expect(r.json).toMatchObject({ type: "record", locale: "en", record: { id: launch, title: "Launch" } });
    expect(r.json.alternates).toEqual({ en: "/p/launch", fr: "/fr/p/lancement" });
  });

  it("serve French under /fr with the French slug", async () => {
    const r = await call("/api/resolve?path=/fr/p/lancement");
    ok(r);
    expect(r.json).toMatchObject({ locale: "fr", record: { title: "Lancement", locale: "fr", price: 5 } });
  });

  it("send another language's slug to this language's address", async () => {
    const r = await call("/api/resolve?path=/fr/p/launch");
    ok(r);
    expect(r.json).toEqual({ type: "redirect", to: "/fr/p/lancement", status: 302 });
  });

  it("never reveal a draft translation's address, and fall back along the chain instead", async () => {
    expect((await call("/api/resolve?path=/ar/p/itlaq")).status).toBe(404);
    // Arabic isn't published, so a visitor reading Arabic gets the English record at its English slug.
    const fallback = await call("/api/resolve?path=/ar/p/launch");
    ok(fallback);
    expect(fallback.json.record).toMatchObject({ locale: "en", title: "Launch" });
  });

  it("take the language as a parameter for a path without its prefix", async () => {
    const r = await call("/api/resolve?path=/p/lancement&locale=fr");
    ok(r);
    expect(r.json.record.title).toBe("Lancement");
    expect((await call("/api/resolve?path=/p/launch&locale=xx")).status).toBe(400);
  });

  it("say which language a read is in", async () => {
    const list = await call(`${P}?locale=fr`);
    expect(list.headers.get("content-language")).toBe("fr");
    const one = await call(`${P}/${launch}?locale=ar`);
    expect(one.headers.get("content-language")).toBe("en");
  });
});

describe("translation status", () => {
  it("is staff knowledge: visitors get no statuses and can't filter by them", async () => {
    const visitor = await call(`${P}?translations=1`);
    ok(visitor);
    expect(visitor.json.items[0]).not.toHaveProperty("translations");
    expect((await call(`${P}?translation=ar:draft`)).status).toBe(403);
  });

  it("filters and badges records for staff", async () => {
    const drafts = await call(`${P}?translation=ar:draft&translations=1`, { as: root });
    ok(drafts);
    expect(drafts.json.items.map((item: { id: number }) => item.id)).toEqual([launch]);
    expect(drafts.json.items[0].translations).toEqual(expect.arrayContaining([{ locale: "ar", status: "draft", outdated: false }, { locale: "fr", status: "published", outdated: false }]));
    expect((await call(`${P}?translation=fr:missing`, { as: root })).json.items).toEqual([]);
  });

  it("marks a translation outdated once its source changes", async () => {
    ok(await call(`${P}/${launch}`, { method: "PATCH", as: root, body: { title: "Launch day" } }));
    const r = await call(`${P}?translations=1`, { as: root });
    expect(r.json.items[0].translations).toEqual(expect.arrayContaining([{ locale: "fr", status: "published", outdated: true }]));
    const editor = await call(`/api/collections/${pages.id}/content/${launch}?locale=fr&fallback=none`, { as: root });
    expect(editor.json.localization).toMatchObject({ locale: "fr", defaultLocale: "en", source: { locale: "en", values: { title: "Launch day", slug: "launch" } } });
    expect(editor.json.localization.translations.find((entry: { locale: string }) => entry.locale === "fr").outdated).toEqual(["title"]);
  });
});

describe("drafts and schedules", () => {
  it("need the right to edit their language", async () => {
    const english = await call(`/api/collections/${pages.id}/content/${launch}/draft?locale=en`, { method: "PUT", as: translator, body: { values: [{ fieldId: pages.fields.find((f) => f.name === "title")!.id, value: "Hijack" }] } });
    expect(english.status, english.text).toBe(403);
    const french = await call(`/api/collections/${pages.id}/content/${launch}/draft?locale=fr`, { method: "PUT", as: translator, body: { values: [{ fieldId: pages.fields.find((f) => f.name === "title")!.id, value: "Lancement !" }] } });
    ok(french);
    const shared = await call(`/api/collections/${pages.id}/content/${launch}/draft?locale=fr`, { method: "PUT", as: translator, body: { values: [{ fieldId: pages.fields.find((f) => f.name === "price")!.id, value: 1 }] } });
    expect(shared.status, shared.text).toBe(403);
  });
});

describe("XLIFF", () => {
  it("exports the source with what the target has, and imports the targets as drafts", async () => {
    const exported = await fetch(`${base}/api/collections/${pages.id}/translations/xliff?from=en&to=ar&ids=${launch}`, { headers: { cookie: root.cookie } });
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("xliff");
    const xml = await exported.text();
    expect(xml).toContain("<source>Launch day</source>");
    expect(xml).toContain("<target>إطلاق</target>");
    const translated = xml.replace("<target>إطلاق</target>", "<target>يوم الإطلاق</target>");
    const imported = await call(`/api/collections/${pages.id}/translations/xliff`, { method: "POST", as: root, body: { xliff: translated } });
    ok(imported);
    expect(imported.json.results).toEqual([{ id: launch, outcome: "saved" }]);
    const arabic = await call(`/api/collections/${pages.id}/content/${launch}?locale=ar&fallback=none`, { as: root });
    expect(arabic.json.values.find((v: { field: { name: string } }) => v.field.name === "title").value).toBe("يوم الإطلاق");
    expect(arabic.json.status).toBe("draft");

    // Once the source changes, the old file can't overwrite newer work.
    ok(await call(`${P}/${launch}`, { method: "PATCH", as: root, body: { title: "Launch week" } }));
    const stale = await call(`/api/collections/${pages.id}/translations/xliff`, { method: "POST", as: root, body: { xliff: translated } });
    expect(stale.json.results).toEqual([{ id: launch, outcome: "skipped", reason: "source changed since export" }]);
  });

  it("refuses files with entities, and languages that don't exist", async () => {
    const evil = await call(`/api/collections/${pages.id}/translations/xliff`, { method: "POST", as: root, body: { xliff: '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><xliff version="2.0" srcLang="en" trgLang="fr"></xliff>' } });
    expect(evil.status).toBe(400);
    expect((await fetch(`${base}/api/collections/${pages.id}/translations/xliff?from=en&to=xx`, { headers: { cookie: root.cookie } })).status).toBe(400);
  });

  it("is staff only", async () => {
    expect((await fetch(`${base}/api/collections/${pages.id}/translations/xliff?from=en&to=fr`)).status).toBe(401);
  });
});

describe("machine translation", () => {
  it("needs a translator plugin", async () => {
    const r = await call(`/api/collections/${pages.id}/content/${launch}/translate`, { method: "POST", as: root, body: { from: "en", to: "fr" } });
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("NO_TRANSLATOR");
  });
});

describe("site text and the interface language", () => {
  it("validates owners' theme words as ICU and serves them to sites", async () => {
    const bad = await call("/api/settings/localization", { method: "PUT", as: root, body: { siteText: { locale: "ar", messages: { readMore: "{count, plural" } } } });
    expect(bad.status).toBe(400);
    ok(await call("/api/settings/localization", { method: "PUT", as: root, body: { siteText: { locale: "ar", messages: { readMore: "اقرأ المزيد" } } } }));
    expect((await call("/api/locales")).json.messages).toEqual({ ar: { readMore: "اقرأ المزيد" } });
  });

  it("is saved per person and remembered by the browser", async () => {
    const r = await call("/api/account/locale", { method: "PUT", as: translator, body: { locale: "ar" } });
    ok(r);
    expect(r.headers.get("set-cookie")).toMatch(/^cms-admin-locale=ar;/);
    expect((await call("/api/account/locale", { method: "PUT", as: translator, body: { locale: "tlh" } })).status).toBe(400);
  });
});

describe("schema export", () => {
  it("carries languages and each collection's localization", async () => {
    const r = await call("/api/schema/export", { as: root });
    ok(r);
    expect(r.json.locales.map((locale: { code: string }) => locale.code)).toEqual(expect.arrayContaining(["en", "fr", "ar"]));
    expect(r.json.collections.find((c: { slug: string }) => c.slug === "i18n-pages").localization).toEqual({ enabled: true, fallback: "chain", fieldFallback: false });
  });
});
