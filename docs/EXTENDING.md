# Extending Tansy

Four ways in, from no code to full code. Read the security model first: extensions run as trusted server code.

| Tier | What | Needs a rebuild? |
|---|---|---|
| Dashboard | Collections, blocks, rules, webhooks | No |
| `cms_hooks/` | Record hooks, routes, jobs | No |
| Plugins | Field types, blocks, permissions, admin pages, plus everything above | Yes |
| External | REST, realtime, webhooks, SDK, OpenAPI, MCP | No |

## Hook files

Every `.ts`, `.mts`, `.js` or `.mjs` file directly inside `cms_hooks/` (or `TANSY_HOOKS_DIR`) is loaded at startup and again when saved. Node runs them directly and strips TypeScript types, so only type syntax Node can strip is allowed, and `@/` imports don't work. Names starting with `_` or `.` are skipped, which suits helper files.

```ts
import type { CmsHooks } from "tansy/plugin";

export default (cms: CmsHooks) => {
  cms.on("record.beforeCreate", ({ collection, values, reject }) => {
    if (collection.slug === "posts" && values.title === "") reject("A title is required.", "title");
  });

  cms.on("file.afterUpload", async ({ data, store }) => {
    await store.set("last-upload", data.file.name);
  });

  cms.on("record.afterUpdate", async ({ record, system }) => {
    await system.records.create("activity", { title: `Updated ${record.id}` });
  });

  cms.route({ method: "GET", path: "/stats", access: "permission", permission: "record:list", apiKey: true, handler: ({ records }) => records.list("posts", { perPage: 1 }) });

  cms.job({ name: "nightly", cron: "0 3 * * *", handler: async ({ system }) => { /* ... */ } });
};
```

A file that fails at startup stops the server. One that fails on a later save keeps its previous version running, and the error shows under **Dashboard → Extensions**. Only the saved file reloads, so re-save the entry file after changing a helper it imports. Create `cms_hooks/` before starting the server, or it won't be watched.

### Record hooks

| Event | Can | Runs |
|---|---|---|
| `record.beforeCreate`, `record.beforeUpdate` | Change `values`, return replacements, or `reject()`. `can(permission)` says whether the writer holds a permission | After the rule check and validation, before the transaction |
| `record.beforeDelete` | `reject()` | Before the transaction |
| `record.afterCreate`, `record.afterUpdate`, `record.afterDelete` | React. `record` is the record as written. On `afterUpdate`, `previous` is the record as stored before the write, so a hook can tell "just became paid" from any other update | After commit, off the request. Retried until they succeed |

Whatever a before-hook leaves in `values` is validated again. A before-hook that throws or takes over 10 seconds stops the write. Hooks that keep triggering each other stop after four levels.

After-hooks are durable. Each write saves its after-hook events in its own transaction, so a crash can't lose one, and they run right after the commit. One that throws or takes over 60 seconds is retried after 10 seconds, 1 minute, 5 minutes, 30 minutes, 2 hours, then every 6 hours for about three days, across restarts. If it still fails it shows under **Dashboard → Extensions → Hook failures**, where someone with `setting:update` can run it again once the cause is fixed. So an after-hook can run more than once for one write, and must be safe to repeat: check whether its work is already done, or use `store.claim` or a conditional update. A retry gets the record as it was written, not as it is now, and hooks for different writes don't wait for a failing one.

Hooks fire for every record write, including the dashboard, batch requests, restores and scheduled publishing.

### Other events

These run after commit and off the request, so a failure is only logged. Each receives `data`, which never holds file contents, passwords or tokens.

| Event | `data` |
|---|---|
| `file.afterUpload`, `file.afterDelete` | `file`: id, name, type, size, createdById |
| `schema.afterCreate`, `schema.afterUpdate` | `collection`: id, slug, name |
| `schema.afterDelete` | `collection`: id, slug |
| `auth.afterSignUp` | `user`: id, email |
| `auth.afterSignIn`, `auth.afterSignOut` | `user`: id |
| `plugin.afterInstall`, `plugin.afterUpgrade` | `plugin`: name, version, and `previousVersion` on an upgrade |

There are no hooks that change what a read returns. They could put hidden fields back.

### Routes

A hook file's routes are served at `/api/ext<path>`, and a plugin's at `/api/ext/<plugin><path>`. `:name` segments become `params`. A plugin declares a root file with `root: true` on a route for a single file name, such as `/sitemap.xml`. It's then also served at the site root, when no page or static file has that name. A hook file's single-file route is served there without declaring it.

A handler also gets `ip`, the caller's address from the client IP header under **Settings → Network**, or `null`. Each route states `access`: `"public"` with a `reason`, `"authenticated"`, or `"permission"` with a `permission`. A write that isn't public must name an `audit` action. `body` and `query` take Zod schemas. Routes go through the same guard as built-in ones, including CSRF checks, rate limits and `fresh`. API keys are refused unless `apiKey: true`.

### Jobs

Five-field cron in UTC. A run still in progress is skipped, on this server or another. A job that missed its time, because the server was stopped or the host only calls the background endpoint now and then, runs once when background work next runs, up to seven days late. The last result shows under **Dashboard → Extensions**. The handler's second argument says how long the run may take: on a host that stops functions after a time, such as Vercel, `deadline` is when this pass must be done, and a long job does what fits in `timeLeft()` and carries on in its next run. On a server that stays up, `deadline` is `null`. For work a route starts and that should outlast the response, use `afterResponse(label, (pass) => ...)` from `tansy/plugin`, which keeps the function alive on such hosts. See [Background work](guides/background-work.md). With a row scope provider installed, such as the multi-tenant plugin, `perScope: true` also runs the job once inside each active value, after the run outside any, so its `store`, `records` and settings are that value's: use it for work kept per tenant, such as a queue in the store. One value failing doesn't stop the others, and the run is marked failed with the first error.

### Words on a site

A render module gives its site words as `messages`, by language, in ICU MessageFormat, nested under the plugin's name. `tansy sync` refuses words under any other name:

```tsx
export default defineRenderers({
  templates: { "shop-products": Product },
  messages: { en: { shop: { addToCart: "Add to cart" } }, ar: { shop: { addToCart: "أضف إلى السلة" } } },
});
```

A theme's words, then the owner's under **Languages → Site text**, win over a plugin's key by key, so either can word a plugin's page differently. Templates get `t`, `formatDate` and `formatNumber` in the page's language, and `words`, the same words as plain data. Blocks get `words` too. A client component can't take functions as props, so pass it `pickWords(words, "shop")` and call `siteWords(words)` inside it for `t()`. Keep the messages in a module with no imports, so client components can read them without pulling in server code. Without `words`, as with a theme written before them, `siteWords()` knows only English.

Links and record reads follow the page's language: `sitePath(words, "/cart")` is `/ar/cart` on an Arabic page, and `contentLocale(words)` is the `locale` to pass to the records API, or `undefined` on a site with one language. `<Pager>` takes `words` and the plain `path`.

For an email, `wordsIn(messages, locale)` from `tansy/plugin` gives `t()` in that language, falling back to English. Write to a customer in the language they used, such as the one stored on their order, and to a person in `system.users.get(id)`'s `locale`.

### What handlers receive

