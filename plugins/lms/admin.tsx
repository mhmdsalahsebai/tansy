import { adminPath, Badge, DataTable, defineAdminPlugin, PageHeader, type AdminPageProps } from "tansy/admin";
import { CollectionGrid, getT } from "tansy/server";
import { CourseBuilder, NewCourse } from "./builder";

/** This plugin's words in the person's interface language. */
async function words(userId: string) {
  const { t } = await getT(userId);
  return (key: string, values?: Record<string, string | number>) => t(`ext.lms.${key}`, values);
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
type Records = AdminPageProps["records"];
type Row = Record<string, unknown>;

/** As the signed-in person, so someone who can't read a collection gets nothing rather than another person's view. */
async function allRows(records: Records, slug: string, query: Record<string, unknown>, limit = 2000): Promise<Row[] | null> {
  try {
    const rows: Row[] = [];
    for (let page = 1; rows.length < limit; page++) {
      const result = await records.list(slug, { ...query, page, perPage: 200 });
      rows.push(...result.items);
      if (page >= result.totalPages) break;
    }
    return rows;
  } catch {
    return null;
  }
}

const WEEK = 7 * 24 * 60 * 60 * 1000;
const recent = (value: unknown) => typeof value === "string" && Date.now() - Date.parse(value) < WEEK;

async function Learners({ records, user }: AdminPageProps) {
  const t = await words(user.id);
  const [courses, enrollments, progress, lessons, quizzes, attempts] = await Promise.all([
    allRows(records, "lms-courses", { sort: "title", fields: "id,title,status" }, 500),
    allRows(records, "lms-enrollments", { fields: "id,course,student,state,completedAt" }),
    allRows(records, "lms-progress", { fields: "course,student" }),
    allRows(records, "lms-lessons", { filter: 'status = "published"', fields: "id,course" }),
    allRows(records, "lms-quizzes", { fields: "id,course" }),
    allRows(records, "lms-attempts", { fields: "quiz,passed" }),
  ]);
  if (!courses || !enrollments || !progress || !lessons) {
    return <div className="cms-gutter"><PageHeader title={t("pages.lms/learners")} /><p className="cms-empty">{t("learners.cantRead")}</p></div>;
  }
  const quizCourse = new Map((quizzes ?? []).map((quiz) => [quiz.id, quiz.course]));
  const rows = courses.map((course) => {
    const enrolled = enrollments.filter((e) => e.course === course.id && e.state !== "revoked");
    const total = lessons.filter((l) => l.course === course.id).length;
    const students = new Set(enrolled.map((e) => e.student));
    const finished = progress.filter((p) => p.course === course.id && students.has(p.student)).length;
    const tries = (attempts ?? []).filter((a) => quizCourse.get(a.quiz as number) === course.id);
    return {
      id: course.id as number,
      title: text(course.title),
      draft: course.status === "draft",
      enrolled: enrolled.length,
      completed: enrolled.filter((e) => e.state === "completed").length,
      recentCompletions: enrolled.filter((e) => e.state === "completed" && recent(e.completedAt)).length,
      average: total && enrolled.length ? Math.round((finished / (total * enrolled.length)) * 100) : null,
      passRate: tries.length ? Math.round((tries.filter((a) => a.passed === true).length / tries.length) * 100) : null,
    };
  });
  return (
    <div className="cms-gutter">
      <PageHeader title={t("pages.lms/learners")} description={t("learners.intro")} />
      <DataTable
        label={t("pages.lms/learners")}
        columns={[{ id: "course", label: t("columns.course") }, { id: "enrolled", label: t("columns.enrolled"), numeric: true }, { id: "completed", label: t("columns.completed"), numeric: true }, { id: "week", label: t("columns.completedWeek"), numeric: true }, { id: "average", label: t("columns.average"), numeric: true }, { id: "passRate", label: t("columns.passRate"), numeric: true }]}
        rows={rows.map((row) => ({
          id: row.id,
          href: adminPath(`/ext/lms/courses/${row.id}`),
          cells: {
            course: <>{row.title || t("common.course", { id: row.id })}{row.draft && <> <Badge tone="warning" tight>{t("common.draftBadge")}</Badge></>}</>,
            enrolled: row.enrolled,
            completed: row.completed,
            week: row.recentCompletions,
            average: row.average === null ? null : t("common.percent", { value: row.average }),
            passRate: row.passRate === null ? null : t("common.percent", { value: row.passRate }),
          },
        }))}
        empty={{ title: t("learners.noCourses") }}
      />
    </div>
  );
}

/** Runs the school, so works on every course. Anyone else, such as an instructor, on their own. */
const managesAll = (permissions: string[]) => permissions.includes("ext.lms:manage") || permissions.includes("record:update");

async function Courses({ user }: AdminPageProps) {
  const t = await words(user.id);
  const all = managesAll(user.permissions);
  if (!all && !/^[A-Za-z0-9_-]{1,64}$/.test(user.id)) return null;
  // Instructors also see other people's published courses through the public rule, so their list is narrowed to their own.
  return (
    <CollectionGrid
      collection="lms-courses"
      title={t("pages.lms/courses")}
      description={all ? t("courses.allDescription") : t("courses.ownDescription")}
      recordPath="/ext/lms/courses/:id"
      filter={all ? undefined : `createdById = "${user.id}"`}
      createAction={<NewCourse />}
    />
  );
}

async function Builder({ records, params, user }: AdminPageProps) {
  const t = await words(user.id);
  const id = /^[1-9]\d{0,15}$/.test(params.id ?? "") ? Number(params.id) : null;
  // As the signed-in person: a course they can't read reads as missing.
  const course = id === null ? null : await records.get("lms-courses", id, { fields: "id" }).catch(() => null);
  if (!course) return <div className="cms-gutter"><PageHeader title={t("courses.notFound")} /><p className="cms-muted">{t("courses.notFoundBody")} <a className="cms-link" href={adminPath("/ext/lms/courses")}>{t("courses.back")}</a></p></div>;
  return <CourseBuilder courseId={id!} canManage={user.permissions.includes("ext.lms:manage")} />;
}

async function Overview({ records, user }: AdminPageProps) {
  const t = await words(user.id);
  const [enrollments, courses] = await Promise.all([
    allRows(records, "lms-enrollments", { sort: "-createdAt", fields: "course,state,enrolledAt,completedAt" }, 1000),
    allRows(records, "lms-courses", { fields: "id,title" }, 500),
  ]);
  if (!enrollments) return <p className="cms-muted cms-text-sm">{t("widget.cantRead")}</p>;
  const started = new Map<unknown, number>();
  for (const enrollment of enrollments.filter((e) => recent(e.enrolledAt))) started.set(enrollment.course, (started.get(enrollment.course) ?? 0) + 1);
  const top = [...started].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const title = (id: unknown) => text(courses?.find((course) => course.id === id)?.title) || t("common.course", { id: String(id) });
  return (
    <ul className="cms-muted cms-text-sm">
      <li>{t("widget.newEnrollments", { count: enrollments.filter((e) => recent(e.enrolledAt)).length })}</li>
      <li>{t("widget.completed", { count: enrollments.filter((e) => e.state === "completed" && recent(e.completedAt)).length })}</li>
      {top.length > 0 && <li>{t("widget.mostStarted", { courses: top.map(([id, count]) => `${title(id)} (${count})`).join(", ") })}</li>}
    </ul>
  );
}

export default defineAdminPlugin({
  pages: [
    { path: "lms/courses", title: "Courses", collection: "lms-courses", component: Courses },
    { path: "lms/courses/:id", title: "Course", collection: "lms-courses", component: Builder },
    { path: "lms/learners", title: "Learners", permission: "ext.lms:manage", component: Learners },
  ],
  section: {
    title: "LMS",
    icon: "academic",
    items: [
      { page: "lms/courses" },
      { page: "lms/learners" },
      { collection: "lms-enrollments" },
      { collection: "lms-certificates" },
      { collection: "lms-attempts" },
      { collection: "lms-my-courses", title: "My courses page" },
      { collection: "lms-certificate", title: "Certificate check page" },
      { settings: true },
    ],
  },
  widgets: [{ id: "lms-overview", title: "Courses", permission: "ext.lms:manage", component: Overview }],
});
