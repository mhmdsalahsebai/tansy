---
title: "Build a custom field"
description: "This guide builds a star rating that holds a score and a comment, and works in collections and inside stream fields. It ends as a working package. Fields live in plugins, so follow steps 1 to 3 of Write and publish a…"
---

This guide builds a star rating that holds a score and a comment, and works in collections and inside stream fields. It ends as a working package. Fields live in plugins, so follow steps 1 to 3 of [Write and publish a plugin](/docs/guides/plugins) first, using the name `acme`.

## 1. Generate the field

```sh
npx tansy field new rating --plugin plugins/acme
```

This adds `plugins/acme/fields/rating/`, with the field type `acme_rating`.

## 2. Define what's stored

Replace `fields/rating/index.ts`:

```ts
import { defineField } from "tansy/fields";
import { z } from "zod";

export const ratingField = defineField({
  type: "acme_rating",
  admin: { label: "Rating", description: "A score out of five, and a comment" },
  config: {},
  value: () => z.strictObject({ score: z.number().int().min(1).max(5), comment: z.string().max(500) }),
  storage: () => ({ sql: "json" }),
  normalize: (value) => {
    const rating = value as { comment?: unknown } | null;
    return rating && typeof rating === "object" && typeof rating.comment === "string" ? { ...rating, comment: rating.comment.trim() } : value;
  },
  search: (value) => [value.comment],
  summary: (value) => `${value.score} of 5`,
  operators: [],
});
```

The server enforces `value` on every write, including inside blocks. `normalize` runs first, must accept anything, and must leave a normalized value unchanged.

## 3. Build the input

Replace `fields/rating/input.tsx`:

```tsx
"use client";

import { defineFieldAdmin, type FieldInputProps } from "tansy/admin";

function RatingInput({ id, value, onChange, disabled, readOnly }: FieldInputProps) {
  const current = (value && typeof value === "object" ? value : {}) as { score?: number; comment?: string };
  const set = (next: { score?: number; comment?: string }) => onChange({ score: 1, comment: "", ...current, ...next });
  return (
    <div className="cms-grid cms-gap-3">
      <input id={id} type="number" min={1} max={5} aria-label="Score" className="cms-input cms-mt-1" disabled={disabled} readOnly={readOnly} value={current.score ?? ""} onChange={(event) => set({ score: Number(event.target.value) })} />
      <input type="text" aria-label="Comment" className="cms-input cms-mt-1" disabled={disabled} readOnly={readOnly} value={current.comment ?? ""} onChange={(event) => set({ comment: event.target.value })} />
    </div>
  );
}

export const ratingAdmin = defineFieldAdmin({ type: "acme_rating", Input: RatingInput });
```

`cms-*` classes and `--cms-*` tokens follow the site's brand colour and dark mode. Honour `disabled` and `readOnly`, because the server refuses a value someone wasn't allowed to change.

## 4. Build the front-end view

Replace `fields/rating/view.tsx`:

```tsx
import type { FieldRenderProps } from "tansy/react";

function RatingView({ value }: FieldRenderProps) {
  const { score, comment } = value as { score: number; comment: string };
  return <p><span aria-label={`${score} of 5`}>{"★".repeat(score)}</span> {comment}</p>;
}

export const ratingRenderers = { acme_rating: RatingView };
```

Keep server code out of this file, because it can run anywhere, including on a headless site.

## 5. Use it in a stream field

Add a block to `index.ts`:

```ts
defineBlock({
  name: "acme_review",
  label: "Review",
  category: "Content",
  fields: [{ name: "rating", type: "acme_rating", config: { required: true } }],
}),
```

Add its component to `render.tsx`, inside `defineRenderers`:

```tsx
function Review({ value, renderers }: BlockProps) {
  return <FieldValue type="acme_rating" value={value.rating} renderers={renderers} />;
}

export default defineRenderers({ blocks: { acme_note_card: NoteCard, acme_review: Review }, fields: fieldRenderers });
```

Restart `next dev`. **Review** is now in the block list of any stream field.

## 6. Test it

Replace the assertion in `fields/rating/field.test.mjs`:

```js
assert.deepEqual(testFieldDefinition(ratingField, {
  valid: [{ score: 5, comment: "Great" }],
  invalid: [{ score: 6, comment: "" }, "text"],
}), []);
```

Run `npm test` in `plugins/acme`. You now have a working package: publish it as in step 7 of [the plugin guide](/docs/guides/plugins#7-publish-it).

## Linking to records and files

A value that holds a record or file id must declare it, or nothing protects that link. `refs` gives it every check a built-in reference field gets, at any block depth:

```ts
refs: (value) => ({ records: [{ collection: "products", id: value.productId }] }),
```

See [Field types](/docs/extending#field-types) for `refs`, `version` and `upgrade`.
