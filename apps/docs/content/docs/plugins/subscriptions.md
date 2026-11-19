---
title: "Subscriptions plugin (`@tansy/subscriptions`)"
description: "Plan access works through Payments' collections: plans, access, memberships, entitlements, and a rule on every gated collection. Each of those was its own screen, and gating meant writing a rule by hand. This plugin…"
---

Plan access works through Payments' collections: plans, access, memberships, entitlements, and a rule on every gated collection. Each of those was its own screen, and gating meant writing a rule by hand. This plugin puts it in one section of the dashboard, **Subscriptions**, and writes the rules itself.

```ts
// tansy.config.ts
import { payments } from "@tansy/payments";
import { stripe } from "@tansy/payments-stripe";
import { subscriptions } from "@tansy/subscriptions";

plugins: [
  payments({ siteUrl: "https://example.com", providers: [stripe()] }),
  subscriptions(),
]
```

Payments must come first, at 0.3.0 or later: the plugin's migration stops startup with a clear message otherwise. In the starter, `TANSY_PLUGIN_PAYMENTS=true` and `TANSY_PLUGIN_SUBSCRIPTIONS=true`.

## 1. The approach

It owns no data. Plans, access, memberships and entitlements stay Payments' collections, so everything Payments does keeps working: webhooks, the Subscribe and Billing buttons, `payments_access` in rules, and other plugins following entitlements. The plugin is the management on top:

| Page | What it does |
|---|---|
| **Overview** | People per plan, what each plan opens, and the next step for a site that's just starting |
| **Plans** | Add and edit a plan on one screen: name, the provider's price ids, a trial, what a pricing page shows (title, description, monthly and yearly price, featured), whether it's on sale, and ticks for the access it opens |
| **Access** | Add and edit access, see which plans include each, and gate collections |
| **Members** | Everyone on a plan, paid or given, with a search. Give someone a plan for free, until a date or with no end, and end it |

Pages read and write as the signed-in person, through the records API and core's collection API, so the same permissions, rules and audit apply as anywhere else. Nothing reaches the database another way.

## 2. Gating a collection

Under **Access → Gate a collection**, choose a collection and how:

- **Some records.** Adds an **Included in** field, a Reference to Access that allows several, and adds to the list and view rules: `included:length = 0 || included ?= @request.auth.payments_access`. A record in no access stays as open as it was. Put a record in an access and only plans that include it open it.
- **The whole collection.** Adds the collection to the chosen access's `collections`, and adds to the rules: `@request.auth.payments_access ?= "<slug>"`.

The gate is added with `&&` after the rule as it was, so it only ever takes access away: a draft stays hidden, and a rule's own conditions still apply. A locked rule stays locked. **Remove gate** takes off exactly what was added, and nothing an owner wrote. The rule is written as `(<old rule>\n) && (<gate>)`. The newline ends a trailing `//` comment, which would otherwise swallow the gate.

It uses `PUT /api/collections/:id/fields` and `PUT /api/collections/:id/rules`, which need `collection:update` and `collection:manage-rules`, a recent sign-in, and are audited. Payments' own collections and collections only staff can read aren't offered.

## 3. Free plans

**Members → Give a plan** makes a membership in `payments-memberships` with provider `manual`, as a provider's webhook would. Payments works out the person's access from it like from any other, so it opens the same things. A job every 15 minutes ends free plans whose date has passed, and **End** ends one now. Only free plans can be ended here: a paid subscription ends with the provider, or Payments would disagree with it.

| Route | Access | |
|---|---|---|
| `GET /api/ext/subscriptions/members` | `ext.subscriptions:manage` | Everyone with entitlements or a free plan, with their email |
| `POST /api/ext/subscriptions/grant` | `ext.subscriptions:manage`, audited as `subscriptions.grant` | Body `{ email, plan, until? }`. The person must have an account |
| `POST /api/ext/subscriptions/grants/:id/end` | `ext.subscriptions:manage`, audited as `subscriptions.end_grant` | Only memberships with provider `manual` |

## 4. Who can use it

The pages need `ext.subscriptions:manage`. The plugin creates a **Subscriptions manager** role once, which owners change under Roles like any other: that permission, list and edit on plans and access, read on entitlements and memberships, and `collection:update` and `collection:manage-rules` for gating. Changing rules is a strong permission: give the role to people you'd let edit collections.

## 5. Security

- The plugin adds no way around rules: every page reads and writes as the person, and gating goes through core's audited collection API.
- A gate can only add a condition. Tests check that a gated rule keeps what it required, that visitors and people with no plan see only records in no access, and that removing a gate gives back the exact rule.
- Free plans are written only by the plugin's routes, behind its permission, and audited with the person and plan. They name a user found by email, never one from the request.
- Ending a grant refuses memberships from a provider.

Covered by `tests/unit/subscriptions-plugin.test.ts` and the Subscriptions part of `tests/integration/payments.test.ts`.
