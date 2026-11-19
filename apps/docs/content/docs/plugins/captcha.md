---
title: "CAPTCHA plugin (`@tansy/captcha`)"
description: "A CAPTCHA guards two kinds of form: the sign-in forms core owns, and the forms plugins add, such as a contact form or a comment form. Both use one setup. Core has a slot for it, auth.captcha, as it has auth.mail for…"
---

## 1. The approach

A CAPTCHA guards two kinds of form: the sign-in forms core owns, and the forms plugins add, such as a contact form or a comment form. Both use one setup. Core has a slot for it, `auth.captcha`, as it has `auth.mail` for email:

- core asks for an answer on the sign-in forms the adapter names, and shows the widget on them
- every plugin gets `context.captcha`, to show the widget on its own forms and check the answer, without knowing which plugin or provider supplies it

As with Email and Payments, there's one core plugin and one small adapter package per provider:

| Package | Provider | Keys (environment variables) |
|---|---|---|
| `@tansy/captcha-turnstile` | Cloudflare Turnstile | `TURNSTILE_SECRET_KEY`, and the site key in the settings or `turnstile({ siteKey })` |
| `@tansy/captcha-hcaptcha` | hCaptcha | `HCAPTCHA_SECRET`, and the site key |
| `@tansy/captcha-recaptcha` | Google reCAPTCHA v2 (the checkbox) | `RECAPTCHA_SECRET_KEY`, and the site key |

```ts
// tansy.config.ts
import { captcha } from "@tansy/captcha";
import { turnstile } from "@tansy/captcha-turnstile";

plugins: [captcha({ providers: [turnstile()] })]
```

Then, under **Extensions → CAPTCHA**, choose the provider, paste its site key and secret, and choose the sign-in forms that ask for it.

**Why not better-auth's `captcha` plugin.** The example used it. It only guards better-auth's own endpoints, so a contact form or comment form couldn't use it, and its providers are fixed in better-auth. Core now checks sign-in answers itself, through the same adapter plugins use, on the raw request before better-auth routes it, as better-auth's plugin does.

## 2. Settings

| Setting | Default | |
|---|---|---|
| Provider | The first one listed, or `provider` in the options | |
| Ask on sign-in | On, or as `authForms` in the options says | Password sign-in only. Lockout after failed attempts applies either way |
| Ask on sign-up | On | |
| Ask on password reset | On | |
| Each provider's site key | Empty, or `siteKey` in its options | Public: it reaches every visitor |
| Each provider's secret | Empty | A `secret` setting: encrypted, never sent back, never audited. Its environment variable wins |

Until the chosen provider's site key and secret are both set, nothing asks for a CAPTCHA, so installing the plugin before entering keys locks nobody out.

## 3. How a form uses it

**Sign-in forms.** `GET /api/auth-config` answers `captcha: { widget, forms }`, or `null`. The dashboard's forms show the widget on the forms listed, and send the answer as the `x-captcha-response` header. A headless site does the same with `CaptchaWidget` from `tansy/react`. A request without an answer gets 400 `CAPTCHA_REQUIRED`, and a refused one 403 `CAPTCHA_FAILED`.

**A plugin's own forms.** A route reads `context.captcha.widget()`, which is `null` when no CAPTCHA is set up, and hands it to the browser. The browser renders `<CaptchaWidget config={widget} onAnswer={...} />` and sends the answer with the form. The route then calls `context.captcha.verify(answer, { ip: context.ip })`. See the Forms plugin.

## 4. Security

- The secret stays on the server. The widget carries the provider's script address, its global, the site key and plain options only. Core checks it before it reaches a browser: an https script, a global that's a plain name and a site key with no markup. Anything else shows no widget and is logged.
- An answer is checked with the provider every time, and works once: providers refuse a reused one. The address passed is the client IP from **Settings → Network**.
- Anything other than `success: true` refuses: an error status, a redirect, a timeout, an answer that isn't JSON. What the provider said beyond that is never logged.
- An adapter whose `verify` throws refuses, and one whose `authForms` throws asks on every sign-in form, so a broken plugin fails closed.
- The providers' origins go into the Content Security Policy as exact origins, for frames and connections. Their scripts load through the page's nonce under `'strict-dynamic'`.

## 5. Adapters

An adapter is about twenty lines: its settings, which all start with its id, whether it's ready, its widget, its siteverify call and its origins. Turnstile, hCaptcha and reCAPTCHA share both the browser side (a global with `render` and `reset`) and the server side (a form post answered with `success`), so `siteVerify` from `@tansy/captcha/provider` does the call. A provider that works differently implements `verify` itself.

reCAPTCHA v3 gives a score instead of a checkbox, and needs an action per form, so it isn't covered by this flow. It would be its own adapter with a score setting.
