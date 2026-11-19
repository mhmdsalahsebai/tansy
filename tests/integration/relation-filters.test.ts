/**
 * Filters that follow a relation, as in `author.name = "x"`.
 *
 * The target collection's **view rule** decides which related records a filter can see,
 * the same rule expand applies. So a filter can narrow by a related field without being
 * able to probe a related record the caller may not view, and the target's list rule has
 * no say: these are not a list of that collection.
 *
 * Runs after auth.test.ts, which completes setup.
 */
import { beforeAll, describe, expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");
const PASSWORD = "correct-horse-battery-staple-9431";

interface Actor { id: string; cookie: string }
let root: Actor;
let authors: number, posts: number;
let authorName: number, postTitle: number, postAuthor: number;
let ada: number, bob: number;

async function call(path: string, { method = "GET", body, as }: { method?: string; body?: unknown; as?: Actor | null } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    redirect: "manual",
    headers: { origin: baseUrl, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(as ? { cookie: as.cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any -- API responses have many shapes
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json, text };
}

async function signIn(email: string): Promise<Actor> {
  const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, { method: "POST", headers: { origin: baseUrl, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie().map((c) => c.split(";")[0]).filter((pair) => !pair.endsWith("=")).join("; ");
  return { id: (await response.json()).user.id, cookie };
}

async function collection(name: string, slug: string, fields: unknown[]) {
  const made = await call("/api/collections", { method: "POST", as: root, body: { name, slug, fields } });
  expect(made.status, made.text).toBe(200);
  return made.json as { id: number; fields: Array<{ id: number; name: string }> };
}

async function rules(id: number, set: Record<string, string | null>) {
  const body = { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, ...set };
  const put = await call(`/api/collections/${id}/rules`, { method: "PUT", as: root, body });
  expect(put.status, put.text).toBeLessThan(300);
}

async function record(id: number, status: "draft" | "published", values: Array<{ fieldId: number; value: unknown }>) {
  const made = await call(`/api/collections/${id}/content`, { method: "POST", as: root, body: { status, values } });
  expect(made.status, made.text).toBe(200);
  return made.json.id as number;
}

/** The titles an actor sees, or the error code when the filter is refused. */
async function titles(filter: string, as: Actor | null = null) {
  const found = await call(`/api/collections/rel-posts/records?filter=${encodeURIComponent(filter)}&sort=title`, { as });
  if (found.status !== 200) return { code: found.json?.error?.code as string, message: found.json?.error?.message as string };
  return { titles: (found.json.items as Array<{ title: string }>).map((item) => item.title) };
}

beforeAll(async () => {
  root = await signIn("root@example.test");
  const authorsCollection = await collection("Rel authors", "rel-authors", [
    { name: "name", type: "text" },
    // Only a caller with record:read sees a hidden field, so only they can follow one.
    { name: "secret", type: "text", config: { hidden: true } },
  ]);
  authors = authorsCollection.id;
  authorName = authorsCollection.fields.find((field) => field.name === "name")!.id;

  const authorSecret = authorsCollection.fields.find((field) => field.name === "secret")!.id;

  const postsCollection = await collection("Rel posts", "rel-posts", [
    { name: "title", type: "text" },
    { name: "author", type: "reference", config: { collection: authors } },
  ]);
  posts = postsCollection.id;
  postTitle = postsCollection.fields.find((field) => field.name === "title")!.id;
  postAuthor = postsCollection.fields.find((field) => field.name === "author")!.id;

  // Authors can be viewed once published, and only an administrator can list them.
  await rules(authors, { viewRule: 'status = "published"' });
  // Every post is public, so what a filter shows can only be the relation's doing.
  await rules(posts, { listRule: "", viewRule: "" });

  ada = await record(authors, "published", [{ fieldId: authorName, value: "Ada" }, { fieldId: authorSecret, value: "classified" }]);
  bob = await record(authors, "draft", [{ fieldId: authorName, value: "Bob" }]);
  await record(posts, "published", [{ fieldId: postTitle, value: "By Ada" }, { fieldId: postAuthor, value: ada }]);
  await record(posts, "published", [{ fieldId: postTitle, value: "By Bob" }, { fieldId: postAuthor, value: bob }]);
  await record(posts, "published", [{ fieldId: postTitle, value: "By nobody" }]);
});

describe("following a relation in a filter", () => {
  it("narrows by a field of the related record", async () => {
    expect(await titles('author.name = "Ada"')).toEqual({ titles: ["By Ada"] });
  });

  it("works through every operator the evaluator defines, the same on either database", async () => {
    expect(await titles('author.name ~ "da"')).toEqual({ titles: ["By Ada"] });
    expect(await titles('author.name != "Ada"')).toEqual({ titles: [] });
    expect(await titles('author.id > 0')).toEqual({ titles: ["By Ada"] });
  });

  it("can't see a related record the caller may not view, so it can't probe one", async () => {
    // Bob's author record is a draft, and the view rule only passes published ones.
    expect(await titles('author.name = "Bob"')).toEqual({ titles: [] });
    expect(await titles('author.name != "Bob"')).toEqual({ titles: ["By Ada"] });
    expect(await titles('author.name ~ ""')).toEqual({ titles: ["By Ada"] });
  });

  it("shows the same filter more once the caller may view the related record", async () => {
    expect(await titles('author.name = "Bob"', root)).toEqual({ titles: ["By Bob"] });
  });

  it("is decided by the target's view rule, not its list rule", async () => {
    // Only an administrator can list authors, and a filter through the relation still works.
    expect((await call("/api/collections/rel-authors/records")).status).toBe(403);
    expect(await titles('author.name = "Ada"')).toEqual({ titles: ["By Ada"] });
  });

  it("leaves a record with no related record out, whichever way the comparison runs", async () => {
    for (const filter of ['author.name = "Ada"', 'author.name != "Ada"', 'author.name = ""', 'author.name != ""']) {
      expect((await titles(filter)).titles).not.toContain("By nobody");
    }
  });

  it("refuses a field of the target the caller can't filter on", async () => {
    const refused = await titles('author.nope = "x"');
    expect(refused.code).toBe("INVALID_FILTER");
    expect(refused.message).toMatch(/no field "nope"/);
  });

  it("refuses a hidden field of the target, which only record:read may follow", async () => {
    // To a visitor a hidden field looks like one that isn't there, as it does everywhere else.
    const refused = await titles('author.secret = "classified"');
    expect(refused.code).toBe("INVALID_FILTER");
    expect(refused.message).toMatch(/no field "secret"/);
    // Staff hold record:read, so for them it is a field like any other.
    expect(await titles('author.secret = "classified"', root)).toEqual({ titles: ["By Ada"] });
  });

  it("refuses more than one relation at a time", async () => {
    const refused = await titles('author.author.name = "x"');
    expect(refused.code).toBe("INVALID_FILTER");
  });

  it("refuses comparing one relation with another", async () => {
    const refused = await titles("author.name = author.id");
    expect(refused.code).toBe("INVALID_FILTER");
  });
});

describe("following a relation backwards", () => {
  const byAuthor = async (filter: string, as: Actor | null = null) => {
    const found = await call(`/api/collections/rel-authors/records?filter=${encodeURIComponent(filter)}&sort=name`, { as });
    if (found.status !== 200) return { code: found.json?.error?.code as string, message: found.json?.error?.message as string };
    return { names: (found.json.items as Array<{ name: string }>).map((item) => item.name) };
  };

  beforeAll(async () => {
    // Authors become listable so the reverse direction can be read; the posts' own view rule still decides.
    await rules(authors, { listRule: "", viewRule: 'status = "published"' });
  });

  it("asks for the any form, because several records can point back", async () => {
    const refused = await byAuthor('rel-posts_via_author.title = "By Ada"', root);
    expect(refused.code).toBe("INVALID_FILTER");
    expect(refused.message).toMatch(/\?=/);
  });

  it("finds the records pointed at", async () => {
    expect(await byAuthor('rel-posts_via_author.title ?= "By Ada"', root)).toEqual({ names: ["Ada"] });
    expect(await byAuthor('rel-posts_via_author.title ?~ "By"', root)).toEqual({ names: ["Ada", "Bob"] });
    // The slug can also be written with underscores for its hyphens, as @collection takes it.
    expect(await byAuthor('rel_posts_via_author.title ?= "By Ada"', root)).toEqual({ names: ["Ada"] });
  });
});

describe("where a relation can't be followed", () => {
  it("refuses one in a realtime filter, which is checked record by record", async () => {
    // A real connection first: the subscribe route knows a client only once it is listening.
    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/api/realtime`, { headers: { cookie: root.cookie }, signal: controller.signal });
    const reader = stream.body!.getReader();
    let received = "";
    void (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; received += new TextDecoder().decode(value); } } catch { /* closed */ } })();
    try {
      for (let i = 0; i < 100 && !received.includes("PB_CONNECT"); i++) await new Promise((resolve) => setTimeout(resolve, 50));
      const clientId = /"clientId":"([^"]+)"/.exec(received)![1];
      const options = encodeURIComponent(JSON.stringify({ query: { filter: 'author.name = "Ada"' } }));
      const subscribed = await call("/api/realtime", { method: "POST", as: root, body: { clientId, subscriptions: [`rel-posts/*?options=${options}`] } });
      expect(subscribed.status).toBe(400);
      expect(subscribed.json.error.message).toMatch(/relation/i);
    } finally {
      controller.abort();
    }
  });

  it("refuses one in a saved rule, which has no collection to read when it runs", async () => {
    const saved = await call(`/api/collections/${posts}/rules`, { method: "PUT", as: root, body: { listRule: 'author.name = "Ada"', viewRule: "", createRule: null, updateRule: null, deleteRule: null } });
    expect(saved.status).toBe(400);
  });
});
