---
title: "Payments plugin (`@tansy/payments`)"
description: "The provider owns the money: checkout, coupons, receipts, tax, refunds and the billing portal stay with the provider. The CMS keeps what the site needs to know, such as who is subscribed to which plan and who bought…"
---

## 1. The approach

The provider owns the money: checkout, coupons, receipts, tax, refunds and the billing portal stay with the provider. The CMS keeps what the site needs to know, such as who is subscribed to which plan and who bought which record, as ordinary records that rules, hooks, templates and the dashboard use.

better-auth's payment plugins already do customers, subscriptions, the billing portal and signed webhooks. Payments installs the chosen one and wires it to the CMS. It doesn't rebuild any of it, and it knows nothing about what's being sold: any collection can sell its records, and any rule can gate on a plan.

Payments is one core plugin and one small adapter package per provider:

| Package | Provider | better-auth plugin |
|---|---|---|
| `@tansy/payments-stripe` | Stripe | `@better-auth/stripe` |
| `@tansy/payments-polar` | Polar | `@polar-sh/better-auth` |
| `@tansy/payments-dodo` | Dodo Payments | `@dodopayments/better-auth` |
| `@tansy/payments-creem` | Creem | `@creem_io/better-auth` |
| `@tansy/payments-commet` | Commet | `@commet/better-auth` |

Everything providers share lives in `@tansy/payments`, which has no provider SDK: plans, purchases, memberships, the price field, the blocks, the routes and the plan user field. A site installs only the adapters it may use, so it carries only their SDKs, and one provider's release never forces another's.

Autumn is listed on better-auth's site, but autumn-js 1.6 removed its better-auth plugin (`autumn-js/better-auth`), so there's no adapter for it. One could be written on its SDK, as below.

```ts
// tansy.config.ts
import { payments } from "@tansy/payments";
import { stripe } from "@tansy/payments-stripe";
import { polar } from "@tansy/payments-polar";

plugins: [payments({ siteUrl: "https://example.com", providers: [stripe(), polar()] })]
```

Then, under **Payments → Settings**, choose the provider and paste its keys, or set its environment variables. Each provider's settings say where to point its webhook. Only the chosen provider's better-auth plugin is installed, and switching keeps every purchase and membership already recorded. Nothing to migrate: core creates the collections on startup.

| Provider | Keys (environment variables) | Webhook | One-time purchases sell under |
|---|---|---|---|
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | `/api/auth/stripe/webhook` | An inline price on each checkout |
| Polar | `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET` | `/api/auth/polar/webhooks` | One one-time product, with the record's price as an ad-hoc price |
| Dodo Payments | `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_SECRET` | `/api/auth/dodopayments/webhooks` | One pay-what-you-want product, in the prices' currency |
| Creem | `CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET` | `/api/auth/creem/webhook` | One pay-what-you-want product, in USD or EUR |
| Commet | `COMMET_API_KEY`, `COMMET_WEBHOOK_SECRET` | `/api/auth/commet/webhooks` | A hosted payment link, which needs no product |

**Test mode** picks Polar's sandbox and Dodo's and Creem's test environments. Stripe and Commet decide by the key.

## 2. What the plugin adds

