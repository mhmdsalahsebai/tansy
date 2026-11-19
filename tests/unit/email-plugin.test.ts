import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext, PluginMigrationContext } from "@/core/extend/define";
import { assertPluginManifest } from "@/core/extend/manifest";
import { resolveSettings } from "@/core/extend/settings-schema";
import { schemaDocument } from "@/core/schema/portable";
import { authSettingsSchema, type AuthSettings } from "@/core/auth/settings-schema";
import { provideCmsConfig } from "@/core/config";
import { defineCms } from "@/core/auth/extensions";
import { activeMailer, sendMail, sendMailBatch, type MailMessage } from "@/core/mail";
import { email, MESSAGES } from "../../plugins/email/index";
import { cleanName, failureOf, outgoing, senderOf } from "../../plugins/email/logic";
import { callProvider, defineEmailProvider, mailbox, ProviderError, type EmailProvider, type EmailSettings, type OutgoingEmail } from "../../plugins/email/provider";
import { brevo } from "../../plugins/email-brevo/index";
import { mailgun } from "../../plugins/email-mailgun/index";
import { postmark } from "../../plugins/email-postmark/index";
import { resend } from "../../plugins/email-resend/index";
import { sendgrid } from "../../plugins/email-sendgrid/index";
import { ses } from "../../plugins/email-ses/index";

vi.mock("@/core/extend/hooks", () => ({ extensionContext: (source: string) => contexts.get(source) }));
const contexts = new Map<string, ExtensionContext>();

const all = () => [resend(), postmark(), sendgrid(), mailgun(), ses(), brevo()];
const auth = (mail: Partial<AuthSettings["mail"]> = {}): AuthSettings => {
  const settings = authSettingsSchema.parse({});
  return { ...settings, mail: { ...settings.mail, ...mail } };
};

const message: MailMessage = { to: "reader@example.com", subject: "Reset your password - Site", text: "Use this link", html: "<p>Use this link</p>", kind: "auth:reset-password" };

/** A plugin context with these settings, whose system records go into `created`. */
function contextWith(values: Record<string, unknown>) {
  const created: Array<Record<string, unknown>> = [];
  const context = {
    settings: { get: async () => ({ provider: "fake", fromAddress: "", fromName: "", replyTo: "", log: true, logDays: 30, ...values }) },
    system: { records: { create: async (_slug: string, data: Record<string, unknown>) => { created.push({ slug: _slug, ...data }); return data; } } },
  } as unknown as ExtensionContext;
  return { context, created };
}

function fakeProvider(send: EmailProvider["send"] = async () => ({ id: "msg_1" })) {
  return defineEmailProvider({
    id: "fake",
    label: "Fake",
    settings: () => [{ name: "fakeKey", type: "secret", label: "Key" }],
    ready: (settings) => Boolean(settings.fakeKey),
    send: vi.fn(send),
  });
}

/** A fetch that records what it was called with and answers `answer`. */
function recordingFetch(answer: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer();
  }) as typeof fetch;
  return { calls, fetcher };
}

const OUT: OutgoingEmail = { from: { address: "site@example.com", name: "Example Site" }, to: "reader@example.com", replyTo: "help@example.com", subject: "Hello", text: "Hi", html: "<p>Hi</p>", headers: {}, bulk: false };
const json = (value: unknown, status = 200) => () => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

afterEach(() => contexts.clear());

