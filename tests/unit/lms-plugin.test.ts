import { describe, expect, it, vi } from "vitest";
import type { BeforeHookContext, CollectionShape, RecordValues } from "@/core/extend/define";
import { assertPluginManifest } from "@/core/extend/manifest";
import { schemaDocument } from "@/core/schema/portable";
import { pluginRenderers } from "@/components/stream/StreamField";
import { lms } from "../../plugins/lms/index";
import lmsRenderers, { courseOutline } from "../../plugins/lms/render";
import { CONTRACT, lmsSchema, OUTLINE_QUERY } from "../../plugins/lms/schema";
import { certificateCode, CERTIFICATE_CODE, grade, isCorrect, normalizeCode, orderLessons, percentDone, publicQuestion, questionsOf, slugify, type QuestionBlock } from "../../plugins/lms/logic";
import { exclusive, userFilter } from "../../plugins/lms/service";

const question = (id: string, value: Record<string, unknown>): QuestionBlock => ({ id, type: "lms_question", value });

describe("lms grading", () => {
  const single = question("q1", { prompt: "2 + 2?", kind: "single", choices: ["3", "4"], correct: 1, explanation: "Arithmetic." });
  const multiple = question("q2", { prompt: "Even?", kind: "multiple", choices: ["1", "2", "3", "4"], correct: [3, 1] });
  const short = question("q3", { prompt: "Capital of France?", kind: "short", correct: ["Paris", "paris, france"] });

  it("marks each kind of question", () => {
    expect(isCorrect(single, 1)).toBe(true);
    expect(isCorrect(single, [1])).toBe(false);
    expect(isCorrect(single, "1")).toBe(false);
    expect(isCorrect(multiple, [1, 3])).toBe(true);
    expect(isCorrect(multiple, [3, 1, 1])).toBe(true);
    expect(isCorrect(multiple, [1])).toBe(false);
    expect(isCorrect(multiple, [1, 3, 0])).toBe(false);
    expect(isCorrect(short, "  PARIS ")).toBe(true);
    expect(isCorrect(short, "Paris,   France")).toBe(true);
    expect(isCorrect(short, "Lyon")).toBe(false);
  });

  it("never gives marks for a question with no usable key", () => {
    expect(isCorrect(question("x", { kind: "single", choices: ["a"] }), 0)).toBe(false);
    expect(isCorrect(question("x", { kind: "short", correct: ["  "] }), "")).toBe(false);
    expect(isCorrect(question("x", { kind: "multiple", correct: "zero" }), [])).toBe(false);
  });

  it("scores a whole quiz, and can't be passed with no questions", () => {
    expect(grade([single, multiple, short], { q1: 1, q2: [1, 3], q3: "no" })).toEqual({ score: 67, correct: 2, total: 3 });
    expect(grade([single], { constructor: 1 })).toEqual({ score: 0, correct: 0, total: 1 });
    expect(grade([], {})).toEqual({ score: 0, correct: 0, total: 0 });
  });

  it("show learners questions without answers or explanations", () => {
    const stream = [single, { id: "t", type: "lms_text", v: 1, value: { body: "x" } }, short, "junk"];
    const shown = questionsOf(stream).map(publicQuestion);
    expect(shown).toEqual([{ id: "q1", prompt: "2 + 2?", kind: "single", choices: ["3", "4"] }, { id: "q3", prompt: "Capital of France?", kind: "short", choices: [] }]);
    expect(JSON.stringify(shown)).not.toMatch(/correct|explanation|Paris/);
  });
});

