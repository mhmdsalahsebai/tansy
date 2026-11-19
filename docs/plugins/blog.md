# Blog plugin (`@tansy/blog`)

Installing it turns the CMS into a blog: posts with bylines, categories and tags, author and editor roles, comments with moderation, RSS and Atom feeds, and public pages under any theme.

```ts
// tansy.config.ts
import { blog } from "@tansy/blog";

plugins: [blog({ siteUrl: "https://example.com", comments: "moderated", notify: "editor@example.com" })]
```

In the starter, `TANSY_PLUGIN_BLOG=true` turns it on, and so does `TANSY_THEME=blog`, because the blog theme requires it.

## 1. Scope

**Built**: posts, categories (nested), tags, author and editor roles, comments with one level of replies and moderation, RSS and Atom, a blog home page, category and tag archives with paging, reading time, related posts under each post, a moderation queue, a dashboard widget, bulk Approve and Spam actions, and the post page's parts exported for themes.

**Already in core, used as is**: drafts, revisions, scheduled publishing, the `publishedAt` every record gets when first published, full-text search (titles and excerpts are searchable), media, redirects, live preview, the `seo` plugin's sitemap and SEO fields.

**Later**: a monthly archive, author archives, anonymous comments (with `context.captcha`, see [the CAPTCHA plugin](captcha.md)), newsletter, series, co-authors, multiple languages, comment forms on a headless site.

## 2. Options

| Option | Default | What it does |
|---|---|---|
| `siteUrl` | required | Where the public site lives. Feeds need absolute links |
| `basePath` | `/blog` | The prefix of the URL patterns created on first install. After that, owners edit URL patterns in the dashboard |
| `comments` | `"moderated"` | `"off"`, `"moderated"` (new comments wait for review) or `"open"` (approved straight away) |
| `feedItems` | `20` | Entries in each feed |
| `notify` | none | An address emailed when a comment is waiting for review |

`comments`, `feedItems` and `notify` are only defaults. Holders of `ext.blog:moderate` change them under **Blog → Settings**, and they apply from the next request, without a rebuild.

## 3. Collections

Rules are listed as `list / view / create / update / delete`, where `null` means locked (staff with `record:*` only). The owner can change any of them, and add fields to any collection. The fields marked as contract are the ones the plugin's code relies on. **Dashboard → Extensions** reports any that go missing or change type, and the hooks skip fields that no longer exist rather than fail.

### `blog-posts`

URL `/blog/:slug`. Rules: `status = "published"` ×2, then `null` ×3.

| Field | Type | Contract | Notes |
|---|---|---|---|
| `title` | text, required, searchable | yes | |
| `slug` | text, unique | yes | Filled from the title when empty, made unique with `-2`, `-3` and so on |
| `excerpt` | text, searchable | yes | Filled from the first paragraph when empty |
| `cover` | image | | |
| `body` | stream | yes | Allows the blocks in §4. Owners can allow more |
| `byline` | text | yes | The writer's name, filled from their account when the post is created. Only someone with `ext.blog:credit` can choose or change it |
| `categories` | reference → `blog-categories`, multiple | yes | |
| `tags` | reference → `blog-tags`, multiple | yes | |
| `featured` | boolean | | Listed first on the blog home |
| `allowComments` | boolean, default true | yes | |
| `readingMinutes` | number | yes | Counted from the body's prose at 220 words a minute, whenever the body changes |

### `blog-categories`, `blog-tags`

Slugs are filled from the name when empty. Rules: `""` ×2, `null` ×3.

| Collection | URL | Fields |
|---|---|---|
| `blog-categories` | `/blog/category/:slug` | `slug`, `name`, `description`, `parent` (reference → itself) |
| `blog-tags` | `/blog/tag/:slug` | `slug`, `name` |

### `blog-comments`

No URL. Rules:

- list and view: `state = "approved" || (@request.auth.id != "" && createdById = @request.auth.id)`, so commenters also see their own comments while they wait
- create: `@request.auth.id != ""`
- update: `null`
- delete: `@request.auth.id != "" && createdById = @request.auth.id`

