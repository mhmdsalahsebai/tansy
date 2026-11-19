/** The LMS's server logic, shared by its hooks and routes. Every write goes through `system.records`, so hooks and the audit log see it. */
import { randomBytes } from "node:crypto";
import { wordsIn, type ExtensionContext, type Formatters, type RecordValues, type RecordsApi } from "tansy/plugin";
import { siteMessages } from "./site-messages";
import { certificateCode, orderLessons, percentDone } from "./logic";
import { COURSES_FIELD } from "./schema";

export interface LmsSettings { certificates: boolean; requireQuizzes: boolean; passingScore: number }

/** better-auth ids are letters, digits, hyphens and underscores. Anything else never reaches a filter. */
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const isUserId = (value: unknown): value is string => typeof value === "string" && USER_ID.test(value);
export const idOf = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null);
const str = (value: unknown) => (typeof value === "string" ? value : "");

/** A filter value for a user id. Throws on anything else, so no caller can write past the quotes. */
export function userFilter(field: string, userId: string) {
  if (!isUserId(userId)) throw new Error("Not a user id.");
  return `${field} = "${userId}"`;
}

/**
 * One at a time per key, in this process. The CMS runs as one server process (SECURITY_MODEL.md,
 * Operating it), so this is enough to keep two parallel requests from both passing a check.
 * On globalThis because Next.js gives routes and instrumentation, where hooks run, separate
 * copies of a module. A route and a hook writing the same thing must still take turns.
 */
declare const globalThis: { lmsQueues?: Map<string, Promise<unknown>> } & typeof global;
const queues = (globalThis.lmsQueues ??= new Map<string, Promise<unknown>>());
export function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(work);
  const settled = run.catch(() => {});
  queues.set(key, settled);
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return run;
}

/** Every matching record, up to `limit`. Lists are paged at 200. */
export async function listAll(records: RecordsApi, slug: string, query: Record<string, unknown>, limit = 2000): Promise<RecordValues[]> {
  const items: RecordValues[] = [];
  for (let page = 1; items.length < limit; page++) {
    const result = await records.list(slug, { ...query, page, perPage: 200 });
    items.push(...result.items);
    if (page >= result.totalPages) break;
  }
  return items.slice(0, limit);
}

/**
 * Enrollments that open a course: active or completed. A revoked one is history, and a lapsed one
 * came from a plan that no longer covers the course, and opens again if it does.
 */
export const CURRENT = 'state != "revoked" && state != "lapsed"';

/** A learner's enrollment in a course that still counts: active or completed. */
export async function currentEnrollment(context: ExtensionContext, student: string, course: number) {
  const { items } = await context.system.records.list("lms-enrollments", { filter: `${userFilter("student", student)} && course = ${course} && ${CURRENT}`, sort: "createdAt", perPage: 1 });
  return items[0] ?? null;
}

/**
 * Writes the student's lms_courses from their enrollments, rather than adding or removing one id,
 * so it repairs itself whatever happened before. A user who no longer exists is skipped.
 */
export async function rebuildCourses(context: ExtensionContext, student: unknown) {
  if (!isUserId(student)) return;
  await exclusive(`courses:${student}`, async () => {
    const enrollments = await listAll(context.system.records, "lms-enrollments", { filter: `${userFilter("student", student)} && ${CURRENT}`, fields: "course" });
    const courses = [...new Set(enrollments.map((enrollment) => idOf(enrollment.course)).filter((id): id is number => id !== null))].sort((a, b) => a - b);
    const stored = await context.system.users.getValues(student);
    if (!stored) return;
    // Usually already right, as the route and the hook both rebuild. Unchanged, nothing is written.
    const current = Array.isArray(stored[COURSES_FIELD]) ? stored[COURSES_FIELD] as unknown[] : [];
    if (current.length === courses.length && current.every((id, i) => id === courses[i])) return;
    await context.system.users.setValues(student, { [COURSES_FIELD]: courses });
  });
}

