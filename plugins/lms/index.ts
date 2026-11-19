import { z } from "zod";
import { defineBlock, definePlugin, defineRoute, type AfterHookContext, type BeforeHookContext, type ExtensionContext, type RecordsApi } from "tansy/plugin";
import { CERTIFICATE_CODE, grade, normalizeCode, publicQuestion, questionsOf, slugify } from "./logic";
import { BYLINE_FIELD, COLLECTIONS, CONTRACT, LAPSED_STATE, lmsRoles, lmsSchema, PAID_ACCESS, PLAN_SOURCE } from "./schema";
import {
  ACCESS, askedLanguage, checkCompletion, covers, currentEnrollment, enroll, entitlementsOf, exclusive, idOf, INCLUDED_FIELD, isUserId, learnerCourses, learnerWords, listAll,
  rebuildCourses, reconcilePlanEnrollments, userFilter, type LmsSettings,
} from "./service";
import { BLOCK_FIELD_LABELS, COLLECTION_LABELS, FIELD_LABELS, messages } from "./messages";
import { lmsTools } from "./tools";

export interface LmsOptions {
  /** The prefix of course addresses, read on first install. After that, edit URL patterns in the dashboard. */
  basePath?: string;
  /** Percent needed to pass a quiz, until changed under LMS → Settings. Each quiz can set its own. */
  passingScore?: number;
  /** Issue a certificate when a course is completed, until changed under LMS → Settings. */
  certificates?: boolean;
  /** Whether a course counts as completed only once its quizzes are passed, until changed under LMS → Settings. */
  requireQuizzes?: boolean;
}

const optionsSchema = z.strictObject({
  basePath: z.string().regex(/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/, 'Use a path such as "/courses".'),
  passingScore: z.number().int().min(0).max(100),
  certificates: z.boolean(),
  requireQuizzes: z.boolean(),
});

/** The field a missing slug is made from, and what to call a record with an empty one. */
const SLUG_SOURCE: Record<string, [string, string]> = { "lms-courses": ["title", "course"], "lms-lessons": ["title", "lesson"] };

/** Running the school: every course, enrollments and settings. Instructors don't hold it. */
const MANAGE = "ext.lms:manage";

const settingsOf = async (context: ExtensionContext) => (await context.settings.get()) as unknown as LmsSettings;

const str = (value: unknown) => (typeof value === "string" ? value : "");

/** Fields the owner may have removed are left alone, or the save would fail on a field that isn't there. */
async function fieldsOf(context: ExtensionContext, slug: string) {
  return new Set((await context.schema.describe(slug))?.fields.map((field) => field.name) ?? []);
}

async function uniqueSlug(records: RecordsApi, slug: string, base: string, ownId: unknown) {
  for (let attempt = 1; attempt <= 50; attempt++) {
    const candidate = attempt === 1 ? base : `${base.slice(0, 75)}-${attempt}`;
    // slugify only produces letters, digits and hyphens, so the filter can't be broken out of.
    const { items } = await records.list(slug, { filter: `slug = "${candidate}"`, perPage: 2, fields: "id" });
    if (!items.some((item) => item.id !== ownId)) return candidate;
  }
  return `${base.slice(0, 60)}-${Date.now().toString(36)}`;
}

/** On an update, `values` holds only what changed, so the stored value fills the rest. */
const currentOf = ({ values, record }: BeforeHookContext) => (name: string) => (Object.hasOwn(values, name) ? values[name] : record?.[name]);

async function fillSlug(context: BeforeHookContext) {
  const [source, fallback] = SLUG_SOURCE[context.collection.slug];
  const current = currentOf(context);
  if (!(await fieldsOf(context, context.collection.slug)).has("slug") || str(current("slug"))) return;
  context.values.slug = await uniqueSlug(context.system.records, context.collection.slug, slugify(str(current(source)), fallback), context.record?.id);
}

