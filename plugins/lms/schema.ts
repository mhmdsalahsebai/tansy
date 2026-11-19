import type { PluginRole } from "tansy/plugin";

/** The collections the LMS creates on first install. Owners can change all of it afterwards. */

export const COLLECTIONS = ["lms-courses", "lms-sections", "lms-lessons", "lms-quizzes", "lms-enrollments", "lms-progress", "lms-attempts", "lms-certificates", "lms-my-courses", "lms-certificate", "lms-outline"] as const;

/** Blocks a course description allows when it's created. */
export const DESCRIPTION_BLOCKS = ["lms_text", "lms_video", "lms_download"];
/** Blocks a lesson allows when it's created. Owners can add their own. */
export const LESSON_BLOCKS = [...DESCRIPTION_BLOCKS, "lms_quiz"];

/** Where a course's own content lives. An instructor writes these for their own courses only. */
export const AUTHORED = ["lms-courses", "lms-sections", "lms-lessons", "lms-quizzes"] as const;

/** Who teaches and who runs the school. Created once, then owners change them under Roles like any other. */
export function lmsRoles(): PluginRole[] {
  const dashboard: NonNullable<PluginRole["permissions"]> = ["dashboard:access", "collection:read", "file:list", "file:read", "file:create"];
  return [
    {
      name: "lms-instructor",
      label: "Instructor",
      description: "Builds courses, and edits and deletes only their own, with their sections, lessons and quizzes. Their courses carry their name.",
      permissions: dashboard,
      records: Object.fromEntries(AUTHORED.map((slug) => [slug, ["create", "list:own", "read:own", "update:own", "delete:own"]])),
    },
    {
      name: "lms-manager",
      label: "LMS manager",
      description: "Edits every course, enrolls and revokes learners, sees progress, and changes the LMS settings.",
      permissions: [...dashboard, "file:delete", "ext.lms:manage", "ext.lms:enroll"],
      records: Object.fromEntries(COLLECTIONS.filter((slug) => slug !== "lms-outline").map((slug) => [slug, ["list", "read", "create", "update", "delete"]])),
    },
  ];
}

/** The name shown on a course. Filled from the instructor's account, and only managers can change it. */
/** Sold through the Payments plugin. Added after the first release, so migration 003 adds it to existing sites. */
export const PAID_ACCESS = { label: "Paid: learners buy it (needs the Payments plugin and a price)", value: "paid" };

/** Enrolled through a plan from the Payments plugin, and lapsed when the plan no longer covers the course. Added by migration 006. */
export const PLAN_SOURCE = { label: "Plan", value: "plan" };
export const LAPSED_STATE = { label: "Lapsed: their plan no longer covers it", value: "lapsed" };

export const BYLINE_FIELD = { name: "byline", type: "text", config: { maxLength: 200, label: "Taught by" } };