- `records`: list, get, create, update and delete under API rules. In a route that means as the caller, elsewhere as a signed-out visitor.
- `update(slug, id, data, { if: { status: "pending" } })` is a conditional update: it writes only while the stored record still has those values, checked in the same SQL statement, and returns `null`, writing nothing, when it doesn't. Of any number of writers racing from the same state, exactly one matches, which a before-hook can't guarantee because it runs outside the transaction. Conditions take text, number, boolean and select fields the caller can read, and `status`, compared exactly, with `null` for no value.
- `system.records`: the same calls ignoring rules and including hidden fields. Writes are audited under the plugin's or hook file's name, such as `plugin:seo`. Never return its results to a caller unchecked. `create(slug, data, { owner: userId })` makes that user the record's creator, so own-record grants such as `update:own` cover it. Only `system.records` accepts `owner`.
- `system.users`: `get(userId)` and `findByEmail(email)` return `{ id, name, email, locale }` or `null`, for emailing someone or naming them on something issued to them. `locale` is the language to write to them in: the one they chose, else the site's default. Read-only. Then `getValues(userId)` and `setValues(userId, values)` on custom user fields, which rules read as `@request.auth.<name>`. A plugin reaches only fields named with its prefix, such as `lms_courses` for `lms`, and a hook file reaches them all. `getValues` includes hidden fields and returns `null` for a user that doesn't exist. `setValues` changes only the fields named, with `null` clearing one, validates like the dashboard's form, and is audited under the plugin's name with the field names but never the values. It refuses a field users can edit themselves, because a rule relying on it would then rely on whatever the user typed. Rules see a new value on the user's next request.
- `store`: `get`, `set`, `delete` and `list(prefix)` on a key-value store only this plugin or hook file reads. With a row scope provider, work in a value, such as one tenant's request, reads and writes that value's own keys, and work outside any, including jobs without `perScope`, the instance's. `claim(key, value)` stores the value only if the key is absent and returns whether this call stored it, so of concurrent claims exactly one gets `true`: use it to handle a provider's webhook event once. For data people edit, declare a collection instead.
- `mail.send({ to, subject, body, action, replyTo, locale })`: email through the site's mail settings. `locale` names the language your text is in, so the email reads right to left where it should; nothing is translated for you. `body` is plain text with blank lines between paragraphs, `subject` is one line, and `action` is a button whose `url` must be http or https. `replyTo` is one address replies go to, such as the visitor who filled in a form. A message that breaks these rules throws. A valid one is queued, so a slow mail server never holds up a hook, and a failed delivery is only logged. The audit log records the recipient and the sender, never the content. `mail.ready()` says whether anything can deliver it: an email plugin that's set up, or SMTP. Without either, mail is only written to the log, so a plugin can warn its owner.
- `mail.sendBatch(emails)`: up to 100 emails of the same shape as `mail.send`'s, sent now rather than queued, returning `{ ok, id? }` or `{ ok: false, error }` for each in order. Every one is checked before any is sent, so one bad address throws for the whole batch. For mail to a list, such as a newsletter: give each email `unsubscribe: { url, oneClick?, label? }`, which adds a footer link and `List-Unsubscribe` headers (with `List-Unsubscribe-Post` when `oneClick`, an https URL that unsubscribes on a POST with any body). Either call takes `richText`, a rich text document, in place of `body`. One audit entry per batch records the counts, never an address.
- `captcha.widget()` and `captcha.verify(answer, { ip })`: the site's CAPTCHA, from whichever plugin supplies one (see [the CAPTCHA plugin](plugins/captcha.md)). `widget()` is public and goes to the browser, which renders it with `CaptchaWidget` from `tansy/react`. It's `null` when none is set up. `verify` is `false` for a refused answer, an unreachable provider, or no CAPTCHA at all, so check `widget()` first to know whether to ask.
- `schema.describe(slug)`: a collection's name, type, URL pattern and fields, as **Dashboard → Schema** exports them, or `null` when there's none. It's read-only. Owners can change collections at any time, so check a field is there before relying on it.
- `schema.languages()`: the site's public languages, the default first, and `href(path, locale)`, a site address in a language: `/fr/blog/x`, or `https://fr.example.com/blog/x` with a domain per language. One item on a site with one language. `records` calls take `locale` (and `fallback: "none"` to skip fallbacks) in their query or options, so a plugin can read or write one language.
- `settings.get()`: a plugin's settings, as saved in the dashboard, with each field's default for any that weren't. See [Settings](#settings). A hook file has none, so it gets `{}`.
- `scope`: the row scope value the work is in, for plugins that keep things per tenant. `value()` is the value, or `null` outside any. `bind(fn)` returns `fn` carrying the current value, for work that runs later, such as a timer or a queue written from a job. `siteUrl()` is the value's own site address, from the provider's `siteUrl`, or `null`: use it in emails and feeds before the site's own. `data.usage(value)` counts a value's records, files and bytes. `data.export`, `data.import` and `data.purge` are for the provider plugin alone and throw for any other.

## Plugins

To start one, follow [Write and publish a plugin](guides/plugins.md) or [Build a custom field](guides/fields.md). This section is the reference.

A plugin is one package with one manifest. To install it, run `npm i` and add one line to `tansy.config.ts`, then rebuild. To turn it off, remove the line and rebuild.

```ts
// @acme/cms-seo
export const seo = (options: SeoOptions) => definePlugin({
  name: "seo",
  version: "1.2.0",
  apiVersion: 1,                          // the plugin API it was built for
  requires: { cms: "^1.0.0" },            // a mismatch stops startup with a clear message
  admin: { server: "@acme/cms-seo/admin", client: "@acme/cms-seo/client" },
  csp: { img: ["https://images.example.com"] },
  options: { schema: optionsSchema, value: options },   // checked at startup
  settings: { fields: [{ name: "titleLength", type: "number", default: 60, label: "Title length" }] },   // changed in the dashboard
  auth: { checkPassword },                // see "Core and plugins" below
  permissions: { "ext.seo": ["read"] },   // shown in the role editor
  fields: [seoTitleField],                // defineField
  blocks: [seoFaqBlock],                  // created at startup, updated when changed
  hooks: { "record.beforeCreate": fillTitle },
  routes: [sitemapRoute],
  jobs: [{ name: "seo.report", cron: "0 3 * * *", handler }],
  migrations: [{ id: "001-collections", up: ({ schema }) => schema.apply(document) }],
  contract: { "seo-redirects": { from: "text", to: "text" } },   // fields the plugin's code relies on
});

// tansy.config.ts
plugins: [seo({ siteUrl: "https://example.com" })]
```

Field types and blocks start with the plugin's name, with hyphens as underscores: plugin `seo` owns `seo_title` and `seo_faq`. Options are code. Secrets go in `secret` settings, which an environment variable can override.

### The admin half

`admin` holds module paths as strings, so the server never imports React. `tansy sync` turns them into import maps in `.tansy/`, which is generated and gitignored. It runs by itself in `next dev` and `next build`, and a build fails if it can't. Run `tansy sync` yourself to refresh types, or `tansy sync --check` in CI. A dashboard page stops with a message if a running plugin isn't in the maps.

`admin.server` exports server components, with `defineAdminPlugin`:

| Slot | What it adds | Permission |
|---|---|---|
| `pages` | A page at `/dashboard/ext/<path>`, and a link to it | Optional |
| `widgets` | A card on the dashboard | Optional |
| `navItems` | A navigation link to any admin path | Required |
| `section` | The plugin's own entry in the navigation, opening to its pages, collections and settings | Per item |
| `shortcut` | An icon button at the end of the top bar that opens one of its `pages`, such as the AI assistant: `{ page: "ai", title: "Ask AI", icon }` | The page's |
| `switcher` | A choice in the top bar that applies to every page, such as the tenant someone works in: `{ label: "Tenant", options: "/switcher", select: "/switcher" }` | Optional |
| `accountPanels` | A card on the account page, which anyone signed in can open, staff or not: `[{ id, component }]` | None |

A `switcher` names two of the plugin's own routes. `options` is a GET route answering `{ current, options: [{ value, label }] }`, where a `value` of `null` means none, and `select` a POST route that receives `{ value }`. The dashboard shows it only when `options` returns a choice, and reloads after one, since every page can depend on it. Startup logs and leaves it out when either route is missing. The routes check for themselves, as the multi-tenant plugin's do.

`accountPanels` are server components that receive `user`, for what concerns the person themself, such as an invitation they haven't accepted yet. They need the host's account page to pass the admin config, as `tansy init` writes it: `createAccountPage(config, admin)`. An entry written before that has no panels.

A page's `path` can hold `:name` segments, such as `lms/courses/:id`. They reach the component as `params`, which are untrusted, and such a page has no link of its own. A page with `collection: "<slug>"` also needs permission to list that collection's records, all of them or only one's own, so a page for instructors who hold only own-record grants can still open for them.

#### A section in the navigation

A plugin that's more than a page or two gets its own entry, as the blog and LMS do. It opens to its items, in order, and each shows only to someone who may open it:

```tsx
export default defineAdminPlugin({
  pages: [
    { path: "lms/courses", title: "Courses", collection: "lms-courses", component: Courses },
    { path: "lms/courses/:id", title: "Course", collection: "lms-courses", component: Builder },
  ],
  section: {
    title: "LMS",
    icon: "academic",                       // or newspaper, book, or any of the navigation's own icons
    items: [
      { page: "lms/courses" },              // one of this plugin's pages
      { collection: "lms-enrollments" },    // a collection's records, for anyone who may list them
      { settings: true },                   // the plugin's settings form
    ],
  },
});
```

`icon` is one of the navigation's own names, or the plugin's own icon as SVG path data, drawn in the navigation's colour: `{ paths: ["M5 4a3 3 0 0 1 6 0…"], viewBox: "0 0 16 16", fillRule: "evenodd" }`. It's data, not a component, because the navigation runs in the browser. Paths that aren't plain path data are ignored, and the default icon shows. The shop's shopping bag is an example.