/** A lesson's section has to be one of its own course's. */
async function checkSection(context: BeforeHookContext) {
  const current = currentOf(context);
  const sectionId = idOf(current("section"));
  if (sectionId === null || !(Object.hasOwn(context.values, "section") || Object.hasOwn(context.values, "course"))) return;
  const section = await context.system.records.get("lms-sections", sectionId, { fields: "course" }).catch(() => null);
  if (!section || section.course !== idOf(current("course"))) context.reject("Choose a section of this lesson's course.", "section");
}

const changes = (context: BeforeHookContext, name: string) =>
  Object.hasOwn(context.values, name) && (context.values[name] ?? null) !== (context.record?.[name] ?? null);

/**
 * Someone who doesn't run the school, such as an instructor, adds sections, lessons and
 * quizzes only to courses they created. Their own-record grants already keep them out of
 * anyone else's records. This keeps them from attaching their own records to another's course.
 */
async function checkOwnCourse(context: BeforeHookContext, course: unknown, field: string) {
  if (context.can(MANAGE) || context.can("record:update")) return;
  const courseId = idOf(course);
  if (courseId === null) return;
  const { userId } = context;
  const { items } = isUserId(userId) ? await context.system.records.list("lms-courses", { filter: `id = ${courseId} && ${userFilter("createdById", userId)}`, perPage: 1, fields: "id" }) : { items: [] };
  if (!items.length) context.reject("Choose one of your own courses.", field);
}

/**
 * A course carries its instructor's name, taken from their account when it's created.
 * Managers can write any name, such as a guest teacher's. Anyone else always gets their
 * own, and can't change it.
 */
async function credit(context: BeforeHookContext) {
  const { values, userId, event } = context;
  if (!(await fieldsOf(context, "lms-courses")).has("byline")) return;
  const manages = context.can(MANAGE);
  if (event === "record.beforeUpdate") {
    if (!manages && changes(context, "byline")) context.reject("Only an LMS manager can change who a course is taught by.", "byline");
    return;
  }
  if (manages && str(values.byline).trim()) return;
  const name = userId ? (await context.system.users.get(userId))?.name.trim().slice(0, 200) : "";
  values.byline = name || null;
}

/** A quiz's course always follows its lesson, because the quiz's rule reads it. */
async function followLesson(context: BeforeHookContext) {
  const current = currentOf(context);
  if (context.record && !Object.hasOwn(context.values, "lesson") && !Object.hasOwn(context.values, "course")) return;
  const lessonId = idOf(current("lesson"));
  const lesson = lessonId === null ? null : await context.system.records.get("lms-lessons", lessonId, { fields: "course" }).catch(() => null);
  if (!lesson) context.reject("Choose the lesson this quiz belongs to.", "lesson");
  context.values.course = lesson!.course;
}

async function prepareEnrollment(context: BeforeHookContext) {
  const { values, reject } = context;
  if (!isUserId(values.student) || !(await context.system.users.get(values.student))) reject("There is no user with this id.", "student");
  const course = idOf(values.course);
  if (course === null) reject("Choose a course.", "course");
  values.state = str(values.state) || "active";
  if (values.state !== "revoked" && (await currentEnrollment(context, values.student as string, course!))) reject("This learner is already enrolled in this course.", "student");
  if (!values.enrolledAt) values.enrolledAt = new Date().toISOString();
}

function keepEnrollmentPlace(context: BeforeHookContext) {
  const { values, record, reject } = context;
  for (const name of ["student", "course"]) {
    if (Object.hasOwn(values, name) && values[name] !== record?.[name]) reject("An enrollment can't move to another learner or course. Revoke it and enroll again.", name);
  }
  if (values.state === "completed" && record?.state !== "completed" && !values.completedAt) values.completedAt = new Date().toISOString();
}

/** Payments' price field type and purchases collection. LMS reads them as data and never imports Payments. */
const PRICE_TYPE = "payments_price";
const PURCHASES = "payments-purchases";
/** One record per person, kept by Payments from their subscriptions: what their plans open. */
const ENTITLEMENTS = "payments-entitlements";

