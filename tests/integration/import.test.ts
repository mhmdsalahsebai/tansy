/**
 * Importing records from a file: a preview, a dry run that writes nothing, then the import,
 * with per-row errors and matching on a unique field. Runs after auth.test.ts, which completes
 * first-run setup.
 */
import { beforeAll, describe, expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");
const PASSWORD = "correct-horse-battery-staple-9431";

interface Actor { id: string; cookie: string }
let root: Actor, adder: Actor;
let posts: number, authors: number, authorId: number;

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

const importInto = (collection: number, body: unknown, as: Actor = root) => call(`/api/collections/${collection}/import`, { method: "POST", as, body });
const records = (slug: string, suffix = "") => `/api/collections/${slug}/records${suffix}`;

beforeAll(async () => {
  root = await signIn("root@example.test");
  ok(await call("/api/roles", { method: "POST", as: root, body: { name: "import-adder", label: "Adder", permissions: ["dashboard:access", "collection:read", "record:list", "record:read", "record:create"] } }));
  ok(await call("/api/users", { method: "POST", as: root, body: { name: "importAdder", email: "importadder@example.test", password: PASSWORD, role: "import-adder" } }));
  adder = await signIn("importadder@example.test");

  const a = await call("/api/collections", { method: "POST", as: root, body: { name: "Import authors", slug: "import-authors", fields: [{ name: "name", type: "text" }] } });
  ok(a);
  authors = a.json.id;
  const author = await call(records("import-authors"), { method: "POST", as: root, body: { name: "Ada" } });
  ok(author);
  authorId = author.json.id;

  const made = await call("/api/collections", { method: "POST", as: root, body: {
    name: "Import posts",
    slug: "import-posts",
    fields: [
      { name: "title", type: "text", config: { required: true } },
      { name: "slug", type: "text", config: { unique: true } },
      { name: "views", type: "number" },
      { name: "live", type: "boolean" },
      { name: "author", type: "reference", config: { collection: authors } },
    ],
  } });
  ok(made);
  posts = made.json.id;
  ok(await call(`/api/collections/${posts}/rules`, { method: "PUT", as: root, body: { listRule: "", viewRule: "", createRule: null, updateRule: null, deleteRule: null } }));
});

describe("importing records", () => {
  const csv = (rows: string[]) => ["title,slug,views,live,author", ...rows].join("\n");

  it("previews the file without writing anything", async () => {
    const preview = await importInto(posts, { csv: csv([`First,first,10,true,${authorId}`, `Second,second,20,false,${authorId}`]), preview: true });
    ok(preview);
    expect(preview.json.columns).toEqual(["title", "slug", "views", "live", "author"]);
    expect(preview.json.total).toBe(2);
    expect(preview.json.mapping).toEqual({ title: "title", slug: "slug", views: "views", live: "live", author: "author" });
    expect(preview.json.sample[0]).toEqual({ title: "First", slug: "first", views: "10", live: "true", author: String(authorId) });
    expect((await call(records("import-posts"))).json.totalItems).toBe(0);
  });

  it("checks every row on a dry run, then writes them as typed values", async () => {
    const body = { csv: csv([`First,first,10,true,${authorId}`, `Second,second,20,false,${authorId}`]), status: "published" };
    const checked = await importInto(posts, { ...body, dryRun: true });
    ok(checked);
    expect(checked.json).toMatchObject({ dryRun: true, total: 2, created: 2, updated: 0, failed: 0 });
    expect((await call(records("import-posts"))).json.totalItems).toBe(0);

    const done = await importInto(posts, body);
    ok(done);
    expect(done.json).toMatchObject({ dryRun: false, created: 2, updated: 0, failed: 0 });
    const listed = await call(records("import-posts", "?perPage=50&sort=slug"));
    ok(listed);
    expect(listed.json.totalItems).toBe(2);
    const first = listed.json.items.find((item: { slug: string }) => item.slug === "first");
    expect(first).toMatchObject({ title: "First", views: 10, live: true, author: authorId, status: "published" });
  });

  it("updates the records a unique column already names, and adds the rest", async () => {
    const result = await importInto(posts, { csv: csv([`First again,first,11,true,${authorId}`, `Third,third,30,true,${authorId}`]), keyField: "slug" });
    ok(result);
    expect(result.json).toMatchObject({ created: 1, updated: 1, failed: 0 });
    const read = await call(records("import-posts", "?perPage=50&filter=" + encodeURIComponent('slug = "first"')));
    expect(read.json.items[0]).toMatchObject({ title: "First again", views: 11 });
    // The record kept its id, so it was updated rather than replaced.
    expect(read.json.items[0].id).toBeLessThan((await call(records("import-posts", "?perPage=50&filter=" + encodeURIComponent('slug = "third"')))).json.items[0].id);
  });

  it("reports the row and the field that failed, and stops or goes on as asked", async () => {
    const rows = [`Bad,bad-a,lots,true,${authorId}`, `Fine,fine-a,5,true,${authorId}`];
    const stopped = await importInto(posts, { csv: csv(rows) });
    ok(stopped);
    expect(stopped.json).toMatchObject({ created: 0, failed: 1, remaining: 1 });
    expect(stopped.json.rows[0]).toMatchObject({ row: 2, action: "failed", field: "views" });
    expect(stopped.json.rows[0].error).toMatch(/isn't a number/);
    expect((await call(records("import-posts", '?perPage=50&filter=' + encodeURIComponent('slug = "fine-a"')))).json.totalItems).toBe(0);

    const carried = await importInto(posts, { csv: csv(rows), onError: "skip" });
    ok(carried);
    expect(carried.json).toMatchObject({ created: 1, failed: 1, remaining: 0 });
    expect((await call(records("import-posts", '?perPage=50&filter=' + encodeURIComponent('slug = "fine-a"')))).json.totalItems).toBe(1);
  });

  it("refuses a file whose columns don't match, a missing required value, and a file that is too big", async () => {
    const unknown = await importInto(posts, { csv: "title,nonsense\nHello,x" });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error.message).toMatch(/no field for "nonsense"/);
    // Mapping it away is accepted.
    ok(await importInto(posts, { csv: "title,nonsense\nMapped away,x", mapping: { title: "title", nonsense: "" }, dryRun: true }));

    const missing = await importInto(posts, { csv: csv([`,no-title,1,true,${authorId}`]), dryRun: true });
    ok(missing);
    expect(missing.json.rows[0]).toMatchObject({ action: "failed", field: "title" });

    const many = await importInto(posts, { csv: csv(Array.from({ length: 2001 }, (_, i) => `Row ${i},row-${i},1,true,${authorId}`)), dryRun: true });
    expect(many.status).toBe(400);
    expect(many.json.error.message).toMatch(/at most 2,?000 rows/);
  });

  it("needs record:create, and record:update to match existing records", async () => {
    // Someone with neither reaches nothing.
    expect((await call(`/api/collections/${posts}/import`, { method: "POST", body: { csv: csv(["X,x,1,true,1"]) } })).status).toBe(401);

    const added = await importInto(posts, { csv: csv([`Theirs,theirs,1,true,${authorId}`]) }, adder);
    ok(added);
    expect(added.json).toMatchObject({ created: 1, failed: 0 });

    // Matching an existing record would be an update, which they may not do.
    const refused = await importInto(posts, { csv: csv([`Theirs again,theirs,2,true,${authorId}`]), keyField: "slug" }, adder);
    ok(refused);
    expect(refused.json).toMatchObject({ created: 0, updated: 0, failed: 1 });
    expect(refused.json.rows[0].error).toMatch(/may not update/);
  });

  it("takes JSON rows with values already typed", async () => {
    const result = await importInto(posts, { rows: [{ title: "From JSON", slug: "from-json", views: 99, live: true, author: authorId }] });
    ok(result);
    expect(result.json).toMatchObject({ created: 1, failed: 0 });
    const read = await call(records("import-posts", "?perPage=50&filter=" + encodeURIComponent('slug = "from-json"')));
    expect(read.json.items[0]).toMatchObject({ views: 99, live: true });
  });
});