| Field | Type | Notes |
|---|---|---|
| `post` | reference → `blog-posts`, required | Can't change after creation |
| `parent` | reference → `blog-comments` | One level of replies, to an approved comment on the same post. Can't change |
| `name` | text, required, up to 80 | The display name the commenter gives |
| `body` | text, required, up to 5,000 | Plain text, so nobody can post markup |
| `state` | radio: pending, approved, spam | Set by the hook from the `comments` option, never by the commenter |

### `blog-home` (singleton)

URL `/blog`. Fields: `title` and `intro` (stream). Created with the title "Blog". It's the heading and introduction of the blog's front page, and the feeds' title.

## 4. Blocks

| Block | Fields | Notes |
|---|---|---|
| `blog_text` | `body` (rich text) | Same fields as the block the blog theme used to create, which the plugin adopts |
| `blog_quote` | `text`, `source` | As above |
| `blog_callout` | `tone` (note, tip, warning), `body` (rich text) | |
| `blog_image` | `image`, `alt`, `caption` | |
| `blog_embed` | `url`, `caption` | YouTube and Vimeo only, played through `youtube-nocookie.com` and `player.vimeo.com`, which `csp.frame` lists. Anything else shows as a link |
| `blog_code` | `code`, `language` | |

Blocks are global, so other collections can use them too.

## 5. Hooks

| Event | Collection | What it does |
|---|---|---|
| `record.beforeCreate`, `beforeUpdate` | posts, categories, tags | Fills a missing slug. For posts, also the excerpt and reading time, and the byline from the writer's name. Refuses byline changes from anyone without `ext.blog:credit` |
| `record.beforeCreate` | `blog-comments` | Refuses when comments are off, the post isn't visible to a visitor or is closed to comments, or the reply isn't one level deep on the same post. Allows 5 comments a minute per person, counted in `store`. Trims the name and body, and sets `state` |
| `record.beforeUpdate` | `blog-comments` | Refuses moving a comment to another post or thread |
| `record.afterCreate` | `blog-comments` | Emails `notify` about a pending comment |

## 6. Routes

| Method and path | Access | What it returns |
|---|---|---|
| `GET /feed.xml` (root) | public: "Feed readers fetch it signed out. It lists only published posts the list rule shows the caller." | RSS 2.0 |
| `GET /atom.xml` (root) | public, same reason | Atom |

Both filter on `status = "published"` as well as the list rule, so a signed-in editor's feed has no drafts either. Comments go through the normal records API, so the plugin adds no route for them: rules and hooks are enough.

## 7. Dashboard

`permissions: { "ext.blog": ["moderate", "credit"] }`. `moderate` only decides what the dashboard offers. `credit` lets someone choose whose name is on a post and link a profile to an account, and the hooks enforce it. Approving a comment needs `record:list` and `record:update` on Comments, granted under **Roles → Records by collection**.

### Roles

Migration `002-authors-are-people` creates two roles if they don't exist yet. Owners can change them under **Roles** afterwards, and upgrades leave them alone.

| Role | Can |
|---|---|
| `blog-author` | Open the dashboard, upload files, write posts, and list, read, edit and delete only the posts they created |
| `blog-editor` | Everything in every blog collection, delete files, write any byline, and moderate comments |

An author is a person with the `blog-author` role, and a post's author is whoever created it. There's no author collection. The post's `byline` holds the name shown on it, copied from the writer's account when the post is created, so the site never reads the users table.

- Without `ext.blog:credit`, the byline is always the writer's name, whatever they send, and can't be changed afterwards.
- With it, an editor can write any byline, such as a guest's. A post they write with no byline gets their name.

Migration `002-authors-are-people` adds `byline` to a site installed before it, and leaves `blog-authors` and the posts' `author` field in place, because migrations never delete data. Once you've copied any names you need into bylines, delete the `author` field under **Collections → Posts → Schema**, then the Authors collection.

