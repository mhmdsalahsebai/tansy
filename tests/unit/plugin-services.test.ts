import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionShape } from "@/core/extend/define";

const mocks = vi.hoisted(() => ({
  queueMail: vi.fn(),
  sendMailBatch: vi.fn(async (messages: unknown[]) => messages.map((_, index) => (index === 1 ? { ok: false as const, error: "status 550" } : { ok: true as const }))),
  audit: vi.fn(async () => {}),
  describeCollection: vi.fn<(slug: string) => Promise<CollectionShape | null>>(async () => null),
}));

vi.mock("@/core/mail", async (original) => ({ ...(await original<typeof import("@/core/mail")>()), queueMail: mocks.queueMail, sendMailBatch: mocks.sendMailBatch }));
vi.mock("@/core/audit", () => ({ audit: mocks.audit }));
vi.mock("@/core/auth/settings", () => ({ loadAuthSettings: async () => ({ settings: { general: { appName: "Acme" } }, revision: 1 }) }));
vi.mock("@/core/schema/portable", () => ({ describeCollection: mocks.describeCollection }));

const { extensionMail } = await import("@/core/extend/mail");
const { contractProblems } = await import("@/core/extend/schema");
const { extensionEmail } = await import("@/core/mail");
const { assertPluginManifest } = await import("@/core/extend/manifest");

beforeEach(() => vi.clearAllMocks());

