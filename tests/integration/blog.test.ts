/**
 * The blog plugin, installed the way a site owner would: on in tansy.config.ts and nothing else.
 * Runs after auth.test.ts, which completes setup and points mail at the test SMTP server.
 */
import net from "node:net";
import { beforeAll, describe, expect, inject, it } from "vitest";

const base = inject("baseUrl");
const PASSWORD = "correct-horse-battery-staple-9431";

interface Actor { id: string; cookie: string }
let root: Actor, reader: Actor, other: Actor;

async function call(path: string, { method = "GET", body, as }: { method?: string; body?: unknown; as?: Actor | null } = {}) {
  const response = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: { origin: base, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(as ? { cookie: as.cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any -- API responses have many shapes
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, text, headers: response.headers };
}

async function signIn(email: string): Promise<Actor> {
  const r = await call("/api/auth/sign-in/email", { method: "POST", body: { email, password: PASSWORD } });
  expect(r.status, r.text).toBe(200);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).filter((pair) => !pair.endsWith("=")).join("; ");
  return { id: r.json.user.id, cookie };
}

async function user(name: string) {
  const r = await call("/api/users", { method: "POST", as: root, body: { name, email: `${name}@example.test`, password: PASSWORD, role: "user" } });
  expect(r.status, r.text).toBe(200);
  return signIn(`${name}@example.test`);
}

const mailbox = () => new Promise<string[]>((resolve, reject) => {
  let data = "";
  net.connect(2588, "127.0.0.1").on("data", (c) => (data += c)).on("end", () => resolve(JSON.parse(data))).on("error", reject);
});

const records = (slug: string, suffix = "") => `/api/collections/${slug}/records${suffix}`;
const rich = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

async function create(slug: string, body: Record<string, unknown>, as: Actor = root) {
  const r = await call(records(slug), { method: "POST", as, body });
  expect(r.status, r.text).toBe(200);
  return r.json;
}

let post: { id: number; slug: string }, draft: { id: number; slug: string }, closed: { id: number };
let category: { id: number; slug: string }, tag: { id: number; slug: string };

beforeAll(async () => {
  root = await signIn("root@example.test");
  reader = await user("blogreader");
  other = await user("blogother");
});

describe("blog plugin: install", () => {
  it("creates its collections and the blog's front page, and reports its fields as expected", async () => {
    const slugs = ((await call("/api/collections", { as: root })).json as Array<{ slug: string }>).map((c) => c.slug);
    for (const slug of ["blog-posts", "blog-categories", "blog-tags", "blog-comments", "blog-home"]) expect(slugs).toContain(slug);
    expect(slugs).not.toContain("blog-authors");
    const home = await call("/blog");
    expect(home.status).toBe(200);
    expect(home.text).toContain('class="bl-main"');
    expect(home.text).toContain("No posts yet.");
    const extensions = await call("/dashboard/extensions", { as: root });
    expect(extensions.text).toContain("As expected");
  });
});

describe("blog plugin: content", () => {
  beforeAll(async () => {
    category = await create("blog-categories", { name: "Field Notes" });
    tag = await create("blog-tags", { name: "Rust & Ruby" });
  });

  it("fills slugs, the excerpt and reading time", async () => {
    expect(tag.slug).toBe("rust-ruby");
    post = await create("blog-posts", { status: "published", title: "Hello, World", body: [{ id: "b1", type: "blog_text", v: 1, value: { body: rich(words(450)) } }], byline: "Ada Writer", categories: [category.id], tags: [tag.id] });
    expect(post).toMatchObject({ slug: "hello-world", readingMinutes: 3 });
    expect((post as unknown as { excerpt: string }).excerpt).toMatch(/^word0 word1 .*…$/);
    const twin = await create("blog-posts", { status: "published", title: "Hello World" });
    expect(twin.slug).toBe("hello-world-2");
    draft = await create("blog-posts", { status: "draft", title: "Secret draft" });
    closed = await create("blog-posts", { status: "published", title: "No comments here", allowComments: false });
  });

  it("serves published posts, archives and feeds to visitors, and nothing of drafts", async () => {
    const page = await call(`/blog/${post.slug}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Hello, World");
    expect(page.text).toContain(`href="/blog/category/${category.slug}"`);
    expect(page.text).toContain("Rust &amp; Ruby");
    expect(page.text).toContain("3 min read");
    expect(page.text).toContain("Ada Writer");
    for (const archive of [`/blog/category/${category.slug}`, `/blog/tag/${tag.slug}`]) {
      const r = await call(archive);
      expect(r.status, archive).toBe(200);
      expect(r.text, archive).toContain(`href="/blog/${post.slug}"`);
    }
    expect((await call(`/blog/${draft.slug}`)).status).toBe(404);
    const listed = (await call(records("blog-posts"))).json.items.map((p: { id: number }) => p.id);
    expect(listed).toContain(post.id);
    expect(listed).not.toContain(draft.id);

    const rssFeed = await call("/feed.xml");
    expect(rssFeed.headers.get("content-type")).toContain("application/rss+xml");
    expect(rssFeed.text).toContain(`<link>${base}/blog/${post.slug}</link>`);
    expect(rssFeed.text).not.toContain("Secret draft");
    // Signed in with every permission, the feed still lists only what's published.
    expect((await call("/atom.xml", { as: root })).text).not.toContain("Secret draft");
    expect((await call("/atom.xml")).text).toContain(`<link href="${base}/blog/${post.slug}"/>`);
  });

  it("suggests posts that share a tag, and pages its lists", async () => {
    await create("blog-posts", { status: "published", title: "Tagged sibling", tags: [tag.id] });
    // Newer and untagged, so they lead the latest posts, and only the shared tag puts the sibling first.
    for (let i = 0; i < 4; i++) await create("blog-posts", { status: "published", title: `Filler ${i}` });
    const page = await call(`/blog/${post.slug}`);
    const more = page.text.slice(page.text.indexOf('class="bl-more"'), page.text.indexOf('class="bl-comments"'));
    expect(more).toContain("Tagged sibling");
    expect(more).not.toContain("Filler");
    expect((await call("/blog?page=1")).status).toBe(200);
    expect((await call("/blog?page=2")).status).toBe(404);
    expect((await call(`/blog/tag/${tag.slug}?page=2`)).status).toBe(404);
  });

});

describe("blog plugin: comments", () => {
  const comment = (as: Actor | null, body: Record<string, unknown>) => call(records("blog-comments"), { method: "POST", as, body: { name: "Reader", body: "Nice post.", ...body } });
  let mine: { id: number };

  it("are refused to visitors and on drafts or closed posts", async () => {
    expect((await comment(null, { post: post.id })).status).toBeGreaterThanOrEqual(400);
    for (const target of [draft.id, closed.id]) {
      const r = await comment(reader, { post: target });
      expect(r.status, r.text).toBe(400);
      expect(r.json.error.message).toMatch(/isn't taking comments/);
    }
  });

  it("wait for review whatever state the commenter asks for, visible only to their author", async () => {
    const r = await comment(reader, { post: post.id, state: "approved", body: "<script>alert(1)</script>" });
    expect(r.status, r.text).toBe(200);
    expect(r.json.state).toBe("pending");
    mine = r.json;
    const ids = async (as: Actor | null) => (await call(records("blog-comments", `?filter=${encodeURIComponent(`post = ${post.id}`)}`), { as })).json.items.map((c: { id: number }) => c.id);
    expect(await ids(null)).not.toContain(mine.id);
    expect(await ids(other)).not.toContain(mine.id);
    expect(await ids(reader)).toContain(mine.id);
  });

  it("email the moderator about a pending comment", async () => {
    for (let i = 0; i < 40; i++) {
      if ((await mailbox()).some((m) => m.includes("blog-moderator@example.test") && m.includes("waiting for review"))) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("No moderation email arrived.");
  });

  it("can't be approved, moved or deleted by anyone but the right people", async () => {
    expect((await call(records("blog-comments", `/${mine.id}`), { method: "PATCH", as: reader, body: { state: "approved" } })).status).toBe(403);
    expect((await call(records("blog-comments", `/${mine.id}`), { method: "DELETE", as: other })).status).toBe(404);
    const moved = await call(records("blog-comments", `/${mine.id}`), { method: "PATCH", as: root, body: { post: closed.id } });
    expect(moved.status).toBe(400);
    const approved = await call(records("blog-comments", `/${mine.id}`), { method: "PATCH", as: root, body: { state: "approved" } });
    expect(approved.status, approved.text).toBe(200);
  });

  it("show approved comments on the post page as plain text", async () => {
    const page = await call(`/blog/${post.slug}`);
    expect(page.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page.text).not.toContain("<script>alert(1)</script>");
  });

  it("take replies one level deep, and limit how fast one person posts", async () => {
    const reply = await comment(other, { post: post.id, parent: mine.id });
    expect(reply.status, reply.text).toBe(200);
    expect((await comment(other, { post: post.id, parent: reply.json.id })).json.error.message).toMatch(/one level deep/);
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await comment(other, { post: post.id })).status;
    expect(last).toBe(400);
  });

  it("can be deleted by their author", async () => {
    expect((await call(records("blog-comments", `/${mine.id}`), { method: "DELETE", as: reader })).status).toBe(204);
  });
});

describe("blog plugin: roles", () => {
  let writer: Actor, rival: Actor;
  let written: { id: number; byline: string; createdById: string };

  beforeAll(async () => {
    const make = async (name: string) => {
      const r = await call("/api/users", { method: "POST", as: root, body: { name, email: `${name}@example.test`, password: PASSWORD, role: "blog-author" } });
      expect(r.status, r.text).toBe(200);
      return signIn(`${name}@example.test`);
    };
    writer = await make("blogwriter");
    rival = await make("blogrival");
  });

  it("are created on install, authors limited to their own posts", async () => {
    const roles = (await call("/api/roles", { as: root })).json.roles as Array<{ name: string; permissions: string[]; system: boolean }>;
    const author = roles.find((r) => r.name === "blog-author")!;
    expect(author.system).toBe(false);
    expect(author.permissions.filter((p) => p.startsWith("record:")).every((p) => p === `record:create@c${p.match(/@c(\d+)/)![1]}` || p.endsWith(":own"))).toBe(true);
    expect(roles.find((r) => r.name === "blog-editor")!.permissions).toContain("ext.blog:moderate");
  });

  it("put a writer's name on their posts, which only an editor can change", async () => {
    written = await create("blog-posts", { title: "By a writer", byline: "Someone Famous" }, writer);
    expect(written.byline).toBe("blogwriter");
    expect(written.createdById).toBe(writer.id);
    expect((await call(records("blog-posts", `/${written.id}`), { method: "PATCH", as: writer, body: { byline: "Someone Famous" } })).status).toBe(400);
    const guest = await create("blog-posts", { title: "Guest post", byline: "A Guest" });
    expect(guest.byline).toBe("A Guest");
    expect((await call(records("blog-posts", `/${guest.id}`), { method: "PATCH", as: root, body: { byline: "Another Guest" } })).status).toBe(200);
  });

  it("show an author their own drafts on the dashboard home, and nobody else's", async () => {
    await create("blog-posts", { title: "Rival draft zq" }, rival);
    const home = await call("/dashboard", { as: writer });
    expect(home.status).toBe(200);
    expect(home.text).toContain("By a writer");
    expect(home.text).not.toContain("Rival draft zq");
  });

  it("let an author edit their own posts and see only those", async () => {
    expect((await call(records("blog-posts", `/${written.id}`), { method: "PATCH", as: writer, body: { title: "Edited" } })).status).toBe(200);
    const listed = await call(records("blog-posts", "?perPage=200"), { as: writer });
    expect(listed.json.items.length).toBeGreaterThan(0);
    // Their own drafts, plus published posts anyone may read.
    expect(listed.json.items.every((item: { status: string; createdById: string }) => item.createdById === writer.id || item.status === "published")).toBe(true);
  });

  it("refuse another author's posts, and published ones the author didn't write", async () => {
    expect((await call(records("blog-posts", `/${written.id}`), { method: "PATCH", as: rival, body: { title: "Mine now" } })).status).toBe(404);
    expect((await call(records("blog-posts", `/${written.id}`), { method: "DELETE", as: rival })).status).toBe(404);
    expect((await call(records("blog-posts", `/${written.id}`), { as: rival })).status).toBe(404);
    expect((await call(records("blog-posts", `/${post.id}`), { method: "PATCH", as: writer, body: { title: "Hijack" } })).status).toBe(404);
    expect((await call(records("blog-posts", `/${written.id}`), { method: "DELETE", as: writer })).status).toBe(204);
  });
});
