/**
 * What a file is described as: its alternative text, caption and credit. Travels with the
 * records that use it, so a theme renders alt text without a read per file. Runs after
 * auth.test.ts, which completes first-run setup.
 */
import { beforeAll, describe, expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");
const PASSWORD = "correct-horse-battery-staple-9431";

interface Actor { id: string; cookie: string }
let root: Actor, author: Actor, stranger: Actor;
let posts: number;

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

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

async function upload(name: string, as: Actor) {
  const response = await fetch(`${baseUrl}/api/files/upload?name=${name}`, { method: "POST", headers: { origin: baseUrl, cookie: as.cookie, "content-type": "image/png" }, body: PNG });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()).id as string;
}

beforeAll(async () => {
  root = await signIn("root@example.test");
  // An author uploads and describes their own files without file:update.
  ok(await call("/api/roles", { method: "POST", as: root, body: { name: "text-author", label: "Author", permissions: ["dashboard:access", "collection:read", "file:create", "file:list", "record:list", "record:read", "record:create", "record:update"] } }));
  ok(await call("/api/users", { method: "POST", as: root, body: { name: "textAuthor", email: "textauthor@example.test", password: PASSWORD, role: "text-author" } }));
  author = await signIn("textauthor@example.test");
  ok(await call("/api/users", { method: "POST", as: root, body: { name: "textStranger", email: "textstranger@example.test", password: PASSWORD, role: "text-author" } }));
  stranger = await signIn("textstranger@example.test");

  const made = await call("/api/collections", { method: "POST", as: root, body: {
    name: "Text posts",
    slug: "text-posts",
    fields: [{ name: "title", type: "text" }, { name: "cover", type: "image" }],
  } });
  ok(made);
  posts = made.json.id;
  // Published posts are public, so a visitor reads the record and its file text.
  ok(await call(`/api/collections/${posts}/rules`, { method: "PUT", as: root, body: { listRule: 'status = "published"', viewRule: 'status = "published"', createRule: null, updateRule: null, deleteRule: null } }));
});

describe("describing a file", () => {
  it("is kept, and read back in the language asked for", async () => {
    const fileId = await upload("cat.png", root);
    ok(await call(`/api/files/${fileId}/text`, { method: "PATCH", as: root, body: { alt: "A grey cat asleep", credit: "Ada" } }));

    const info = await call(`/api/files/${fileId}/info`, { as: root });
    ok(info);
    expect(info.json.alt).toBe("A grey cat asleep");
    expect(info.json.credit).toBe("Ada");
    expect(info.json.caption).toBe("");

    // For editing, each language's own words, never a fallback's.
    const words = await call(`/api/files/${fileId}/text`, { as: root });
    ok(words);
    expect(words.json.words[words.json.primary]).toEqual({ alt: "A grey cat asleep", caption: "", credit: "Ada" });
    expect(words.json.languages.length).toBeGreaterThan(0);

    // One word at a time, leaving the others alone.
    ok(await call(`/api/files/${fileId}/text`, { method: "PATCH", as: root, body: { caption: "Asleep on a chair" } }));
    const after = await call(`/api/files/${fileId}/info`, { as: root });
    expect(after.json).toMatchObject({ alt: "A grey cat asleep", caption: "Asleep on a chair", credit: "Ada" });

    expect((await call(`/api/files/${fileId}/text`, { method: "PATCH", as: root, body: { alt: "x", locale: "zz" } })).status).toBe(400);
    expect((await call(`/api/files/${fileId}/text`, { method: "PATCH", as: root, body: {} })).status).toBe(400);
  });

  it("travels with the records that use it, to whoever may read them", async () => {
    const fileId = await upload("cover.png", root);
    ok(await call(`/api/files/${fileId}/text`, { method: "PATCH", as: root, body: { alt: "The cover" } }));
    const post = await call("/api/collections/text-posts/records", { method: "POST", as: root, body: { status: "published", title: "With a cover", cover: fileId } });
    ok(post);

    // A signed-out visitor, as a theme reads it.
    const read = await call(`/api/collections/text-posts/records/${post.json.id}`);
    ok(read);
    expect(read.json.files[fileId]).toEqual({ alt: "The cover", caption: "", credit: "" });
    const listed = await call("/api/collections/text-posts/records?perPage=50");
    ok(listed);
    expect(listed.json.items.find((item: { id: number }) => item.id === post.json.id).files[fileId].alt).toBe("The cover");

    // A record with no files says nothing about files.
    const plain = await call("/api/collections/text-posts/records", { method: "POST", as: root, body: { status: "published", title: "No cover" } });
    ok(plain);
    expect((await call(`/api/collections/text-posts/records/${plain.json.id}`)).json.files).toBeUndefined();
  });

  it("is open to whoever uploaded the file, and to nobody else without file:update", async () => {
    const mine = await upload("mine.png", author);
    ok(await call(`/api/files/${mine}/text`, { method: "PATCH", as: author, body: { alt: "My own upload" } }));
    expect((await call(`/api/files/${mine}/info`, { as: author })).json.alt).toBe("My own upload");

    // Another author can neither read the words for editing nor change them, and is told no
    // more than they would be about a file that isn't there.
    expect((await call(`/api/files/${mine}/text`, { as: stranger })).status).toBe(404);
    expect((await call(`/api/files/${mine}/text`, { method: "PATCH", as: stranger, body: { alt: "Not mine" } })).status).toBe(404);
    // Whoever holds file:update may describe any file.
    ok(await call(`/api/files/${mine}/text`, { method: "PATCH", as: root, body: { alt: "Described by staff" } }));
    expect((await call(`/api/files/${mine}/info`, { as: author })).json.alt).toBe("Described by staff");
  });
});

