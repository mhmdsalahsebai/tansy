import type { PluginRole } from "tansy/plugin";

/** The collections the blog creates on first install. Owners can change all of it afterwards. */

export const COLLECTIONS = ["blog-categories", "blog-tags", "blog-posts", "blog-comments", "blog-home"] as const;

/** Blocks a post's body allows when it's created. Owners can add their own. */
export const BODY_BLOCKS = ["blog_text", "blog_image", "blog_quote", "blog_code", "blog_embed", "blog_callout"];

/** Who writes and who runs the blog. Created once, then owners change them under Roles like any other. */
export function blogRoles(): PluginRole[] {
  const writing: NonNullable<PluginRole["permissions"]> = ["dashboard:access", "collection:read", "file:list", "file:read", "file:create"];
  return [
    {
      name: "blog-author",
      label: "Blog author",
      description: "Writes posts, and edits and deletes only their own. Their byline is their name.",
      permissions: writing,
      records: { "blog-posts": ["create", "list:own", "read:own", "update:own", "delete:own"] },
    },
    {
      name: "blog-editor",
      label: "Blog editor",
      description: "Edits every post, category and tag, writes any byline, and moderates comments.",
      permissions: [...writing, "file:delete", "ext.blog:moderate", "ext.blog:credit"],
      records: Object.fromEntries(COLLECTIONS.map((slug) => [slug, ["list", "read", "create", "update", "delete"]])),
    },
  ];
}

/** Filled from the title or name when left empty, so it isn't required. */
const SLUG_FIELD = {
  name: "slug",
  type: "text",
  config: { unique: true, maxLength: 80, pattern: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$", patternError: "Use lowercase letters, numbers and hyphens, starting and ending with a letter or number." },
};

/** The name shown on a post. Filled from the writer's account, and only editors can change it. */
export const BYLINE_FIELD = { name: "byline", type: "text", config: { maxLength: 120 } };

const PUBLIC = { listRule: "", viewRule: "", createRule: null, updateRule: null, deleteRule: null };

/** A field the plugin's code reads or writes, by collection: the contract Extensions checks. */
export const CONTRACT = {
  "blog-posts": { slug: "text", title: "text", excerpt: "text", body: "stream", byline: "text", categories: "reference", tags: "reference", allowComments: "boolean", readingMinutes: "number" },
  "blog-categories": { slug: "text", name: "text" },
  "blog-tags": { slug: "text", name: "text" },
  "blog-comments": { post: "reference", parent: "reference", name: "text", body: "text", state: "radio" },
};

export function blogSchema(basePath: string) {
  return {
    version: 1,
    collections: [
      {
        slug: "blog-categories",
        name: "Categories",
        description: "Broad topics. A category can sit inside another.",
        urlPattern: `${basePath}/category/:slug`,
        rules: PUBLIC,
        fields: [
          SLUG_FIELD,
          { name: "name", type: "text", config: { required: true, maxLength: 120 } },
          { name: "description", type: "text", config: { multiline: true, maxLength: 1000 } },
          { name: "parent", type: "reference", config: { collection: "blog-categories", displayField: "name" } },
        ],
      },
      {
        slug: "blog-tags",
        name: "Tags",
        description: "Narrow topics, many to a post.",
        urlPattern: `${basePath}/tag/:slug`,
        rules: PUBLIC,
        fields: [
          SLUG_FIELD,
          { name: "name", type: "text", config: { required: true, maxLength: 120 } },
        ],
      },
      {
        slug: "blog-posts",
        name: "Posts",
        description: "Articles. A slug, excerpt and reading time are filled in when left empty.",
        urlPattern: `${basePath}/:slug`,
        rules: { listRule: 'status = "published"', viewRule: 'status = "published"', createRule: null, updateRule: null, deleteRule: null },
        fields: [
          { name: "title", type: "text", config: { required: true, maxLength: 200, searchable: true } },
          SLUG_FIELD,
          { name: "excerpt", type: "text", config: { multiline: true, maxLength: 500, searchable: true } },
          { name: "cover", type: "image", config: {} },
          { name: "body", type: "stream", config: { allowedBlocks: BODY_BLOCKS } },
          BYLINE_FIELD,
          { name: "categories", type: "reference", config: { collection: "blog-categories", displayField: "name", allowMultiple: true } },
          { name: "tags", type: "reference", config: { collection: "blog-tags", displayField: "name", allowMultiple: true } },
          { name: "featured", type: "boolean", config: {} },
          { name: "allowComments", type: "boolean", config: { defaultValue: true } },
          { name: "readingMinutes", type: "number", config: {} },
        ],
      },
      {
        slug: "blog-comments",
        name: "Comments",
        description: "Readers' comments. New ones wait for approval unless comments are open.",
        urlPattern: null,
        // Commenters also see their own comments while they wait, so a new comment doesn't seem to vanish.
        rules: { listRule: 'state = "approved" || (@request.auth.id != "" && createdById = @request.auth.id)', viewRule: 'state = "approved" || (@request.auth.id != "" && createdById = @request.auth.id)', createRule: '@request.auth.id != ""', updateRule: null, deleteRule: '@request.auth.id != "" && createdById = @request.auth.id' },
        fields: [
          { name: "post", type: "reference", config: { collection: "blog-posts", displayField: "title", required: true } },
          { name: "parent", type: "reference", config: { collection: "blog-comments", displayField: "name" } },
          { name: "name", type: "text", config: { required: true, maxLength: 80 } },
          { name: "body", type: "text", config: { required: true, multiline: true, maxLength: 5000 } },
          { name: "state", type: "radio", config: { options: [{ label: "Waiting for review", value: "pending" }, { label: "Approved", value: "approved" }, { label: "Spam", value: "spam" }], defaultValue: "pending" } },
        ],
      },
      {
        slug: "blog-home",
        name: "Blog home",
        description: "The heading and introduction of the blog's front page.",
        type: "singleton",
        urlPattern: basePath,
        rules: PUBLIC,
        fields: [
          { name: "title", type: "text", config: { required: true, maxLength: 120 } },
          { name: "intro", type: "stream", config: { allowedBlocks: BODY_BLOCKS } },
        ],
      },
    ],
    blocks: [],
  };
}