Pages a section names leave the shared Plugins group. Collections whose slug starts with the plugin's name and a hyphen are listed under its title on the Collections page, so the owner still finds them, and can still change them like any other.

#### Settings

`options` are code: a change means a rebuild. `settings` are what people running the site change in the dashboard, under the plugin's section or from **Extensions**. Take your options as their defaults:

```ts
settings: {
  permission: "ext.lms:manage",             // "setting:update" when left out
  fields: [
    { name: "passingScore", type: "number", integer: true, min: 0, max: 100, default: value.passingScore, label: "Passing score (%)" },
    { name: "certificates", type: "boolean", default: value.certificates, label: "Issue certificates" },
    { name: "comments", type: "select", default: "moderated", label: "Comments", options: [{ label: "Held for review", value: "moderated" }, { label: "Off", value: "off" }] },
    { name: "notify", type: "text", default: "", maxLength: 320, label: "Email for comments to review" },
    { name: "apiKey", type: "secret", env: "ACME_API_KEY", label: "Acme API key" },
  ],
},
```

Read them with `await context.settings.get()` wherever they apply, so a change takes effect on the next request. The form is generated and validated on the server against these fields. A saved value that no longer fits its field, such as after you tightened `max`, falls back to the default. A bad declaration stops startup. Whoever holds the permission sees every value except `secret` ones. A `secret` is stored encrypted, never sent back to the dashboard (it only shows whether one is set), and never audited. It has no default, and when `env` names an environment variable that is set, that value wins and the field is shown as set by it. `context.settings.get()` returns secrets in the clear, so never return them to a caller.

With a row scope provider installed, such as the multi-tenant plugin, mark a field `perScope: true` when each value, such as a tenant, can have its own: an analytics site id, a greeting, a sender name. Someone with the settings permission working in a value saves its own values for those fields, and the others change for everyone. Only a value that differs from the instance's is kept, so the rest follow the instance's as it changes. `context.settings.get()` returns them layered for the scope value the work is in. Settings a better-auth plugin is built from apply instance-wide, since better-auth is built once for the instance.

A `text` setting can offer choices it doesn't limit itself to, such as the models a provider lists, with `suggestions: { route: "/models", with: ["provider"] }`. The form calls that GET route of the same plugin, with the unsaved values of the settings named in `with` (never secrets) as query parameters, and offers the `{ options: [{ value, label? }] }` it returns while still taking any text. The route states its own access, usually the settings permission, and reads keys from the saved settings. A route that isn't one of the plugin's GET routes stops startup.

`admin.client` reaches the browser, so keep server code out of it. It exports `defineAdminClient`:

| Slot | What it adds | Permission |
|---|---|---|
| `fieldAdmin` | A field's form control, grid cell and look on a block's canvas, with `defineFieldAdmin` | None |
| `authWidgets` | A component on the sign-in, sign-up and reset forms | None |
| `recordPanels` | A panel under the record form, which can change the form's fields with `setValues`. Nothing is saved until the person saves | None |
| `fieldActions` | A button or your own control by a field in the record form, which can change that field with `setValue`. `types` limits it to field types | Required |
| `gridColumns` | A column in the record grid | Required |
| `recordActions` | A button on each row of the grid | Required |
| `bulkActions` | A button shown when rows are selected | Required |
| `settingsTabs` | A tab under Settings | Required |
| `blockActions` | A button on a block in the stream editor | Required |
| `blockEditors` | How a block looks and is edited on the canvas | None |

A permission only decides what to offer. The route a slot calls still has to check for itself. Everything a plugin renders is inside an error boundary, so a broken plugin costs its own slot and not the page. `gridColumns`, `recordActions`, `bulkActions` and `fieldActions` take `collections`, and `blockActions` takes `blocks`, to limit where they appear.

Admin components are styled with the classes in `styles/`, such as `cms-btn`, `cms-input` and `cms-panel`, and colours and spacing come from `--cms-*` tokens. Use those and a plugin follows the brand colour and dark mode. Put your own CSS in the `cms.overrides` layer.

A config that switches a plugin on at run time, such as from an environment variable, has to list it during `tansy sync` or its admin code won't be in the build. `tansy sync` sets `TANSY_SYNC=true` while reading the config, so test for that as well, as `apps/starter/tansy.config.ts` does.

### Field types

`defineField` needs `type`, `admin`, `config`, `value` and `storage`. These are optional:

| Option | What it does |
|---|---|
| `normalize(value, config)` | Tidies a submitted value before validation. It must accept anything, and leave a normalized value unchanged |
| `refs(value, config)` | Declares records and files held inside the value: `{ records: [{ collection, id }], files: [id] }`. `collection` is an id or a slug |
| `search(value, config)` | The words to index. Without it, strings and lists of strings are indexed |
| `summary(value, config)` | One line for the record grid and revision diffs |
| `operators` | The filter operators callers may use on this field. `[]` makes it unfilterable. Rules aren't limited |
| `version`, `upgrade` | Change a value's shape: raise `version` and add a step keyed by the version it starts from, such as `{ 1: (value) => ({ ...value, label: value.title }) }` |
| `localizable: false` | For a value that means the same in every language, such as a colour or a coordinate. The field then can't be marked localized on a collection's schema. No built-in type opts out: even a reference or a file can differ per market |

`refs` links get every check a built-in reference or file field gets, at any block depth: a record has to exist and then can't be deleted while linked, `?expand=<field>` returns a list that passes each target's view rule, and a writer can attach only files they're entitled to. Deleting a whole collection that values link to isn't blocked, because the schema can't see inside values. Those links then expand to nothing, and the next save of that value is refused.

Upgrades run once at startup, over every stored value including inside blocks, and each result must pass `value`. A step that fails stops startup with the record named, nothing is lost, and the next start resumes where it stopped. Revisions aren't rewritten, so restoring one from before an upgrade can fail validation. A type with `version` above 1 can't be used for user fields.

Leave out `admin.input` when `defineFieldAdmin` supplies the control. `Input` receives `id`, `field`, `value`, `onChange`, `path`, `error`, `disabled` and `readOnly`, and `ConfigInput` replaces the form generated from `config`. `Button`, `Input`, `Field`, `Card`, `Alert` and `Modal` come from `tansy/admin`.

Check a definition in your plugin's own tests. The published package has to be compiled to load, so `tansy plugin new` generates a test that reads it through `jiti`:

```ts
import { testFieldDefinition } from "tansy/testing";

expect(testFieldDefinition(linkField, { valid: [{ label: "A", id: 1 }], invalid: ["x"] })).toEqual([]);
```

### Blocks

`defineBlock` takes `name`, `label`, `icon` and `fields`, plus `labels` for the label in other interface languages, `category` and `previewImage` for the add menu, `defaults` for new blocks, and `upgrades` for stored blocks, by the version they start from.

#### On the editor's canvas

Blocks show on the canvas the way the site renders them, as in WordPress's block editor. `tansy sync` writes `.tansy/preview.ts`, with the theme's and plugins' render components and the theme's tokens, and the dashboard loads it the first time it shows a stream. Each block then shows:

1. **The plugin's block editor**, from `blockEditors` in `admin.client`, Gutenberg's `edit`. It renders the same markup as the block's render component, and places `Field` where each value goes. `Field` is the CMS's own control: text without a box that takes the surrounding typography, inline rich text, an image as itself, nested blocks. Settings such as a tone stay in the sidebar. If the theme restyles the block, the theme's version shows until the block is selected.
2. Otherwise, **the site's rendering** while the block isn't selected, and its fields while it is. A block whose fields are all settings keeps showing the rendering. A rendering that shows nothing, such as a new block's, gives way to the fields.
3. Without either, **the fields**: text without a box, images and files as themselves, and a YouTube or Vimeo link as its player when the Content Security Policy allows the frame. A field type can set `Canvas` in `fieldAdmin` to choose how it shows there.

```tsx
"use client";
import { defineAdminClient, type BlockEditorProps } from "tansy/admin";

function QuoteEditor({ block, selected, Field }: BlockEditorProps) {
  return (
    <blockquote className="acme-quote">
      <Field name="text" placeholder="Write a quote…" />
      {(selected || block.value.source) && <div className="acme-quote-source"><Field name="source" placeholder="Who said it" /></div>}
    </blockquote>
  );
}

export default defineAdminClient({ blockEditors: [{ blocks: ["acme_quote"], component: QuoteEditor }] });
```

