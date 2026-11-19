import { describe, expect, it } from "vitest";
import type { BeforeHookContext } from "@/core/extend/define";
import { assertPluginManifest } from "@/core/extend/manifest";
import { resolveSettings } from "@/core/extend/settings-schema";
import { richTextEmail } from "@/core/mail/rich";
import { fieldNameProblem } from "@/core/schema/names";
import { newsletter } from "../../plugins/newsletter/index";
import {
  absolute, campaignFromRecord, campaignProblem, confirmToken, CONFIRM_DAYS, CONFIRM_RESEND_MS, csvCell, formToken, formTokenProblem, hasWords, maskAddress,
  mayResendConfirmation, normalizeAddress, pagePath, parseImport, perMinuteOf, readToken, tokenProblem, unsubscribeToken,
} from "../../plugins/newsletter/logic";
import { CAMPAIGNS, CONTRACT, newsletterRoles, newsletterSchema, PAGE, SUBSCRIBERS } from "../../plugins/newsletter/schema";
import { messages } from "../../plugins/newsletter/messages";
import { siteMessages } from "../../plugins/newsletter/site-messages";

const KEY = "a".repeat(64);
const plugin = () => newsletter({ siteUrl: "https://example.com/" });

describe("newsletter manifest", () => {
  it("names its fields as core allows, so the install migration can apply them", () => {
    for (const collection of newsletterSchema().collections) {
      for (const field of collection.fields) expect(fieldNameProblem(field.name), `${collection.slug}.${field.name}`).toBeNull();
    }
  });

  it("validates, and keeps subscribers and campaigns locked to staff", () => {
    expect(() => assertPluginManifest(plugin())).not.toThrow();
    const [subscribers, campaigns, page] = newsletterSchema().collections;
    const locked = { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null };
    expect(subscribers.rules).toEqual(locked);
    expect(campaigns.rules).toEqual(locked);
    // The page anyone may read, and nobody but staff writes.
    expect(page).toMatchObject({ slug: PAGE, type: "singleton", urlPattern: "/newsletter", rules: { listRule: "", viewRule: "", createRule: null, updateRule: null, deleteRule: null } });
    // The database keeps one subscriber per address, whatever two requests do at once.
    expect(subscribers.fields.find((field) => field.name === "email")?.config).toMatchObject({ required: true, unique: true });
    expect(campaigns.fields.find((field) => field.name === "cursor")?.config).toMatchObject({ hidden: true });
    for (const [slug, fields] of Object.entries(CONTRACT)) {
      const collection = newsletterSchema().collections.find((item) => item.slug === slug)!;
      for (const [name, type] of Object.entries(fields)) expect(collection.fields.find((field) => field.name === name)?.type, `${slug}.${name}`).toBe(type);
    }
  });

  it("states every route's access, audits every write, and rate limits sign-ups and unsubscribes", () => {
    const routes = plugin().routes!;
    const find = (method: string, path: string) => routes.find((route) => route.method === method && route.path === path)!;
    expect(find("POST", "/subscribe")).toMatchObject({ access: "public", audit: "newsletter.subscribe", rateLimit: { window: 600, max: 5 } });
    expect(find("POST", "/unsubscribe/:token")).toMatchObject({ access: "public", audit: "newsletter.unsubscribe", rateLimit: { window: 600, max: 10 } });
    // One-click unsubscribe sends a form body, so the route takes no JSON schema.
    expect(find("POST", "/unsubscribe/:token").body).toBeUndefined();
    expect(find("POST", "/confirm")).toMatchObject({ access: "public", audit: "newsletter.confirm" });
    for (const path of ["/campaigns/:id/send", "/campaigns/:id/test", "/campaigns/:id/cancel", "/campaigns/:id/copy", "/campaigns/from-record"]) {
      expect(find("POST", path)).toMatchObject({ access: "permission", permission: "ext.newsletter:send" });
    }
    for (const [method, path] of [["POST", "/subscribers"], ["POST", "/subscribers/:id/state"], ["GET", "/subscribers.csv"]]) {
      expect(find(method, path)).toMatchObject({ access: "permission", permission: "ext.newsletter:manage" });
    }
    for (const route of routes) {
      if (route.method !== "GET") expect(route.audit, `${route.method} ${route.path}`).toMatch(/^newsletter\./);
      if (route.access === "public") expect(route.reason).toBeTruthy();
    }
  });

  it("takes its options as the settings' defaults, and refuses bad ones", () => {
    const values = resolveSettings(newsletter({ siteUrl: "https://example.com", doubleOptIn: false, perMinute: 50 }).settings!.fields, null);
    expect(values).toMatchObject({ doubleOptIn: false, perMinute: 50, captcha: true, pendingDays: 7 });
    expect(() => newsletter({ siteUrl: "ftp://example.com" })).toThrow();
    expect(() => newsletter({ siteUrl: "https://example.com", perMinute: 0 })).toThrow();
    expect(() => newsletter({} as never)).toThrow();
  });

  it("gives its editor role the collections and both permissions", () => {
    const [role] = newsletterRoles();
    expect(role.name).toBe("newsletter-editor");
    expect(role.permissions).toEqual(expect.arrayContaining(["ext.newsletter:send", "ext.newsletter:manage"]));
    expect(role.records?.[SUBSCRIBERS]).not.toContain("create");
  });

  it("has every word in Arabic too", () => {
    const keys = (value: unknown, prefix = ""): string[] => (value && typeof value === "object" ? Object.entries(value).flatMap(([key, child]) => keys(child, `${prefix}${key}.`)) : [prefix]);
    expect(keys(messages.ar).sort()).toEqual(keys(messages.en).sort());
    expect(keys(siteMessages.ar).sort()).toEqual(keys(siteMessages.en).sort());
  });
});

