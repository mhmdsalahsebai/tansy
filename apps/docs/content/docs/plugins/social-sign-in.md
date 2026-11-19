---
title: "Social sign-in plugin (`@tansy/social-sign-in`)"
description: "Sign in with Google, GitHub, Microsoft, GitLab, Discord or Facebook. Each one is turned on and given its keys on the dashboard, so the same build serves a site using none of them and a site using all six."
---

Sign in with Google, GitHub, Microsoft, GitLab, Discord or Facebook. Each one is turned on and
given its keys on the dashboard, so the same build serves a site using none of them and a site using
all six.

```ts
// tansy.config.ts
import { socialSignIn } from "@tansy/social-sign-in";

plugins: [socialSignIn()]
```

The plugin takes no options. It offers the six providers to core's `auth.oauthProviders` slot;
whether any of them appears on a sign-in form is a settings decision, not a code one. Remove the
line to offer none.

## 1. Setting a provider up

**Dashboard → Settings → OAuth** lists every provider a plugin has offered. For each one you want:

1. Copy the callback address the page shows and register it with the provider.
2. Paste the **client ID** and **client secret** it gives you back.
3. Turn the provider on.

A provider cannot be enabled until both its client ID and its secret are filled in, so nothing
half-configured ever reaches a sign-in form. The secret is stored as a secret setting: encrypted,
never sent back to the browser, and never written to the audit log. Enabled providers appear on the
sign-in form, and `GET /api/auth-config` lists them so a headless front end can show the same
buttons.

Whether a first-time visitor signing in through a provider gets an account at all follows
**Settings → Sign-up**: with sign-up off, only people who already have an account can use these
buttons.

## 2. A provider that isn't listed

The six above are the ones better-auth has built-in support for. For anything else, better-auth's
generic OAuth plugin goes in a plugin of your own through `auth.plugins` — a few lines, and it needs
nothing private. See "Plugins" in [Extending Tansy](/docs/extending).

## 3. Limits to know

- Sign-in and account linking only. The plugin reads no profile beyond what an account needs, and
  imports no contacts, avatars or organisation membership.
- Which role a new account gets is core's business: the default role under **Settings → Sign-up**.
  A provider cannot map its own groups onto CMS roles.
- No SAML and no OIDC discovery. For an identity provider of that kind, write a small plugin around
  better-auth's own support for it.
- Keys live in settings rather than in environment variables, because which providers a site uses is
  a runtime decision like the rest of the schema.
