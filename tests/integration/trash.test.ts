/**
 * The trash: a delete is recoverable. A record goes to the trash, comes back under its own id
 * with the links other records had to it, and holds its files until its entry goes. Runs after
 * auth.test.ts, which completes first-run setup.
 */
import { beforeAll, describe, expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");
const PASSWORD = "correct-horse-battery-staple-9431";

interface Actor { id: string; cookie: string }
let root: Actor, outsider: Actor, staff: Actor;
let authors: number, posts: number;
let postTitle: number;

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

const ok = (r: { status: number; text: string }) => expect(r.status, r.text).toBeLessThan(300);

async function signIn(email: string): Promise<Actor> {
  const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, { method: "POST", headers: { origin: baseUrl, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie().map((c) => c.split(";")[0]).filter((pair) => !pair.endsWith("=")).join("; ");
  return { id: (await response.json()).user.id, cookie };
}

/** Records by field name, as the public API takes and returns them. */
const record = (slug: string, suffix = "") => `/api/collections/${slug}/records${suffix}`;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

async function upload(name: string) {
  const response = await fetch(`${baseUrl}/api/files/upload?name=${name}`, { method: "POST", headers: { origin: baseUrl, cookie: root.cookie, "content-type": "image/png" }, body: PNG });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()).id as string;
}

async function trashOf(collectionId: number, recordId: number) {
  const list = await call("/api/trash?perPage=200", { as: root });
  ok(list);
  return list.json.items.find((item: { collectionId: number; recordId: number }) => item.collectionId === collectionId && item.recordId === recordId);
}

beforeAll(async () => {
  root = await signIn("root@example.test");
  const made = await call("/api/users", { method: "POST", as: root, body: { name: "trashOutsider", email: "trashoutsider@example.test", password: PASSWORD, role: "user" } });
  ok(made);
  outsider = await signIn("trashoutsider@example.test");
  // Dashboard access, so the trash page opens, but no record permissions at all.
  ok(await call("/api/roles", { method: "POST", as: root, body: { name: "trash-watcher", label: "Trash watcher", permissions: ["dashboard:access", "collection:read"] } }));
  ok(await call("/api/users", { method: "POST", as: root, body: { name: "trashStaff", email: "trashstaff@example.test", password: PASSWORD, role: "trash-watcher" } }));
  staff = await signIn("trashstaff@example.test");

  const a = await call("/api/collections", { method: "POST", as: root, body: { name: "Trash authors", slug: "trash-authors", fields: [{ name: "name", type: "text" }] } });
  ok(a);
  authors = a.json.id;

  const p = await call("/api/collections", { method: "POST", as: root, body: {
    name: "Trash posts",
    slug: "trash-posts",
    fields: [
      { name: "title", type: "text" },
      { name: "author", type: "reference", config: { collection: authors } },
      { name: "tags", type: "reference", config: { collection: authors, allowMultiple: true } },
      { name: "cover", type: "image" },
    ],
  } });
  ok(p);
  posts = p.json.id;
  postTitle = p.json.fields[0].id as number;
  expect(postTitle).toBeGreaterThan(0);
  // Anyone signed in may read both, so the outsider's refusals are about permissions, not visibility.
  for (const id of [authors, posts]) {
    ok(await call(`/api/collections/${id}/rules`, { method: "PUT", as: root, body: { listRule: "", viewRule: "", createRule: null, updateRule: null, deleteRule: null } }));
  }
});

describe("deleting a record", () => {
  it("keeps it in the trash, and puts it back under its own id with the links to it", async () => {
    const author = await call(record("trash-authors"), { method: "POST", as: root, body: { status: "published", name: "Ada" } });
    ok(author);
    const authorId = author.json.id as number;
    const single = await call(record("trash-posts"), { method: "POST", as: root, body: { status: "published", title: "One", author: authorId } });
    ok(single);
    const listed = await call(record("trash-posts"), { method: "POST", as: root, body: { status: "published", title: "Two", tags: [authorId] } });
    ok(listed);

    ok(await call(record("trash-authors", `/${authorId}`), { method: "DELETE", as: root }));
    expect((await call(record("trash-authors", `/${authorId}`), { as: root })).status).toBe(404);
    // The delete cleared the links to it, as it always has.
    expect((await call(record("trash-posts", `/${single.json.id}`), { as: root })).json.author).toBeNull();
    expect((await call(record("trash-posts", `/${listed.json.id}`), { as: root })).json.tags).toEqual([]);

    const entry = await trashOf(authors, authorId);
    expect(entry, "the deleted record is in the trash").toBeTruthy();
    expect(entry.label).toBe("Ada");
    expect(entry.status).toBe("published");
    expect(entry.canRestore).toBe(true);

    ok(await call(`/api/collections/${authors}/trash/${entry.id}/restore`, { method: "POST", as: root }));
    const back = await call(record("trash-authors", `/${authorId}`), { as: root });
    ok(back);
    expect(back.json.id).toBe(authorId);
    expect(back.json.name).toBe("Ada");
    expect(back.json.status).toBe("published");
    // The links other records had are back too, where nothing has filled them since.
    expect((await call(record("trash-posts", `/${single.json.id}`), { as: root })).json.author).toBe(authorId);
    expect((await call(record("trash-posts", `/${listed.json.id}`), { as: root })).json.tags).toEqual([authorId]);
    expect(await trashOf(authors, authorId), "the entry goes with the restore").toBeFalsy();
  });

  it("leaves a link that has been filled since alone", async () => {
    const first = await call(record("trash-authors"), { method: "POST", as: root, body: { name: "Grace" } });
    const second = await call(record("trash-authors"), { method: "POST", as: root, body: { name: "Alan" } });
    const post = await call(record("trash-posts"), { method: "POST", as: root, body: { title: "Filled", author: first.json.id } });
    ok(post);
    ok(await call(record("trash-authors", `/${first.json.id}`), { method: "DELETE", as: root }));
    ok(await call(record("trash-posts", `/${post.json.id}`), { method: "PATCH", as: root, body: { author: second.json.id } }));

    const entry = await trashOf(authors, first.json.id);
    ok(await call(`/api/collections/${authors}/trash/${entry.id}/restore`, { method: "POST", as: root }));
    expect((await call(record("trash-posts", `/${post.json.id}`), { as: root })).json.author).toBe(second.json.id);
  });

  it("holds the files it used until its entry goes", async () => {
    const fileId = await upload("cover.png");
    const post = await call(record("trash-posts"), { method: "POST", as: root, body: { title: "With a cover", cover: fileId } });
    ok(post);
    ok(await call(record("trash-posts", `/${post.json.id}`), { method: "DELETE", as: root }));

    const refused = await call(`/api/files/${fileId}`, { method: "DELETE", as: root });
    expect(refused.status, refused.text).toBe(409);
    expect(refused.json.error.code).toBe("CONFLICT");

    const entry = await trashOf(posts, post.json.id);
    ok(await call(`/api/collections/${posts}/trash/${entry.id}`, { method: "DELETE", as: root }));
    expect(await trashOf(posts, post.json.id)).toBeFalsy();
    ok(await call(`/api/files/${fileId}`, { method: "DELETE", as: root }));
  });

  it("refuses the id to someone without record:delete there, and shows them nothing", async () => {
    const author = await call(record("trash-authors"), { method: "POST", as: root, body: { name: "Hidden" } });
    ok(author);
    ok(await call(record("trash-authors", `/${author.json.id}`), { method: "DELETE", as: root }));
    const entry = await trashOf(authors, author.json.id);

    // Without dashboard access the list isn't theirs to open at all.
    expect((await call("/api/trash", { as: outsider })).status).toBe(403);
    // With dashboard access but no record:delete anywhere, the list is empty rather than refused.
    const theirs = await call("/api/trash", { as: staff });
    ok(theirs);
    expect(theirs.json.items).toEqual([]);
    expect(theirs.json.totalItems).toBe(0);
    for (const as of [outsider, staff]) {
      expect((await call(`/api/collections/${authors}/trash/${entry.id}/restore`, { method: "POST", as })).status).toBe(403);
      expect((await call(`/api/collections/${authors}/trash/${entry.id}`, { method: "DELETE", as })).status).toBe(403);
    }
    // Another collection's id doesn't reach it either.
    expect((await call(`/api/collections/${posts}/trash/${entry.id}/restore`, { method: "POST", as: root })).status).toBe(404);
    ok(await call(`/api/collections/${authors}/trash/${entry.id}`, { method: "DELETE", as: root }));
  });

  it("is permanent again once the trash is turned off", async () => {
    const read = await call("/api/settings/auth", { as: root });
    ok(read);
    const settings = read.json.settings;
    ok(await call("/api/settings/auth", { method: "PUT", as: root, body: { ...settings, trash: { ...settings.trash, enabled: false } } }));
    try {
      const author = await call(record("trash-authors"), { method: "POST", as: root, body: { name: "Gone" } });
      ok(author);
      ok(await call(record("trash-authors", `/${author.json.id}`), { method: "DELETE", as: root }));
      expect(await trashOf(authors, author.json.id)).toBeFalsy();
    } finally {
      ok(await call("/api/settings/auth", { method: "PUT", as: root, body: { ...settings, trash: { ...settings.trash, enabled: true } } }));
    }
  });
});