Render a field you don't want on the canvas only while `selected`, such as alt text, or it can't be edited. Calling `setField` more than once in one event is fine: the calls build on each other. Import your stylesheet from the editor module too, so it applies before the site's components load. The blog and LMS plugins' `editors.tsx` are complete examples.

Render components shown on the canvas run in the dashboard as the signed-in person, through the same guarded API as anywhere else. They can't be clicked, so a form or player does nothing there.

A stream field with `max: 1` and one allowed block is edited as plain fields, which makes it a group field. Any field can set `showIf: { field: "kind", equals: "video" }`. It only changes what the form shows, and the server validates a hidden value like any other.

### Rendering on a site

`admin.render` names a module with no server imports, exporting `defineRenderers({ blocks, fields })`. `tansy sync` joins them in `.tansy/render.ts`:

```tsx
import renderers from "../.tansy/render";

<StreamField blocks={post.body} components={{ hero: MyHero }} renderers={renderers} />
```

Each block uses `components`, then `renderers`, then `fallback`. Inside a block component, `<FieldValue type="seo_link" value={value.link} renderers={renderers} />` renders one field.

A plugin's render module can also give site pages to its own collections, whose slugs start with the plugin's name and a hyphen:

```tsx
export default defineRenderers({
  templates: { "blog-posts": Post, "blog-home": BlogHome },
  queries: { "blog-home": { posts: { collection: "blog-posts", sort: "-publishedAt", perPage: 10 } } },
  expand: { "blog-posts": "author,tags" },
});
```

Queries, in plugins and themes alike, take these on top of the API's list options:

- **`filter`** may name fields of the record the page shows as `@record.<field>`, as in `categories ?= @record.id`. A list field matches when any of its values does, so `tags ?= @record.tags && id != @record.id` finds posts sharing a tag. Values are written in as literals and bound as parameters by the API, like any filter. A list needs an "any" operator (`?=`, `?!=`, `?~` and so on). On a page with no record, or when the record lacks the field or holds something that isn't a plain value, the query returns an empty list.

  A filter may also **follow one relation**, as in `author.name = "Ada"`, or backwards as `<slug>_via_<field>.title ?= "x"`, which answers against the records pointing here. The related records are read as whoever the query reads as, through their own collection's view rule, so a query can't show what that person couldn't view. One relation deep, one per comparison, and the "any" operators for a path that can hold several. A big target collection is fine, since only the records that could match are read, but a filter that matches more than 10,000 of them is refused: narrow it, or filter on the relation's own column, such as its id.
- **`paged: true`** reads the page that `?page=` asks for. A number past the last page shows the not-found page. `<Pager list={data.posts} path={path} />` from `tansy/react` renders the previous and next links.
- **`urls: "1"`** adds `recordPath` to each item, its address under the collection's URL pattern, so links follow whatever patterns the owner sets.
- **`viewer: true`** reads the query as the signed-in person, under API rules alone, such as a learner's own progress where the rule is `student = @request.auth.id`. Signed out, it reads as a visitor. Their role's permissions never apply, so staff get only their own rows too, and the read is never cached.

A page whose record only the signed-in person may view, such as a lesson in a course they joined, renders for them the same way: the record, its `expand` and its `viewer` queries are read as them, and everyone else gets the not-found page. Rules stay the only gate, so gated content needs no route of its own. See the site layer in the security model.

In a client component, `apiPath("/collections/...")` from `tansy/react` is the address of the CMS's API in this app, and `authPath("signin?next=/somewhere")` links to sign-in and back.

A template receives the same props as a theme's, and renders inside the theme's layout. It wins over the theme's `default`. `tansy sync` refuses a template, query or expand for a collection outside the plugin's prefix, so one plugin can't take over another's pages. Style templates with the theme's `--site-*` tokens.

The theme's own template for that collection wins, so a theme can redesign a plugin's pages. It still receives the plugin's queries for that template as `data`, with the theme's own queries winning on a name. So that a theme doesn't lose what the plugin does on the page, the render module also exports its parts, such as the blog's `<PostComments>`, for the theme to place:

```tsx
import { MorePosts, PostComments, PostMeta } from "@tansy/blog/render";

function Post({ record, data, stream }: TemplateProps) {
  return <article><h1>{String(record?.title)}</h1><PostMeta post={record!} data={data} /><StreamField blocks={record?.body} {...stream} /><MorePosts post={record!} data={data} /><PostComments post={record!} data={data} /></article>;
}
```

A plugin can also put a component on every page of the site, such as an analytics tracker or a cookie notice. The manifest's `everyPage` function runs on the server as each page renders, with the plugin's context and the page, and returns the component's props, or `null` to leave it off that page. The render module's `everyPage` component of the same name gets them. Names start with the plugin's name and a hyphen:

```ts
// index.ts
everyPage: {
  "acme-banner": async ({ settings, page }) => (page.preview ? null : { text: (await settings.get()).bannerText }),
},

// render.tsx
export default defineRenderers({
  everyPage: { "acme-banner": ({ props, page }) => <aside>{String(props.text)}</aside> },
});
```

Props reach the browser in the page, so never return a secret. They're copied through JSON and kept under 16 KB. A function that throws or takes over two seconds leaves its component off, logged, and the page renders without it. The component renders after the theme's layout, inside the site's root, so position it with CSS if it belongs elsewhere. A headless site has no `everyPage`: export the component, with a public route for its props, for it to place itself, as the analytics plugin does. See [the Analytics plugin](plugins/analytics.md).

### Translators

A plugin that declares `translator` adds **Translate with …** to the record editor, for each language but the default. Core walks the record, takes apart text, rich text and every block's text into segments, and sends only localized, readable, non-hidden text. The result goes into the form unsaved, so an editor reviews it before saving.

```ts
definePlugin({
  name: "deepl",
  translator: {
    label: "DeepL",
    // One string back per segment, in the same order.
    translate: async (segments, { from, to }) => callDeepL(segments.map((segment) => segment.text), from, to),
  },
});
```

`Segment` and `Translator` come from `tansy/plugin`. Anything other than one string per segment is refused with a 502, and core never puts back text where the source had none.

### The dashboard in other languages

The dashboard's words come from catalogs in `core/i18n/catalogs`, English first, in ICU MessageFormat. A person picks their language under **Account**, and the dashboard turns right to left for Arabic. A plugin ships its own words as `messages`, by language, and its pages read them under `ext.<plugin>`:

```ts
definePlugin({ name: "blog", messages: { en: { moderate: "Moderate" }, ar: { moderate: "إشراف" } } });
```

```tsx
import { useT } from "tansy/admin";
const { t, formatDate } = useT();
t("ext.blog.moderate");
```

English is the fallback for any key a language lacks. Server components use `getT()` from `tansy/server`. Code that runs outside a component, such as a bulk action's `run` or an error thrown from a click, uses `translate()` from `tansy/admin`, which takes the same keys.

The words a plugin registers in code, which the dashboard shows itself, are looked up in the same `messages` under fixed keys, and shown as registered where there's no entry:

| What | Key under `ext.<plugin>` |
|---|---|
| The section's title | `section` |
| A page's title | `pages.<path>`, such as `pages.blog/comments` |
| A collection in the section | `collections.<slug>`, else the collection's name in that language |
| The section's settings link | `settingsTitle` |
| A link in `navItems` | `nav.<path>` |
| A widget's title | `widgets.<id>` |
| A grid column's title | `columns.<id>` |
| A record, bulk, field or block action's label | `actions.<id>` |
| A settings tab's title | `tabs.<id>` |
| A block category in the add menu | `categories.<category>` |
| A setting's label, description and choices | `settings.<name>.label`, `settings.<name>.description`, `settings.<name>.options.<value>` |
| A field type's name and description | `fieldTypes.<type>.label`, `fieldTypes.<type>.description` |
| A field type's config option | `fieldTypes.<type>.options.<key>` |

A plugin whose adapters come from other packages, such as payment, email, AI or CAPTCHA providers, lets each adapter ship the words for its own settings and merges them into its `messages` with `mergeMessagesByLanguage(own, ...adapters.map((a) => a.messages))` from `tansy/plugin`. `checkPassword` gets `{ locale, t }` as its third argument, so a refusal is in the language of the person choosing the password: `t("ext.<plugin>.<key>")`.

