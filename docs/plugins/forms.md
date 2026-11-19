# Forms plugin (`@tansy/forms`)

## 1. What it tests

Contact forms are the most common need on a marketing site. They are also the first plugin where **visitors write signed out**: every other plugin's writes come from signed-in people or the server. So Forms tests anonymous writes under rate limits, spam protection, and email to the owner with the visitor as reply-to.

```ts
// tansy.config.ts
import { forms } from "@tansy/forms";

plugins: [forms({ notify: "hello@example.com" })]
```

The starter turns it on with `TANSY_PLUGIN_FORMS=true`, and `TANSY_FORMS_NOTIFY` for the addresses.

## 2. Collections and blocks

| Collection | Rules | |
|---|---|---|
| `forms-forms` | View: `status = "published"`. List, create, update, delete: locked | A form: `title`, `fields` (a stream), `submitLabel`, `successMessage`, `notify` (hidden), `captcha` |
| `forms-submissions` | All locked | `form`, `email`, `data` (JSON, by field name), `page`, `state` (new, done, spam) |

A form's `fields` stream takes the plugin's field blocks: **Short answer** (`forms_text`), **Email**, **Long answer**, **Choice** (one option per line), **Checkbox** (required means it must be ticked, as for consent) and **Number**. Each has a `name`, the key its answer is stored under, a label, help text and whether it's required. Two fields with the same name are refused when the form is saved. They're the plugin's own blocks, so the server knows how to check each answer.

The **Form** block (`forms_embed`) puts a published form on any page. A form also renders on its own page if the owner gives the collection a URL pattern.

## 3. Sending a form

The block's component, `FormView` from `@tansy/forms/render`, uses two public routes. A headless site renders it with `api="https://cms.example.com/api"`.

| Route | |
|---|---|
| `GET /api/ext/forms/forms/:id` | The form as the caller may read it, by the view rule. Its fields, button label, the CAPTCHA's public widget or `null`, and a signed token. Never `notify`. Not cached |
| `POST /api/ext/forms/forms/:id/submit` | `{ values, token, answer?, website?, page? }`. Checks in this order, then keeps the submission |

1. **The form**: read through the view rule as the caller, so a draft or missing form is the same 404.
2. **The trap**: `website` is a field people never see. When it's filled in, the route answers as if it worked and keeps nothing, so the script learns nothing.
3. **Time**: the token is an HMAC of the form id and when it was handed out, with a key kept in the plugin's store. Anything sent sooner than **Forms → Settings → Fastest a person fills in a form** (3 seconds) is refused with `TOO_FAST`. A token that isn't ours, is for another form or is a day old is `FORM_EXPIRED`, and the form fetches a new one.
4. **The answers**: checked against the form's own fields: required, length, email, one of the options, number range. Anything the form doesn't ask is dropped, so a submission holds only what the owner asked for. Problems come back by field as `INVALID_ANSWERS`.
5. **The CAPTCHA**: when the form asks for it and one is set up (see [the CAPTCHA plugin](captcha.md)), checked after the answers, since an answer works only once.
6. **Rate limit**: 5 sends per 10 minutes per address and form, through the route guard, counting refused ones too.

The submission is written with `system.records`, audited as `forms.submit` with its id, never its content.

## 4. Email

A `record.afterCreate` hook on submissions emails each address in the form's `notify`, or else in **Forms → Settings**, at most ten. The body is plain text, each question and its answer. Reply-to is the visitor's address, from the form's first email field, so the owner just replies. Hooks are durable, so a crash between saving and emailing doesn't lose the notification.

The visitor is never emailed. A confirmation to whatever address someone types would let anyone use the site to send mail to strangers.

**Forms → Overview** warns when email isn't set up (`mail.ready()`), or no CAPTCHA is: submissions are still kept either way.

## 5. Settings

| Setting | Default | |
|---|---|---|
| Email submissions to | `notify` in the options | For forms that don't name their own |
| Fastest a person fills in a form | 3 seconds | 0 turns it off |
| Delete submissions after | 0, never | A daily job removes older ones |

Nothing about the visitor is kept beyond what the form asks and the page it was sent from: no IP address and no user agent.

## With tenants

With the multi-tenant plugin (or another row scope provider), each tenant keeps its own data. Notifications, the minimum seconds before a submission and how long submissions are kept can differ per tenant, and forgetting old submissions runs in each one.