describe("email plugin manifest", () => {
  it("validates and checks its options", () => {
    expect(() => assertPluginManifest(email({ providers: all() }))).not.toThrow();
    expect(() => email({ providers: [] })).toThrow(/at least one provider/);
    expect(() => email({ providers: all(), provider: "nobody" })).toThrow(/isn't one of the providers/);
    expect(() => email({ providers: [resend(), resend()] })).toThrow(/listed twice/);
  });

  it("requires each provider's settings to start with its id", () => {
    const bad = defineEmailProvider({ ...fakeProvider(), settings: () => [{ name: "apiKey", type: "secret", label: "Key" }] });
    expect(() => email({ providers: [bad] })).toThrow(/must start with "fake"/);
  });

  it("defaults to the first provider, and keeps every key a secret", () => {
    const plugin = email({ providers: all() });
    const values = resolveSettings(plugin.settings!.fields, null);
    expect(values.provider).toBe("resend");
    for (const name of ["resendApiKey", "postmarkServerToken", "sendgridApiKey", "mailgunApiKey", "sesAccessKeyId", "sesSecretAccessKey", "brevoApiKey"]) {
      expect(plugin.settings!.fields.find((field) => field.name === name)?.type).toBe("secret");
    }
  });

  it("creates a log collection only it writes and nobody reads by rule", async () => {
    const apply = vi.fn(async () => {});
    const context = { schema: { describe: async () => null, apply } } as unknown as PluginMigrationContext;
    await email({ providers: all() }).migrations![0].up(context);
    const [collection] = schemaDocument.parse((apply.mock.calls[0] as unknown[])[0]).collections;
    expect(collection.slug).toBe(MESSAGES);
    expect(Object.values(collection.rules).every((rule) => rule === null)).toBe(true);
    expect(collection.fields.map((field) => field.name)).not.toContain("body");
  });
});

describe("email plugin delivery", () => {
  it("is ready only once the chosen provider's keys are set", async () => {
    const plugin = email({ providers: [fakeProvider()] });
    expect(await plugin.auth!.mail!.ready!(contextWith({}).context)).toBe(false);
    expect(await plugin.auth!.mail!.ready!(contextWith({ fakeKey: "k" }).context)).toBe(true);
    expect(await plugin.auth!.mail!.ready!(contextWith({ fakeKey: "k", fromAddress: "not an address" }).context)).toBe(false);
  });

  it("sends from its sender, falling back to Settings → Email, and logs without the body", async () => {
    const provider = fakeProvider();
    const plugin = email({ providers: [provider] });
    const { context, created } = contextWith({ fakeKey: "k", replyTo: "help@example.com" });
    await plugin.auth!.mail!.send(message, auth({ fromAddress: "smtp@example.com", fromName: "From SMTP" }), context);
    expect(provider.send).toHaveBeenCalledWith(expect.objectContaining({ from: { address: "smtp@example.com", name: "From SMTP" }, to: "reader@example.com", replyTo: "help@example.com" }), expect.anything());
    expect(created).toEqual([{ slug: MESSAGES, recipient: "reader@example.com", subject: message.subject, kind: "auth:reset-password", provider: "fake", state: "sent", providerId: "msg_1" }]);
  });

  it("logs a failure with only the status, and still throws", async () => {
    const plugin = email({ providers: [fakeProvider(async () => { throw new ProviderError("Fake", 401); })] });
    const { context, created } = contextWith({ fakeKey: "k", fromAddress: "site@example.com" });
    await expect(plugin.auth!.mail!.send(message, auth(), context)).rejects.toBeInstanceOf(ProviderError);
    expect(created[0]).toMatchObject({ state: "failed", error: "HTTP 401" });
  });

  it("refuses to send without a sender, and keeps no log when it's off", async () => {
    const plugin = email({ providers: [fakeProvider()] });
    await expect(plugin.auth!.mail!.send(message, auth(), contextWith({ fakeKey: "k" }).context)).rejects.toThrow(/from address/);
    const { context, created } = contextWith({ fakeKey: "k", fromAddress: "site@example.com", log: false });
    await plugin.auth!.mail!.send(message, auth(), context);
    expect(created).toEqual([]);
  });
});

describe("email logic", () => {
  const settings = { fromAddress: "", fromName: "", replyTo: "" } as EmailSettings;

  it("takes line breaks out of names and subjects, so nothing can add a header", () => {
    expect(cleanName("Site\r\nBcc: victim@example.com")).toBe("Site Bcc: victim@example.com");
    const out = outgoing({ ...message, subject: "Hi\r\nBcc: x@example.com" }, { address: "a@example.com", name: "A" }, settings)!;
    expect(out.subject).not.toMatch(/[\r\n]/);
    expect(outgoing({ ...message, to: "a@example.com\r\nb@example.com" }, { address: "a@example.com", name: "A" }, settings)).toBeNull();
  });

  it("uses a message's own reply-to over the site-wide one, and drops one that isn't an address", () => {
    const from = { address: "a@example.com", name: "A" };
    expect(outgoing({ ...message, replyTo: "visitor@example.com" }, from, { ...settings, replyTo: "help@example.com" })!.replyTo).toBe("visitor@example.com");
    expect(outgoing({ ...message, replyTo: "not an address" }, from, { ...settings, replyTo: "help@example.com" })!.replyTo).toBe("help@example.com");
    expect(outgoing(message, from, settings)!.replyTo).toBeNull();
  });

  it("picks the sender from the plugin, then Settings → Email, then the site's name", () => {
    expect(senderOf({ ...settings, fromAddress: "a@example.com", fromName: "A" }, { fromAddress: "b@example.com", fromName: "B", appName: "Site" })).toEqual({ address: "a@example.com", name: "A" });
    expect(senderOf(settings, { fromAddress: "b@example.com", fromName: "", appName: "Site" })).toEqual({ address: "b@example.com", name: "Site" });
    expect(senderOf(settings, { fromAddress: "", fromName: "", appName: "Site" })).toBeNull();
  });

  it("quotes display names that need it", () => {
    expect(mailbox({ address: "a@example.com", name: "Plain Name" })).toBe("Plain Name <a@example.com>");
    expect(mailbox({ address: "a@example.com", name: 'Acme, "Inc"' })).toBe('"Acme, \\"Inc\\"" <a@example.com>');
    expect(mailbox({ address: "a@example.com", name: "" })).toBe("a@example.com");
  });

  it("never keeps what a provider said", async () => {
    const { fetcher } = recordingFetch(() => new Response("invalid key re_secret for account acme", { status: 403 }));
    const error = await callProvider("Resend", "https://api.resend.com/emails", {}, fetcher).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(String((error as Error).message)).not.toContain("re_secret");
    expect(failureOf(error)).toBe("HTTP 403");
    expect(failureOf(new Error("anything"))).toBe("error");
  });
});

describe("email provider adapters", () => {
  const body = (init: RequestInit) => JSON.parse(String(init.body)) as Record<string, unknown>;

  it("Resend", async () => {
    const { calls, fetcher } = recordingFetch(json({ id: "re_1" }));
    const provider = resend(fetcher);
    expect(provider.ready({ resendApiKey: "" } as never)).toBe(false);
    expect(await provider.send(OUT, { resendApiKey: "re_key" } as never)).toEqual({ id: "re_1" });
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer re_key");
    expect(body(calls[0].init)).toMatchObject({ from: "Example Site <site@example.com>", to: ["reader@example.com"], reply_to: "help@example.com", text: "Hi", html: "<p>Hi</p>" });
  });

  it("Postmark", async () => {
    const { calls, fetcher } = recordingFetch(json({ MessageID: "pm_1", ErrorCode: 0 }));
    expect(await postmark(fetcher).send(OUT, { postmarkServerToken: "t", postmarkMessageStream: "bad stream!" } as never)).toEqual({ id: "pm_1" });
    expect((calls[0].init.headers as Record<string, string>)["x-postmark-server-token"]).toBe("t");
    expect(body(calls[0].init)).toMatchObject({ To: "reader@example.com", MessageStream: "outbound", ReplyTo: "help@example.com" });
  });

  it("SendGrid", async () => {
    const { calls, fetcher } = recordingFetch(() => new Response(null, { status: 202, headers: { "x-message-id": "sg_1" } }));
    expect(await sendgrid(fetcher).send(OUT, { sendgridApiKey: "SG.x", sendgridRegion: "eu" } as never)).toEqual({ id: "sg_1" });
    expect(calls[0].url).toBe("https://api.eu.sendgrid.com/v3/mail/send");
    expect(body(calls[0].init)).toMatchObject({ personalizations: [{ to: [{ email: "reader@example.com" }] }], from: { email: "site@example.com", name: "Example Site" } });
  });

  it("Mailgun, refusing a domain that could change the path", async () => {
    const { calls, fetcher } = recordingFetch(json({ id: "<mg_1@example.com>" }));
    const provider = mailgun(fetcher);
    expect(provider.ready({ mailgunApiKey: "k", mailgunDomain: "mg.example.com/../v4" } as never)).toBe(false);
    expect(provider.ready({ mailgunApiKey: "k", mailgunDomain: "mg.example.com" } as never)).toBe(true);
    expect(await provider.send(OUT, { mailgunApiKey: "k", mailgunDomain: "mg.example.com", mailgunRegion: "eu" } as never)).toEqual({ id: "<mg_1@example.com>" });
    expect(calls[0].url).toBe("https://api.eu.mailgun.net/v3/mg.example.com/messages");
    expect((calls[0].init.body as URLSearchParams).get("h:Reply-To")).toBe("help@example.com");
  });

  it("Amazon SES, signed, refusing a region that could change the host", async () => {
    const { calls, fetcher } = recordingFetch(json({ MessageId: "ses_1" }));
    const provider = ses(fetcher);
    const keys = { sesAccessKeyId: "AKIA", sesSecretAccessKey: "secret" };
    expect(provider.ready({ ...keys, sesRegion: "evil.com/x" } as never)).toBe(false);
    expect(await provider.send(OUT, { ...keys, sesRegion: "eu-west-1", sesConfigurationSet: "" } as never)).toEqual({ id: "ses_1" });
    expect(calls[0].url).toBe("https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
    expect(new Headers(calls[0].init.headers).get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA\//);
    expect(body(calls[0].init)).toMatchObject({ Destination: { ToAddresses: ["reader@example.com"] }, ReplyToAddresses: ["help@example.com"] });
  });

  it("Brevo", async () => {
    const { calls, fetcher } = recordingFetch(json({ messageId: "<br_1>" }, 201));
    expect(await brevo(fetcher).send(OUT, { brevoApiKey: "xkeysib-1" } as never)).toEqual({ id: "<br_1>" });
    expect((calls[0].init.headers as Record<string, string>)["api-key"]).toBe("xkeysib-1");
    expect(body(calls[0].init)).toMatchObject({ sender: { email: "site@example.com", name: "Example Site" }, to: [{ email: "reader@example.com" }] });
  });
});

describe("core mail delivery (C17)", () => {
  function install(ready: boolean) {
    const send = vi.fn(async () => {});
    contexts.set("plugin:mailer", { marker: "mailer" } as unknown as ExtensionContext);
    provideCmsConfig(defineCms({ plugins: [{ name: "mailer", version: "1.0.0", apiVersion: 1, auth: { mail: { ready: async () => ready, send } } }] }));
    return send;
  }

  it("uses SMTP while a plugin's adapter isn't ready", async () => {
    install(false);
    expect(await activeMailer(auth({ host: "smtp.example.com" }))).toEqual({ kind: "smtp" });
    expect(await activeMailer(auth())).toBeNull();
  });

  it("hands mail to a ready adapter with the plugin's own context", async () => {
    const send = install(true);
    expect(await activeMailer(auth({ host: "smtp.example.com" }))).toMatchObject({ kind: "plugin", name: "mailer" });
    await sendMail(message, auth());
    expect(send).toHaveBeenCalledWith(message, expect.anything(), { marker: "mailer" });
  });

  it("treats an adapter without `ready` as always ready, as before", async () => {
    contexts.set("plugin:legacy", {} as ExtensionContext);
    provideCmsConfig(defineCms({ plugins: [{ name: "legacy", version: "1.0.0", apiVersion: 1, auth: { mail: { send: async () => {} } } }] }));
    expect(await activeMailer(auth())).toMatchObject({ kind: "plugin", name: "legacy" });
  });
});

describe("mail to many (C21)", () => {
  const BULK: OutgoingEmail = { ...OUT, headers: { "List-Unsubscribe": "<https://example.com/u/1>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, bulk: true };
  const body = (init: RequestInit) => JSON.parse(String(init.body)) as unknown;
  const settings = { fromAddress: "", fromName: "", replyTo: "" } as EmailSettings;

  it("passes on only the unsubscribe headers, each one line", () => {
    const out = outgoing({ ...message, headers: { "List-Unsubscribe": "<https://example.com/u>", "X-Evil": "1", "List-Unsubscribe-Post": "a\r\nBcc: x@example.com" }, bulk: true }, { address: "a@example.com", name: "A" }, settings)!;
    expect(out.headers).toEqual({ "List-Unsubscribe": "<https://example.com/u>" });
    expect(out.bulk).toBe(true);
    expect(outgoing(message, { address: "a@example.com", name: "A" }, settings)).toMatchObject({ headers: {}, bulk: false });
  });

  it("sends a batch through the provider's batch API, logging each message", async () => {
    const provider = { ...fakeProvider(), sendBatch: vi.fn(async (emails: OutgoingEmail[]) => emails.map((_, index) => (index === 1 ? new ProviderError("Fake", 422) : { id: `b_${index}` }))) };
    const plugin = email({ providers: [provider] });
    const { context, created } = contextWith({ fakeKey: "k", fromAddress: "site@example.com" });
    const messages = [{ ...message, to: "a@example.com", kind: "plugin:newsletter" }, { ...message, to: "b@example.com", kind: "plugin:newsletter" }, { ...message, to: "not an address" }];
    expect(await plugin.auth!.mail!.sendBatch!(messages, auth(), context)).toEqual([{ ok: true }, { ok: false, error: "HTTP 422" }, { ok: false, error: "not an address" }]);
    expect(provider.sendBatch).toHaveBeenCalledOnce();
    expect(provider.send).not.toHaveBeenCalled();
    expect(created.map((entry) => [entry.recipient, entry.state, entry.providerId ?? entry.error])).toEqual([["a@example.com", "sent", "b_0"], ["b@example.com", "failed", "HTTP 422"]]);
  });

  it("sends one at a time when the provider has no batch API, and a refused call fails only its message", async () => {
    let calls = 0;
    const provider = fakeProvider(async () => { calls++; if (calls === 2) throw new ProviderError("Fake", 500); return { id: `m_${calls}` }; });
    const plugin = email({ providers: [provider] });
    const { context } = contextWith({ fakeKey: "k", fromAddress: "site@example.com", log: false });
    const results = await plugin.auth!.mail!.sendBatch!([{ ...message, to: "a@example.com" }, { ...message, to: "b@example.com" }, { ...message, to: "c@example.com" }], auth(), context);
    expect(results).toEqual([{ ok: true }, { ok: false, error: "HTTP 500" }, { ok: true }]);
  });

  it("Resend sends a batch in one call, with each message's headers", async () => {
    const { calls, fetcher } = recordingFetch(json({ data: [{ id: "re_1" }, { id: "re_2" }] }));
    const results = await resend(fetcher).sendBatch!([BULK, { ...BULK, to: "other@example.com" }], { resendApiKey: "re_key" } as never);
    expect(results).toEqual([{ id: "re_1" }, { id: "re_2" }]);
    expect(calls[0].url).toBe("https://api.resend.com/emails/batch");
    expect(body(calls[0].init)).toMatchObject([{ to: ["reader@example.com"], headers: BULK.headers }, { to: ["other@example.com"] }]);
  });

  it("Postmark sends bulk mail through the broadcast stream, and answers for each message of a batch", async () => {
    const { calls, fetcher } = recordingFetch(json([{ ErrorCode: 0, MessageID: "pm_1" }, { ErrorCode: 406, Message: "Inactive recipient" }]));
    const results = await postmark(fetcher).sendBatch!([BULK, { ...BULK, to: "gone@example.com" }], { postmarkServerToken: "t", postmarkMessageStream: "outbound", postmarkBroadcastStream: "" } as never);
    expect(results[0]).toEqual({ id: "pm_1" });
    expect(results[1]).toBeInstanceOf(ProviderError);
    expect(calls[0].url).toBe("https://api.postmarkapp.com/email/batch");
    expect(body(calls[0].init)).toMatchObject([{ MessageStream: "broadcast", Headers: [{ Name: "List-Unsubscribe", Value: "<https://example.com/u/1>" }, { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" }] }, {}]);
    // Mail to one person stays on the transactional stream.
    const single = recordingFetch(json({ MessageID: "pm_2", ErrorCode: 0 }));
    await postmark(single.fetcher).send(OUT, { postmarkServerToken: "t", postmarkMessageStream: "outbound", postmarkBroadcastStream: "news" } as never);
    expect(body(single.calls[0].init)).toMatchObject({ MessageStream: "outbound" });
    expect(body(single.calls[0].init)).not.toHaveProperty("Headers");
  });

  it("SendGrid, Mailgun, SES and Brevo carry the headers", async () => {
    const sg = recordingFetch(() => new Response(null, { status: 202 }));
    await sendgrid(sg.fetcher).send(BULK, { sendgridApiKey: "SG.x" } as never);
    expect(body(sg.calls[0].init)).toMatchObject({ headers: BULK.headers });
    const mg = recordingFetch(json({ id: "<mg>" }));
    await mailgun(mg.fetcher).send(BULK, { mailgunApiKey: "k", mailgunDomain: "mg.example.com" } as never);
    expect((mg.calls[0].init.body as URLSearchParams).get("h:List-Unsubscribe-Post")).toBe("List-Unsubscribe=One-Click");
    const aws = recordingFetch(json({ MessageId: "ses" }));
    await ses(aws.fetcher).send(BULK, { sesAccessKeyId: "AKIA", sesSecretAccessKey: "s", sesRegion: "eu-west-1" } as never);
    expect(body(aws.calls[0].init)).toMatchObject({ Content: { Simple: { Headers: [{ Name: "List-Unsubscribe", Value: "<https://example.com/u/1>" }, { Name: "List-Unsubscribe-Post" }] } } });
    const br = recordingFetch(json({ messageId: "<br>" }, 201));
    await brevo(br.fetcher).send(BULK, { brevoApiKey: "k" } as never);
    expect(body(br.calls[0].init)).toMatchObject({ headers: BULK.headers });
  });

  it("core hands a batch to the adapter's sendBatch, else to send one by one", async () => {
    const sendBatch = vi.fn(async () => [{ ok: true as const }]);
    const send = vi.fn(async () => {});
    contexts.set("plugin:batcher", {} as ExtensionContext);
    provideCmsConfig(defineCms({ plugins: [{ name: "batcher", version: "1.0.0", apiVersion: 1, auth: { mail: { send, sendBatch } } }] }));
    // An adapter that answers for fewer messages than it got leaves the rest undelivered.
    expect(await sendMailBatch([message, { ...message, to: "b@example.com" }], auth())).toEqual([{ ok: true }, { ok: false, error: "not delivered" }]);
    expect(send).not.toHaveBeenCalled();

    let count = 0;
    const one = vi.fn(async () => { count++; if (count === 1) throw Object.assign(new Error("mailbox full: someone@example.com"), { status: 552 }); });
    contexts.set("plugin:single", {} as ExtensionContext);
    provideCmsConfig(defineCms({ plugins: [{ name: "single", version: "1.0.0", apiVersion: 1, auth: { mail: { send: one } } }] }));
    // The reason is the status, never what the server said.
    expect(await sendMailBatch([message, message], auth())).toEqual([{ ok: false, error: "status 552" }, { ok: true }]);
    await expect(sendMailBatch(Array.from({ length: 101 }, () => message), auth())).rejects.toThrow(/at most 100/);
  });
});