Names in the schema are given per language beside the plain one, which covers any language missing: `labels` on a collection, a block (including `defineBlock`) or a field's config, and `descriptions` on a field's config, such as `labels: { ar: "المقالات" }`. A collection's names can be set under its schema, sent as `labels` to the collections API, and travel in schema files. A plugin gives its collections names in a migration with `schema.addLabels(slug, labels)`, which adds only the languages the collection has no name in, so an owner's own names stay. Its fields get theirs the same way with `schema.addFieldLabels(slug, { title: { labels: { ar: "العنوان" }, descriptions: { … } }, state: { options: { draft: { ar: "مسودة" } } } })`, by field name and then choice value, and `schema.addBlockFieldLabels(block, …)` does it for a block the plugin made with `apply`. A block in the plugin's `blocks` carries its words in its code. A choice on a radio, select or multiselect field takes `labels` too, beside its `label`. Changing only words, in any language, never starts a new block version.

Field labels and descriptions follow the interface language too: give a field `labels` and `descriptions` by language, such as `{ "ar": "العنوان" }`, and `label` and `description` cover every language missing. Account email goes out in the language the recipient chose, or the instance's default (`TANSY_ADMIN_LOCALE`), and API errors show in the interface language by their `code`, while `message` stays English for API callers.

### Agent tools

`tools` are what an AI agent can do with a plugin, beyond reading and writing single records. Core already offers `list_collections`, `describe_collection`, `list_records`, `get_record`, `create_record`, `update_record` and `delete_record`. A plugin adds steps that take several records or some knowledge of its own, such as LMS's `lms_create_course`, which makes a course, its sections and lessons in one call:

```ts
import { defineTool } from "tansy/plugin";

defineTool({
  name: "lms_create_course",            // starts with the plugin's prefix
  description: "Create a whole course in one step…",
  input: z.object({ title: z.string(), sections: z.array(…) }),
  access: { access: "authenticated" },  // or { access: "permission", permission: "ext.lms:manage" }
  write: true,                           // asks the person first, in the assistant
  audit: "lms.create_course",           // required for a write
  handler: async ({ input, records, tools }) => { … },
});
```

Every tool is served to outside agents over MCP, and to plugins as `context.tools` on route contexts, so the AI plugin and any other assistant get it with no import. A handler runs as the caller: `records` and `tools` act as them, so rules and own-record grants hold. Use `system.records` only for what the plugin itself must do, and never return what it read unchecked. `tools.call("create_record", …)` takes rich text as Markdown and fills in blocks' `id` and `v`, which saves a tool from knowing either. Each call is audited on its own, by tool and record id, never values; `auditTarget(type, id, metadata)` names what the call touched, such as a tenant, and that becomes the entry's target. A tool call shows no recent sign-in, so **give no tool what one of your routes guards with `fresh`**, such as removing something for good: keep that on the route, where a person signs in again first. A good line to hold is that a tool does only what an API key may already do on one of your routes, under the same permission. `tools.withRole(name)` gives the same tools limited to what that role also grants, still as the caller, for an assistant that should do less than the person using it; `tools.roles()` lists the roles to offer. The input must be an object JSON Schema can express, or startup fails.

### Commands

`commands` add words to the `tansy` CLI, such as `tansy tenant list` from the multi-tenant plugin. Core dispatches a name it doesn't know to the plugin that declares it: it refuses a name of its own, so a plugin can't change what `tansy migrate` means, and refuses two plugins claiming one name.

```ts
import { defineCommand } from "tansy/plugin";

defineCommand({
  name: "tenant",                       // becomes cms tenant
  usage: "cms tenant <list | show <id>>",
  describe: "Run this instance's tenants.",
  run: async ({ args, flags, api, log, fail }) => {
    if (args[0] !== "list") fail("Usage: tansy tenant list");
    const { items } = await api.request<{ items: Array<{ slug: string }> }>("/tenants");
    for (const tenant of items) log(tenant.slug);
  },
});
```

**A command reaches the instance only over HTTP**, through `api`, as the API key in `TANSY_API_KEY`, and never by opening the database. So everything it does goes through the same guard, permissions, rules and audit log as any other request, and it can do no more than that key may. `api.request(path)` calls this plugin's own routes under `/api/ext/<plugin>` and gives back the parsed JSON, or stops with the server's own message; `api.fetch` is the raw response, for a route that answers with a file or takes one. The server has to be running, and `--url`, else `TANSY_URL`, else `BETTER_AUTH_URL` says where it is. The key is asked for on the first request, so a command can print its own usage without one.

It follows that **a route guarded with `fresh` has no command**: an API key can't show a recent sign-in, which is the point of that guard. Leave that work in the dashboard, and say so when someone asks for it, as `tansy tenant` does for making a tenant and for a purge.

### What tansy doctor says

`doctor` adds lines to `tansy doctor`, for what only the plugin knows: an option of its own that works but gives something up, or one that will fail the first time it is really used. It runs with no server and no database, so a check reads the plugin's options, the environment and the app's files, and nothing else.

```ts
doctor: ({ env }) => [
  { ok: Boolean(env.ACME_KEY), label: "its key is set", fix: "Set ACME_KEY, or the first order fails." },
  { ok: options.mode !== "test", label: "it talks to the live service", fix: "mode is \"test\", so no order is real.", warning: true },
],
```

Each line is labelled with the plugin's name. A failure makes `tansy doctor` exit non-zero; a `warning` is printed but still passes, for something that is fine if it was meant. A plugin whose checks throw is reported as a failure of its own, and the other plugins' checks still run. Counting rows, or anything else that needs the database, belongs in the dashboard or a job instead.

### Upgrades

`migrations` run in order at startup, once each. They use `system.records`, `store` and `schema.apply(document)` with a portable schema document, and never SQL. To add a field to a collection a site already has, use `schema.addFields(slug, fields)`: it adds only the fields that are missing, by name, and leaves the collection's other fields, rules and address as the owner set them, where `apply` would reset rules to the document's. Add new ones at the end of the list. To offer a new choice on a radio or select field a site already has, use `schema.addOptions(slug, field, options)`: it adds the values that are missing after the owner's own, and does nothing when the owner removed the field. To name a collection in other interface languages, use `schema.addLabels(slug, labels)`, and for its fields `schema.addFieldLabels(slug, fields)`: each adds the languages that have no words yet. A failure stops startup, and migrations already finished aren't repeated. `PluginState` records the installed version and what has run, and it stays when a plugin is removed. Installing a version older than the database has reached stops startup. Startup migrations assume one server is starting, so upgrade a multi-server deployment one server first.

### Collections a plugin relies on

A plugin that needs a value per user, such as which courses someone may open, declares a user field in a migration with `schema.apply({ version: 1, collections: [], userFields: [{ name: "lms_courses", type: "json", config: { hidden: true } }] })`. Its name must start with the plugin's prefix, or the migration fails. Make it hidden, so the user never sees a value only rules use, and set it with `system.users`. While the plugin runs, the dashboard won't let users edit the field themselves.

A plugin that needs people in particular jobs, such as authors and editors, declares roles in a migration with `roles.ensure(...)`. A role's name must start with the plugin's name and a hyphen. `records` names collections by slug, and a grant ending in `:own` covers only the records the person created:

```ts
up: async ({ roles }) => {
  await roles.ensure({
    name: "blog-author",
    label: "Blog author",
    permissions: ["dashboard:access", "collection:read", "file:create"],
    records: { "blog-posts": ["create", "list:own", "read:own", "update:own", "delete:own"] },
  });
}
```

A hook can then tell the roles apart with `can()`. In a before-hook, `can("ext.blog:credit")` is true when whoever is writing holds that permission: never for a visitor, always for a system write, and for an API key only if the key was given it. Use it to refuse, never to allow what the collection's rule refused.

A grant can also be `publish`, for a role that approves changes where a collection requires review. It has no `:own` form.

It creates the role only if no role has that name, so owners can change it under **Roles** and a later upgrade won't undo that. It's audited as `role.create` under `plugin:<name>`. Nobody holds the role until someone assigns it, and assigning still needs every permission it grants.

A plugin that creates collections should name them `<plugin>-<name>`, such as `blog-posts`, and treat them as the owner's: the owner can add fields, edit rules and change URL patterns, and removing the plugin keeps them. List the fields the plugin's code reads or writes under `contract`, by collection slug, then field name and type. Nothing enforces it, because the owner stays in charge. Instead, **Dashboard → Extensions** shows any collection or field that's missing or has a different type, and the plugin can check with `schema.describe` and turn off what needs it.

### Row scopes

One plugin can split records by a value it resolves per request, such as a tenant or a workspace, with `scope`. Core enforces it below roles and rules on every collection the owner marks scoped (see "Row scopes" in the security model). A second plugin with `scope` stops startup.