describe("a picture's focal point", () => {
  it("is kept, read back with the file, and travels with the records that use it", async () => {
    const fileId = await upload("focal.png", root);
    expect((await call(`/api/files/${fileId}/info`, { as: root })).json.focus).toBeNull();

    ok(await call(`/api/files/${fileId}/focus`, { method: "PATCH", as: root, body: { focus: { x: 30, y: 70 } } }));
    expect((await call(`/api/files/${fileId}/info`, { as: root })).json.focus).toEqual({ x: 30, y: 70 });

    const post = await call("/api/collections/text-posts/records", { method: "POST", as: root, body: { status: "published", title: "With a focal point", cover: fileId } });
    ok(post);
    // A signed-out visitor, as a theme reads it: the point comes with the record, beside its text.
    expect((await call(`/api/collections/text-posts/records/${post.json.id}`)).json.files[fileId].focus).toEqual({ x: 30, y: 70 });

    // Cleared, and then the middle again, which a record doesn't carry at all.
    ok(await call(`/api/files/${fileId}/focus`, { method: "PATCH", as: root, body: { focus: null } }));
    expect((await call(`/api/files/${fileId}/info`, { as: root })).json.focus).toBeNull();
    expect((await call(`/api/collections/text-posts/records/${post.json.id}`)).json.files[fileId].focus).toBeUndefined();
  });

  it("is refused outside the picture, and on anything that isn't one", async () => {
    const fileId = await upload("bounds.png", root);
    expect((await call(`/api/files/${fileId}/focus`, { method: "PATCH", as: root, body: { focus: { x: 140, y: 10 } } })).status).toBe(400);
    expect((await call(`/api/files/${fileId}/focus`, { method: "PATCH", as: root, body: { focus: { x: 10 } } })).status).toBe(400);

    const response = await fetch(`${baseUrl}/api/files/upload?name=notes.txt`, { method: "POST", headers: { origin: baseUrl, cookie: root.cookie, "content-type": "text/plain" }, body: "plain words" });
    const text = (await response.json()).id as string;
    expect((await call(`/api/files/${text}/focus`, { method: "PATCH", as: root, body: { focus: { x: 50, y: 50 } } })).status).toBe(400);
  });

  it("is placed by whoever may describe the file, and by nobody else", async () => {
    const mine = await upload("theirs.png", author);
    ok(await call(`/api/files/${mine}/focus`, { method: "PATCH", as: author, body: { focus: { x: 10, y: 20 } } }));
    expect((await call(`/api/files/${mine}/focus`, { method: "PATCH", as: stranger, body: { focus: { x: 1, y: 2 } } })).status).toBe(404);
    expect((await call(`/api/files/${mine}/info`, { as: author })).json.focus).toEqual({ x: 10, y: 20 });
  });

  it("decides what a cropping thumbnail keeps", async () => {
    // Forty by twenty, black on the left and white on the right, so which half a square
    // thumbnail keeps is visible in its bytes.
    const HALF = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAYAAAD/Rn+7AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAKklEQVRIx+3OMQ0AAAjAsPk3DSa4SJfsb9Vcfl2AgICAgICAgICAgJ+BC8N2yJqUBSQ8AAAAAElFTkSuQmCC", "base64");
    const made = await fetch(`${baseUrl}/api/files/upload?name=halves.png`, { method: "POST", headers: { origin: baseUrl, cookie: root.cookie, "content-type": "image/png" }, body: new Uint8Array(HALF) });
    expect(made.status, await made.clone().text()).toBe(200);
    const fileId = (await made.json()).id as string;

    const thumb = async () => {
      const response = await fetch(`${baseUrl}/api/files/${fileId}?thumb=100x100`, { headers: { origin: baseUrl, cookie: root.cookie } });
      expect(response.status, `thumbnail ${response.status}`).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/webp");
      return Buffer.from(await response.arrayBuffer());
    };

    ok(await call(`/api/files/${fileId}/focus`, { method: "PATCH", as: root, body: { focus: { x: 0, y: 50 } } }));
    const leftHalf = await thumb();
    ok(await call(`/api/files/${fileId}/focus`, { method: "PATCH", as: root, body: { focus: { x: 100, y: 50 } } }));
    const rightHalf = await thumb();
    // A new point is a new thumbnail, not the crop made for the old one.
    expect(leftHalf.equals(rightHalf), "the two focal points must crop different halves").toBe(false);
    expect(leftHalf.length).toBeGreaterThan(0);
  });
});