describe("lms helpers", () => {
  it("make slugs", () => {
    expect(slugify("Intro to Rust!")).toBe("intro-to-rust");
    expect(slugify("ستة", "course")).toBe("course");
  });

  it("make certificate codes that verify, and forgive how they're typed", () => {
    const code = certificateCode(() => new Uint8Array(10).fill(255));
    expect(code).toBe("ZZZZZZZZZZZZZZZZ");
    const random = certificateCode((size) => crypto.getRandomValues(new Uint8Array(size)));
    expect(random).toMatch(CERTIFICATE_CODE);
    expect(normalizeCode("abcd-efgh ijkl-mnop")).toBe("ABCDEFGH1JK1MN0P");
    expect(CERTIFICATE_CODE.test("ABCDEFGHIJKLMNOP")).toBe(false);
  });

  it("order lessons by section, then position", () => {
    const sections = [{ id: 1, position: 20 }, { id: 2, position: 10 }];
    const lessons = [{ id: 1, section: 1, position: 1 }, { id: 2, section: 2, position: 2 }, { id: 3, section: 2, position: 1 }, { id: 4, section: null, position: 5 }];
    expect(orderLessons(lessons, sections).map((lesson) => lesson.id)).toEqual([4, 3, 2, 1]);
    expect(percentDone(1, 3)).toBe(33);
    expect(percentDone(0, 0)).toBe(0);
  });

  it("write only real user ids into filters", () => {
    expect(userFilter("student", "abc_DEF-123")).toBe('student = "abc_DEF-123"');
    for (const bad of ['x" || 1 = 1 || "', "", "a b", "a".repeat(65)]) expect(() => userFilter("student", bad), bad).toThrow();
  });

  it("run work for one key one at a time", async () => {
    const order: string[] = [];
    const slow = exclusive("k", async () => { await new Promise((r) => setTimeout(r, 20)); order.push("first"); });
    const fast = exclusive("k", async () => { order.push("second"); });
    const failing = exclusive("k", async () => { throw new Error("boom"); });
    const after = exclusive("k", async () => { order.push("after a failure"); });
    await Promise.all([slow, fast, failing.catch(() => {}), after]);
    expect(order).toEqual(["first", "second", "after a failure"]);
  });
});

describe("lms plugin manifest", () => {
  it("passes the startup checks, keeps defaults for unset options, and refuses bad ones", () => {
    expect(() => assertPluginManifest(lms())).not.toThrow();
    expect(lms({ passingScore: undefined }).options?.value).toMatchObject({ basePath: "/courses", passingScore: 70, certificates: true, requireQuizzes: true });
    // Options are the settings' defaults, until a manager changes them in the dashboard.
    expect(Object.fromEntries(lms({ passingScore: 80 }).settings!.fields.map((field) => [field.name, field.default]))).toEqual({ passingScore: 80, requireQuizzes: true, certificates: true });
    expect(() => assertPluginManifest(lms({ passingScore: 101 }))).toThrow(/passingScore/);
    expect(() => assertPluginManifest(lms({ basePath: "courses" }))).toThrow(/basePath/);
  });

  it("creates a schema that imports, with every contract field, gated lessons and an outline without content", () => {
    const document = schemaDocument.parse(lmsSchema("/learn-here"));
    expect(document.collections.find((c) => c.slug === "lms-courses")?.urlPattern).toBe("/learn-here/:slug");
    for (const [slug, fields] of Object.entries(CONTRACT)) {
      const collection = document.collections.find((c) => c.slug === slug)!;
      for (const [name, type] of Object.entries(fields)) expect(collection.fields.find((f) => f.name === name)?.type, `${slug}.${name}`).toBe(type);
    }
    const lessons = document.collections.find((c) => c.slug === "lms-lessons")!;
    expect(lessons.rules.viewRule).toContain("@request.auth.lms_courses ?= course");
    expect(lessons.rules.createRule).toBeNull();
    expect(document.collections.find((c) => c.slug === "lms-quizzes")!.fields.find((f) => f.name === "questions")?.config.hidden).toBe(true);
    for (const slug of ["lms-enrollments", "lms-progress", "lms-attempts", "lms-certificates"]) {
      const rules = document.collections.find((c) => c.slug === slug)!.rules;
      expect([rules.createRule, rules.updateRule, rules.deleteRule], slug).toEqual([null, null, null]);
      expect(rules.viewRule, slug).toContain("student = @request.auth.id");
    }
    expect(OUTLINE_QUERY).not.toMatch(/content|slug/);
    expect(document.userFields).toEqual([expect.objectContaining({ name: "lms_courses", selfEditable: false, config: expect.objectContaining({ hidden: true }) })]);
  });

  it("renders only its own collections", () => {
    expect(() => pluginRenderers("lms", lmsRenderers)).not.toThrow();
    expect(Object.keys(lmsRenderers.templates!).every((slug) => slug.startsWith("lms-"))).toBe(true);
    // A learner's own records are only ever read as them.
    for (const queries of Object.values(lmsRenderers.queries!)) {
      for (const query of Object.values(queries)) if (["lms-lessons", "lms-progress", "lms-enrollments"].includes(query.collection)) expect(query.viewer, query.collection).toBe(true);
    }
  });

  it("builds a course outline from what the viewer may open", () => {
    const list = (items: RecordValues[]) => ({ page: 1, perPage: 200, totalItems: items.length, totalPages: 1, items: items as Array<RecordValues & { id: number }> });
    const outline = courseOutline({
      outline: list([{ id: 1, title: "Welcome", section: 10, position: 1, preview: true }, { id: 2, title: "Deep dive", section: 10, position: 2 }]),
      sections: list([{ id: 10, title: "Basics", position: 1 }]),
      lessons: list([{ id: 1, recordPath: "/learn/welcome" }]),
      progress: list([]),
      enrollment: list([]),
    });
    expect(outline.enrolled).toBe(false);
    expect(outline.sections).toEqual([{ id: 10, title: "Basics", lessons: [expect.objectContaining({ id: 1, href: "/learn/welcome", preview: true }), expect.objectContaining({ id: 2, href: null })] }]);
  });
});