```ts
scope: {
  label: "Workspace",
  scopeNewCollections: false,                       // default true: collections made through the API are scoped
  resolve: ({ host, headers, path, principal }) => headers.get("x-workspace"), // a hint, or null for none
  exists: (value) => workspaces.has(value),         // anything else is refused with 404
  rolesFor: ({ user }, value) => isMember(user, value) ? ["workspaces-editor"] : [],
  initial: () => "alpha",                           // where existing records go when a collection becomes scoped
  values: () => [...workspaces.keys()],             // every active value, for jobs with perScope
  siteUrl: (value) => `https://${value}.example.com`, // optional: the value's own site, for links in emails and feeds
  limits: (value) => ({ records: 10_000, storageBytes: 1e9, requestsPerMinute: 600 }), // optional, null for none
}
```

Values are short ids, matching `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. The roles `rolesFor` names count only if they are scoped, which a migration declares with `scope: "scoped"` in `roles.ensure(...)`. A scoped role can hold `dashboard:access`, `collection:read`, `file:create`, `locale:edit` and record permissions, and those reach scoped collections only, plus any of the plugin's own permissions it lists in `scopedPermissions`, such as `["ext.multi-tenant:members"]`: a route checking one must work on `principal.scope` alone. With `everyValue: "ext.<plugin>:all"`, someone with no role in a value reaches it only with that permission, whatever their instance roles. Hooks and jobs run across every value, so they can read and change scoped records but not create one, except a job with `perScope`, which also runs once inside each value. A working example lives in `examples/workspaces`: set `TANSY_EXAMPLE_WORKSPACES=alpha:ann@example.com;beta:bob@example.com` and send `x-workspace` with each request. `plugins/multi-tenant` is the full one, on better-auth's organization plugin: set `TANSY_PLUGIN_MULTI_TENANT=true` (without the workspaces example) and send `x-cms-tenant`, or switch with `POST /api/ext/multi-tenant/switch` or the dashboard's top bar. Dashboard pages resolve the value as API routes do, so a plugin page or widget reads in it through its `records`. Give the scope's word in other languages as `scopeLabel` in the plugin's `messages`. Core checks `limits` where records are made, files saved and API requests answered, refusing with `SCOPE_LIMIT_REACHED` (or 429 for requests), and holds them for 15 seconds: call `context.scope.forgetLimits(value)` after changing them. Webhooks, audit entries, search documents and after-hook deliveries follow the value of the record or request they come from.

**System-owned collections.** `systemCollections: ["acme-ledger"]` lists collections only the plugin's own `system.records` may write. Roles, own grants and API rules can't open them: staff with record permissions read them, and nobody else writes them. Use it for anything a person must not edit for themselves, such as memberships or payments.

### What's installed

**Dashboard → Extensions** is a read-only list of plugins with their version, permissions, routes and access. `tansy routes` prints the same inventory from the command line, and `tansy doctor` prints it after its checks. Extensions also links to a read-only list of community packages, taken from npm by the keywords `tansy-plugin` and `tansy-theme`. Being listed isn't an endorsement, and the page says so.

Two plugins can't share a route, job, block or field type: a clash stops startup. A hook file that clashes is refused like any other broken file. Blocks from a plugin are read-only in the dashboard, and a block name already used by a dashboard block is a clash.

Removing a plugin keeps your data. Its blocks become ordinary editable blocks. A field whose type came from the plugin stays readable but can't be edited, and can be removed under the collection's schema. Blocks using such a field are kept as stored until the plugin returns.

A working example lives in `examples/seo-plugin`. Set `TANSY_EXAMPLE_SEO=true` and `TANSY_EXAMPLE_SEO_COLLECTIONS=posts` to try it. The listed collections need `title` and `seo_title` fields.

### Trust

Plugins are npm packages that you install yourself and name in `tansy.config.ts`. They run as ordinary server code with full access, and declared permissions describe what a plugin adds rather than confine it. The dashboard can't install or enable one. Review a plugin as you would any other dependency, and keep a lockfile.

### Plugins in a Docker image

A plugin's admin half is bundled at build time, so adding one means building again. Start from the repository's build stage, then lay the result over the normal image:

```dockerfile
# First: docker build -t tansy . && docker build --target build -t tansy-build .
FROM tansy-build AS plugins
COPY tansy.config.ts apps/starter/
RUN npm install @acme/cms-seo -w apps/starter && npm run build && npm prune --omit=dev

FROM tansy
COPY --from=plugins /app/node_modules /app/node_modules
COPY --from=plugins /app/apps/starter/.next/standalone /app
COPY --from=plugins /app/apps/starter/.next/static /app/apps/starter/.next/static
```

## Themes

A theme is the public site's look, installed like a plugin: `npm i`, one line in `tansy.config.ts`, rebuild. It's trusted code, so read what you install.

```ts
// tansy.config.ts
import { blog } from "@tansy/theme-blog";

export default defineCms({ theme: blog({ tagline: "Field notes" }) });
```

A build can install several themes instead, with `themes`, and each scope value — a tenant, say — then picks one under **Site**:

```ts
export default defineCms({ themes: [blog({ tagline: "Field notes" }), magazine()] });
```

The first is the default, which is what an instance and any site that has chosen nothing is served in. Set `theme` or `themes`, never both. The themes come with the build, so changing the list means rebuilding; the choice is a setting, so changing that doesn't. See [Several themes in one build](guides/themes.md#several-themes-in-one-build).

Run `npx tansy init --site` once to add the page that renders it. If your app already has a home page, it stays in charge of `/` and the command says how to hand it over.

### Writing one

`tansy theme new <name>` generates a working package, and [Write and publish a theme](guides/themes.md) walks through it. A theme is one package with two entries, so `tansy.config.ts` never imports React:

```ts
// index.ts, the manifest
export const acme = (settings: { tagline: string }) => defineTheme({
  name: "acme",
  version: "1.0.0",
  apiVersion: 1,
  render: "@acme/theme/render",
  options: { schema: z.object({ tagline: z.string() }), value: settings },   // checked at startup, reaches headless sites, no secrets
  tokens: { color: { accent: "#2f6f5e" }, font: { body: "system-ui, sans-serif" } },
  requires: { plugins: ["seo"] },
  schema,                                                  // a portable schema document
  singletons: ["site-menu"],                               // given to every page as `globals`
  queries: { home: { posts: { collection: "posts", sort: "-publishedAt", perPage: 20 } } },   // per template
  expand: { posts: "author" },                             // per collection
});
```

```tsx
// render.tsx, no server imports
export default defineThemeComponents<Options>({
  blocks: { hero: Hero },
  fields: { acme_link: LinkView },
  templates: { home: Home, posts: Post, default: Page },
  layouts: { default: SiteLayout },
  fontClassName: font.variable,
});
```

- **Templates** are picked by collection slug, then `default`. `home` renders a site's root when no record lives there.
- **Tokens** become `--site-<group>-<name>` on the page's wrapper, in the groups `color`, `font`, `space`, `radius`, `size` and `shadow`. Each value is checked against its group, and a bad one fails the build. The accent colour under Settings overrides `color.accent`.
- **Styles** are your own stylesheet, imported by the render entry. Use `--site-*` tokens in it.
- **Fonts** use `next/font/local` in the render entry, so they're served from the site as the Content Security Policy requires.
- **Templates and layouts are server components**, because their props include a function, `fileUrl`. They can render client components inside them.
- **`stream`** is on every template's props. Spread it onto `<StreamField>` and blocks use your components, then plugins' defaults. A block with neither shows a notice.
- **`schema`** is applied once per theme version. It creates the collections and blocks that don't exist yet, and adds the fields a collection is missing, onto the collection as the owner left it. It never changes or removes anything that exists, and never brings back a collection, field or block the owner deleted, because the theme remembers everything its schema has named. Give a field you add in a later version no `required`, as the collection may already hold records, and handle fields an owner may have removed.
- **Paging and record values** work in theme queries as in plugins' ones: see `paged` and `@record.<field>` under [Rendering on a site](#rendering-on-a-site).
- **Languages.** On a site with more than one public language, every page is in one: `/fr/blog/x` with prefixes, or the host with a domain per language. Lists, singletons and the page's record are read in it, and `<ThemedPage>` sets `lang` and `dir`. Templates get `language`, null on a site with one language, with `locale`, `direction`, `locales`, `alternates` (this page's address in each language, for a switcher) and `href(path)`, which writes an address in the page's language. Link with `language?.href("/blog") ?? "/blog"`. `pageMetadata` adds `hreflang` alternates.
- **Words.** Give the components `messages`, by language, in ICU MessageFormat, and use `t("readMore")`, `t("pageOf", { page, total })`, `formatDate` and `formatNumber` from the props. Owners can change any message per language under **Languages → Site text**. `defaultLocale` names the language the theme's words are written in, `en` unless set.