describe("email from plugins", () => {
  const mail = extensionMail("plugin:blog");

  it("queues a valid message and audits the recipient, not the content", async () => {
    await mail.send({ to: "reader@example.com", subject: "New comment", body: "Someone replied.\n\nHave a look.", action: { label: "Open", url: "https://example.com/blog/a" } });
    expect(mocks.queueMail).toHaveBeenCalledOnce();
    const [message] = mocks.queueMail.mock.calls[0];
    expect(message).toMatchObject({ to: "reader@example.com", subject: "New comment - Acme" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "extension.mail_queued", actorEmail: "plugin:blog", targetId: "reader@example.com" }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("Someone replied");
  });

  it.each([
    ["a second header line", { subject: "Hi\r\nBcc: everyone@example.com" }],
    ["a script link", { action: { label: "Go", url: "javascript:alert(1)" } }],
    ["a bad address", { to: "not an address" }],
    ["an empty body", { body: "  " }],
    ["unknown keys", { html: "<b>x</b>" }],
  ])("refuses %s, and sends nothing", async (_, change) => {
    await expect(mail.send({ to: "a@example.com", subject: "S", body: "B", ...change } as never)).rejects.toThrow(/plugin:blog: email not sent/);
    expect(mocks.queueMail).not.toHaveBeenCalled();
  });

  it("sets a reply-to address, and refuses one that isn't a single address", async () => {
    await mail.send({ to: "owner@example.com", replyTo: "visitor@example.com", subject: "New message", body: "Hello" });
    expect(mocks.queueMail.mock.calls[0][0]).toMatchObject({ to: "owner@example.com", replyTo: "visitor@example.com" });
    await expect(mail.send({ to: "owner@example.com", replyTo: "a@example.com\r\nBcc: b@example.com", subject: "S", body: "B" })).rejects.toThrow(/replyTo/);
    await expect(mail.send({ to: "owner@example.com", replyTo: "a@example.com, b@example.com", subject: "S", body: "B" })).rejects.toThrow(/replyTo/);
  });

  it("escapes the body and keeps paragraphs", () => {
    const { html, text } = extensionEmail("a@example.com", "Acme", "S", "<b>One</b>\nline two\n\nTwo", { label: "<Go>", url: "https://example.com/?a=1&b=2" });
    expect(html).toBe('<p>&lt;b&gt;One&lt;/b&gt;<br>line two</p><p>Two</p><p><a href="https://example.com/?a=1&amp;b=2">&lt;Go&gt;</a></p>');
    expect(text).toContain("<Go>: https://example.com/?a=1&b=2");
  });
});

describe("email to many from plugins (C21)", () => {
  const mail = extensionMail("plugin:newsletter");
  const doc = { type: "doc", content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "News <today>" }] },
    { type: "paragraph", content: [{ type: "text", text: "Read " }, { type: "text", text: "this", marks: [{ type: "link", attrs: { href: "https://example.com/a?x=1&y=2" } }, { type: "bold" }] }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }, { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] }] },
  ] };
  const unsubscribe = { url: "https://example.com/newsletter#unsubscribe=u1.abc", oneClick: "https://example.com/api/ext/newsletter/unsubscribe/u1.abc", label: "Unsubscribe" };

  it("sends a batch now, reports each message, and audits once with counts and no addresses", async () => {
    const results = await mail.sendBatch([
      { to: "a@example.com", subject: "Issue 1", richText: doc, unsubscribe },
      { to: "b@example.com", subject: "Issue 1", body: "Plain", unsubscribe },
    ]);
    expect(results).toEqual([{ ok: true }, { ok: false, error: "status 550" }]);
    expect(mocks.audit).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "extension.mail_batch", outcome: "failure", actorEmail: "plugin:newsletter", metadata: { count: 2, sent: 1, failed: 1 } }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("a@example.com");
    expect(mocks.queueMail).not.toHaveBeenCalled();
  });

  it("turns rich text into email HTML and plain text, escaped, with its links", async () => {
    await mail.sendBatch([{ to: "a@example.com", subject: "Issue 1", richText: doc }]);
    const [[[message]]] = mocks.sendMailBatch.mock.calls as unknown as Array<[Array<{ html: string; text: string; headers?: unknown; bulk?: boolean }>]>;
    expect(message.html).toContain('<h2 style="margin:24px 0 12px;font-size:22px">News &lt;today&gt;</h2>');
    expect(message.html).toContain('Read <strong><a href="https://example.com/a?x=1&amp;y=2">this</a></strong>');
    expect(message.html).toContain("<li><p style=\"margin:0\">one</p></li>");
    expect(message.text).toBe("NEWS <TODAY>\n\nRead this (https://example.com/a?x=1&y=2)\n\n- one\n- two");
    expect(message.headers).toBeUndefined();
    expect(message.bulk).toBeUndefined();
  });

  it("adds the unsubscribe link and the one-click headers, and marks the message as bulk", async () => {
    await mail.sendBatch([{ to: "a@example.com", subject: "Issue 1", body: "Hello", unsubscribe }]);
    const [[[message]]] = mocks.sendMailBatch.mock.calls as unknown as Array<[Array<{ html: string; text: string; headers?: Record<string, string>; bulk?: boolean }>]>;
    expect(message.headers).toEqual({ "List-Unsubscribe": `<${unsubscribe.oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(message.bulk).toBe(true);
    expect(message.text).toContain(`Unsubscribe: ${unsubscribe.url}`);
    expect(message.html).toContain(`href="https://example.com/newsletter#unsubscribe=u1.abc"`);
  });

  it.each([
    ["both a body and rich text", { body: "B", richText: doc }],
    ["neither", {}],
    ["rich text with a script link", { richText: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] }] } }],
    ["rich text that isn't a document", { richText: "<p>hi</p>" }],
    ["an unsubscribe address that could add a header", { body: "B", unsubscribe: { url: "https://example.com/a>\r\nBcc: x@example.com" } }],
    ["an unsubscribe address that isn't the web", { body: "B", unsubscribe: { url: "javascript:alert(1)" } }],
  ])("refuses %s, and sends none of the batch", async (_, change) => {
    await expect(mail.sendBatch([{ to: "ok@example.com", subject: "S", body: "Fine" }, { to: "a@example.com", subject: "S", ...change } as never])).rejects.toThrow(/plugin:newsletter: email not sent.*\(email 2 of the batch\)/);
    expect(mocks.sendMailBatch).not.toHaveBeenCalled();
  });

  it("takes at most 100 emails a batch", async () => {
    const many = Array.from({ length: 101 }, (_, index) => ({ to: `r${index}@example.com`, subject: "S", body: "B" }));
    await expect(mail.sendBatch(many)).rejects.toThrow(/at most 100/);
    expect(await mail.sendBatch([])).toEqual([]);
  });
});

describe("plugin field contracts", () => {
  const shape = (fields: Array<[string, string]>): CollectionShape => ({ slug: "blog-posts", name: "Posts", type: "base", urlPattern: null, fields: fields.map(([name, type]) => ({ name, type, config: {} })) });

  it("reports missing collections, missing fields and changed types", async () => {
    mocks.describeCollection.mockImplementation(async (slug) => (slug === "blog-posts" ? shape([["title", "text"], ["body", "rich_text"]]) : null));
    const problems = await contractProblems({ contract: { "blog-posts": { title: "text", body: "stream", slug: "text" }, "blog-tags": { name: "text" } } });
    expect(problems).toEqual([
      '"blog-posts.body" is a rich_text field, and should be stream.',
      '"blog-posts" has no "slug" field.',
      'The "blog-tags" collection is missing.',
    ]);
  });

  it("finds nothing wrong when the fields are there, whatever else the owner added", async () => {
    mocks.describeCollection.mockResolvedValue(shape([["title", "text"], ["material", "text"]]));
    expect(await contractProblems({ contract: { "blog-posts": { title: "text" } } })).toEqual([]);
    expect(await contractProblems({})).toEqual([]);
  });

  it("must name real collection slugs and field types", () => {
    const plugin = { name: "blog", version: "1.0.0", apiVersion: 1 };
    expect(() => assertPluginManifest({ ...plugin, contract: { "blog-posts": { title: "text" } } })).not.toThrow();
    expect(() => assertPluginManifest({ ...plugin, contract: { "Blog Posts": { title: "text" } } })).toThrow(/isn't a collection slug/);
    expect(() => assertPluginManifest({ ...plugin, contract: { "blog-posts": { title: "" } } })).toThrow(/needs a field type/);
  });
});