| Part | What |
|---|---|
| Settings | The provider, default currency, test mode, whether every new account gets a customer with the provider, then each installed provider's keys (`secret` settings, C14) and products |
| Auth plugin | The chosen provider's better-auth plugin from `auth.plugins`, built from the settings with the plugin's context (C6). No keys, no plugin: the routes answer 503 |
| `payments-plans` | Plans the owner edits in the dashboard: name, the provider's price or product id, a yearly one, trial days (Stripe), limits, group. Ids are checked against the chosen provider's form. Published plans are public, for a pricing page |
| `payments-subscription`, `payments-creem-subscription`, `payments-user-data` | Tables and user columns of the providers' better-auth plugins, kept as collections by core (C5). Locked to staff by default |
| `payments-memberships` | Subscriptions with Polar, Dodo, Creem and Commet, whose plugins keep none or don't keep the plan, written from their webhooks. One per subscription, the newest event winning. Each person sees their own |
| `payments_plan` user field | Set by a durable hook whenever a subscription or membership changes, to the active plan's name or nothing. Rules gate on it: `@request.auth.payments_plan = "pro"` |
| `payments-access` | What plans open, edited by the owner: a name, and `collections`, the collections it opens whole. Records go in an access through a Reference field to it. Plans list theirs in `includes`. See §8 |
| `payments-entitlements`, `payments_access` user field | Each person's active plans and the access they include, kept by a durable hook. Rules gate on the field: `included:length > 0 && included ?= @request.auth.payments_access` |
| `payments_price` field type | Add it to any collection to make its records for sale. Owners type the price as they'd say it, such as 19.99. Config: a currency, and `once` (on by default) for things each person buys once |
| `payments-purchases` | One record per paid checkout, written from the provider's webhook, with the provider's name. Each buyer sees their own. A full refund marks it refunded |
| `POST /api/ext/payments/checkout` | Signed in. Starts a checkout for one record with the chosen provider, reading the price from the stored record as the caller, so a record they can't see can't be bought |
| `POST /api/ext/payments/confirm` | Signed in. Body `{ sessionId }`, from the `session_id` the provider's return address carries. Reads the checkout from the provider and records the purchase if it's paid and the caller's own, so buyers don't wait on the webhook, and a site the provider can't reach (such as localhost) still records it. The webhook stays the backup |
| `GET /api/ext/payments/offer` | Public. A record's price and currency, read as the caller, and whether the caller already bought it. Sellers such as LMS use it to show a Buy button without importing Payments |
| `GET /api/ext/payments/purchased` | Signed in. Whether the caller owns a record |
| `POST /api/ext/payments/subscribe` | Signed in. Body `{ plan, annual?, returnPath? }`. Starts a subscription checkout for a published plan with the chosen provider |
| `POST /api/ext/payments/billing` | Signed in. The provider's billing page for the caller: plan, card, invoices, cancelling |
| Blocks | Buy button (collection and record id), Subscribe button (plan, yearly or not), Manage billing |
| `@tansy/payments/react` | `BuyButton`, `SubscribeButton` and `BillingButton`, for templates. They call Payments' routes, so they work with any provider |
| `@tansy/payments/provider` | The adapter interface and the helpers adapters share |

## 3. Writing an adapter

An adapter is `definePaymentProvider({...})` from `@tansy/payments/provider`: the provider's better-auth plugin, plus its SDK for what that plugin leaves out. The five above are examples. It declares:

- `id`, `label` and `webhookPath`. Every setting's name starts with the id, so two adapters can't claim one.
- `settings(siteUrl)`: its keys, as `secret` settings with an `env` name, and anything else it needs.
- `authPlugins(settings, context, siteUrl)`: its better-auth plugin, with webhook callbacks that call `recordPurchase`, `recordRefund` and `upsertMembership`.
- `serverOnlyPaths`: its plugin's endpoints that take an id, product or metadata from the caller. Payments closes them to HTTP (C15).
- `subscriptionRecords`, when its plugin keeps subscriptions itself, as Stripe's does. Otherwise it keeps memberships.
- `checkout`, `confirm`, `subscribe` and `billing`. They may call the plugin's own endpoints as the caller with `context.auth.call` (C16), even closed ones.

A one-time checkout must go in Payments' records as one Payments started: the adapter makes a reference with `newReference()`, puts it in the checkout's metadata and in the return address as `session_id`, and stores it with `rememberCheckout`. `recordPurchase` refuses a purchase whose metadata doesn't match a remembered checkout for the same buyer and record, because most providers' plugins can create checkouts with metadata of the caller's choosing. Only an adapter whose plugin can't create one-time checkouts at all may pass `metadataTrusted`, as Stripe's does.

## 4. What core provides

| Gap | Why | Status |
|---|---|---|
| C5: better-auth plugin tables as collections | The Prisma client ships generated, so `subscription` and `user.stripeCustomerId` have no table. Core plans a collection per model from the plugin's declared schema, creates it on startup, and routes better-auth's adapter calls for those models to it (`core/auth/plugin-adapter.ts`). Core tables never change | Done on 2026-11-13 |
| C6: context in `auth.plugins` | The webhook handlers write purchases and the plans come from a collection | Done on 2026-11-13 |
| C14: secret settings | The owner connects a provider from the dashboard | Done on 2026-11-13 |
| C15: `auth.serverOnlyPaths` | Polar's, Dodo's and Creem's checkouts take any metadata, and Creem's portal and subscription endpoints any id | Done on 2026-11-13 |
| C16: `context.auth.call` | One Subscribe and Billing route for every provider, calling Stripe's, Polar's, Creem's, Dodo's and Commet's endpoints as the caller | Done on 2026-11-13 |
| C12, C13 | Durable hooks keep `payments_plan` right even if a write fails once. Purchases are unique by session, so a provider's repeats change nothing | Done |

