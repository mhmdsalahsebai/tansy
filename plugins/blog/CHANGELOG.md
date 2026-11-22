# Changelog

What changed in each release of `@tansy/blog`. Releases up to 0.1.1 went out with every other
package on one version and are described in [tansy's changelog](../../CHANGELOG.md).

## 0.1.2 — 2026-11-22

The parts `@tansy/blog/render` exports now fit inside a theme's own design without CSS to undo them.

- **Parts carry no outer margin or border.** The plugin's own post page still places them as before,
  inside `.bl-main`, so it looks the same. A theme that embeds `MorePosts` or `PostComments` now gets
  no top margin, padding or rule above them, and `PostMeta`, `PostCategories`, `PostTags` and
  `PostList` bring no outer margin either. A theme that relied on that spacing sets it itself, as the
  blog, dispatch and magazine themes in this repository now do: until you upgrade those themes, the
  space and rule above "More posts" and the comments are missing on their post pages.
- **Headings are the theme's.** `PostComments` takes `heading`, `formHeading` and `headingLevel`, and
  `MorePosts` takes `heading` and `headingLevel`. A string replaces the text, `false` hides the
  heading while the section keeps the default text as its `aria-label`, and `headingLevel` (2 to 6)
  sets the main heading's level, with the form heading and the post titles in `MorePosts` one below.
  `PostList` takes `headingLevel` for its post titles. All new props are optional.
- **Ids no longer collide.** The headings take their ids from React's `useId`, so two parts on one
  page don't share `bl-comments-title` or `bl-more-title`.
- **Class hooks for every element a theme styles:** `bl-comments-title`, `bl-form-title`,
  `bl-more-title`, `bl-comments-empty` and `bl-replies`, beside the existing class names. Every rule
  weighs a single class, so one class of the theme's overrides it.
