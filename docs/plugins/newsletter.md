# Newsletter plugin (`@tansy/newsletter`)

## 1. What it tests

A newsletter goes naturally with Blog and the email adapters: visitors subscribe, confirm by email, and leave with one click, and staff send a post as a campaign to everyone. It tests three things no other plugin has needed:

- **Bulk mail.** A campaign goes to thousands of people, so mail has to go out in batches through the provider's batch API, not one queued message at a time.
- **Per-recipient tokens.** Every email carries its own signed unsubscribe link, and the headers mail clients need for one-click unsubscribing (RFC 8058).
- **Jobs that send a lot at once,** at a pace the provider allows, without sending anyone the same campaign twice when a run overlaps or the server restarts.

```ts
// tansy.config.ts
import { newsletter } from "@tansy/newsletter";

plugins: [newsletter({ siteUrl: "https://example.com" })]
```

`siteUrl` is the site's public address, which links in email start with. The options also take `doubleOptIn` (default `true`) and `perMinute` (default 300). The starter turns it on with `TANSY_PLUGIN_NEWSLETTER=true`, uses `TANSY_SITE_URL` or else `BETTER_AUTH_URL` for the address, and `TANSY_NEWSLETTER_PER_MINUTE` for the pace.

The dashboard gets one sidebar link, **Newsletter**, with tabs for campaigns, subscribers and settings.

## 2. Collections, page and block

| Collection | Rules | |
|---|---|---|
| `newsletter-subscribers` | All locked | `email` (unique, lowercase), `name`, `state` (pending, confirmed, unsubscribed), `language`, `source` (the page they signed up on, or `import`), `confirmedAt`, `unsubscribedAt` |
| `newsletter-campaigns` | All locked | `subject`, `body` (rich text), `link` and `linkLabel` (a button), `source` (the record it was made from), `state` (draft, scheduled, sending, sent, cancelled), `scheduledAt`, and progress: `startedAt`, `finishedAt`, `recipients`, `sent`, `failed` |
| `newsletter-page` | View: public. Writes locked | A singleton at `/newsletter`: `title` and `intro`. Its template shows the sign-up form, and handles the links in email |

The **Newsletter sign-up** block (`newsletter_signup`) puts the form on any page, such as the end of every blog post: a title, text, a button label and whether to ask for a name.

Two hooks keep the data straight. Addresses are lowercased, so one person is one subscriber, and a change of state is dated. A campaign written by a person always starts as a draft, its progress fields can't be set by hand, and once it's no longer a draft its content can't change: send, schedule and cancel happen only through the plugin's routes. A sending campaign can't be deleted.

The role **Newsletter editor** has `ext.newsletter:send` and the record permissions on campaigns. `ext.newsletter:manage` is for the subscriber list: importing, exporting and changing someone's state.

## 3. Signing up

`SignupForm` and `NewsletterManager` from `@tansy/newsletter/client` use the public routes. A headless site passes `api="https://cms.example.com/api"`.

| Route | |
|---|---|
| `GET /api/ext/newsletter/signup` | The CAPTCHA's public widget or `null`, and a signed form token. Not cached |
| `POST /api/ext/newsletter/subscribe` | `{ email, name?, token, answer?, website?, page?, locale? }`. Rate limited to 5 per 10 minutes per address |
| `POST /api/ext/newsletter/confirm` | `{ token }` from the confirmation email |
| `GET /api/ext/newsletter/unsubscribe/:token` | The address, mostly hidden (`ad•••@example.com`), and whether it's unsubscribed already |
| `POST /api/ext/newsletter/unsubscribe/:token` | Unsubscribes. Takes any body, as mail clients send `List-Unsubscribe=One-Click`. Rate limited to 10 per 10 minutes per link |

`/subscribe` checks the trap field (`website`; filled in means a script, answered as if it worked and nothing kept), the form token (sent less than 2 seconds after it was handed out is `TOO_FAST`; forged or a day old is `FORM_EXPIRED`), the address, and the CAPTCHA when one is set up and **Ask for the CAPTCHA** is on.

Then, with double opt-in, a new address is kept as `pending` and sent a confirmation email. The answer is the same whether the address was new, waiting or already subscribed, so nobody can learn who's on the list. A waiting address gets at most one confirmation an hour, so the form can't be used to flood someone's inbox. A person who's signed in and subscribes their own verified address is confirmed at once. Someone who unsubscribed and signs up again is asked to confirm again.

### The links in email

| Token | Shape | Lasts |
|---|---|---|
| Confirm | `c<id>.<issued>.<HMAC>` | 7 days |
| Unsubscribe | `u<id>.<HMAC>` | For good, as the law in most places requires |

Each is an HMAC-SHA256, with a key the plugin keeps in its store, over what the token is for, the subscriber's id and their address. A token for one thing can't be used for another or for another subscriber, and stops working if the address changes.