## 5. Out of scope

- Orders, carts, coupons, refunds and receipts in the CMS. The provider has them.
- Offline payments (cash on delivery, bank transfer).
- Usage billing, seats and credits, which some providers' plugins offer. A site can add them in its own code.
- Subscriptions for organizations. Each provider is set up for the person's own only.

## 6. Milestones

| # | Work | Done when |
|---|---|---|
| P1 | Core C5, C6, C14 | A better-auth plugin's tables appear as collections on SQLite and Postgres, and running again changes nothing. Done on 2026-11-13 |
| P2 | The plugin: settings, plans, subscriptions, `payments_plan`, price field, checkout, purchases, refunds, blocks | Signed webhook events, as the Stripe CLI sends them, store a subscription that opens a gated record and closes it when cancelled, and record a purchase once however often they repeat. Done on 2026-11-13 |
| P3 | Try it from another plugin, such as paid LMS courses, using only its data and hooks | A plugin sells its records with no change to Payments or core. Done on 2026-11-13 |
| P4 | Gating one record by purchase in a rule (C7) | `@collection` rules match one purchase row in SQL |
| P5 | Every provider with a better-auth payment plugin, as adapters | Switching provider needs no change in core or in templates, a signed Creem subscription event opens a gated record, and a forged purchase changes nothing. Done on 2026-11-13 |

Until P4, a template asks `/purchased` or lists the buyer's purchases to decide what to show, and a plugin that sells its records can copy purchases into its own user field from a `record.afterCreate` hook on `payments-purchases`, as LMS does for enrollments.

## 7. Security

- The checkout route reads the record as the caller and the price from the stored record, never from the request. Return addresses are paths on `siteUrl` only.
- Providers' events are checked against the webhook secret by their better-auth plugins. A bad signature changes nothing, and a repeated event changes nothing the second time.
- A purchase is recorded only for a checkout Payments started for that buyer and record (§3). Endpoints that take metadata, products or ids from the caller are closed to HTTP (C15), and Payments' routes call them after their own checks.
- `context.auth.call` forwards only the caller's session cookie, never an API key, and reaches only Payments' own better-auth endpoints.
- Purchases, memberships, subscriptions and customer ids are written only by the plugin. Buyers read only their own purchases and memberships. The providers' collections are locked.
- `payments_plan` isn't self-editable, and a person manages only their own subscription.
- Secret settings never leave the server and are never audited. A provider's error messages go to the server log, not to buyers, as they can name the site's account.

Covered by `tests/unit/payments-plugin.test.ts`, `tests/unit/payments-records.test.ts`, `tests/unit/plugin-auth.test.ts` and `tests/integration/payments.test.ts`.

## 8. Plan access (proposed on 2026-11-14)