/** A before-hook context with in-memory services. */
function hookContext(slug: string, values: RecordValues, overrides: Partial<BeforeHookContext> = {}) {
  const fields = Object.fromEntries(lmsSchema("/courses").collections.map((c) => [c.slug, c.fields.map((f) => f.name)]));
  const describe = vi.fn(async (name: string): Promise<CollectionShape | null> => (fields[name] ? { slug: name, name, type: "base", urlPattern: null, fields: fields[name].map((field) => ({ name: field, type: "text", config: {} })) } : null));
  const empty = { page: 1, perPage: 2, totalItems: 0, totalPages: 0, items: [] };
  return {
    event: "record.beforeCreate",
    collection: { id: 1, slug, name: slug },
    userId: "staff-1",
    // Runs the school unless a test says otherwise.
    can: vi.fn(() => true),
    values,
    records: { list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    system: {
      records: { list: vi.fn(async () => empty), get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
      users: { get: vi.fn(async (id: string) => (id === "learner-1" ? { id, name: "Lee", email: "lee@example.test" } : null)), findByEmail: vi.fn(), getValues: vi.fn(), setValues: vi.fn() },
    },
    store: { get: async () => null, set: async () => {}, delete: async () => {}, list: async () => [] },
    mail: { send: vi.fn(async () => {}) },
    schema: { describe },
    settings: { get: async () => ({ passingScore: 70, requireQuizzes: true, certificates: true }) },
    reject: (message: string): never => { throw new Error(message); },
    ...overrides,
  } as unknown as BeforeHookContext;
}

describe("lms hooks", () => {
  const plugin = lms();
  const beforeCreate = plugin.hooks!["record.beforeCreate"]!;
  const beforeUpdate = plugin.hooks!["record.beforeUpdate"]!;

  it("fill a lesson's slug and refuse a section from another course", async () => {
    const context = hookContext("lms-lessons", { title: "First Steps", course: 1, section: 5 });
    vi.mocked(context.system.records.get).mockResolvedValue({ id: 5, course: 2 });
    await expect(beforeCreate(context)).rejects.toThrow(/section of this lesson's course/);
    const fine = hookContext("lms-lessons", { title: "First Steps", course: 1, section: 5 });
    vi.mocked(fine.system.records.get).mockResolvedValue({ id: 5, course: 1 });
    await beforeCreate(fine);
    expect(fine.values.slug).toBe("first-steps");
  });

  it("keep a quiz's course in step with its lesson, whatever was sent", async () => {
    const context = hookContext("lms-quizzes", { title: "Check", lesson: 3, course: 99 });
    vi.mocked(context.system.records.get).mockResolvedValue({ id: 3, course: 7 });
    await beforeCreate(context);
    expect(context.values.course).toBe(7);
    const orphan = hookContext("lms-quizzes", { title: "Check", lesson: 3 });
    vi.mocked(orphan.system.records.get).mockRejectedValue(new Error("404"));
    await expect(beforeCreate(orphan)).rejects.toThrow(/Choose the lesson/);
  });

  it("let an instructor add sections, lessons and quizzes only to their own courses", async () => {
    const instructor = { can: vi.fn(() => false), userId: "teacher-1" };
    const theirs = hookContext("lms-sections", { title: "Intro", course: 4 }, instructor);
    await expect(beforeCreate(theirs)).rejects.toThrow(/your own courses/);
    expect(vi.mocked(theirs.system.records.list).mock.calls[0][1]).toMatchObject({ filter: 'id = 4 && createdById = "teacher-1"' });

    const own = hookContext("lms-lessons", { title: "One", course: 4 }, instructor);
    vi.mocked(own.system.records.list).mockResolvedValue({ page: 1, perPage: 1, totalItems: 1, totalPages: 1, items: [{ id: 4 }] });
    await beforeCreate(own);

    const quiz = hookContext("lms-quizzes", { title: "Check", lesson: 3 }, instructor);
    vi.mocked(quiz.system.records.get).mockResolvedValue({ id: 3, course: 9 });
    await expect(beforeCreate(quiz)).rejects.toThrow(/your own courses/);

    // An update that keeps the course isn't checked again.
    await beforeUpdate(hookContext("lms-lessons", { title: "Renamed" }, { ...instructor, event: "record.beforeUpdate", record: { id: 2, course: 4, title: "One" } }));
  });

  it("put the instructor's name on a new course, and let only managers change it", async () => {
    const instructor = { can: vi.fn(() => false), userId: "learner-1" };
    const created = hookContext("lms-courses", { title: "Rust", byline: "Someone famous" }, instructor);
    await beforeCreate(created);
    expect(created.values.byline).toBe("Lee");
    await expect(beforeUpdate(hookContext("lms-courses", { byline: "Me" }, { ...instructor, event: "record.beforeUpdate", record: { id: 1, byline: "Lee" } }))).rejects.toThrow(/LMS manager/);

    const guest = hookContext("lms-courses", { title: "Go", byline: "A Guest" });
    await beforeCreate(guest);
    expect(guest.values.byline).toBe("A Guest");
  });

  it("enroll only real users, once per course", async () => {
    await expect(beforeCreate(hookContext("lms-enrollments", { student: "ghost", course: 1 }))).rejects.toThrow(/no user/);
    await expect(beforeCreate(hookContext("lms-enrollments", { student: 'x" || "', course: 1 }))).rejects.toThrow(/no user/);
    const twice = hookContext("lms-enrollments", { student: "learner-1", course: 1 });
    vi.mocked(twice.system.records.list).mockResolvedValue({ page: 1, perPage: 1, totalItems: 1, totalPages: 1, items: [{ id: 4, state: "active" }] });
    await expect(beforeCreate(twice)).rejects.toThrow(/already enrolled/);
    const first = hookContext("lms-enrollments", { student: "learner-1", course: 1 });
    await beforeCreate(first);
    expect(first.values).toMatchObject({ state: "active", enrolledAt: expect.any(String) });
  });

  it("keep an enrollment on its learner and course, and date its completion", async () => {
    await expect(beforeUpdate(hookContext("lms-enrollments", { student: "someone-else" }, { record: { id: 1, student: "learner-1", course: 1, state: "active" } }))).rejects.toThrow(/can't move/);
    const completing = hookContext("lms-enrollments", { state: "completed" }, { record: { id: 1, student: "learner-1", course: 1, state: "active" } });
    await beforeUpdate(completing);
    expect(completing.values.completedAt).toEqual(expect.any(String));
  });
});