| Slot | What |
|---|---|
| Section **Blog** | Posts, Categories, Tags, Comments to review, All comments, the blog home page, and Settings, each shown to whoever may open it |
| Page `blog/comments` (`ext.blog:moderate`) | Comments to review: pending comments, oldest first, with Approve and Spam buttons |
| Settings (`ext.blog:moderate`) | Comment mode, the address told about comments to review, posts in feeds |
| Widget | Comments waiting, drafts and published posts |
| `bulkActions` on `blog-comments` | Approve, Mark as spam |

## 8. Site pages

Plugin templates render inside the active theme's layout and use its `--site-*` tokens. A theme that ships its own template for one of these collections wins.

| Template | Shows |
|---|---|
| `blog-home` | Its title and intro, then 20 posts a page, featured ones first |
| `blog-posts` | Categories, title, byline, date, reading time, cover, body, tags, up to three posts sharing a tag (the latest when none do), comments |
| `blog-categories`, `blog-tags` | 20 posts a page |

Lists page with `?page=`, and a number past the last page is a 404. Links come from each collection's URL pattern through `recordPath`, so they follow whatever the owner sets. Approved comments are rendered on the server. The form is a client component that posts as the signed-in reader. It shows their own comment straight away, marked as waiting for review.

A theme can design its own post page and keep everything the plugin does on it. Its `blog-posts` template wins over the plugin's, receives the plugin's lists as `data`, and places the parts `@tansy/blog/render` exports. Each takes the template's `record` as `post`, and its `data`:

| Part | Shows |
|---|---|
| `PostMeta` | Byline, date and reading time |
| `PostCategories`, `PostTags` | Links to the archives |
| `MorePosts` | Related posts, or the latest, with an optional `heading` |
| `PostComments` | Approved comments and the form, unless the post has comments off |
| `PostList` | Any list of posts, given as `posts` |

The blog theme's post page is built this way.

## 9. Differences from the plan

- **No `publishedAt` field or hook.** Core already stamps every record with `publishedAt` on first publish.
- **Related posts and archives come from template queries.** They needed filters on the page's record, which led to `@record.<field>` in template filters, a core addition that themes can use too. Related posts are `tags ?= @record.tags && id != @record.id`.
- **No `postsPerPage` option.** Options reach the server, not the render module, so pages hold 20 posts. A theme that wants another number declares its own `posts` query for the template.
- **Commenters type their name.** Plugins can't read users' built-in details, such as their name. C4 gave them custom user fields only.
- **Slugs aren't required.** Validation runs before hooks, so a required slug would be refused before the hook could fill it. The slug pattern avoids nested repeats, which core refuses as a hang risk.
- **The blog theme's post page is its own,** made of the parts above, so it follows the theme's `showDates` option and keeps comments.

## 10. Tests

- `tests/unit/site.test.ts`: the blog theme's own post page, made of the plugin's parts and given the plugin's lists, and its paged home page.
- `tests/unit/blog-plugin.test.ts`: slugs, reading time, excerpts, embeds, feed escaping, options, schema against the contract, the adopted theme blocks, and every hook against an in-memory context.
- `tests/integration/blog.test.ts`, against a running server with the plugin on:
  - The install creates everything, and Extensions reports the fields as expected.
  - Slugs, excerpts and reading time are filled.
  - Posts, archives and feeds are served, with links from URL patterns.
  - Posts sharing a tag lead "More posts", and a page past the end of a list is a 404.
  - Drafts stay out of pages, lists and feeds, including for a superadmin's feed.
  - An author's byline is their name, they can't change it, and an editor can.
  - Comments are refused to visitors and on drafts or closed posts.
  - A comment waits for review even when the commenter asks for `approved`, and is visible only to its author until then.
  - The moderator is emailed.
  - A commenter can't approve their own comment, staff can't move one, and nobody can delete another person's.
  - Approved comments render as plain text, replies go one level deep, posting is rate-limited, and authors can delete their own comments.

## 11. Open questions

- Should comment authors be able to edit a comment for a short time? That needs a time comparison in the update rule. Not in 0.1.

## With tenants

With the multi-tenant plugin (or another row scope provider), each tenant keeps its own data. Comments, their notifications and the number of feed items can differ per tenant. The feed's links use the tenant's own domain, or its path prefix on this app's address until it has one.