### Headless

The same theme package renders on another site, through the API:

```tsx
const client = new CmsClient({ url: process.env.TANSY_URL });
const theme = { manifest: acme({ tagline: "Hi" }), components };
const renderers = mergeRenderers([pluginRenderers("blog", blogRender)]);   // optional: plugins' blocks and pages

export default async function Page({ params, searchParams }) {
  const path = `/${((await params).path ?? []).join("/")}`;
  const { token, page: pageNumber } = await searchParams;
  const reader = client.reader({ tags: ["cms"], revalidate: 300 });   // optional: lets Next.js cache the reads
  const page = await loadSitePage(theme, reader, path, { previewToken: token, page: pageNumber, renderers });
  if (page.type === "redirect") redirect(page.to);
  if (page.type === "missing") notFound();
  return <ThemedPage theme={theme} page={page} renderers={renderers} />;
}
```

`renderers` holds plugins' render modules, so their blocks and pages render here too. Leave it out if you use none. Give `ThemedPage` the same renderers as `loadSitePage`.

`reader({ tags, revalidate })` lets Next.js cache what the page reads, which a same-app site gets from the CMS's own read cache. Previews are never cached. Only cache reads made with no API key, or one that reads as a visitor, as cached reads are shared by everyone. To clear them when content changes, add the route from `tansy/headless` and point a webhook at it:

```ts
// app/api/cms-revalidate/route.ts
import { createRevalidateRoute } from "tansy/headless";

export const { POST } = createRevalidateRoute({ secret: process.env.TANSY_WEBHOOK_SECRET, tag: "cms" });
```

In the CMS, add a webhook for create, update and delete on all collections that posts to `https://your-site/api/cms-revalidate`, and put the secret it shows in `TANSY_WEBHOOK_SECRET`. The route checks the signature and its age with `verifyWebhook`, then clears the whole tag, as one change can affect lists on any page. Webhooks carry record changes only, so a schema or settings change shows once `revalidate` runs out. `npx create-tansy --template headless` sets all of this up.

To preview on that site, set `previewUrl` in `tansy.config.ts`. The dashboard's Preview button opens it with `?token=`. A real site should move the token into its own cookie, as `/api/preview/enter` does, rather than keeping it in the address.

#### Members on a headless site

Add the site's origin under **Settings → Network → Trusted origins**. The API then answers it with CORS, so a browser there can call `/api`, `/api/auth` and plugins' routes. A site on a sibling subdomain, such as `www.example.com` beside `cms.example.com`, can use the CMS's cookie session with `credentials: "include"`. Any other site turns on **Bearer tokens** under **Settings → Sign-in methods** and signs members in through the client, which keeps the token:

```ts
const cms = new CmsClient({ url: process.env.TANSY_URL, onToken: (token) => saveToken(token) });
await cms.auth.signIn.email({ email, password });   // or signUp.email, requestPasswordReset, resetPassword, signOut
const me = await cms.auth.session();
await cms.request("/api/ext/payments/checkout", { method: "POST", body: { collection: "lms-courses", id: 4 } });
```

`auth.call(path, body)` reaches any other better-auth endpoint, such as `/sign-in/magic-link` or `/two-factor/verify-totp`. Links in emails go wherever the call's `callbackURL` or `redirectTo` says, which must be on a trusted origin.

To render members' pages, such as an enrolled learner's lesson, give the client the member's token. A site that renders on its server keeps it in its own HttpOnly cookie, out of reach of the page's scripts:

```tsx
const client = new CmsClient({ url: process.env.TANSY_URL, token: (await cookies()).get("cms_token")?.value });
const page = await loadSitePage(theme, client.reader({ tags: ["cms"], revalidate: 300 }), path, { renderers });
```

`reader()` still reads as a visitor, so its reads stay safe to cache. Only its `viewer()` reads as the member, with `x-cms-as: member`, under API rules alone and never cached, so staff see exactly what any member would, as on a same-app site. With two-factor on, signing in from another site finishes on the site's server, which passes the `two_factor` cookie from the sign-in answer on to `/two-factor/verify-totp`. See the security model, under Headless frontends.

### Reading records yourself

`tansy/server` gives a same-app page the reads themes use, as a signed-out visitor and cached:

```ts
const site = createSite(config);
const posts = await site.list("posts", { sort: "-publishedAt" });
```

There's no way to pass an identity to it. A page that depends on who is looking should call the HTTP API with that person's credentials.

Cached reads last at most 30 seconds, and any write clears them. `TANSY_SITE_CACHE_SECONDS` changes that, and `0` turns it off.

### Admin themes

`adminTheme` in `tansy.config.ts` changes the dashboard's tokens and logo. It can't replace components.

```ts
adminTheme: defineAdminTheme({
  name: "corporate",
  tokens: { light: { "color-surface": "#fafafa" }, dark: { "color-surface": "#101014" } },
  logo: "/logo.svg",
}),
```

Names are the admin's `--cms-` tokens without the prefix. The logo and accent colour under Settings win over the theme's.

## Your own proxy

Next.js allows one `proxy.ts`, so a host app passes its own to the CMS's:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createCmsProxy } from "tansy/proxy";
import cspAdditions from "./.tansy/csp";

