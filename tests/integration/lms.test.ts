/**
 * The LMS plugin, installed the way a site owner would: on in tansy.config.ts and nothing else.
 * Runs after auth.test.ts, which completes setup and points mail at the test SMTP server.
 *
 * Lessons are gated by the API rule `@request.auth.lms_courses ?= course`, so these tests try
 * every way of reading a record: list, view, expand, realtime, /api/resolve, files inside
 * blocks, and the site's own pages, which read a members' page as the signed-in member (C9).
 */
import net from "node:net";
import { beforeAll, describe, expect, inject, it } from "vitest";

const base = inject("baseUrl");
const PASSWORD = "correct-horse-battery-staple-9431";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

interface Actor { id: string; cookie: string; email: string }
let root: Actor, learner: Actor, outsider: Actor;

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
  return { id: r.json.user.id, cookie, email };
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
async function waitForMail(match: (message: string) => boolean) {
  for (let i = 0; i < 40; i++) {
    const found = (await mailbox()).find(match);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("No matching email arrived.");
}
const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 40; i++) { if (await check()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };

const records = (slug: string, suffix = "") => `/api/collections/${slug}/records${suffix}`;
const rich = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const block = (id: string, type: string, value: Record<string, unknown>) => ({ id, type, v: 1, value });
const ext = (path: string) => `/api/ext/lms${path}`;

async function create(slug: string, body: Record<string, unknown>, as: Actor = root) {
  const r = await call(records(slug), { method: "POST", as, body: { status: "published", ...body } });
  expect(r.status, r.text).toBe(200);
  return r.json;
}

let course: { id: number; slug: string; byline?: string }, paid: { id: number; slug: string };
let basics: { id: number }, intro: { id: number; slug: string }, gated: { id: number; slug: string }, last: { id: number; slug: string }, draft: { id: number; slug: string };
let quiz: { id: number }, file: string;
const SECRET = "only-for-enrolled-learners";

beforeAll(async () => {
  root = await signIn("root@example.test");
  learner = await user("lmslearner");
  outsider = await user("lmsoutsider");
});

describe("lms plugin: install", () => {
  it("creates its collections, the outline view, its pages and the gate's user field", async () => {
    const slugs = ((await call("/api/collections", { as: root })).json as Array<{ slug: string }>).map((c) => c.slug);
    for (const slug of ["lms-courses", "lms-sections", "lms-lessons", "lms-quizzes", "lms-enrollments", "lms-progress", "lms-attempts", "lms-certificates", "lms-my-courses", "lms-certificate", "lms-outline"]) expect(slugs).toContain(slug);
    const fields = (await call("/api/user-fields", { as: root })).json as Array<{ name: string; selfEditable: boolean; config: { hidden?: boolean } }>;
    expect(fields.find((f) => f.name === "lms_courses")).toMatchObject({ selfEditable: false, config: { hidden: true } });
    for (const page of ["/my-courses", "/certificates"]) expect((await call(page)).status, page).toBe(200);
    // Instructors are people with a role, not records.
    expect(slugs).not.toContain("lms-instructors");
  });
});

describe("lms plugin: content", () => {
  beforeAll(async () => {
    const upload = await fetch(`${base}/api/files/upload?name=worksheet.png`, { method: "POST", headers: { origin: base, cookie: root.cookie, "content-type": "image/png" }, body: PNG });
    expect(upload.status).toBe(200);
    file = ((await upload.json()) as { id: string }).id;
  });

  it("fills slugs, keeps a quiz's course with its lesson, and refuses a section from another course", async () => {
    course = await create("lms-courses", { title: "Rust Basics", summary: "Learn Rust.", access: "free", byline: "Grace Teacher", description: [block("d1", "lms_text", { body: rich("A friendly course.") })] });
    expect(course.slug).toBe("rust-basics");
    // A manager may credit anyone.
    expect(course.byline).toBe("Grace Teacher");
    paid = await create("lms-courses", { title: "Advanced Rust", access: "enrollment" });
    basics = await create("lms-sections", { title: "Basics", course: course.id, position: 10 });
    const elsewhere = await create("lms-sections", { title: "Elsewhere", course: paid.id, position: 10 });
    intro = await create("lms-lessons", { title: "Welcome", course: course.id, section: basics.id, position: 1, preview: true, content: [block("i1", "lms_text", { body: rich("Hello everyone.") })] });
    gated = await create("lms-lessons", { title: "Ownership", course: course.id, section: basics.id, position: 2, content: [block("g1", "lms_text", { body: rich(SECRET) }), block("g2", "lms_download", { file, label: "Worksheet" })] });
    last = await create("lms-lessons", { title: "Borrowing", course: course.id, section: basics.id, position: 3, content: [] });
    draft = await create("lms-lessons", { title: "Unfinished", course: course.id, section: basics.id, position: 4, status: "draft" });
    expect(intro.slug).toBe("welcome");
    const wrong = await call(records("lms-lessons"), { method: "POST", as: root, body: { status: "published", title: "Misplaced", course: course.id, section: elsewhere.id } });
    expect(wrong.status).toBe(400);
    expect(wrong.text).toMatch(/section of this lesson's course/);

    quiz = await create("lms-quizzes", {
      title: "Ownership check",
      lesson: last.id,
      course: paid.id,
      passingScore: 50,
      maxAttempts: 3,
      questions: [
        block("q1", "lms_question", { prompt: "Who owns a value?", kind: "single", choices: ["Everyone", "One owner"], correct: 1, explanation: rich("THE-EXPLANATION") }),
        block("q2", "lms_question", { prompt: "Name the checker", kind: "short", choices: [], correct: ["borrow checker"] }),
      ],
    });
    expect((quiz as unknown as { course: number }).course).toBe(course.id);
    const updated = await call(records("lms-lessons", `/${last.id}`), { method: "PATCH", as: root, body: { content: [block("l1", "lms_quiz", { quiz: quiz.id })] } });
    expect(updated.status, updated.text).toBe(200);
  });
});

describe("lms plugin: gating before enrollment", () => {
  it("shows the course and its outline to anyone, but no lesson content", async () => {
    const page = await call(`/courses/${course.slug}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Rust Basics");
    for (const title of ["Welcome", "Ownership", "Borrowing"]) expect(page.text).toContain(title);
    expect(page.text).not.toContain("Unfinished");
    expect(page.text).not.toContain(SECRET);
    expect(page.text).toContain("Enroll for free");
    const outline = await call(records("lms-outline", `?filter=${encodeURIComponent(`course = ${course.id}`)}`));
    expect(outline.status).toBe(200);
    expect(outline.json.items.map((l: { id: number }) => l.id).sort()).toEqual([intro.id, gated.id, last.id].sort());
    expect(outline.text).not.toContain(SECRET);
    expect(outline.json.items[0].content).toBeUndefined();
  });

  it("opens a preview lesson to everyone", async () => {
    expect((await call(records("lms-lessons", `/${intro.id}`))).status).toBe(200);
    const page = await call(`/learn/${intro.slug}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Hello everyone.");
    expect(page.text).toContain("This is a preview");
  });

  it("keeps other lessons from visitors and outsiders on every path, and from staff on the site", async () => {
    for (const { name, as } of [{ name: "visitor", as: null }, { name: "outsider", as: outsider }]) {
      expect((await call(records("lms-lessons", `/${gated.id}`), { as })).status, name).toBe(404);
      const listed = await call(records("lms-lessons", `?filter=${encodeURIComponent(`course = ${course.id}`)}`), { as });
      expect(listed.text, name).not.toContain(SECRET);
      expect(listed.json.items.map((l: { id: number }) => l.id), name).toEqual([intro.id]);
      expect((await call(`/api/resolve?path=${encodeURIComponent(`/learn/${gated.slug}`)}`, { as })).status, name).toBe(404);
      expect((await call(`/learn/${gated.slug}`, { as })).status, name).toBe(404);
      expect((await call(`/api/files/${file}`, { as })).status, name).toBe(404);
    }
    // An administrator's role reads any record through the API. The site shows them only what members see, and they aren't enrolled.
    expect((await call(records("lms-lessons", `/${gated.id}`), { as: root })).status).toBe(200);
    expect((await call(`/learn/${gated.slug}`, { as: root })).status).toBe(404);
  });

  it("keeps quizzes from anyone not enrolled", async () => {
    expect((await call(ext(`/quizzes/${quiz.id}`), { as: outsider })).status).toBe(404);
    expect((await call(ext(`/quizzes/${quiz.id}/attempts`), { method: "POST", as: outsider, body: { answers: { q1: 1 } } })).status).toBe(404);
    expect((await call(records("lms-quizzes", `/${quiz.id}`), { as: outsider })).status).toBe(404);
  });

  it("enrolls only through the plugin: learners can't write enrollments, progress, attempts, certificates or their own lms_courses", async () => {
    const forged = { status: "published", course: course.id, student: learner.id, state: "active" };
    expect((await call(records("lms-enrollments"), { method: "POST", as: learner, body: forged })).status).toBe(403);
    expect((await call(records("lms-progress"), { method: "POST", as: learner, body: { key: `${learner.id}:${gated.id}`, student: learner.id, course: course.id, lesson: gated.id } })).status).toBe(403);
    expect((await call(records("lms-attempts"), { method: "POST", as: learner, body: { quiz: quiz.id, student: learner.id, score: 100, passed: true } })).status).toBe(403);
    expect((await call(records("lms-certificates"), { method: "POST", as: learner, body: { code: "AAAAAAAAAAAAAAAA", student: learner.id, course: course.id } })).status).toBe(403);
    const batch = await call("/api/batch", { method: "POST", as: learner, body: { requests: [{ method: "POST", url: records("lms-enrollments"), body: forged }] } });
    expect(batch.status).toBeGreaterThanOrEqual(400);
    expect((await call("/api/account/fields", { method: "PATCH", as: learner, body: { values: { lms_courses: [course.id] } } })).status).toBe(400);
    expect((await call(records("lms-lessons", `/${gated.id}`), { as: learner })).status).toBe(404);
  });

  it("refuses to enroll in a course staff enroll, a draft, or without signing in", async () => {
    expect((await call(ext(`/courses/${course.id}/enroll`), { method: "POST" })).status).toBe(401);
    expect((await call(ext(`/courses/${paid.id}/enroll`), { method: "POST", as: learner })).status).toBe(403);
    const hidden = await create("lms-courses", { title: "Secret course", access: "free", status: "draft" });
    expect((await call(ext(`/courses/${hidden.id}/enroll`), { method: "POST", as: learner })).status).toBe(404);
    expect((await call(ext("/enrollments"), { method: "POST", as: learner, body: { course: paid.id, emails: [learner.email] } })).status).toBe(403);
  });
});

describe("lms plugin: enrolled", () => {
  it("enrolls once, emails a welcome, and opens every lesson at once", async () => {
    const first = await call(ext(`/courses/${course.id}/enroll`), { method: "POST", as: learner });
    expect(first.status, first.text).toBe(200);
    expect(first.json.created).toBe(true);
    const twice = await Promise.all([1, 2].map(() => call(ext(`/courses/${course.id}/enroll`), { method: "POST", as: learner })));
    expect(twice.map((r) => r.json.created)).toEqual([false, false]);
    const mine = await call(records("lms-enrollments"), { as: learner });
    expect(mine.json.items).toHaveLength(1);
    expect((await call(records("lms-enrollments"), { as: outsider })).json.items).toHaveLength(0);

    const lesson = await call(records("lms-lessons", `/${gated.id}`), { as: learner });
    expect(lesson.status).toBe(200);
    expect(lesson.text).toContain(SECRET);
    expect((await call(`/api/resolve?path=${encodeURIComponent(`/learn/${gated.slug}`)}`, { as: learner })).status).toBe(200);
    expect((await call(`/api/files/${file}`, { as: learner })).status).toBeLessThan(400);
    await waitForMail((m) => m.includes(learner.email) && m.includes("enrolled in Rust Basics"));
  });

  it("serves the lesson page to the member alone, never from a shared cache, and never a draft", async () => {
    const page = await call(`/learn/${gated.slug}`, { as: learner });
    expect(page.status).toBe(200);
    expect(page.text).toContain(SECRET);
    expect(page.text).toContain("Mark as complete");
    expect(page.headers.get("cache-control") ?? "").toMatch(/private|no-store/);
    // Straight after, a visitor at the same address still gets nothing.
    expect((await call(`/learn/${gated.slug}`)).status).toBe(404);
    expect((await call(`/learn/${draft.slug}`, { as: learner })).status).toBe(404);
    const coursePage = await call(`/courses/${course.slug}`, { as: learner });
    expect(coursePage.text).toContain("Start: Welcome");
    expect(coursePage.text).toContain(`href="/learn/${gated.slug}"`);
    expect(coursePage.text).not.toContain("Enroll for free");
  });

  it("gives a quiz's questions without answers, and grades on the server", async () => {
    const shown = await call(ext(`/quizzes/${quiz.id}`), { as: learner });
    expect(shown.status, shown.text).toBe(200);
    expect(shown.json).toMatchObject({ passingScore: 50, maxAttempts: 3, attemptsLeft: 3, passed: false });
    expect(shown.json.questions.map((q: { id: string }) => q.id)).toEqual(["q1", "q2"]);
    expect(shown.text).not.toMatch(/correct|borrow checker|THE-EXPLANATION/);
    // The hidden field stays hidden on the records API, as a view, a list and an expand.
    const direct = await call(records("lms-quizzes", `/${quiz.id}`), { as: learner });
    expect(direct.status).toBe(200);
    expect(direct.json.questions).toBeUndefined();
    expect((await call(records("lms-quizzes"), { as: learner })).text).not.toContain("borrow checker");
    expect((await call(records("lms-lessons", `/${last.id}?expand=content`), { as: learner })).text).not.toContain("borrow checker");

    const wrong = await call(ext(`/quizzes/${quiz.id}/attempts`), { method: "POST", as: learner, body: { answers: { q1: 0, q2: "type checker" } } });
    expect(wrong.status, wrong.text).toBe(200);
    expect(wrong.json).toEqual({ score: 0, correct: 0, total: 2, passed: false, attemptsLeft: 2 });
    expect(wrong.text).not.toMatch(/borrow|THE-EXPLANATION/);
  });

  it("holds the attempt limit under parallel submissions", async () => {
    // One of three is used, so of three at once, two get through.
    const results = await Promise.all([1, 2, 3].map(() => call(ext(`/quizzes/${quiz.id}/attempts`), { method: "POST", as: learner, body: { answers: { q1: 0 } } })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 409]);
    const attempts = await call(records("lms-attempts"), { as: learner });
    expect(attempts.json.totalItems).toBe(3);
    expect((await call(ext(`/quizzes/${quiz.id}`), { as: learner })).json.attemptsLeft).toBe(0);
    // Staff give another try by raising the limit.
    expect((await call(records("lms-quizzes", `/${quiz.id}`), { method: "PATCH", as: root, body: { maxAttempts: 5 } })).status).toBe(200);
  });

  it("tracks progress once per lesson, and only for enrolled learners", async () => {
    expect((await call(ext(`/lessons/${intro.id}/complete`), { method: "POST", as: outsider })).status).toBe(403);
    expect((await call(ext(`/lessons/${gated.id}/complete`), { method: "POST", as: outsider })).status).toBe(404);
    const done = await Promise.all([1, 2].map(() => call(ext(`/lessons/${intro.id}/complete`), { method: "POST", as: learner })));
    expect(done.map((r) => r.status)).toEqual([200, 200]);
    expect(done.map((r) => r.json.first).sort()).toEqual([false, true]);
    expect((await call(ext(`/lessons/${gated.id}/complete`), { method: "POST", as: learner })).json.courseCompleted).toBe(false);
    expect((await call(ext(`/lessons/${last.id}/complete`), { method: "POST", as: learner })).json.courseCompleted).toBe(false);
    const me = await call(ext("/me/courses"), { as: learner });
    expect(me.json.items).toEqual([expect.objectContaining({ lessons: 3, completed: 3, percent: 100, next: null, enrollment: expect.objectContaining({ state: "active" }) })]);
  });

  it("completes the course once its quiz is passed, and issues one certificate that anyone can check", async () => {
    const pass = await call(ext(`/quizzes/${quiz.id}/attempts`), { method: "POST", as: learner, body: { answers: { q1: 1, q2: "  Borrow   Checker " } } });
    expect(pass.json).toMatchObject({ score: 100, passed: true });
    const enrollment = (await call(records("lms-enrollments"), { as: learner })).json.items[0];
    expect(enrollment.state).toBe("completed");
    expect(enrollment.completedAt).toBeTruthy();
    // A second completion path, such as re-marking a lesson, issues nothing new.
    await call(ext(`/lessons/${last.id}/complete`), { method: "POST", as: learner });
    const certificates = (await call(records("lms-certificates"), { as: learner })).json.items;
    expect(certificates).toHaveLength(1);
    const code = certificates[0].code as string;
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
    expect((await call(records("lms-certificates"), { as: outsider })).json.items).toHaveLength(0);

    const verified = await call(ext(`/certificates/${code.toLowerCase().replace(/(.{4})/g, "$1-")}`));
    expect(verified.status, verified.text).toBe(200);
    expect(verified.json).toEqual({ code, studentName: "lmslearner", course: "Rust Basics", issuedAt: expect.any(String) });
    expect(verified.text).not.toContain(learner.id);
    expect(verified.text).not.toContain(learner.email);
    expect((await call(ext("/certificates/AAAAAAAAAAAAAAAA"))).status).toBe(404);
    expect((await call(ext(`/certificates/${encodeURIComponent('" || code != "')}`))).status).toBe(404);
    await waitForMail((m) => m.includes(learner.email) && m.includes(code));
    expect((await call(`/courses/${course.slug}`, { as: learner })).text).toContain("You completed this course.");
  });
});

describe("lms plugin: staff", () => {
  it("bulk-enroll by email, saying only how many had accounts", async () => {
    const r = await call(ext("/enrollments"), { method: "POST", as: root, body: { course: paid.id, emails: [outsider.email.toUpperCase(), "nobody@example.test", outsider.email] } });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toEqual({ enrolled: 1, already: 0, unknown: 1 });
    expect((await call(records("lms-enrollments"), { as: outsider })).json.items).toEqual([expect.objectContaining({ course: paid.id, source: "staff", state: "active" })]);
    const dashboard = await call("/dashboard/ext/lms/learners", { as: root });
    expect(dashboard.status).toBe(200);
    expect(dashboard.text).toContain("Advanced Rust");
  });

  it("enroll by hand under Records, which the hooks keep in step", async () => {
    const twice = await call(records("lms-enrollments"), { method: "POST", as: root, body: { status: "published", course: paid.id, student: outsider.id } });
    expect(twice.status).toBe(400);
    expect((await call(records("lms-enrollments"), { method: "POST", as: root, body: { status: "published", course: paid.id, student: "no-such-user" } })).status).toBe(400);
  });
});

describe("lms plugin: revoking", () => {
  it("ends access on the next request, on every path, and on an open realtime subscription", async () => {
    // A second course, so the learner's completed one doesn't count.
    const lesson = await create("lms-lessons", { title: "Lifetimes", course: paid.id, content: [block("x1", "lms_text", { body: rich("lifetime-secret") })] });
    const enrollment = (await call(records("lms-enrollments", `?filter=${encodeURIComponent(`course = ${paid.id}`)}`), { as: outsider })).json.items[0];
    expect((await call(records("lms-lessons", `/${lesson.id}`), { as: outsider })).status).toBe(200);
    const progress = await call(ext(`/lessons/${lesson.id}/complete`), { method: "POST", as: outsider });
    expect(progress.status, progress.text).toBe(200);

    const controller = new AbortController();
    const stream = await fetch(`${base}/api/realtime`, { headers: { cookie: outsider.cookie }, signal: controller.signal });
    const reader = stream.body!.getReader();
    let received = "";
    void (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; received += new TextDecoder().decode(value); } } catch { /* closed */ } })();
    await until(async () => received.includes("PB_CONNECT"));
    const clientId = /"clientId":"([^"]+)"/.exec(received)![1];
    expect((await call("/api/realtime", { method: "POST", as: outsider, body: { clientId, subscriptions: ["lms-lessons/*"] } })).status).toBe(204);
    await call(records("lms-lessons", `/${lesson.id}`), { method: "PATCH", as: root, body: { title: "Lifetimes, seen" } });
    expect(await until(async () => received.includes("Lifetimes, seen"))).toBe(true);

    const revoked = await call(records("lms-enrollments", `/${enrollment.id}`), { method: "PATCH", as: root, body: { state: "revoked" } });
    expect(revoked.status, revoked.text).toBe(200);
    expect(await until(async () => (await call(records("lms-lessons", `/${lesson.id}`), { as: outsider })).status === 404)).toBe(true);
    expect((await call(`/learn/${lesson.slug}`, { as: outsider })).status).toBe(404);
    expect((await call(records("lms-progress", "?expand=lesson"), { as: outsider })).text).not.toContain("lifetime-secret");
    // Realtime resolves its subscriber again every couple of seconds.
    await new Promise((r) => setTimeout(r, 2500));
    await call(records("lms-lessons", `/${lesson.id}`), { method: "PATCH", as: root, body: { title: "Lifetimes, after revoking" } });
    await new Promise((r) => setTimeout(r, 1000));
    controller.abort();
    expect(received).not.toContain("Lifetimes, after revoking");
  });
});