/** A person's plans changed, so their plan enrollments follow: lapsed where no longer covered, open again where they are. */
async function followEntitlements(context: AfterHookContext) {
  await reconcilePlanEnrollments(context, await settingsOf(context), context.record.user);
}

/**
 * A course was put in or taken out of an access, so the plan enrollments in it follow, person by
 * person. Courses opened whole by an access don't change here: that's a change to the access,
 * which Payments follows by updating everyone's entitlements.
 */
async function followCourseAccess(context: AfterHookContext) {
  const shape = await context.schema.describe("lms-courses");
  const fields = (shape?.fields ?? []).filter((field) => field.type === "reference" && field.config?.collection === ACCESS).map((field) => field.name);
  if (!fields.some((name) => JSON.stringify(context.record[name] ?? null) !== JSON.stringify(context.previous?.[name] ?? null))) return;
  const course = idOf(context.record.id);
  if (course === null) return;
  const enrollments = await listAll(context.system.records, "lms-enrollments", { filter: `course = ${course} && source = "plan" && state != "revoked"`, fields: "student" }, 10_000);
  const settings = await settingsOf(context);
  for (const student of new Set(enrollments.map((enrollment) => enrollment.student))) await reconcilePlanEnrollments(context, settings, student, course);
}

/**
 * Paid courses are sold through the Payments plugin, which sells any record with its price
 * field. A paid course needs a price, and only a paid course keeps one, so a free or
 * staff-only course can't be bought around its access.
 */
async function checkPrice(context: BeforeHookContext) {
  const price = (await context.schema.describe("lms-courses"))?.fields.find((field) => field.type === PRICE_TYPE);
  // An edit that touches neither leaves the course as it was sold.
  if (context.record && !changes(context, "access") && !(price && changes(context, price.name))) return;
  const current = currentOf(context);
  if (current("access") !== "paid") {
    if (!price || current(price.name) === null || current(price.name) === undefined) return;
    // Switched away from paid, the price goes with it. A price sent with it is a mistake.
    if (Object.hasOwn(context.values, price.name)) context.reject("Only a paid course has a price. Choose Paid, or clear the price.", price.name);
    context.values[price.name] = null;
    return;
  }
  if (!price) context.reject("To sell courses, install the Payments plugin and add a Price field to Courses.", "access");
  const amount = current(price!.name);
  if (typeof amount !== "number" || amount <= 0) context.reject("Set a price to sell this course.", price!.name);
}

/** A purchase of a course from Payments is only data to LMS: `buyer`, `collection`, `recordId` and `state`. */
function purchasedCourse(record: AfterHookContext["record"]) {
  const course = idOf(record.recordId);
  return record.collection === "lms-courses" && isUserId(record.buyer) && course !== null ? { student: record.buyer, course } : null;
}

/**
 * Enrolls the buyer of a course. A durable hook may run more than once, and enroll()
 * leaves a current enrollment alone, so a repeat changes nothing.
 */
async function enrollBuyer(context: AfterHookContext) {
  const bought = purchasedCourse(context.record);
  if (!bought || context.record.state !== "paid") return;
  // A course deleted since it was bought can't be enrolled in, and retrying wouldn't change that.
  if (!(await context.system.records.get("lms-courses", bought.course, { fields: "id" }).catch(() => null))) return;
  await enroll(context, bought.student, bought.course, "purchase");
}

/** A refunded course is taken back: enrollments that came from buying it are revoked. Staff and free enrollments stay. */
async function revokeRefunded(context: AfterHookContext) {
  const bought = purchasedCourse(context.record);
  if (!bought || context.record.state !== "refunded" || context.previous?.state === "refunded") return;
  const enrollments = await listAll(context.system.records, "lms-enrollments", { filter: `${userFilter("student", bought.student)} && course = ${bought.course} && source = "purchase" && state != "revoked"`, fields: "id" });
  for (const enrollment of enrollments) await context.system.records.update("lms-enrollments", enrollment.id as number, { state: "revoked" });
  if (enrollments.length) await rebuildCourses(context, bought.student);
}