/** The course's published lessons in reading order, with only their place. */
export async function courseLessons(records: RecordsApi, course: number) {
  const [lessons, sections] = await Promise.all([
    listAll(records, "lms-lessons", { filter: `course = ${course} && status = "published"`, fields: "id,title,section,position" }),
    listAll(records, "lms-sections", { filter: `course = ${course}`, fields: "id,position" }),
  ]);
  return orderLessons(lessons as Array<RecordValues & { id: number }>, sections as Array<{ id: number; position?: unknown }>);
}

/** Which lessons of a course the student finished, by lesson id. */
export async function finishedLessons(context: ExtensionContext, student: string, course: number) {
  const progress = await listAll(context.system.records, "lms-progress", { filter: `${userFilter("student", student)} && course = ${course}`, fields: "lesson" });
  return new Set(progress.map((row) => idOf(row.lesson)).filter((id): id is number => id !== null));
}

/** Quizzes of the course's published lessons, and which of them the student has passed. */
async function quizzesLeft(context: ExtensionContext, student: string, course: number, lessonIds: Set<number>) {
  const quizzes = (await listAll(context.system.records, "lms-quizzes", { filter: `course = ${course}`, fields: "id,lesson" })).filter((quiz) => lessonIds.has(idOf(quiz.lesson) ?? 0));
  if (!quizzes.length) return 0;
  const passed = await listAll(context.system.records, "lms-attempts", { filter: `${userFilter("student", student)} && passed = true`, fields: "quiz" });
  const passedIds = new Set(passed.map((attempt) => idOf(attempt.quiz)));
  return quizzes.filter((quiz) => !passedIds.has(quiz.id as number)).length;
}

/**
 * Completes the enrollment once every published lesson is done, and every quiz passed when
 * that's required. Then issues one certificate and emails it. Safe to call any number of times.
 */
export async function checkCompletion(context: ExtensionContext, settings: LmsSettings, student: unknown, course: unknown) {
  const courseId = idOf(course);
  if (!isUserId(student) || courseId === null) return;
  await exclusive(`complete:${student}:${courseId}`, async () => {
    const enrollment = await currentEnrollment(context, student, courseId);
    if (!enrollment) return;
    const lessons = await courseLessons(context.system.records, courseId);
    if (!lessons.length) return;
    const done = await finishedLessons(context, student, courseId);
    if (!lessons.every((lesson) => done.has(lesson.id))) return;
    if (settings.requireQuizzes && (await quizzesLeft(context, student, courseId, new Set(lessons.map((lesson) => lesson.id)))) > 0) return;

    if (enrollment.state !== "completed") {
      await context.system.records.update("lms-enrollments", enrollment.id as number, { state: "completed", completedAt: new Date().toISOString() });
    }
    if (settings.certificates) await issueCertificate(context, student, courseId);
  });
}

/**
 * The language to write to a learner in, with the plugin's words in it and how to read records
 * in it: their chosen language when the site is published in it, otherwise the site's default.
 */
export async function learnerWords(context: Pick<ExtensionContext, "schema">, locale: string): Promise<Formatters & { locale: string; read: { locale?: string } }> {
  const languages = await context.schema.languages();
  const known = languages.items.some((item) => item.code === locale) ? locale : null;
  return { locale, ...wordsIn(siteMessages, locale), read: known && languages.items.length > 1 ? { locale: known } : {} };
}

/** A language for the records API from `?locale=`, on a site with more than one. Anything else reads the default. */
export async function askedLanguage(context: Pick<ExtensionContext, "schema">, request: Request) {
  const asked = new URL(request.url).searchParams.get("locale");
  if (!asked) return {};
  const languages = await context.schema.languages();
  return languages.items.length > 1 && languages.items.some((item) => item.code === asked) ? { locale: asked } : {};
}