describe("replacing a file's bytes", () => {
  /** Two pixels by one, so a replace is visibly different bytes of the same kind. */
  const WIDE_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQI12PgOiHHdUIOAAZvAeHYWn2lAAAAAElFTkSuQmCC", "base64");

  const put = (id: string, body: Buffer | string, type: string, as: Actor) =>
    fetch(`${baseUrl}/api/files/${id}/bytes`, {
      method: "PUT",
      headers: { origin: baseUrl, cookie: as.cookie, "content-type": type },
      body: typeof body === "string" ? body : new Uint8Array(body),
    });

  it("keeps the id, so every record that uses the file shows the new picture", async () => {
    const fileId = await upload("replace-me.png", root);
    const before = await call(`/api/files/${fileId}/info`, { as: root });
    ok(before);
    ok(await call(`/api/files/${fileId}/text`, { method: "PATCH", as: root, body: { alt: "Kept across a replace" } }));
    const post = await call("/api/collections/text-posts/records", { method: "POST", as: root, body: { status: "published", title: "Replaced cover", cover: fileId } });
    ok(post);

    const replaced = await put(fileId, WIDE_PNG, "image/png", root);
    expect(replaced.status, await replaced.clone().text()).toBe(200);
    const after = (await replaced.json()) as { id: string; size: number; width: number; height: number };
    expect(after.id).toBe(fileId);
    expect(after.size).toBe(WIDE_PNG.length);
    expect(after.size).not.toBe(before.json.size);
    expect(after.width).toBe(2);

    // The record still points at the same file, which now serves the new bytes and keeps its text.
    const read = await call(`/api/collections/text-posts/records/${post.json.id}`);
    expect(read.json.cover).toBe(fileId);
    expect(read.json.files[fileId].alt).toBe("Kept across a replace");
    const served = await fetch(`${baseUrl}/api/files/${fileId}`, { headers: { origin: baseUrl, cookie: root.cookie } });
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer()).length).toBe(WIDE_PNG.length);
  });

  it("refuses bytes of another kind, and anyone without file:update", async () => {
    const fileId = await upload("kind.png", root);
    const wrong = await put(fileId, "just words", "text/plain", root);
    expect(wrong.status).toBe(409);
    expect((await wrong.json()).error.code).toBe("FILE_TYPE_CHANGED");

    // The uploader alone can't: these bytes are already published wherever the file is used.
    const mine = await upload("mine-bytes.png", author);
    expect((await put(mine, WIDE_PNG, "image/png", author)).status).toBe(403);
    expect((await put(mine, WIDE_PNG, "image/png", root)).status).toBe(200);
  });

  it("refuses an empty body", async () => {
    const fileId = await upload("empty.png", root);
    expect((await put(fileId, "", "image/png", root)).status).toBe(400);
  });
});

describe("liveness, readiness and metrics", () => {
  it("answer a load balancer with no credentials, and say nothing more than they must", async () => {
    const health = await call("/api/health");
    ok(health);
    expect(health.json).toMatchObject({ status: "ok" });
    expect(health.json.uptimeSeconds).toBeGreaterThanOrEqual(0);
    // No version for an anonymous caller.
    expect(health.text).not.toMatch(/\d+\.\d+\.\d+/);

    const ready = await call("/api/ready");
    ok(ready);
    expect(ready.json).toEqual({ ready: true, checks: { database: true, storage: true } });
  });

  it("serve metrics to a caller with setting:read, and to nobody else", async () => {
    expect((await call("/api/metrics")).status).toBe(401);
    expect((await call("/api/metrics", { as: author })).status).toBe(403);

    const response = await fetch(`${baseUrl}/api/metrics`, { headers: { origin: baseUrl, cookie: root.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    const text = await response.text();
    expect(text).toContain("# TYPE cms_build_info gauge");
    expect(text).toMatch(/cms_files \d+/);
    expect(text).toMatch(/cms_background_mode\{mode="(timers|external)"\} 1/);
  });
});