async function welcome(context: AfterHookContext) {
  const { record, system, mail } = context;
  if (record.state !== "active" || !isUserId(record.student)) return;
  const user = await system.users.get(record.student);
  if (!user) return;
  // In the learner's language, and the course's title in it when the course has one.
  const { t, locale, read } = await learnerWords(context, user.locale);
  const course = await system.records.get("lms-courses", record.course as number, { fields: "title", ...read }).catch(() => null);
  const title = str(course?.title) || t("lms.mail.aCourse");
  await mail.send({ to: user.email, locale, subject: t("lms.mail.enrolledSubject", { title: title.slice(0, 150) }), body: t("lms.mail.enrolledBody", { name: user.name || t("lms.mail.someone"), title }) });
}

/** Turns the CMS into a learning platform: courses, lessons, enrollments, progress, quizzes and certificates. See docs/plugins/lms.md. */
export function lms(options: LmsOptions = {}) {
  // An option left undefined, as a config reading an unset variable passes, keeps its default.
  const given = Object.fromEntries(Object.entries(options).filter(([, option]) => option !== undefined)) as LmsOptions;
  const value = { basePath: "/courses", passingScore: 70, certificates: true, requireQuizzes: true, ...given };

  const beforeWrite = async (context: BeforeHookContext) => {
    const slug = context.collection.slug;
    if (SLUG_SOURCE[slug]) await fillSlug(context);
    if (slug === "lms-courses") {
      await credit(context);
      await checkPrice(context);
    }
    if ((slug === "lms-sections" || slug === "lms-lessons") && (!context.record || changes(context, "course"))) await checkOwnCourse(context, context.values.course, "course");
    if (slug === "lms-lessons") await checkSection(context);
    if (slug === "lms-quizzes") {
      await followLesson(context);
      if (!context.record || changes(context, "lesson")) await checkOwnCourse(context, context.values.course, "lesson");
    }
  };

  /** Completion may follow from a lesson finished or a quiz passed, including ones staff record by hand. */
  const afterProgress = async (context: AfterHookContext) => {
    const { collection, record } = context;
    if (collection.slug === "lms-progress") await checkCompletion(context, await settingsOf(context), record.student, record.course);
    if (collection.slug === "lms-attempts" && record.passed === true) {
      const quiz = await context.system.records.get("lms-quizzes", record.quiz as number, { fields: "course" }).catch(() => null);
      if (quiz) await checkCompletion(context, await settingsOf(context), record.student, quiz.course);
    }
  };

  return definePlugin({
    name: "lms",
    messages,
    version: "0.1.0",
    apiVersion: 1,
    requires: { cms: "^0.1.0" },
    admin: { server: "@tansy/lms/admin", client: "@tansy/lms/client", render: "@tansy/lms/render" },
    csp: { frame: ["https://www.youtube-nocookie.com", "https://player.vimeo.com"] },
    options: { schema: optionsSchema, value },
    settings: {
      permission: MANAGE,
      fields: [
        { name: "passingScore", type: "number", integer: true, min: 0, max: 100, default: value.passingScore, label: "Passing score (%)", description: "Needed to pass a quiz that doesn't set its own." },
        { name: "requireQuizzes", type: "boolean", default: value.requireQuizzes, label: "Require quizzes", description: "A course counts as completed only once its quizzes are passed." },
        { name: "certificates", type: "boolean", default: value.certificates, label: "Issue certificates", description: "Give each learner a certificate, with a code anyone can check, when they complete a course." },
      ],
    },
    permissions: { "ext.lms": ["manage", "enroll"] },
    contract: CONTRACT,
    tools: lmsTools,
    blocks: [
      defineBlock({ name: "lms_text", label: "Text", labels: { ar: "نص" }, category: "Lesson", fields: [{ name: "body", type: "rich_text", config: { labels: { ar: "النص" } } }] }),
      defineBlock({
        name: "lms_video",
        label: "Video",
        labels: { ar: "فيديو" },
        category: "Lesson",
        fields: [
          { name: "file", type: "file", config: { allowedTypes: ["video/mp4", "video/webm", "video/ogg"], labels: { ar: "الملف" } } },
          { name: "url", type: "url", config: { allowedProtocols: ["https"], allowedDomains: ["youtube.com", "youtu.be", "vimeo.com"], description: "YouTube or Vimeo, when there's no uploaded file.", labels: { ar: "الرابط" }, descriptions: { ar: "YouTube أو Vimeo، حين لا يوجد ملف مرفوع." } } },
          { name: "title", type: "text", config: { maxLength: 200, labels: { ar: "العنوان" } } },
          { name: "transcript", type: "rich_text", config: { labels: { ar: "النص المكتوب" } } },
        ],
      }),
      defineBlock({
        name: "lms_download",
        label: "Download",
        labels: { ar: "تنزيل" },
        category: "Lesson",
        fields: [
          { name: "file", type: "file", config: { required: true, labels: { ar: "الملف" } } },
          { name: "label", type: "text", config: { maxLength: 200, labels: { ar: "النص الظاهر" } } },
        ],
      }),
      defineBlock({
        name: "lms_question",
        label: "Question",
        labels: { ar: "سؤال" },
        category: "Quiz",
        defaults: { kind: "single", choices: [] },
        fields: [
          { name: "prompt", type: "text", config: { required: true, multiline: true, maxLength: 2000, labels: { ar: "السؤال" } } },
          { name: "kind", type: "radio", config: { labels: { ar: "النوع" }, options: [{ label: "One answer", labels: { ar: "إجابة واحدة" }, value: "single" }, { label: "Several answers", labels: { ar: "عدة إجابات" }, value: "multiple" }, { label: "Typed answer", labels: { ar: "إجابة مكتوبة" }, value: "short" }] } },
          { name: "choices", type: "json", config: { description: 'For choice questions, a list such as ["Paris", "Rome"].', labels: { ar: "الخيارات" }, descriptions: { ar: 'لأسئلة الاختيار، قائمة مثل ["Paris", "Rome"].' } } },
          { name: "correct", type: "json", config: { description: "The answer's position from 0, such as 1. Several: [0, 2]. Typed: the accepted answers, such as [\"Paris\"].", labels: { ar: "الإجابة الصحيحة" }, descriptions: { ar: "موضع الإجابة بدءًا من 0، مثل 1. لعدة إجابات: [0, 2]. للمكتوبة: الإجابات المقبولة، مثل [\"Paris\"]." } } },
          { name: "explanation", type: "rich_text", config: { labels: { ar: "الشرح" } } },
        ],
      }),
    ],
    hooks: {
      "record.beforeCreate": async (context) => {
        if (context.collection.slug === "lms-enrollments") await prepareEnrollment(context);
        else await beforeWrite(context);
      },
      "record.beforeUpdate": async (context) => {
        if (context.collection.slug === "lms-enrollments") keepEnrollmentPlace(context);
        else await beforeWrite(context);
      },
      "record.afterCreate": async (context) => {
        if (context.collection.slug === "lms-enrollments") {
          await rebuildCourses(context, context.record.student);
          await welcome(context);
        } else if (context.collection.slug === PURCHASES) await enrollBuyer(context);
        else if (context.collection.slug === ENTITLEMENTS) await followEntitlements(context);
        else await afterProgress(context);
      },
      "record.afterUpdate": async (context) => {
        if (context.collection.slug === "lms-enrollments") await rebuildCourses(context, context.record.student);
        else if (context.collection.slug === PURCHASES) await revokeRefunded(context);
        else if (context.collection.slug === ENTITLEMENTS) await followEntitlements(context);
        else if (context.collection.slug === "lms-courses") await followCourseAccess(context);
      },
      "record.afterDelete": async (context) => {
        if (context.collection.slug === "lms-enrollments") await rebuildCourses(context, context.record.student);
      },
    },
    routes: [
      defineRoute({
        method: "POST",
        path: "/courses/:id/enroll",
        access: "authenticated",
        audit: "lms.enroll",
        handler: async (context) => {
          const id = Number(context.params.id);
          // As the caller, so a draft or unknown course reads as missing.
          const course = await context.records.get("lms-courses", id, { fields: "id,access" });
          const student = context.principal.kind === "anonymous" ? "" : context.principal.user.id;
          // A free course is free for everyone. Otherwise the person's plans may cover it, read from what Payments stored.
          // Under the lock the plan hook takes, so a plan ending meanwhile can't miss the enrollment made here.
          const result = course.access === "free"
            ? { source: "free" as const, ...(await enroll(context, student, id, "free")) }
            : await exclusive(`plan:${student}`, async () => ((await covers(context, await entitlementsOf(context, student), id)) ? { source: "plan" as const, ...(await enroll(context, student, id, "plan")) } : null));
          if (!result && course.access === "paid") return Response.json({ error: { code: "PURCHASE_REQUIRED", message: "Buy this course, or subscribe to a plan that includes it, to enroll." } }, { status: 403 });
          if (!result) return Response.json({ error: { code: "ENROLLMENT_REQUIRED", message: "Staff enroll learners in this course." } }, { status: 403 });
          const { enrollment, created, source } = result;
          context.auditTarget("course", String(id), { created, source });
          return { enrollment: { id: enrollment.id, state: enrollment.state }, created, source };
        },
      }),
      defineRoute({
        method: "POST",
        path: "/enrollments",
        access: "permission",
        permission: "ext.lms:enroll",
        audit: "lms.enroll_staff",
        body: z.strictObject({ course: z.number().int().positive(), emails: z.array(z.email().max(320)).min(1).max(200) }),
        handler: async (context) => {
          const { course, emails } = context.body;
          await context.system.records.get("lms-courses", course, { fields: "id" });
          let enrolled = 0, already = 0, unknown = 0;
          for (const email of new Set(emails.map((address) => address.toLowerCase()))) {
            const user = await context.system.users.findByEmail(email);
            if (!user) { unknown++; continue; }
            const { created } = await enroll(context, user.id, course, "staff");
            if (created) enrolled++;
            else already++;
          }
          // Counts only: whether an address has an account isn't this permission's business.
          context.auditTarget("course", String(course), { enrolled, already, unknown });
          return { enrolled, already, unknown };
        },
      }),
      defineRoute({
        method: "POST",
        path: "/lessons/:id/complete",
        access: "authenticated",
        audit: "lms.lesson_complete",
        handler: async (context) => {
          const id = Number(context.params.id);
          const student = context.principal.kind === "anonymous" ? "" : context.principal.user.id;
          // The gate: the caller must be able to open the lesson.
          const lesson = await context.records.get("lms-lessons", id, { fields: "id,course" });
          const course = idOf(lesson.course)!;
          // A preview lesson opens for anyone, but only enrolled learners make progress.
          if (!(await currentEnrollment(context, student, course))) return Response.json({ error: { code: "NOT_ENROLLED", message: "Enroll in this course to track your progress." } }, { status: 403 });
          const key = `${student}:${id}`;
          const done = await exclusive(`progress:${key}`, async () => {
            const { items } = await context.system.records.list("lms-progress", { filter: `key = "${key}"`, perPage: 1, fields: "id" });
            if (items.length) return false;
            await context.system.records.create("lms-progress", { status: "published", key, student, course, lesson: id, completedAt: new Date().toISOString() });
            return true;
          });
          await checkCompletion(context, await settingsOf(context), student, course);
          context.auditTarget("lesson", String(id), { first: done });
          const enrollment = await currentEnrollment(context, student, course);
          return { completed: true, first: done, courseCompleted: enrollment?.state === "completed" };
        },
      }),
      defineRoute({
        method: "GET",
        path: "/me/courses",
        access: "authenticated",
        handler: async (context) => ({ items: await learnerCourses(context, context.records, context.principal.kind === "anonymous" ? "" : context.principal.user.id, await askedLanguage(context, context.request)) }),
      }),
      defineRoute({
        method: "GET",
        path: "/quizzes/:id",
        access: "authenticated",
        handler: async (context) => {
          const id = Number(context.params.id);
          const student = context.principal.kind === "anonymous" ? "" : context.principal.user.id;
          // The rule decides who may take it. Only then are the hidden questions read, and their answers left out.
          // In the learner's language, when the site has more than one.
          const read = await askedLanguage(context, context.request);
          const quiz = await context.records.get("lms-quizzes", id, { fields: "id,title,passingScore,maxAttempts", ...read });
          const stored = await context.system.records.get("lms-quizzes", id, { fields: "questions", ...read });
          const attempts = await listAll(context.system.records, "lms-attempts", { filter: `${userFilter("student", student)} && quiz = ${id}`, sort: "-submittedAt", fields: "score,passed,submittedAt" }, 200);
          const maxAttempts = typeof quiz.maxAttempts === "number" ? quiz.maxAttempts : null;
          return {
            id,
            title: str(quiz.title),
            passingScore: typeof quiz.passingScore === "number" ? quiz.passingScore : (await settingsOf(context)).passingScore,
            maxAttempts,
            attemptsLeft: maxAttempts === null ? null : Math.max(0, maxAttempts - attempts.length),
            passed: attempts.some((attempt) => attempt.passed === true),
            best: attempts.reduce<number | null>((best, attempt) => (typeof attempt.score === "number" && (best === null || attempt.score > best) ? attempt.score : best), null),
            questions: questionsOf(stored.questions).map(publicQuestion),
          };
        },
      }),
      defineRoute({
        method: "POST",
        path: "/quizzes/:id/attempts",
        access: "authenticated",
        audit: "lms.quiz_attempt",
        rateLimit: { window: 60, max: 10 },
        body: z.strictObject({ answers: z.record(z.string().max(64), z.union([z.number().int().min(0).max(1000), z.array(z.number().int().min(0).max(1000)).max(50), z.string().max(500)])) }),
        handler: async (context) => {
          const id = Number(context.params.id);
          const student = context.principal.kind === "anonymous" ? "" : context.principal.user.id;
          const quiz = await context.records.get("lms-quizzes", id, { fields: "id,passingScore,maxAttempts" });
          const result = await exclusive(`attempt:${student}:${id}`, async () => {
            const { totalItems } = await context.system.records.list("lms-attempts", { filter: `${userFilter("student", student)} && quiz = ${id}`, perPage: 1, fields: "id" });
            const maxAttempts = typeof quiz.maxAttempts === "number" ? quiz.maxAttempts : null;
            if (maxAttempts !== null && totalItems >= maxAttempts) return null;
            // Graded against the questions as the learner read them, in case a translation words or orders them differently.
            const stored = await context.system.records.get("lms-quizzes", id, { fields: "questions", ...(await askedLanguage(context, context.request)) });
            const questions = questionsOf(stored.questions);
            const { score, correct, total } = grade(questions, context.body.answers);
            const passed = total > 0 && score >= (typeof quiz.passingScore === "number" ? quiz.passingScore : (await settingsOf(context)).passingScore);
            const answers = Object.fromEntries(questions.filter((question) => Object.hasOwn(context.body.answers, question.id)).map((question) => [question.id, context.body.answers[question.id]]));
            await context.system.records.create("lms-attempts", { status: "published", quiz: id, student, answers, score, passed, submittedAt: new Date().toISOString() });
            return { score, correct, total, passed, attemptsLeft: maxAttempts === null ? null : maxAttempts - totalItems - 1 };
          });
          if (!result) return Response.json({ error: { code: "NO_ATTEMPTS_LEFT", message: "You have used every attempt at this quiz." } }, { status: 409 });
          context.auditTarget("quiz", String(id), { score: result.score, passed: result.passed });
          if (result.passed) {
            const stored = await context.system.records.get("lms-quizzes", id, { fields: "course" });
            await checkCompletion(context, await settingsOf(context), student, stored.course);
          }
          // The score only. Which answers were right would hand the key to the next attempt.
          return result;
        },
      }),
      defineRoute({
        method: "GET",
        path: "/certificates/:code",
        access: "public",
        reason: "Anyone with a certificate's code may check it is genuine. It reveals only the name, course and date. Codes are 80 random bits, and reads are rate limited.",
        handler: async (context) => {
          const code = normalizeCode(String(context.params.code ?? ""));
          if (!CERTIFICATE_CODE.test(code)) return Response.json({ error: { code: "NOT_FOUND", message: "No certificate has this code." } }, { status: 404 });
          const { items } = await context.system.records.list("lms-certificates", { filter: `code = "${code}"`, perPage: 1, fields: "code,course,studentName,issuedAt" });
          const certificate = items[0];
          if (!certificate) return Response.json({ error: { code: "NOT_FOUND", message: "No certificate has this code." } }, { status: 404 });
          const course = await context.system.records.get("lms-courses", certificate.course as number, { fields: "title", ...(await askedLanguage(context, context.request)) }).catch(() => null);
          return { code, studentName: str(certificate.studentName), course: str(course?.title), issuedAt: certificate.issuedAt ?? null };
        },
      }),
    ],
    migrations: [{
      id: "001-collections",
      up: async ({ schema, system }) => {
        for (const slug of COLLECTIONS) {
          if (await schema.describe(slug)) throw new Error(`A collection called "${slug}" already exists, and the LMS plugin didn't create it. Rename it under Dashboard → Collections, then start again.`);
        }
        await schema.apply(lmsSchema(value.basePath));
        await system.records.create("lms-my-courses", { status: "published", title: "My courses" });
        await system.records.create("lms-certificate", { status: "published", title: "Check a certificate" });
      },
    }, {
      // Instructors are people with a role, so a course names who teaches it instead of linking a profile.
      id: "002-instructors-are-people",
      up: async ({ schema, roles }) => {
        if (await schema.describe("lms-courses")) await schema.addFields("lms-courses", [BYLINE_FIELD]);
        for (const role of lmsRoles()) await roles.ensure(role);
      },
    }, {
      // A third way in: learners buy the course through the Payments plugin.
      id: "003-paid-courses",
      up: async ({ schema }) => {
        if (await schema.describe("lms-courses")) await schema.addOptions("lms-courses", "access", [PAID_ACCESS]);
      },
    }, {
      id: "004-names-in-languages",
      up: async ({ schema }) => {
        for (const [slug, labels] of Object.entries(COLLECTION_LABELS)) await schema.addLabels(slug, labels);
      },
    }, {
      id: "005-field-names-in-languages",
      up: async ({ schema }) => {
        for (const [slug, fields] of Object.entries(FIELD_LABELS)) await schema.addFieldLabels(slug, fields);
        for (const [block, fields] of Object.entries(BLOCK_FIELD_LABELS)) await schema.addBlockFieldLabels(block, fields);
      },
    }, {
      // Courses included in plans, when the Payments plugin is installed (§8.3).
      id: "006-plans",
      up: async ({ schema }) => {
        if (!(await schema.describe("lms-enrollments"))) return;
        await schema.addOptions("lms-enrollments", "source", [PLAN_SOURCE]);
        await schema.addOptions("lms-enrollments", "state", [LAPSED_STATE]);
        // Again, now that the new choices exist: words for a choice that isn't there yet are skipped.
        await schema.addFieldLabels("lms-enrollments", FIELD_LABELS["lms-enrollments"]);
        if ((await schema.describe(ACCESS)) && (await schema.describe("lms-courses"))) {
          await schema.addFields("lms-courses", [INCLUDED_FIELD]);
          await schema.addFieldLabels("lms-courses", { included: { labels: { ar: "مشمولة في" }, descriptions: { ar: "يمكن لمشتركي خطة تشمل أحدها أخذ الدورة دون شرائها." } } });
        }
      },
    }],
  });
}