describe("lms plugin: instructors and settings", () => {
  let teacher: Actor, other: Actor;
  let own: { id: number; byline: string };

  beforeAll(async () => {
    const make = async (name: string) => {
      const r = await call("/api/users", { method: "POST", as: root, body: { name, email: `${name}@example.test`, password: PASSWORD, role: "lms-instructor" } });
      expect(r.status, r.text).toBe(200);
      return signIn(`${name}@example.test`);
    };
    teacher = await make("lmsteacher");
    other = await make("lmsother");
  });

  it("are roles created on install, instructors limited to their own courses", async () => {
    const roles = (await call("/api/roles", { as: root })).json.roles as Array<{ name: string; permissions: string[] }>;
    const instructorRole = roles.find((r) => r.name === "lms-instructor")!;
    expect(instructorRole.permissions.filter((p) => p.startsWith("record:")).every((p) => /^record:create@c\d+$/.test(p) || p.endsWith(":own"))).toBe(true);
    expect(roles.find((r) => r.name === "lms-manager")!.permissions).toEqual(expect.arrayContaining(["ext.lms:manage", "ext.lms:enroll"]));
  });

  it("put an instructor's name on their course, which only a manager can change", async () => {
    own = await create("lms-courses", { title: "Teacher's course", byline: "Someone Famous", status: "draft" }, teacher);
    expect(own.byline).toBe("lmsteacher");
    expect((await call(records("lms-courses", `/${own.id}`), { method: "PATCH", as: teacher, body: { byline: "Someone Famous" } })).status).toBe(400);
    expect((await call(records("lms-courses", `/${own.id}`), { method: "PATCH", as: teacher, body: { summary: "Mine." } })).status).toBe(200);
  });

  it("let an instructor build only their own courses", async () => {
    const section = await create("lms-sections", { title: "Start", course: own.id }, teacher);
    await create("lms-lessons", { title: "First", course: own.id, section: section.id, status: "draft" }, teacher);
    // Attaching their records to someone else's course is refused, and so is editing another's course.
    expect((await call(records("lms-sections"), { method: "POST", as: teacher, body: { title: "Sneaky", course: course.id } })).status).toBe(400);
    expect((await call(records("lms-sections"), { method: "POST", as: other, body: { title: "Sneaky", course: own.id } })).status).toBe(400);
    expect((await call(records("lms-courses", `/${course.id}`), { method: "PATCH", as: teacher, body: { title: "Mine now" } })).status).toBe(404);
    expect((await call(records("lms-lessons", `/${gated.id}`), { method: "PATCH", as: teacher, body: { title: "Mine now" } })).status).toBe(404);
  });

  it("open the course builder to instructors, only for their own courses", async () => {
    expect((await call(`/dashboard/ext/lms/courses`, { as: teacher })).status).toBe(200);
    const builder = await call(`/dashboard/ext/lms/courses/${own.id}`, { as: teacher });
    expect(builder.status).toBe(200);
    // The heading, not the words: the dashboard's messages, which every page carries, include them.
    const notFound = /<h1[^>]*>Course not found<\/h1>/;
    expect(builder.text).not.toMatch(notFound);
    expect((await call(`/dashboard/ext/lms/courses/${own.id}`, { as: other })).text).toMatch(notFound);
    // Learners have no dashboard.
    expect((await call(`/dashboard/ext/lms/courses`, { as: learner })).status).not.toBe(200);
  });

  it("keep settings to managers, validate them, and apply them", async () => {
    expect((await call("/api/extensions/lms/settings", { as: teacher })).status).toBe(403);
    expect((await call("/api/extensions/lms/settings", { method: "PUT", as: teacher, body: { values: { passingScore: 10, requireQuizzes: true, certificates: true } } })).status).toBe(403);
    expect((await call("/api/extensions/nothing/settings", { as: root })).status).toBe(404);
    expect((await call("/api/extensions/lms/settings", { as: root })).json).toEqual({ values: { passingScore: 70, requireQuizzes: true, certificates: true } });
    expect((await call("/api/extensions/lms/settings", { method: "PUT", as: root, body: { values: { passingScore: 101, requireQuizzes: true, certificates: true } } })).status).toBe(400);
    expect((await call("/api/extensions/lms/settings", { method: "PUT", as: root, body: { values: { passingScore: 70, requireQuizzes: true, certificates: true, extra: 1 } } })).status).toBe(400);
    const saved = await call("/api/extensions/lms/settings", { method: "PUT", as: root, body: { values: { passingScore: 90, requireQuizzes: true, certificates: true } } });
    expect(saved.status, saved.text).toBe(200);
    // A quiz without its own passing score now asks for the new default.
    const bare = await create("lms-quizzes", { title: "Defaults", lesson: intro.id });
    const shown = await call(ext(`/quizzes/${bare.id}`), { as: root });
    expect(shown.json?.passingScore).toBe(90);
    await call("/api/extensions/lms/settings", { method: "PUT", as: root, body: { values: { passingScore: 70, requireQuizzes: true, certificates: true } } });
  });
});