P6 is built: access, `includes` on plans, entitlements and the `payments_access` user field. P9 is built as the [Subscriptions plugin](/docs/plugins/subscriptions), which runs all of this from one section of the dashboard. P7 is built in the LMS ([the LMS plugin §8.1](/docs/plugins/lms#81-courses-in-plans)). P8 and P10 are next.

**Plans on pricing pages.** Migration `006-plans-on-pricing-pages`, on 2026-11-17, gives plans what a pricing page shows: `title`, `description`, `amount` and `annualAmount` (the monthly and yearly price shown), `currency` and `featured`. The provider still charges the price set with it, so these are for people to read and never decide what anyone pays. A plan with a price and no currency takes Payments' currency when saved. Published plans were already public, so this exposes nothing new.

A subscription should open more than records whose rule names a plan. Sites want "the All courses plan opens every course", "Premium opens these twenty posts", "Club members get these products free" and "a person on two plans gets both". Today:

| Want | What stops it |
|---|---|
| A plan opens courses | Lessons open by enrollment (`@request.auth.lms_courses ?= course`), and enrolling checks only for a purchase |
| A plan opens or discounts products | The Shop prices orders from stored products and never looks at plans |
| A plan opens some posts, not all | Possible with a `premium` boolean and a rule, but each plan needs its own field and rule, so a post can't belong to two plans without rewriting rules |
| Two subscriptions at once | `payments_plan` holds one name |
| A locked post's title and excerpt on the list | Rules decide whole records (C11) |

### 8.1 The approach

Plans grant **access**, and access is data. The owner names what a subscription opens once, as an access, and puts records in it. Plans list the access they include. Rules compare the person's access with the record's, and neither side names a plan, so plans can change without touching rules.

```
payments-plans ──includes──▶ payments-access ◀──included in── any record (field)
       │                          │
 subscriptions,             whole collections
  memberships                (such as lms-courses)
       │
       ▼
payments-entitlements (one record per person) ──mirrored to──▶ payments_access user field ──▶ rules
```

- **`payments-access`**, edited by the owner: `name` ("All courses", "Premium posts"), `description`, and `collections`, the collections it opens whole. Published access is public, for pricing pages.
- **Plans** get `includes`, references to access. One access can be in several plans, such as Premium in both Pro and Team.
- **"Included in"** is a Reference field to Access that allows several, named as the owner likes. Owners add it to any collection like any other field, and P9 adds it for them. It needs no field type of its own: rules compare the record ids it holds.
- **`payments-entitlements`**, one record per person: `user` and `access`, the union of every access their active subscriptions and memberships include, plus the slugs of the collections those open. It's data so other plugins can react to it with a `record.afterUpdate` hook, which they can't do for a user field. Written only by Payments. Each person sees their own.
- **The `payments_access` user field** mirrors it, so rules read it on every request with no lookup. The hook that kept `payments_plan` is now `accessSync` in `shared.ts`, and it computes both. "Active" is unchanged: `ACTIVE_STATES`.

Rules then read:

```
// Records in one of the person's access, or a collection one of them opens whole
(included:length > 0 && included ?= @request.auth.payments_access) || @request.auth.payments_access ?= "blog-posts"
```

`?=` with a list on both sides already means "any of one matches any of the other" (`compare` in `core/authz/rules/evaluate.ts`), so this needs no change to rules. **`included:length > 0` is required**: an empty list compares as `""`, so without the guard a record in no access would match a visitor with no access, who is everyone signed out. Payments writes rules with the guard itself (P9), and the docs never show one without it.

`payments_plan` stays, for rules that already use it. With two subscriptions it names one of them, so rules for people on more than one plan use access instead.

**Why not C7.** A rule on `payments-entitlements` through `@collection` would need C7 to match one row. The user field doesn't: a person's access is a handful of ids, however many records they open. C7 is still needed for gating by purchase (P4), where the list grows with every purchase.

**Trying it in the starter.** Set `TANSY_PLUGIN_PAYMENTS=true` and `TANSY_EXAMPLE_PLAN_ACCESS=true`, and start it. No provider keys are needed. The example (`examples/plan-access`) sets up:

- Access **Premium articles**, and **The whole library**, which opens the Library collection whole.
- Plans **pro**, which includes Premium articles, and **library**, which includes both. Their price ids suit Stripe, and matter only once someone pays.
- **Articles**: "Welcome", in no access, so anyone can read it, and "The premium deep dive", in Premium articles. Its rule is `status = "published" && (included:length = 0 || included ?= @request.auth.payments_access)`, so a record in no access is free on purpose.
- **Library**: "The complete guide", for plans that include The whole library.

Then:

1. Signed out, or as a person with no plan, `GET /api/collections/plan-access-articles/records` lists only Welcome, and the Library lists nothing.
2. Under **Collections → Memberships**, add one as staff, as a provider's webhook would: provider `creem`, any subscription id, the person's user id, plan `pro`, state `active`. Within a second they see the deep dive too, and **Entitlements** shows their access.
3. Change the plan to `library` and they see the Library as well. Under **Plans**, take Premium articles out of `library` and the deep dive closes again for them.
4. Set the state to `canceled` and they're back to Welcome alone.

### 8.2 Keeping it right

| Change | What follows |
|---|---|
| A subscription or membership starts, changes plan or ends | The durable hook recomputes that person's entitlements and user field, as `payments_plan` today |
| A plan's `includes` changes, or an access's `collections` | A durable hook recomputes everyone on that plan, a page at a time. Each page is idempotent, so a retry finishes the job |
| An access is deleted | Removed from plans and entitlements by the same recompute. References to it in records stop matching |
| A record is put in or taken out of an access | Nothing to recompute: the rule reads the record's field |

Each recompute reads the person's subscriptions, plans and access as they are at that moment and writes the whole result, never a change to the last one. So a later event, or a retry of a failed one, always leaves the right list. The entitlements record is written only when it changes, so hooks that follow it see real changes only. A plan or access with many subscribers is recomputed in one hook delivery, a page of 200 at a time.

### 8.3 Sellers

They use the data alone and import nothing from Payments, as LMS does for purchases.

**LMS.** Courses get the "Included in" field. Being in an access is separate from the course's own access, so a paid course can also be in a plan: buy it or subscribe.

- `POST /api/ext/lms/courses/:id/enroll` also enrolls, with source `plan`, someone whose entitlements cover the course: one of the course's access, or `lms-courses`. It reads the course and the entitlements on the server, never from the request.
- A durable `record.afterUpdate` hook on `payments-entitlements` sets the person's `plan` enrollments to `lapsed` when the course is no longer covered, and back to `active` when it is again. Progress, quiz attempts and certificates are kept either way. `lms_courses` already counts only active enrollments, so lessons close on the next request.
- The course page offers "Included in Pro" beside Buy, from published plans and access, which are public.
- `source` gains `plan` through `schema.addOptions`, and `state` gains `lapsed`.

**Shop.** Products get the "Included in" field, and the Shop gets `shop-perks`, edited by the owner: an access, then `discountPercent`, `freeShipping`, and the products or categories it applies to (none means all).

- Pricing on the server reads the buyer's entitlements and applies the best perk per line, never more than one. The order keeps each line's perk, so staff and the buyer see why it cost less.
- A perk at 100% can make an order total 0. The Shop marks that order paid itself, without Payments, only after pricing it on the server, and records which perks made it free. A total of 0 sent from the browser changes nothing, because the total is never read from the request.
- Members-only products use the rule from §8.1 on `shop-products`. The cart refuses a product the buyer can't view, as it does a draft.

**Blog and any collection.** Add "Included in" and set the rule, or have P9 set it. A teaser, with the title and excerpt shown and the body held back, needs C11.

### 8.4 Security

- `payments-access` and plans are edited by staff with `collection:update` on them, as today. `payments-entitlements` and the `payments_access` user field are written only by Payments, aren't self-editable, and show each person only their own.
- A rule that opens records by access must have the `:length > 0` guard (§8.1). P9 writes it, and an integration test checks that a signed-out visitor and a signed-in person with no subscription see none of the gated records, on SQLite and Postgres.
- Cancelling closes access on the next request, because rules read user values every time. The site's own pages follow, through C9.
- LMS and the Shop check coverage from stored data on the server. A course id, perk or total in a request grants nothing.
- Recomputing after a plan changes only ever reads active subscriptions, so it can't open anything to someone who doesn't pay.
- Applying a rule (P9) is a schema change, audited as one, and needs the same permission as editing the collection's rules in the dashboard.

### 8.5 Milestones

| # | Work | Done when |
|---|---|---|
| P6 | `payments-access`, `includes` on plans, `payments-entitlements` and the `payments_access` user field, kept by the durable hooks in §8.2 | Two subscriptions with providers' signed events give a person both plans' access. Cancelling one removes only its access. Editing a plan updates every subscriber's access. A gated post opens and closes with the subscription, and stays closed to visitors. Done on 2026-11-14 |
| P7 | LMS: enrolling through a plan, lapsed and restored enrollments | A subscriber enrolls in a course their plan covers with no purchase, loses its lessons when the subscription ends, and gets them back with their progress when they subscribe again. Done on 2026-11-17 in the LMS plugin |
| P8 | Shop: perks, members-only products, orders free through a perk | A 20% perk lowers the order total on the server. A 100% perk completes an order without a checkout. A non-member can't see or order a members-only product |
| P9 | Dashboard: "Gate with access" on a collection writes the guarded rule, and each access shows what it opens | An owner gates a collection without writing a rule, and the rule written passes the visitor test in §8.4. Done on 2026-11-14 in the [Subscriptions plugin](/docs/plugins/subscriptions) |
| P10 | C11 in core, then teasers in the Blog and lesson previews in LMS | A locked post lists its title and excerpt and never its body, through every way of reading records |

P6 to P9 change the public plugin API only by adding to it: the collections and the user field. P6, P8 and P9 are security changes and say so in their PR. P10 is C11, with its own.

Out of scope: access for organizations, and limits on how much of something a plan allows (five downloads a month). The plan's `limits` stay for a site's own code.