async function issueCertificate(context: ExtensionContext, student: string, course: number) {
  const { items } = await context.system.records.list("lms-certificates", { filter: `${userFilter("student", student)} && course = ${course}`, perPage: 1, fields: "id" });
  if (items.length) return;
  const user = await context.system.users.get(student);
  if (!user) return;
  const { t, locale, read } = await learnerWords(context, user.locale);
  const title = str((await context.system.records.get("lms-courses", course, { fields: "title", ...read }).catch(() => null))?.title) || t("lms.mail.yourCourse");
  const code = certificateCode((size) => randomBytes(size));
  await context.system.records.create("lms-certificates", { status: "published", code, student, course, studentName: user.name, issuedAt: new Date().toISOString() });
  await context.mail.send({
    to: user.email,
    locale,
    subject: t("lms.mail.completedSubject", { title: title.slice(0, 150) }),
    body: t("lms.mail.completedBody", { name: user.name || t("lms.mail.learner"), title, code }),
  }).catch((error: unknown) => console.error("[lms] certificate email", error));
}

/** Percent done and the next lesson, for each of a learner's courses. `records` reads as the learner, so only what they may open gets a link. */
export async function learnerCourses(context: ExtensionContext, records: RecordsApi, student: string, read: { locale?: string } = {}) {
  const enrollments = await listAll(records, "lms-enrollments", { filter: `${userFilter("student", student)} && ${CURRENT}`, sort: "-enrolledAt", fields: "id,course,state,enrolledAt,completedAt" }, 200);
  return Promise.all(enrollments.map(async (enrollment) => {
    const courseId = idOf(enrollment.course)!;
    const course = await records.get("lms-courses", courseId, { fields: "id,title,slug,summary,cover", urls: "1", ...read }).catch(() => null);
    const lessons = await courseLessons(records, courseId);
    const done = await finishedLessons(context, student, courseId);
    const next = lessons.find((lesson) => !done.has(lesson.id));
    const nextLesson = next ? await records.get("lms-lessons", next.id, { fields: "id,title", urls: "1", ...read }).catch(() => null) : null;
    return {
      enrollment: { id: enrollment.id, state: enrollment.state, enrolledAt: enrollment.enrolledAt ?? null, completedAt: enrollment.completedAt ?? null },
      course: course ? { id: course.id, title: str(course.title), summary: str(course.summary), cover: str(course.cover) || null, recordPath: str(course.recordPath) || null } : { id: courseId, title: "", summary: "", cover: null, recordPath: null },
      lessons: lessons.length,
      completed: lessons.filter((lesson) => done.has(lesson.id)).length,
      percent: percentDone(lessons.filter((lesson) => done.has(lesson.id)).length, lessons.length),
      next: nextLesson ? { id: nextLesson.id, title: str(nextLesson.title), recordPath: str(nextLesson.recordPath) || null } : null,
    };
  }));
}

export type EnrollmentSource = "free" | "staff" | "purchase" | "plan";

/**
 * Enrolls the student unless they already are. A revoked enrollment stays as history, and a new
 * one is made. A lapsed one opens again, so it keeps its place. Returns the enrollment and whether
 * it is new.
 *
 * Someone in a course through their plan who then buys it or is enrolled by staff keeps it when
 * the plan ends, so the enrollment takes the new source.
 */
export async function enroll(context: ExtensionContext, student: string, course: number, source: EnrollmentSource) {
  const result = await exclusive(`enroll:${student}:${course}`, async () => {
    const existing = await currentEnrollment(context, student, course);
    if (existing) {
      if (existing.source === "plan" && source !== "plan") return { enrollment: await context.system.records.update("lms-enrollments", existing.id as number, { source }), created: false };
      return { enrollment: existing, created: false };
    }
    const { items: [lapsed] } = await context.system.records.list("lms-enrollments", { filter: `${userFilter("student", student)} && course = ${course} && state = "lapsed"`, sort: "-createdAt", perPage: 1, fields: "id" });
    if (lapsed) return { enrollment: await context.system.records.update("lms-enrollments", lapsed.id as number, { state: "active", source }), created: false };
    const enrollment = await context.system.records.create("lms-enrollments", { status: "published", course, student, source, state: "active", enrolledAt: new Date().toISOString() });
    return { enrollment, created: true };
  });
  // Straight away, rather than only from the hook after commit, so the learner's next request can open the course.
  await rebuildCourses(context, student);
  return result;
}

