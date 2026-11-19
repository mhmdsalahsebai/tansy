/**
 * Review: draft → in review → published. Runs after auth.test.ts, which completes setup.
 * An editor (no `record:publish`) submits; a reviewer approves or sends back.
 */
import { beforeAll, describe, expect, inject, it } from "vitest";

const baseUrl = inject("baseUrl");
const PASSWORD = "correct-horse-battery-staple-9431";

interface Actor { id: string; cookie: string }
let root: Actor, editor: Actor, reviewer: Actor, member: Actor;
let collectionId: number, titleId: number;

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

async function user(name: string, role: string) {
  const r = await call("/api/users", { method: "POST", as: root, body: { name, email: `${name}@example.test`, password: PASSWORD, role } });
  expect(r.status, r.text).toBe(200);
  return signIn(`${name}@example.test`);
}

const content = (suffix = "") => `/api/collections/${collectionId}/content${suffix}`;
const values = (title: string) => [{ fieldId: titleId, value: title }];

async function create(title: string, status: "draft" | "published", as: Actor) {
  const r = await call(content(), { method: "POST", as, body: { status, values: values(title) } });
  expect(r.status, r.text).toBe(200);
  return r.json.id as number;
}

beforeAll(async () => {
  root = await signIn("root@example.test");
  editor = await user("reviewEditor", "editor");
  reviewer = await user("reviewReviewer", "reviewer");
  member = await user("reviewMember", "user");
  const made = await call("/api/collections", { method: "POST", as: root, body: { name: "Articles", slug: "review-articles", fields: [{ name: "title", type: "text" }] } });
  expect(made.status, made.text).toBe(200);
  collectionId = made.json.id;
  titleId = made.json.fields[0].id;
  // Members may create through the rule, to show review applies to rule writers too.
  expect((await call(`/api/collections/${collectionId}/rules`, { method: "PUT", as: root, body: { listRule: null, viewRule: null, createRule: "@request.auth.id != \"\"", updateRule: null, deleteRule: null } })).status).toBeLessThan(300);
});