/** A before-hook's context for a campaign, as a person (a user id) or the plugin (null). */
function hookContext(event: BeforeHookContext["event"], values: Record<string, unknown>, record: Record<string, unknown> | undefined, userId: string | null) {
  return {
    event, values, record, userId, collection: { id: 1, slug: CAMPAIGNS, name: "Campaigns" },
    reject(message: string, field?: string): never { throw Object.assign(new Error(message), { field }); },
  } as unknown as BeforeHookContext;
}

describe("campaign guard", () => {
  const hooks = plugin().hooks!;
  const sent = { id: 3, subject: "Hi", state: "sent", sent: 10, recipients: 10, cursor: 10, startedAt: "2026-11-10T10:00:00.000Z" };

  it("starts every campaign a person makes as a draft, whatever they send", async () => {
    const values = { subject: "Hi", state: "sent", sent: 999, cursor: 5 };
    const result = await hooks["record.beforeCreate"]!(hookContext("record.beforeCreate", values, undefined, "u1"));
    expect(result).toEqual({ subject: "Hi", state: "draft" });
  });

  it("refuses a person's change to a campaign's progress, but takes the same values back unchanged", async () => {
    expect(() => hooks["record.beforeUpdate"]!(hookContext("record.beforeUpdate", { state: "sending" }, { ...sent, state: "draft" }, "u1"))).toThrow(/from the Newsletter page/);
    expect(() => hooks["record.beforeUpdate"]!(hookContext("record.beforeUpdate", { cursor: 0 }, sent, "u1"))).toThrow(/from the Newsletter page/);
    // An editor's form sends every field back as it was.
    expect(() => hooks["record.beforeUpdate"]!(hookContext("record.beforeUpdate", { state: "sent", sent: 10, startedAt: "2026-11-10T10:00:00Z", subject: "Hi" }, sent, "u1"))).not.toThrow();
  });

  it("refuses rewriting a campaign that has gone out, and deleting one that's sending", async () => {
    expect(() => hooks["record.beforeUpdate"]!(hookContext("record.beforeUpdate", { subject: "Changed" }, sent, "u1"))).toThrow(/can't change/);
    expect(() => hooks["record.beforeDelete"]!(hookContext("record.beforeDelete", {}, { ...sent, state: "sending" }, "u1"))).toThrow(/Cancel it/);
    expect(() => hooks["record.beforeDelete"]!(hookContext("record.beforeDelete", {}, sent, "u1"))).not.toThrow();
  });

  it("lets the plugin's own writes through", () => {
    expect(() => hooks["record.beforeUpdate"]!(hookContext("record.beforeUpdate", { state: "sending", cursor: 0 }, { ...sent, state: "draft" }, null))).not.toThrow();
  });

  it("keeps subscribers' addresses in lowercase, and dates a change of state", async () => {
    const context = { ...hookContext("record.beforeUpdate", { email: "  Ada@Example.COM ", state: "unsubscribed" }, { state: "confirmed" }, "u1"), collection: { id: 2, slug: SUBSCRIBERS, name: "Subscribers" } } as BeforeHookContext;
    const result = await hooks["record.beforeUpdate"]!(context) as Record<string, unknown>;
    expect(result.email).toBe("ada@example.com");
    expect(typeof result.unsubscribedAt).toBe("string");
    const bad = { ...hookContext("record.beforeCreate", { email: "nope" }, undefined, "u1"), collection: { id: 2, slug: SUBSCRIBERS, name: "Subscribers" } } as BeforeHookContext;
    expect(() => hooks["record.beforeCreate"]!(bad)).toThrow(/email address/);
  });
});

describe("newsletter tokens", () => {
  it("confirms for one subscriber's address, for a week", async () => {
    const now = Date.UTC(2026, 10, 15);
    const token = await confirmToken(KEY, 7, "ada@example.com", now);
    const parsed = readToken(token)!;
    expect(parsed).toMatchObject({ purpose: "confirm", id: 7, issued: now });
    expect(await tokenProblem(KEY, parsed, "ada@example.com", now + 1000)).toBe("ok");
    expect(await tokenProblem(KEY, parsed, "eve@example.com", now)).toBe("invalid");
    expect(await tokenProblem("b".repeat(64), parsed, "ada@example.com", now)).toBe("invalid");
    expect(await tokenProblem(KEY, parsed, "ada@example.com", now + (CONFIRM_DAYS + 1) * 86_400_000)).toBe("expired");
    // Another subscriber's id in an otherwise good token.
    expect(await tokenProblem(KEY, { ...parsed, id: 8 }, "ada@example.com", now)).toBe("invalid");
  });

  it("unsubscribes for good, and can't be used to confirm", async () => {
    const token = await unsubscribeToken(KEY, 7, "ada@example.com");
    const parsed = readToken(token)!;
    expect(parsed).toMatchObject({ purpose: "unsubscribe", id: 7, issued: null });
    expect(await tokenProblem(KEY, parsed, "ada@example.com", Date.now() + 3650 * 86_400_000)).toBe("ok");
    expect(await tokenProblem(KEY, { ...parsed, purpose: "confirm", issued: Date.now() }, "ada@example.com")).toBe("invalid");
  });

  it("reads nothing but its own shapes", () => {
    for (const bad of ["", "u7", "u7.xyz", `x7.${"0".repeat(64)}`, `u${"9".repeat(16)}.${"0".repeat(64)}`, `c7.123.${"0".repeat(64)}`, null, 7]) expect(readToken(bad)).toBeNull();
  });

  it("refuses a sign-up sent sooner than a person could, or with a form that isn't ours", async () => {
    const now = Date.now();
    const token = await formToken(KEY, now);
    expect(await formTokenProblem(KEY, token, now + 500)).toBe("early");
    expect(await formTokenProblem(KEY, token, now + 3000)).toBe("ok");
    expect(await formTokenProblem(KEY, token, now + 2 * 86_400_000)).toBe("expired");
    expect(await formTokenProblem("b".repeat(64), token, now + 3000)).toBe("invalid");
    expect(await formTokenProblem(KEY, `${now}.${"0".repeat(64)}`, now + 3000)).toBe("invalid");
  });

  it("sends a confirmation at most once an hour", () => {
    const now = Date.now();
    expect(mayResendConfirmation(null, now)).toBe(true);
    expect(mayResendConfirmation(new Date(now - 60_000).toISOString(), now)).toBe(false);
    expect(mayResendConfirmation(new Date(now - CONFIRM_RESEND_MS).toISOString(), now)).toBe(true);
  });
});

describe("newsletter subscribers", () => {
  it("imports addresses in the shapes people paste, once each", () => {
    const { entries, invalid, tooMany } = parseImport([
      "email,name",
      "Ada@Example.com",
      "Grace Hopper <grace@example.com>",
      "alan@example.com, Alan Turing",
      "\"linus@example.com\";\"Linus\"",
      "ada@example.com, Ada Lovelace",
      "not an address",
      "",
      "=cmd()@x",
    ].join("\n"));
    expect(entries).toEqual([
      { email: "ada@example.com", name: "Ada Lovelace" },
      { email: "grace@example.com", name: "Grace Hopper" },
      { email: "alan@example.com", name: "Alan Turing" },
      { email: "linus@example.com", name: "Linus" },
    ]);
    expect(invalid).toBe(2);
    expect(tooMany).toBe(false);
    expect(parseImport(Array.from({ length: 5001 }, (_, index) => `r${index}@example.com`).join("\n"))).toMatchObject({ tooMany: true });
  });

  it("keeps a spreadsheet from running an exported value as a formula", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("Ada, Countess")).toBe("\"Ada, Countess\"");
    expect(csvCell(null)).toBe("");
  });

  it("shows only enough of an address for its owner to know it", () => {
    expect(maskAddress("ada.lovelace@example.com")).toBe("ad•••@example.com");
    expect(maskAddress("a@example.com")).toBe("a•••@example.com");
    expect(normalizeAddress(" A@B.CO ")).toBe("a@b.co");
  });
});

