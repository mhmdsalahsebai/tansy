import { apiPath, defineRenderers, pickWords, RichText, sitePath, StreamField, type BlockProps, type SiteWords } from "tansy/react";
import type { SiteList, SiteRecord, TemplateProps, ThemeQuery } from "tansy/theme";
import { embedUrl, money, orderLessons, percentDone } from "./logic";
import { CertificateCheck, CourseOffer, EnrollButton, MarkComplete, MyCourses, Progress, Quiz, SubscribedNotice, SubscribeToPlan, type PlanOption } from "./parts";
import { siteMessages } from "./site-messages";
import { lmsWords } from "./words";
import "./lms.css";

const text = (value: unknown) => (typeof value === "string" ? value : "");
const idOf = (value: unknown) => (typeof value === "number" ? value : null);
const items = (list: SiteList | undefined) => list?.items ?? [];
const fileHref = (id: string, thumb?: "800x0") => apiPath(`/files/${encodeURIComponent(id)}${thumb ? `?thumb=${thumb}` : ""}`);
/** The LMS's words for a client part, and no one else's. */
const forParts = (words: SiteWords | undefined) => (words ? pickWords(words, "lms") : undefined);

/**
 * A course's lessons in reading order, grouped by section, with what this visitor may open and has
 * finished. Titles come from the public outline. Links come from lessons read as the viewer, so a
 * lesson they can't open has none.
 */
export interface CourseOutline {
  sections: Array<{ id: number | null; title: string; lessons: OutlineLesson[] }>;
  ordered: OutlineLesson[];
  enrolled: boolean;
  done: number;
}
export interface OutlineLesson { id: number; title: string; href: string | null; preview: boolean; done: boolean; minutes: number | null }

/**
 * Builds the outline from a page's `data`: `outline`, `sections`, `lessons`, `progress` and `enrollment`, as this plugin's queries name them.
 * Pass the template's `words` so lesson links stay in the page's language.
 */
export function courseOutline(data: TemplateProps["data"], words?: SiteWords): CourseOutline {
  const sections = items(data.sections);
  const links = new Map(items(data.lessons).map((lesson) => [lesson.id, text(lesson.recordPath) ? sitePath(words, text(lesson.recordPath)) : null]));
  const finished = new Set(items(data.progress).map((row) => idOf(row.lesson)));
  const ordered = orderLessons(items(data.outline), sections).map((lesson) => ({
    id: lesson.id,
    title: text(lesson.title),
    href: links.get(lesson.id) ?? null,
    preview: lesson.preview === true,
    done: finished.has(lesson.id),
    minutes: typeof lesson.durationMinutes === "number" ? lesson.durationMinutes : null,
    section: idOf(lesson.section),
  }));
  const groups: CourseOutline["sections"] = [];
  for (const lesson of ordered) {
    const section = sections.find((candidate) => candidate.id === lesson.section);
    const last = groups.at(-1);
    if (last && last.id === (section?.id ?? null)) last.lessons.push(lesson);
    else groups.push({ id: section?.id ?? null, title: text(section?.title), lessons: [lesson] });
  }
  return { sections: groups, ordered, enrolled: items(data.enrollment).length > 0, done: ordered.filter((lesson) => lesson.done).length };
}

