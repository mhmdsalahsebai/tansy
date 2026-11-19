# Write and publish a plugin

By the end you'll have a package on npm that adds a custom field and a block to any tansy site. You need Node 22.18 or later and an npm account. The full reference is in [Extending Tansy](../EXTENDING.md).

## 1. Create a site to develop against

```sh
npx create-tansy my-site
cd my-site
```

## 2. Generate the plugin

```sh
npx tansy plugin new acme --package @your-scope/cms-acme
```

This writes `plugins/acme`:

| File | What it's for |
|---|---|
| `index.ts` | The manifest: the plugin's name, fields and blocks. Runs on the server |
| `client.tsx` | What reaches the dashboard's browser code |
| `render.tsx` | How blocks and fields look on a public site |
| `fields/note/` | A field type, `acme_note`: its definition, input, front-end view and test |

Field types and blocks must start with the plugin's name, with hyphens as underscores. The generated `acme_note` holds a heading and some text, and `acme_note_card` is a block that uses it in stream fields.

## 3. Try it in your site

```sh
npm install ./plugins/acme
```

Add it to `tansy.config.ts`:

```ts
import { acmePlugin } from "@your-scope/cms-acme";

export default defineCms({
  plugins: [acmePlugin()],
  // ...what was already here
});
```

Run `npm run dev`. Open a collection's schema and add a stream field. **Note card** is in its block list. Add one to a record, and save.

The field also appears directly in the schema editor as **Note**.

## 4. Show it on your site

A theme picks up the plugin's `render.tsx` by itself, so the `blank` theme renders a Note card with no more code.

## 5. Change it

Edit `fields/note/index.ts` to change what's stored, `input.tsx` for the dashboard's form, and `view.tsx` for the site. To add another field:

```sh
npx tansy field new rating --plugin plugins/acme
```

`fields/index.ts`, `client.ts` and `render.ts` are rebuilt each time, so don't edit those. Everything else is yours.

## 6. Test it

From `plugins/acme`:

```sh
npm test
```

Each field's `field.test.mjs` uses `testFieldDefinition`, which checks your valid and invalid examples, and that values survive being stored on both databases.

## 7. Publish it

Check `name`, `version` and `peerDependencies` in `package.json`, and add a `license`. Give
`peerDependencies` a real range rather than `*` — `"tansy": "^0.1.0"` — or a site can install your
plugin beside a CMS it was never built for. Add a `files` list too, so the tarball holds your package
and nothing else that happens to be in the folder. Keep the `tansy-plugin` keyword: it's how the
dashboard's list of community packages finds yours.

```sh
cd plugins/acme
npm publish --access public
```

A plugin made this way ships TypeScript source, and `tansy sync` tells Next.js to compile it because
the manifest names `client` and `render` entries. If you remove both, a site installing the plugin
has to add it to `transpilePackages` itself.

Compiling before you publish avoids that question altogether, and is what the first-party plugins do:
point `exports` at the compiled `.js` and its `.d.ts` instead of the source, so a site gets types
without compiling your package. `scripts/build-packages.mjs` in the tansy repository is one way to
do it — one `tsc` run per package, in the same layout, which keeps each `"use client"` on its own
file.

## 8. Install it somewhere else

In any other tansy app:

```sh
npm install @your-scope/cms-acme
```

Add the same import and `plugins` line, then rebuild. Run `npx tansy doctor` to confirm the setup and see what the plugin exposes.

## Before you publish

- A plugin runs with full access to the server, so say what yours does in its README.
- Secrets come from environment variables, never from options.
- A route needs an explicit `access`. Public routes need a `reason`, and `tansy doctor` shows it to whoever installs yours.
- Changing a stored value's shape needs `version` and `upgrade` on the field. See [Field types](../EXTENDING.md#field-types).