describe("newsletter campaigns", () => {
  it("drafts a campaign from any record with a page: its title, its summary and a link to it", () => {
    const rich = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Teaser" }] }] };
    expect(campaignFromRecord({ title: " Our\nnews ", excerpt: "First.\n\nSecond.", body: "secret" }, "https://example.com/blog/news", "Read more")).toEqual({
      subject: "Our news",
      body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "First." }] }, { type: "paragraph", content: [{ type: "text", text: "Second." }] }] },
      link: "https://example.com/blog/news",
      linkLabel: "Read more",
    });
    expect(campaignFromRecord({ name: "Course", description: rich }, "https://example.com/c", "More").body).toBe(rich);
    expect(campaignFromRecord({ sku: "x" }, "https://example.com/p", "More")).toMatchObject({ subject: "", body: null });
  });

  it("needs a subject, and words or a link, to send", () => {
    expect(campaignProblem({ subject: " ", link: "https://example.com" })).toBe("subject");
    expect(campaignProblem({ subject: "Hi", body: { type: "doc", content: [{ type: "paragraph" }] } })).toBe("empty");
    expect(campaignProblem({ subject: "Hi", link: "https://example.com" })).toBeNull();
    expect(hasWords({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: " x " }] }] })).toBe(true);
  });

  it("builds addresses on the site, and keeps the page's own path only when it's plain", () => {
    expect(absolute("https://example.com", "/newsletter")).toBe("https://example.com/newsletter");
    expect(absolute("https://example.com", "https://fr.example.com/newsletter")).toBe("https://fr.example.com/newsletter");
    expect(pagePath("/news/letter", "/newsletter")).toBe("/news/letter");
    expect(pagePath("/news/:slug", "/newsletter")).toBe("/newsletter");
    expect(pagePath("//evil.example.com", "/newsletter")).toBe("/newsletter");
    expect(perMinuteOf(0)).toBe(1);
    expect(perMinuteOf("x")).toBe(300);
  });
});

describe("rich text email", () => {
  it("drops what it doesn't know, and links that aren't the web or mail", () => {
    const { html, text } = richTextEmail({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "<script>", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] },
      { type: "iframe", content: [{ type: "text", text: "hidden" }] },
      { type: "codeBlock", content: [{ type: "text", text: "a < b" }] },
      { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "first" }] }] }] },
      { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }] },
    ] });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("hidden");
    expect(html).toContain("a &lt; b");
    expect(text).toBe("<script>\n\na < b\n\n1. first\n\n> quoted");
  });
});