/** The outline as a list, with finished lessons ticked and the current one marked. */
export function Outline({ outline, current, words }: { outline: CourseOutline; current?: number; words?: SiteWords }) {
  const { t } = lmsWords(words);
  if (!outline.ordered.length) return <p className="lms-muted">{t("lms.noLessons")}</p>;
  return (
    <nav className="lms-outline" aria-label={t("lms.outline")}>
      {outline.sections.map((section, index) => (
        <section key={section.id ?? `loose-${index}`}>
          {section.title && <h3>{section.title}</h3>}
          <ol>
            {section.lessons.map((lesson) => (
              <li key={lesson.id} className={lesson.done ? "lms-done" : undefined} aria-current={lesson.id === current ? "page" : undefined}>
                <span className="lms-tick" aria-hidden>{lesson.done ? "✓" : lesson.href ? "○" : "🔒"}</span>
                {lesson.href ? <a href={lesson.href}>{lesson.title}</a> : <span>{lesson.title}</span>}
                {lesson.preview && !outline.enrolled && <span className="lms-badge">{t("lms.preview")}</span>}
                {lesson.done && <span className="sr-only"> {t("lms.completedMark")}</span>}
                {lesson.minutes !== null && <span className="lms-muted"> · {t("lms.minutes", { count: lesson.minutes })}</span>}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </nav>
  );
}

const ids = (value: unknown) => (Array.isArray(value) ? value : [value]).filter((id): id is number => typeof id === "number");
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** A plan record from the Payments plugin, as the LMS's parts take it. */
export function planOption(plan: SiteRecord): PlanOption {
  return {
    name: text(plan.name),
    title: text(plan.title) || text(plan.name),
    amount: num(plan.amount),
    annualAmount: num(plan.annualAmount),
    currency: text(plan.currency) || null,
    featured: plan.featured === true,
  };
}

/** Cheapest first, and plans with no price shown last. */
export const sortPlans = (plans: PlanOption[]) => [...plans].sort((a, b) => (a.amount ?? Number.MAX_VALUE) - (b.amount ?? Number.MAX_VALUE));

/** The price a plan shows, such as "$19.00 a month", or null when it shows none. */
export function planPrice(plan: PlanOption, words: SiteWords | undefined, annual = false) {
  const amount = annual ? plan.annualAmount : plan.amount;
  if (amount === null || !plan.currency) return null;
  return lmsWords(words).t(annual ? "lms.perYear" : "lms.perMonth", { price: money(amount, plan.currency, words?.locale ?? "en") });
}

/**
 * Which published plans include a course, and whether the visitor's own plans already do, from
 * a page's `plans`, `access` and `entitlements` lists, as this plugin's queries name them. Plans
 * come from the Payments plugin as data. Without it the lists are empty, and so is this.
 *
 * A plan includes a course when one of its access opens every course (`lms-courses`), or is one
 * the course is "Included in".
 */
export function coursePlans(course: SiteRecord, data: TemplateProps["data"]) {
  const whole = new Set(items(data.access).filter((access) => Array.isArray(access.collections) && access.collections.includes("lms-courses")).map((access) => access.id));
  const own = new Set(ids(course.included));
  const opening = new Set([...whole, ...own]);
  const plans = sortPlans(items(data.plans).filter((plan) => ids(plan.includes).some((id) => opening.has(id))).map(planOption));
  const mine = (items(data.entitlements)[0]?.access ?? []) as unknown[];
  const covered = Array.isArray(mine) && (mine.includes("lms-courses") || mine.some((id) => typeof id === "number" && own.has(id)));
  return { plans, covered };
}

/** Plans that include the course, each with its price and a Subscribe button. */
export function PlanOffers({ plans, heading, words }: { plans: PlanOption[]; heading?: string; words?: SiteWords }) {
  if (!plans.length) return null;
  return (
    <div className="lms-plans">
      {heading && <p className="lms-muted">{heading}</p>}
      <ul>
        {plans.map((plan) => (
          <li key={plan.name}>
            <strong>{plan.title}</strong>
            {planPrice(plan, words) && <span className="lms-muted"> · {planPrice(plan, words)}</span>}
            <SubscribeToPlan plan={plan} words={forParts(words)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Enroll, continue or completed, by what this visitor's enrollment says. Someone whose plan
 * covers the course enrolls with one click. Anyone else is offered the plans that include it,
 * beside buying it when it's sold.
 */
export function CourseAction({ course, outline, data, words }: { course: SiteRecord; outline: CourseOutline; data?: TemplateProps["data"]; words?: SiteWords }) {
  const { t } = lmsWords(words);
  const next = outline.ordered.find((lesson) => !lesson.done && lesson.href) ?? null;
  if (outline.enrolled) {
    if (outline.ordered.length && outline.done === outline.ordered.length) return <p className="lms-success">{t("lms.courseCompleted")}</p>;
    return next ? <p><a className="lms-button" href={next.href!}>{t(outline.done ? "lms.continue" : "lms.start", { title: next.title })}</a></p> : null;
  }
  if (course.access === "free") return <EnrollButton courseId={course.id} continueHref={null} words={forParts(words)} />;
  const { plans, covered } = data ? coursePlans(course, data) : { plans: [], covered: false };
  if (covered) return <EnrollButton courseId={course.id} continueHref={null} label={t("lms.startWithPlan")} words={forParts(words)} />;
  return (
    <>
      <SubscribedNotice words={forParts(words)} />
      {course.access === "paid" && <CourseOffer courseId={course.id} words={forParts(words)} />}
      {course.access !== "paid" && !plans.length && <p className="lms-muted">{t("lms.staffEnroll")}</p>}
      <PlanOffers plans={plans} heading={course.access === "paid" ? t("lms.orPlan") : t("lms.withPlan")} words={words} />
    </>
  );
}

const LEVELS = new Set(["beginner", "intermediate", "advanced"]);

function Course({ record, data, stream, fileUrl, fileText, t, words }: TemplateProps) {
  if (!record) return null;
  const outline = courseOutline(data, words);
  const level = text(record.level);
  return (
    <main className="lms-main">
      <header className="lms-hero">
        {level && <p className="lms-kicker">{LEVELS.has(level) ? t(`lms.levels.${level}`) : level}</p>}
        <h1>{text(record.title)}</h1>
        {text(record.summary) && <p className="lms-lead">{text(record.summary)}</p>}
        {text(record.byline) && <p className="lms-muted">{t("lms.taughtBy", { name: text(record.byline) })}</p>}
        {outline.enrolled && outline.ordered.length > 0 && <Progress percent={percentDone(outline.done, outline.ordered.length)} label={t("lms.lessonsDone", { done: outline.done, total: outline.ordered.length })} name={t("lms.progress")} />}
        <CourseAction course={record} outline={outline} data={data} words={words} />
      </header>
      {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked API address that redirects to a signed URL, which next/image can't optimize */}
      {text(record.cover) && <img className="lms-cover" src={fileUrl(text(record.cover), "800x0")} alt={fileText(text(record.cover)).alt} />}
      {Array.isArray(record.description) && record.description.length > 0 && <div className="lms-body"><StreamField blocks={record.description} {...stream} /></div>}
      <h2>{t("lms.outline")}</h2>
      <Outline outline={outline} words={words} />
    </main>
  );
}

function Lesson({ record, data, stream, t, words }: TemplateProps) {
  if (!record) return null;
  const outline = courseOutline(data, words);
  const course = items(data.course)[0];
  const index = outline.ordered.findIndex((lesson) => lesson.id === record.id);
  const previous = index > 0 ? outline.ordered[index - 1] : null;
  const next = index >= 0 ? outline.ordered.slice(index + 1).find((lesson) => lesson.href) ?? null : null;
  return (
    <div className="lms-classroom">
      <aside className="lms-sidebar">
        {course && <p className="lms-kicker">{text(course.recordPath) ? <a href={sitePath(words, text(course.recordPath))}>{text(course.title)}</a> : text(course.title)}</p>}
        {outline.enrolled && <Progress percent={percentDone(outline.done, outline.ordered.length)} label={t("lms.done", { done: outline.done, total: outline.ordered.length })} name={t("lms.progress")} />}
        <Outline outline={outline} current={record.id} words={words} />
      </aside>
      <main className="lms-main lms-lesson">
        <h1>{text(record.title)}</h1>
        <div className="lms-body"><StreamField blocks={record.content} {...stream} /></div>
        {outline.enrolled
          ? <MarkComplete lessonId={record.id} done={outline.ordered[index]?.done ?? false} nextHref={next?.href ?? null} words={forParts(words)} />
          : course && <p className="lms-muted">{t("lms.previewNotice")} <a href={text(course.recordPath) ? sitePath(words, text(course.recordPath)) : "#"}>{t("lms.enrollToTrack")}</a></p>}
        <nav className="lms-pager" aria-label={t("lms.lessons")}>
          {previous?.href ? <a href={previous.href} rel="prev">← {previous.title}</a> : <span />}
          {next?.href && <a href={next.href} rel="next">{next.title} →</a>}
        </nav>
      </main>
    </div>
  );
}

function SingletonPage({ record, children }: { record: SiteRecord | null; children: React.ReactNode }) {
  return (
    <main className="lms-main">
      <h1>{text(record?.title)}</h1>
      {record?.intro !== undefined && record?.intro !== null && <div className="lms-body"><RichText doc={record.intro} /></div>}
      {children}
    </main>
  );
}

const MyCoursesPage = ({ record, words }: TemplateProps) => <SingletonPage record={record}><MyCourses words={forParts(words)} /></SingletonPage>;
const CertificatePage = ({ record, words }: TemplateProps) => <SingletonPage record={record}><CertificateCheck words={forParts(words)} /></SingletonPage>;

const TextBlock = ({ value }: BlockProps) => <RichText doc={value.body} />;

function Video({ value, words }: BlockProps) {
  const { t } = lmsWords(words);
  const file = text(value.file);
  const src = embedUrl(text(value.url));
  const title = text(value.title) || t("lms.video");
  return (
    <figure className="lms-figure">
      {file
        ? <video className="lms-video" src={fileHref(file)} controls preload="metadata" title={title} />
        : src && <div className="lms-embed"><iframe src={src} title={title} loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation" /></div>}
      {value.transcript !== undefined && value.transcript !== null && <details><summary>{t("lms.transcript")}</summary><RichText doc={value.transcript} /></details>}
    </figure>
  );
}

function Download({ value, words }: BlockProps) {
  const file = text(value.file);
  if (!file) return null;
  return <p className="lms-download"><a href={fileHref(file)} download>{text(value.label) || lmsWords(words).t("lms.download")}</a></p>;
}

function QuizBlock({ value, words }: BlockProps) {
  const quiz = idOf(value.quiz);
  return quiz === null ? null : <Quiz quizId={quiz} words={forParts(words)} />;
}

/** Lessons and the learner's own records are read as the viewer, so rules decide what each person gets. */
const viewer = (query: ThemeQuery): ThemeQuery => ({ ...query, viewer: true });
const outlineFor = (course: string) => ({
  outline: { collection: "lms-outline", filter: `course = ${course}`, perPage: 200 },
  sections: { collection: "lms-sections", filter: `course = ${course}`, perPage: 200, fields: "id,title,position" },
  lessons: viewer({ collection: "lms-lessons", filter: `course = ${course}`, perPage: 200, fields: "id", urls: "1" }),
  progress: viewer({ collection: "lms-progress", filter: `course = ${course}`, perPage: 200, fields: "lesson" }),
  enrollment: viewer({ collection: "lms-enrollments", filter: `course = ${course} && state != "revoked" && state != "lapsed"`, perPage: 1, fields: "id,state" }),
});

/**
 * Plans that may include a course, from the Payments plugin: published plans and access are public,
 * for pricing pages, and each person reads only their own entitlements. Without Payments, empty lists.
 */
export const PLAN_QUERIES: Record<string, ThemeQuery> = {
  plans: { collection: "payments-plans", filter: 'status = "published"', perPage: 50, fields: "id,name,title,description,amount,annualAmount,currency,featured,includes" },
  access: { collection: "payments-access", filter: 'status = "published"', perPage: 200, fields: "id,name,description,collections" },
  entitlements: viewer({ collection: "payments-entitlements", perPage: 1, fields: "access" }),
};

export { Progress, SubscribedNotice, SubscribeToPlan, type PlanOption } from "./parts";

export default defineRenderers({
  messages: siteMessages,
  blocks: { lms_text: TextBlock, lms_video: Video, lms_download: Download, lms_quiz: QuizBlock },
  templates: { "lms-courses": Course, "lms-lessons": Lesson, "lms-my-courses": MyCoursesPage, "lms-certificate": CertificatePage },
  queries: {
    "lms-courses": { ...outlineFor("@record.id"), ...PLAN_QUERIES },
    "lms-lessons": { ...outlineFor("@record.course"), course: { collection: "lms-courses", filter: "id = @record.course", perPage: 1, fields: "id,title", urls: "1" } },
  },
});
