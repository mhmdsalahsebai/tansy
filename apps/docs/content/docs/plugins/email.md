---
title: "Email plugin (`@tansy/email`)"
description: "Everything the site sends goes through one place in core: account email (verification, password resets, magic links, codes, security alerts), plugins' mail.send, and the test email under Settings → Email. Out of the…"
---

## 1. The approach

Everything the site sends goes through one place in core: account email (verification, password resets, magic links, codes, security alerts), plugins' `mail.send`, and the test email under **Settings → Email**. Out of the box, core sends it over SMTP. The Email plugin delivers all of it through a provider's HTTP API instead. Nothing that sends mail has to change.

As with Payments, there's one core plugin and one small adapter package per provider:

| Package | Provider | Keys (environment variables) | Other settings |
|---|---|---|---|
| `@tansy/email-resend` | Resend | `RESEND_API_KEY` | |
| `@tansy/email-postmark` | Postmark | `POSTMARK_SERVER_TOKEN` | Message stream, `outbound` by default |
| `@tansy/email-sendgrid` | SendGrid | `SENDGRID_API_KEY` | Region: global or EU |
| `@tansy/email-mailgun` | Mailgun | `MAILGUN_API_KEY` | Sending domain, region: US or EU |
| `@tansy/email-ses` | Amazon SES (v2 API) | `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` | Region, optional configuration set |
| `@tansy/email-brevo` | Brevo | `BREVO_API_KEY` | |

The adapters call each provider's API with `fetch` and bring no vendor SDK. SES requests are signed with `aws4fetch`, which core already uses for S3.

```ts
// tansy.config.ts
import { email } from "@tansy/email";
import { resend } from "@tansy/email-resend";
import { ses } from "@tansy/email-ses";

plugins: [email({ providers: [resend(), ses()] })]
```

Then, under **Email → Settings**, choose the provider, paste its keys (or set its environment variables) and set the from address. Use **Settings → Email → Send test email** to try it.

## 2. Falling back to SMTP

The plugin sends only once the chosen provider's keys are set and there's a valid from address. Until then, mail goes through SMTP under **Settings → Email** as before, or to the console in development. This means that:

- installing the plugin before entering keys never stops password resets
- clearing a key switches back to SMTP at once
- once the plugin is sending, **Settings → Email** says so, and the test email goes through it

A provider that refuses a message doesn't fall back to SMTP. The failure is logged, as a failed SMTP delivery would be, so a misconfigured provider is noticed rather than hidden.

## 3. Settings

| Setting | Default | |
|---|---|---|
| Provider | The first one listed, or `provider` in the options | |
| From address | Empty: uses the one under Settings → Email | Must be at a domain verified with the provider |
| From name | Empty: uses the one under Settings → Email, then the site's name | Line breaks and control characters are removed |
| Reply-to address | Empty | A message's own reply-to wins, such as a form notification answering the visitor (`mail.send({ replyTo })`) |
| Keep a delivery log | On | |
| Keep log entries for (days) | 30 | A daily job removes older ones |

Every provider setting starts with the provider's id, such as `resendApiKey`, and the plugin refuses an adapter whose settings don't. Keys are `secret` settings (C14): encrypted at rest, never sent back to the dashboard, and never audited.

## 4. The delivery log

`email-messages` (**Email → Messages**) has one record per message the provider was asked to send:

| Field | |
|---|---|
| `recipient` | |
| `subject` | |
| `kind` | What sent it: `auth:<email kind>` such as `auth:reset-password`, `plugin:<name>`, a hook file's name, or `test` |
| `provider` | |
| `state` | `sent` when the provider accepted it, or `failed` |
| `providerId` | The provider's id for the message, to look it up in their dashboard |
| `error` | `HTTP <status>` or `unreachable`, nothing else |

The body is never stored, because it can hold sign-in links, reset tokens and codes. What the provider answered isn't stored or logged either, since it can quote the account or the key. Every rule on the collection is `null`: only staff with record permissions can read it, and only the plugin writes to it.

## 5. Writing an adapter

An adapter implements `EmailProvider` from `@tansy/email/provider`:

```ts
import { callProvider, defineEmailProvider, idOf, mailbox, str } from "@tansy/email/provider";

export const acme = () => defineEmailProvider({
  id: "acme",
  label: "Acme Mail",
  settings: () => [{ name: "acmeApiKey", type: "secret", env: "ACME_API_KEY", label: "Acme API key" }],
  ready: (settings) => Boolean(str(settings.acmeApiKey)),
  async send(email, settings) {
    const answer = await callProvider("Acme", "https://api.acme.test/send", {
      method: "POST",
      headers: { authorization: `Bearer ${str(settings.acmeApiKey)}`, "content-type": "application/json" },
      body: JSON.stringify({ from: mailbox(email.from), to: email.to, subject: email.subject, text: email.text, html: email.html }),
    });
    return { id: idOf(answer.id) };
  },
});
```

`callProvider` times out after 15 seconds, refuses redirects, and on a non-2xx answer throws a `ProviderError` that carries only the status. Every address in `email` has already been checked, and the subject and from name contain no line breaks. A value from settings that goes into a URL, such as Mailgun's domain or SES's region, must be checked against a strict pattern first, so it can't change the host or path.

### Mail to many

`OutgoingEmail` carries `headers`, only `List-Unsubscribe` and `List-Unsubscribe-Post` and never with a line break, and `bulk`, true for newsletters and other mail to a list. Every adapter passes the headers on. An adapter may add `sendBatch(emails, settings)`, returning a result for each email in order: Resend's and Postmark's use their batch APIs, and Postmark sends bulk mail through the message stream in **Postmark broadcast stream** (`broadcast`), as it requires. Without `sendBatch`, the plugin sends a batch one email after another, so a provider's rate limit isn't hit all at once. Each email in a batch gets its own line in the delivery log.

## 6. Not yet

- **Bounces and complaints.** Each provider signs its webhooks differently (Svix for Resend, SNS for SES, ECDSA for SendGrid, HMAC for Mailgun, basic auth for Postmark). A follow-up can add an optional `webhook` to `EmailProvider`, a suppression list, and a `state` of `bounced` or `complained` in the log.
- **Sending through more than one provider**, such as failover. The first ready adapter sends, and there's one per site.