export const proxy = createCmsProxy(cspAdditions, {
  proxy: (request: NextRequest) => {
    if (request.nextUrl.pathname === "/old") return NextResponse.redirect(new URL("/new", request.url));
  },
});
```

It runs only outside the admin and API paths, and can't change what reaches them. Return nothing to carry on, or a response. Security headers and the nonce are added to whatever it returns, so a site page is still under the CMS's Content Security Policy. That policy needs a per-request nonce, so site pages must render dynamically. `tansy init` marks the site's root layout `force-dynamic`, and `withCms` turns off `cacheComponents` and `partialPrefetching` for the same reason.

## Core and plugins

Core is the engine and open protocols. Anything that names a vendor or is an optional feature is a plugin, and removing its line from `tansy.config.ts` removes the feature.

**Authentication and requests** go under a plugin's `auth`:

| Option | What it does | Example |
|---|---|---|
| `plugins` | Adds better-auth plugins, built with `(authSettings, context, access)` and rebuilt when the dashboard's auth settings, roles or the plugin's own settings change. It may be async, so it can read `context.settings`. `access.accessControl({ statements, roles, grant })` gives a better-auth plugin that checks roles, such as the organization plugin, the CMS's roles as its `ac` and `roles`, with what each grants on the plugin's own statements (`plugins/multi-tenant`). Tables and columns those better-auth plugins declare become collections named with the plugin's prefix, created on startup and locked to staff (see below) | `plugins/payments` |
| `serverOnlyPaths` | Paths of those better-auth plugins closed to direct HTTP, such as an endpoint that takes a customer id or metadata from the request. The plugin's routes still reach them with `context.auth.call` | `plugins/payments` |
| `trustedOrigins` | Origins to trust besides the owner's list under Settings → Network, for CSRF, CORS and better-auth, such as tenants' verified domains. `(context) => string[]`, each a plain http(s) origin, never a pattern. Read again every 30 seconds, or at once after a route calls `context.auth.refreshTrustedOrigins()` | `plugins/multi-tenant` |
| `oauthProviders` | Adds sign-in providers to Settings, OAuth | `plugins/social-sign-in` |
| `authWidget` | Shows a component on the sign-in, sign-up and reset forms. Its props reach the browser, so never put secrets in them | |
| `captcha` | A CAPTCHA. `widget(context)` is what the browser shows, public. `verify(answer, { ip }, context)` asks the provider. `authForms(context)` names the sign-in forms that ask for it: core then refuses their requests without a good answer in `x-captcha-response`, before better-auth routes them. Every plugin reaches it as `context.captcha`. An optional `ready(context)` works as for `mail`, and the first ready one wins | `plugins/captcha` |
| `checkPassword` | Refuses a password on every path that sets one. Return a message to refuse | `plugins/pwned-passwords`, `examples/password-denylist` |
| `onSignIn` | Runs in the background after a sign-in, with earlier sign-in addresses and a way to email the user | `examples/sign-in-alerts` |
| `emailContent` | Changes an email's subject or body. Links and codes are added afterwards, so it can't lose them | `examples/email-templates` |
| `guardRequest` | Return `false` to refuse a request that passed every other check. It can only take access away, and a guard that throws refuses | `examples/ip-allowlist` |
| `mail` | Delivers all of the site's email instead of SMTP. `send(message, authSettings, context)` gets the plugin's own context, to read its settings and keys. An optional `ready(context)` says whether it can send yet: until it does, mail goes through SMTP, so installing the plugin before entering keys breaks nothing. The first ready adapter wins. An optional `sendBatch(messages, authSettings, context)` sends many at once, through the provider's batch API, with a result for each | `plugins/email` |
| `onAudit` | Forwards audit events | |

**Calling a better-auth plugin from a route.** A route's `context.auth.call(path, { body, query })` calls an endpoint of the better-auth plugins its own plugin added, by path, as the caller: better-auth sees their session cookie and nothing else, so the endpoint acts for them alone, and an error it throws becomes the route's error response. Endpoints of other plugins and of core can't be called. With `auth.serverOnlyPaths`, a plugin can close an endpoint to HTTP and offer it only through a route that checks first, as Payments does for Creem's portal:

```ts
defineRoute({
  method: "POST", path: "/billing", access: "authenticated", audit: "payments.billing",
  handler: async (context) => context.auth.call("/creem/create-portal", { body: {} }),
})
```

`context.auth.server(pathOrName, { body })` calls one of the same endpoints as the server, with no caller, by path or by its `auth.api` name for an endpoint better-auth only offers on the server, such as the organization plugin's `addMember`. better-auth trusts the input then, such as which user to act for, so only call it after the route's own checks. Throw `HttpError` from `tansy/plugin` to refuse with a status and code of your own.

**better-auth plugins with their own tables.** The Prisma client ships generated with the package, so it can't learn new models. Instead, core keeps each table a better-auth plugin declares, such as `@better-auth/stripe`'s `subscription`, as a collection `<plugin>-<model>`, one record per row with better-auth's id in `authId`. Columns it adds to a core table, such as `user.stripeCustomerId`, go to `<plugin>-<model>-data`, one record per core row keyed by `coreId`. Field names records reserve get the model's name in front, so `status` is `subscriptionStatus`. There's nothing to migrate. Writes go through the plugin's `system.records`, so they're validated, audited under the plugin's name and fire hooks: a plugin reacts to a new subscription with `record.afterCreate` on its collection. Owners can open these collections up with rules, such as `referenceId = @request.auth.id`, unless the plugin lists them in `systemCollections`. better-auth's joins work by reading each joined model on its own, core models included, such as an organization member's user. Renamed fields and OR conditions on added columns aren't supported, and stop with a clear error.

**In the browser**, a plugin's `admin.client` supplies `authWidgets`, the components for `authWidget`, and `recordPanels`, shown under the fields in the record editor with the form's current values (`examples/live-preview`).

**Outside origins** go in a plugin's `csp`, or the top-level `csp` in `tansy.config.ts` for the site's own code, for frames, connections and images. Sources must be exact origins. Scripts aren't listed: a script your component inserts is already trusted through the page's nonce.

**Search** uses the database's own full-text index. Mark fields **Searchable**, then query `/records?search=words`. To use an outside engine, set `search` in `tansy.config.ts` to `@tansy/search-meilisearch`, `@tansy/search-typesense` or `@tansy/search-algolia`, or implement `SearchAdapter` from `tansy/search`. Core queues changes in the write's transaction and retries until the engine has them. See [Search](guides/search.md).

The examples are off unless their variable is set:

| Variable | Example |
|---|---|
| `TANSY_EXAMPLE_SIGN_IN_ALERTS=true` | Email on a sign-in from a new network |
| `TANSY_EXAMPLE_EMAIL_TEMPLATES=true` | Email wording edited as records in an `email-templates` collection |
| `TANSY_EXAMPLE_IP_ALLOWLIST=203.0.113.0/24,198.51.100.7` | Dashboard staff limited to these addresses |
| `TANSY_EXAMPLE_DENIED_PASSWORDS=acme,welcome` | Passwords containing these words refused |
| `NEXT_PUBLIC_TANSY_PREVIEW_URL=https://site.example`, set at build time | Live preview beside the record form |

`TANSY_PLUGIN_CAPTCHA=true` turns on `plugins/captcha` with every provider: set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`, or enter keys under **Extensions → CAPTCHA**. See [the CAPTCHA plugin](plugins/captcha.md).

`TANSY_PLUGIN_FORMS=true` turns on `plugins/forms`: contact forms put on any page with the Form block, emailed to `TANSY_FORMS_NOTIFY`. See [the Forms plugin](plugins/forms.md).

`TANSY_PLUGIN_NEWSLETTER=true` turns on `plugins/newsletter`: subscribers with double opt-in and campaigns sent in batches, with links in email starting at `TANSY_SITE_URL` (or `BETTER_AUTH_URL`) and `TANSY_NEWSLETTER_PER_MINUTE` emails a minute. See [the Newsletter plugin](plugins/newsletter.md).

`TANSY_PLUGIN_REQUEST_LOGS=true` turns on `plugins/request-logs`: every API request logged, shown on the dashboard, and optionally sent to S3 or other storage, a log service, or the server's output. See [the Request logs plugin](plugins/request-logs.md).

`TANSY_PLUGIN_ANALYTICS=true` turns on `plugins/analytics`: page views counted with no cookies, shown on the dashboard, and optionally sent to Plausible, Umami, Google Analytics, Fathom or Matomo, chosen under **Analytics → Settings**. `PLAUSIBLE_HOST`, `UMAMI_HOST` and `MATOMO_URL` point it at self-hosted ones. See [the Analytics plugin](plugins/analytics.md).

`TANSY_PLUGIN_BLOG=true` turns on `plugins/blog`, which makes the CMS a blog: see [the Blog plugin](plugins/blog.md). The `blog` theme requires it.

`TANSY_PWNED_PASSWORDS=true` turns on the Have I Been Pwned check from `plugins/pwned-passwords`. `TANSY_SEO_COLLECTIONS=posts,pages` turns on `plugins/seo`, which adds `seo_title` and `seo_description` fields and a `/sitemap.xml` built from those collections' URL patterns.

## Webhooks

Manage them under **Dashboard → Webhooks**. Each delivery is a POST with a JSON body:

```json
{ "id": "…", "event": "record.create", "collection": "posts", "at": "…", "record": { } }
```

Verify `X-CMS-Signature: t=<unix seconds>,v1=<hex>`, where the value is the HMAC-SHA256 of `<t>.<raw body>` with the webhook's secret. Reject old timestamps. `verifyWebhook(secret, header, rawBody)` from `tansy/sdk` does both, in any JavaScript runtime. `X-CMS-Delivery` is unique per delivery, for ignoring repeats. Any 2xx is a success. Others retry after 30 seconds, 5 minutes, 30 minutes, 2 hours and 6 hours, and redirects aren't followed.

## Schema as code

**Dashboard → Schema** exports collections, blocks, rules and user fields as JSON, and imports with a preview. Importing only changes what differs, so it can be repeated.

Set `TANSY_SCHEMA_FILE=schema.json` to apply a file at every startup, for example to build a new environment. Startup never loses data: it won't remove fields or run conversions that need confirming.

Import never deletes a collection. "Remove fields that aren't in the file" applies only to collections listed in it. Each step is its own transaction, so after a failure, fix the cause and import again.

## Clients

```ts
import { createClient } from "@/sdk";
import type { CmsCollections } from "./cms-types";

const cms = createClient<CmsCollections>({ url: "https://cms.example.com", apiKey });
const page = await cms.collection("posts").list({ sort: "-createdAt" });
const stop = cms.collection("posts").subscribe((event) => console.log(event.action, event.record));
```

- **Types:** `TANSY_API_KEY=… npx tansy types --url https://cms.example.com --out cms-types.ts`. The key needs `collection:read`. Hidden fields appear only if it also has `record:read`.
- **OpenAPI 3.1:** `GET /api/schema/openapi`, under the same permission.
- **MCP:** point a client at `POST /api/mcp` with an `x-api-key` header. It offers core's tools (`list_collections`, `describe_collection`, `list_records`, `get_record`, `create_record`, `update_record`, `delete_record`) and every plugin's agent tools the key may run, such as `lms_create_course` and `shop_create_product`, with MCP's read-only and destructive hints. They follow the same rules as the key does over REST. `describe_collection` gives each field's JSON Schema and the blocks a stream accepts, and writes take rich text as Markdown. For example, in Claude Code: `claude mcp add --transport http cms https://cms.example.com/api/mcp --header "x-api-key: cms_…"`.