/**
 * Plans, from the Payments plugin, read as data: LMS imports nothing from it. A person's
 * `payments-entitlements` record lists the access their active plans include, by id, and the
 * collections those open whole, by slug. A course is covered by a plan when that list has
 * `lms-courses`, or one of the access the course is "Included in".
 */
export const ACCESS = "payments-access";
const ENTITLEMENTS = "payments-entitlements";
/** The field the LMS adds to courses when Payments is installed. Any other Reference to Access on courses counts too. */
export const INCLUDED = "included";
export const INCLUDED_FIELD = {
  name: INCLUDED,
  type: "reference",
  config: { collection: ACCESS, displayField: "name", allowMultiple: true, label: "Included in", description: "Subscribers to a plan that includes one of these may take the course without buying it." },
};

const accessIds = (value: unknown) => (Array.isArray(value) ? value : [value]).filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0);

/** What the person's plans open, from the record Payments keeps. Without Payments, nothing. */
export async function entitlementsOf(context: ExtensionContext, student: string): Promise<Array<number | string>> {
  if (!isUserId(student)) return [];
  const { items } = await context.system.records.list(ENTITLEMENTS, { filter: userFilter("user", student), perPage: 1, fields: "access" }).catch(() => ({ items: [] as RecordValues[] }));
  const access = items[0]?.access;
  return Array.isArray(access) ? access.filter((item): item is number | string => typeof item === "number" || typeof item === "string") : [];
}

/** Reference fields on courses that point at Payments' access, whatever the owner named them. */
async function accessFields(context: ExtensionContext) {
  const shape = await context.schema.describe("lms-courses");
  return (shape?.fields ?? []).filter((field) => field.type === "reference" && field.config?.collection === ACCESS).map((field) => field.name);
}

/** The access a course is "Included in", read from what's stored, never from a request. */
export async function courseAccess(context: ExtensionContext, course: number) {
  const fields = await accessFields(context);
  if (!fields.length) return [];
  const record = await context.system.records.get("lms-courses", course, { fields: fields.join(",") }).catch(() => null);
  return [...new Set(fields.flatMap((field) => accessIds(record?.[field])))];
}

/** Whether these entitlements open the course: every course, or one of the access it is in. */
export async function covers(context: ExtensionContext, access: Array<number | string>, course: number) {
  if (!access.length) return false;
  if (access.includes("lms-courses")) return true;
  return (await courseAccess(context, course)).some((id) => access.includes(id));
}

/**
 * Brings a learner's plan enrollments in line with what their plans cover now: a course no longer
 * covered lapses, and one covered again opens where they left it. Progress, quiz attempts and
 * certificates are kept either way. Reads everything as it is now, so running it again, or after a
 * newer change, always leaves the right state. `course` limits it to one course.
 */
export async function reconcilePlanEnrollments(context: ExtensionContext, settings: LmsSettings, student: unknown, course?: number) {
  if (!isUserId(student)) return;
  const restored = await exclusive(`plan:${student}`, async () => {
    const enrollments = await listAll(context.system.records, "lms-enrollments", { filter: `${userFilter("student", student)} && source = "plan" && state != "revoked"${course ? ` && course = ${course}` : ""}`, fields: "id,course,state" });
    if (!enrollments.length) return [];
    const access = await entitlementsOf(context, student);
    const opened: number[] = [];
    let changed = false;
    for (const enrollment of enrollments) {
      const courseId = idOf(enrollment.course);
      if (courseId === null) continue;
      const covered = await covers(context, access, courseId);
      if (enrollment.state === "lapsed" && covered) {
        await context.system.records.update("lms-enrollments", enrollment.id as number, { state: "active" });
        opened.push(courseId);
        changed = true;
      } else if (enrollment.state !== "lapsed" && !covered) {
        await context.system.records.update("lms-enrollments", enrollment.id as number, { state: "lapsed" });
        changed = true;
      }
    }
    if (changed) await rebuildCourses(context, student);
    return opened;
  });
  // A course they had finished counts as finished again.
  for (const courseId of restored) await checkCompletion(context, settings, student, courseId);
}