/** Filled from the title or name when left empty, so it isn't required. */
const SLUG_FIELD = {
  name: "slug",
  type: "text",
  config: { unique: true, maxLength: 80, pattern: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$", patternError: "Use lowercase letters, numbers and hyphens, starting and ending with a letter or number." },
};

/** A user's id. Rules compare it with @request.auth.id, and only the plugin's routes and staff write it. */
const STUDENT_FIELD = { name: "student", type: "text", config: { required: true, maxLength: 64, label: "Student (user id)" } };

const LOCKED = { createRule: null, updateRule: null, deleteRule: null };
const PUBLIC = { listRule: "", viewRule: "", ...LOCKED };

/** Records about one learner: only they may read them, and nobody but staff and the plugin writes them. */
const OWN = 'student = @request.auth.id && @request.auth.id != ""';
const LEARNER = { listRule: OWN, viewRule: OWN, ...LOCKED };

/**
 * The gate. A course id in the hidden lms_courses user field means an active enrollment,
 * and only the plugin writes that field. Rules read user values on every request, so
 * revoking an enrollment ends access on the next one, through every way of reading records.
 */
export const ENROLLED = "@request.auth.lms_courses ?= course";
const GATED = `status = "published" && (preview = true || ${ENROLLED})`;

/** The user field the gate reads. */
export const COURSES_FIELD = "lms_courses";

/**
 * Only what a course page may show anyone about its lessons. Drafts stay out, and the
 * lessons themselves stay gated. Quoted names, so it runs the same on SQLite and Postgres.
 */
export const OUTLINE_QUERY = `SELECT "id", "title", "course", "section", "position", "preview", "durationMinutes" FROM "rec_lms_lessons" WHERE "status" = 'published'`;

/** A field the plugin's code reads or writes, by collection: the contract Extensions checks. */
export const CONTRACT = {
  "lms-courses": { slug: "text", title: "text", summary: "text", byline: "text", access: "radio" },
  "lms-sections": { course: "reference", title: "text", position: "number" },
  "lms-lessons": { slug: "text", title: "text", course: "reference", section: "reference", position: "number", preview: "boolean", content: "stream" },
  "lms-quizzes": { lesson: "reference", course: "reference", title: "text", questions: "stream", passingScore: "number", maxAttempts: "number" },
  "lms-enrollments": { course: "reference", student: "text", state: "radio", source: "radio", enrolledAt: "datetime", completedAt: "datetime" },
  "lms-progress": { key: "text", student: "text", course: "reference", lesson: "reference", completedAt: "datetime" },
  "lms-attempts": { quiz: "reference", student: "text", answers: "json", score: "number", passed: "boolean", submittedAt: "datetime" },
  "lms-certificates": { code: "text", student: "text", course: "reference", studentName: "text", issuedAt: "datetime" },
};

const position = { name: "position", type: "number", config: { format: "integer", min: 0, description: "Lower comes first." } };

export function lmsSchema(basePath: string) {
  return {
    version: 1,
    collections: [
      {
        slug: "lms-courses",
        name: "Courses",
        description: "Courses, made of sections and lessons. Free courses take anyone who signs in. Others need staff to enroll each learner.",
        urlPattern: `${basePath}/:slug`,
        rules: { listRule: 'status = "published"', viewRule: 'status = "published"', ...LOCKED },
        fields: [
          { name: "title", type: "text", config: { required: true, maxLength: 200, searchable: true } },
          SLUG_FIELD,
          { name: "summary", type: "text", config: { multiline: true, maxLength: 500, searchable: true } },
          { name: "cover", type: "image", config: {} },
          { name: "description", type: "stream", config: { allowedBlocks: DESCRIPTION_BLOCKS } },
          BYLINE_FIELD,
          { name: "level", type: "radio", config: { options: [{ label: "Beginner", value: "beginner" }, { label: "Intermediate", value: "intermediate" }, { label: "Advanced", value: "advanced" }] } },
          { name: "access", type: "radio", config: { options: [{ label: "Free: anyone signed in can enroll", value: "free" }, { label: "By enrollment: staff enroll learners", value: "enrollment" }, PAID_ACCESS], defaultValue: "free" } },
          { name: "estimatedMinutes", type: "number", config: { format: "integer", min: 0 } },
        ],
      },
      {
        slug: "lms-sections",
        name: "Course sections",
        description: "Chapters that group a course's lessons.",
        urlPattern: null,
        rules: PUBLIC,
        fields: [
          { name: "title", type: "text", config: { required: true, maxLength: 200 } },
          { name: "course", type: "reference", config: { collection: "lms-courses", displayField: "title", required: true } },
          position,
        ],
      },
      {
        slug: "lms-lessons",
        name: "Lessons",
        description: "Open to enrolled learners. A preview lesson is open to everyone.",
        urlPattern: "/learn/:slug",
        rules: { listRule: GATED, viewRule: GATED, ...LOCKED },
        fields: [
          { name: "title", type: "text", config: { required: true, maxLength: 200 } },
          SLUG_FIELD,
          { name: "course", type: "reference", config: { collection: "lms-courses", displayField: "title", required: true } },
          { name: "section", type: "reference", config: { collection: "lms-sections", displayField: "title" } },
          position,
          { name: "preview", type: "boolean", config: { description: "Open to everyone, enrolled or not." } },
          { name: "content", type: "stream", config: { allowedBlocks: LESSON_BLOCKS } },
          { name: "durationMinutes", type: "number", config: { format: "integer", min: 0 } },
        ],
      },
      {
        slug: "lms-quizzes",
        name: "Quizzes",
        description: "Graded on the server. Questions and answers are hidden: learners get the questions without answers through the plugin's route.",
        urlPattern: null,
        // Only enrolled learners. A quiz has no preview.
        rules: { listRule: ENROLLED, viewRule: ENROLLED, ...LOCKED },
        fields: [
          { name: "title", type: "text", config: { required: true, maxLength: 200 } },
          { name: "lesson", type: "reference", config: { collection: "lms-lessons", displayField: "title", required: true } },
          { name: "course", type: "reference", config: { collection: "lms-courses", displayField: "title", description: "Set from the lesson when saved." } },
          { name: "questions", type: "stream", config: { allowedBlocks: ["lms_question"], hidden: true } },
          { name: "passingScore", type: "number", config: { format: "integer", min: 0, max: 100, description: "Percent needed to pass. Empty uses the site's default." } },
          { name: "maxAttempts", type: "number", config: { format: "integer", min: 1, description: "Empty for no limit." } },
        ],
      },
      {
        slug: "lms-enrollments",
        name: "Enrollments",
        description: "Who may open which course. Revoking one ends access on the learner's next request.",
        urlPattern: null,
        rules: LEARNER,
        fields: [
          { name: "course", type: "reference", config: { collection: "lms-courses", displayField: "title", required: true } },
          STUDENT_FIELD,
          { name: "state", type: "radio", config: { options: [{ label: "Active", value: "active" }, { label: "Completed", value: "completed" }, { label: "Revoked", value: "revoked" }], defaultValue: "active" } },
          { name: "source", type: "radio", config: { options: [{ label: "Free enrollment", value: "free" }, { label: "Staff", value: "staff" }, { label: "Purchase", value: "purchase" }], defaultValue: "staff" } },
          { name: "enrolledAt", type: "datetime", config: {} },
          { name: "completedAt", type: "datetime", config: {} },
        ],
      },
      {
        slug: "lms-progress",
        name: "Lesson progress",
        description: "Each lesson a learner has completed.",
        urlPattern: null,
        rules: LEARNER,
        fields: [
          // <student>:<lesson>, so the database itself keeps a lesson from completing twice.
          { name: "key", type: "text", config: { required: true, unique: true, maxLength: 100 } },
          STUDENT_FIELD,
          { name: "course", type: "reference", config: { collection: "lms-courses", displayField: "title", required: true } },
          { name: "lesson", type: "reference", config: { collection: "lms-lessons", displayField: "title", required: true } },
          { name: "completedAt", type: "datetime", config: {} },
        ],
      },
      {
        slug: "lms-attempts",
        name: "Quiz attempts",
        description: "Each submitted quiz, graded on the server.",
        urlPattern: null,
        rules: LEARNER,
        fields: [
          { name: "quiz", type: "reference", config: { collection: "lms-quizzes", displayField: "title", required: true } },
          STUDENT_FIELD,
          { name: "answers", type: "json", config: {} },
          { name: "score", type: "number", config: { min: 0, max: 100 } },
          { name: "passed", type: "boolean", config: {} },
          { name: "submittedAt", type: "datetime", config: {} },
        ],
      },
      {
        slug: "lms-certificates",
        name: "Certificates",
        description: "Issued when a learner completes a course. Anyone with the code can check one is genuine.",
        urlPattern: null,
        rules: LEARNER,
        fields: [
          { name: "code", type: "text", config: { required: true, unique: true, maxLength: 32 } },
          STUDENT_FIELD,
          { name: "course", type: "reference", config: { collection: "lms-courses", displayField: "title", required: true } },
          { name: "studentName", type: "text", config: { maxLength: 200 } },
          { name: "issuedAt", type: "datetime", config: {} },
        ],
      },
      {
        slug: "lms-my-courses",
        name: "My courses page",
        description: "The page where signed-in learners see their courses and progress.",
        type: "singleton",
        urlPattern: "/my-courses",
        rules: PUBLIC,
        fields: [
          { name: "title", type: "text", config: { required: true, maxLength: 120 } },
          { name: "intro", type: "rich_text", config: {} },
        ],
      },
      {
        slug: "lms-certificate",
        name: "Certificate check page",
        description: "The page where anyone can check a certificate by its code.",
        type: "singleton",
        urlPattern: "/certificates",
        rules: PUBLIC,
        fields: [
          { name: "title", type: "text", config: { required: true, maxLength: 120 } },
          { name: "intro", type: "rich_text", config: {} },
        ],
      },
      {
        slug: "lms-outline",
        name: "Course outlines",
        description: "Every published lesson's title and place, for course pages. The lessons stay gated.",
        type: "view",
        viewQuery: OUTLINE_QUERY,
        urlPattern: null,
        rules: PUBLIC,
        fields: [],
      },
    ],
    // Here rather than in the plugin's blocks, because it links to a collection this document creates.
    blocks: [{ name: "lms_quiz", label: "Quiz", labels: { ar: "اختبار" }, icon: null, fields: [{ name: "quiz", type: "reference", config: { collection: "lms-quizzes", displayField: "title", required: true } }] }],
    userFields: [{ name: COURSES_FIELD, type: "json", config: { hidden: true, label: "Enrolled courses", description: "Set by the LMS from active enrollments. Lesson rules read it." }, selfEditable: false }],
  };
}