The tokens go to the newsletter page after `#`, as `/newsletter#confirm=…` and `/newsletter#unsubscribe=…`. The part after `#` never reaches a server or its logs, and the page confirms from JavaScript, which mail scanners that only fetch a link never run. Unsubscribing asks first, showing the hidden address. Mail clients unsubscribe without the page, through the `List-Unsubscribe` header that points at the POST route.

A daily job forgets sign-ups that weren't confirmed after **Forget unconfirmed sign-ups after** (7 days).

## 4. Campaigns

Staff write a campaign as a record under **Newsletter → Campaigns**, or with **Send as a newsletter** on any published record that has a page, such as a blog post: that drafts a campaign with the record's title as the subject, its excerpt or summary as the text, and a **Read more** button linking to it. The record is read as the person, with only the fields they can read.

| Route | Needs | |
|---|---|---|
| `GET /api/ext/newsletter/status` | `dashboard:access` | Whether email and a CAPTCHA are set up, and the counts |
| `GET /api/ext/newsletter/campaigns` | `send` | |
| `POST …/campaigns/:id/test` | `send` | Sends it to the person asking, and nobody else |
| `POST …/campaigns/:id/send` | `send` | `{ at? }`: now, or at a time |
| `POST …/campaigns/:id/cancel` | `send` | Stops a scheduled or sending campaign |
| `POST …/campaigns/:id/copy` | `send` | A new draft with the same content |
| `POST …/campaigns/from-record` | `send` | `{ collection, id }` |

**Sending** freezes the recipients: everyone confirmed when it starts, up to the highest subscriber id then. The `newsletter-send` job runs every minute, and right after a send, and sends up to **Emails sent a minute** (300). Each batch of up to 100 is claimed before it's sent, by moving the campaign's cursor past it with a conditional update (C13), so two runs never send the same batch and a restart never sends one twice. A batch that fails partway is counted as failed, not retried: someone missing a newsletter is better than someone getting it twice. Someone who unsubscribes during the send isn't sent it.

Every email has the campaign's text, its button, and a footer link to unsubscribe, plus `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers with that subscriber's own link. Its fixed words, the button's default label and the footer, are in the site's default language.

## 5. Subscribers

**Newsletter → Subscribers** lists them by state, searches, and unsubscribes or confirms one by hand.

**Import** takes pasted addresses, one per line, as `ada@example.com`, `Ada Lovelace <ada@example.com>` or a spreadsheet's `ada@example.com, Ada`, up to 5,000 at a time. The person importing says whether these people agreed to get the newsletter: if so they're confirmed at once, and if not each is sent a confirmation, in batches by the sending job. An import never brings back someone who unsubscribed.

**Export** downloads a CSV of the subscribers the person can read. A value a spreadsheet would run as a formula is prefixed with an apostrophe. Both are audited, without addresses.

## 6. Settings

| Setting | Default | |
|---|---|---|
| Ask new subscribers to confirm | `doubleOptIn` in the options, on | Off lets anyone sign up any address |
| Ask for the CAPTCHA on sign-up | On | Once one is set up, see [the CAPTCHA plugin](captcha.md) |
| Emails sent a minute | `perMinute` in the options, 300 | Keep it under your provider's limit |
| Forget unconfirmed sign-ups after | 7 days | 0 keeps them |

Nothing about a visitor is kept beyond their address, the name they gave, their language and the page they signed up on: no IP address and no user agent.

## 7. Core gap C21: mail to many

`mail.send` queued one message at a time with no headers, so a campaign would have been thousands of single sends, with no way to add the unsubscribe headers mail clients and Gmail's and Yahoo's sender rules expect. C21 adds:

- `mail.sendBatch(emails)` on `ExtensionContext`: up to 100 messages, all checked before any is sent, returning `{ ok, id? }` or `{ ok: false, error }` for each. One audit entry, `extension.mail_batch`, with the counts and never an address.
- `unsubscribe: { url, oneClick?, label? }` on an email: a footer link, and the `List-Unsubscribe` headers. Such mail is marked as bulk.
- `richText` in place of `body`: a rich text document, sent as HTML with inline styles and as plain text.
- `sendBatch` on mail adapters (`auth.mail`). The email plugin uses the provider's batch API where there is one (Resend, Postmark) and sends one after another otherwise. Postmark sends bulk mail through its broadcast stream. SMTP sends a batch over one pooled connection.
- The admin sidebar shows a section with a single page as one link.

## 8. Not yet

- **Bounces and complaints** come with webhooks in the email plugin ([Email §6](email.md#6-not-yet)). Then a bounced address can be unsubscribed.
- **Segments**, such as subscribers by language or by tag. Every campaign goes to everyone confirmed.
- **Open and click tracking**, which needs tracking pixels and redirects many sites would rather not have.

## With tenants

With the multi-tenant plugin (or another row scope provider), each tenant keeps its own data. Double opt-in, the CAPTCHA and the days before unconfirmed sign-ups are forgotten can differ per tenant, and sending and forgetting run in each one. Links in emails go to the tenant's own domain, or under its path prefix on this app's address until it has one; the one-click unsubscribe address is the API's, which is never prefixed.