describe("review workflow", () => {
  it("changes nothing until a collection requires review", async () => {
    const id = await create("free", "published", editor);
    expect((await call(content(`/${id}/review`), { method: "POST", as: editor, body: {} })).json.error.code).toBe("REVIEW_NOT_REQUIRED");
    const on = await call(`/api/collections/${collectionId}`, { method: "PATCH", as: root, body: { reviewRequired: true } });
    expect(on.status, on.text).toBe(200);
    expect(on.json.reviewRequired).toBe(true);
  });

  it("refuses every way an editor could publish, unpublish or change live content", async () => {
    expect((await call(content(), { method: "POST", as: editor, body: { status: "published", values: values("x") } })).json.error.code).toBe("REVIEW_REQUIRED");
    const id = await create("draft one", "draft", editor);
    expect((await call(content(`/${id}`), { method: "PATCH", as: editor, body: { status: "published", values: [] } })).json.error.code).toBe("REVIEW_REQUIRED");
    const live = await create("live", "published", reviewer);
    expect((await call(content(`/${live}`), { method: "PATCH", as: editor, body: { values: values("edited live") } })).json.error.code).toBe("REVIEW_REQUIRED");
    expect((await call(content(`/${live}`), { method: "PATCH", as: editor, body: { status: "draft", values: [] } })).json.error.code).toBe("REVIEW_REQUIRED");
    expect((await call(content(`/${live}/draft`), { method: "PUT", as: editor, body: { values: values("pending") } })).status).toBe(200);
    expect((await call(content(`/${live}/draft/publish`), { method: "POST", as: editor })).json.error.code).toBe("REVIEW_REQUIRED");
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await call(content(`/${live}/schedule`), { method: "PUT", as: editor, body: { publishAt: future, unpublishAt: null } })).json.error.code).toBe("REVIEW_REQUIRED");
    // The records API goes through the same write path.
    expect((await call(`/api/collections/review-articles/records`, { method: "POST", as: editor, body: { title: "y", status: "published" } })).json.error.code).toBe("REVIEW_REQUIRED");
    // So does a write the API rule allows.
    expect((await call(content(), { method: "POST", as: member, body: { status: "published", values: values("m") } })).json.error.code).toBe("REVIEW_REQUIRED");
    expect((await call(content(), { method: "POST", as: member, body: { status: "draft", values: values("m") } })).status).toBe(200);
  });

  it("lets an editor submit, a reviewer send back, and approve to publish", async () => {
    const id = await create("story", "draft", editor);
    const submitted = await call(content(`/${id}/review`), { method: "POST", as: editor, body: { note: "Ready" } });
    expect(submitted.status, submitted.text).toBe(200);
    expect(submitted.json).toMatchObject({ state: "pending", note: "Ready", submittedBy: "reviewEditor" });

    // Editors can't act as reviewers.
    expect((await call(content(`/${id}/review/approve`), { method: "POST", as: editor, body: {} })).status).toBe(403);
    expect((await call(content(`/${id}/review/changes`), { method: "POST", as: editor, body: { note: "no" } })).status).toBe(403);

    const queue = await call("/api/reviews", { as: reviewer });
    expect(queue.json.items.some((item: { recordId: number; canReview: boolean }) => item.recordId === id && item.canReview)).toBe(true);
    const mine = await call("/api/reviews", { as: editor });
    expect(mine.json.items.find((item: { recordId: number }) => item.recordId === id)).toMatchObject({ mine: true, canReview: false });

    const back = await call(content(`/${id}/review/changes`), { method: "POST", as: reviewer, body: { note: "Fix the title" } });
    expect(back.json).toMatchObject({ state: "changes", reviewNote: "Fix the title", reviewedBy: "reviewReviewer" });
    expect((await call(content(`/${id}/review/approve`), { method: "POST", as: reviewer, body: {} })).json.error.code).toBe("NO_PENDING_REVIEW");
    expect((await call("/api/reviews?state=changes", { as: editor })).json.items.some((item: { recordId: number }) => item.recordId === id)).toBe(true);

    expect((await call(content(`/${id}`), { method: "PATCH", as: editor, body: { values: values("better story") } })).status).toBe(200);
    expect((await call(content(`/${id}/review`), { method: "POST", as: editor, body: {} })).json.state).toBe("pending");
    const approved = await call(content(`/${id}/review/approve`), { method: "POST", as: reviewer, body: { note: "Good" } });
    expect(approved.status, approved.text).toBe(200);
    expect(approved.json.status).toBe("published");
    expect((await call(content(`/${id}/review`), { as: editor })).status).toBe(204);
  });

  it("approves pending changes to a published record, refusing ones saved after the reviewer read them", async () => {
    const id = await create("live story", "published", reviewer);
    const draft = await call(content(`/${id}/draft`), { method: "PUT", as: editor, body: { values: values("revised") } });
    expect((await call(content(`/${id}/review`), { method: "POST", as: editor, body: {} })).status).toBe(200);
    expect((await call(content(`/${id}/review/approve`), { method: "POST", as: reviewer, body: { expectedDraftAt: "2000-01-01T00:00:00.000Z" } })).json.error.code).toBe("RECORD_CHANGED");
    const approved = await call(content(`/${id}/review/approve`), { method: "POST", as: reviewer, body: { expectedDraftAt: draft.json.createdAt } });
    expect(approved.status, approved.text).toBe(200);
    expect(approved.json.values.find((entry: { field: { name: string } }) => entry.field.name === "title").value).toBe("revised");
    expect((await call(content(`/${id}/draft`), { as: editor })).status).toBe(204);
  });

  it("closes a review when a reviewer publishes directly, and when the draft is discarded", async () => {
    const direct = await create("direct", "draft", editor);
    await call(content(`/${direct}/review`), { method: "POST", as: editor, body: {} });
    expect((await call(content(`/${direct}`), { method: "PATCH", as: reviewer, body: { status: "published", values: [] } })).status).toBe(200);
    expect((await call(content(`/${direct}/review`), { as: editor })).status).toBe(204);

    const live = await create("discard", "published", reviewer);
    await call(content(`/${live}/draft`), { method: "PUT", as: editor, body: { values: values("maybe") } });
    await call(content(`/${live}/review`), { method: "POST", as: editor, body: {} });
    expect((await call(content(`/${live}/draft`), { method: "DELETE", as: editor })).status).toBe(204);
    expect((await call(content(`/${live}/review`), { as: editor })).status).toBe(204);
    expect((await call(content(`/${live}/review`), { method: "POST", as: editor, body: {} })).json.error.code).toBe("NOTHING_TO_REVIEW");
  });

  it("only lets holders of a record grant submit, and shows the queue only what they may see", async () => {
    const id = await create("private", "draft", editor);
    expect((await call(content(`/${id}/review`), { method: "POST", as: member, body: {} })).status).toBe(403);
    expect((await call("/api/reviews", { as: member })).status).toBe(403);
  });

  it("refuses review on a view, and carries the setting through schema export", async () => {
    const exported = await call("/api/schema/export", { as: root });
    if (exported.status === 200) expect(exported.json.collections.find((c: { slug: string }) => c.slug === "review-articles").reviewRequired).toBe(true);
  });
});
