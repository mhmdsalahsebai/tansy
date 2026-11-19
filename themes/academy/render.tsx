import type { ComponentType } from "react";
import Link from "next/link";
import lmsRenderers, { courseOutline, CourseAction, coursePlans, Outline, planOption, planPrice, Progress, sortPlans, SubscribedNotice, SubscribeToPlan, type PlanOption } from "@tansy/lms/render";
import { authPath, Menu, pickWords, RichText, StreamField } from "tansy/react";
import { defineThemeComponents, type LayoutProps, type SiteList, type SiteRecord, type TemplateProps } from "tansy/theme";
import type { AcademyOptions } from "./index";
import "./theme.css";

type Props = TemplateProps<AcademyOptions>;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const items = (list: SiteList | undefined) => list?.items ?? [];
const ids = (value: unknown) => (Array.isArray(value) ? value : [value]).filter((id): id is number => typeof id === "number");
const hasDoc = (value: unknown) => value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);

/**
 * The theme's words, under `academy`. Owners can change any of them per language under
 * Languages → Site text. The LMS's own words, such as `lms.enroll`, come from the LMS plugin.
 */
const messages = {
  en: {
    academy: {
      kicker: "Learn at your own pace",
      intro: "Courses taught by people who do the work. Start with a free course, buy the ones you want, or get a plan that opens many at once.",
      browse: "Browse courses",
      seePlans: "See plans",
      courses: "Courses",
      coursesLead: "Every course, newest first.",
      courseCount: "{count, plural, one {# course} other {# courses}}",
      noCourses: "No courses yet. Check back soon.",
      plans: "Plans",
      plansLead: "Subscribe once and take every course your plan includes.",
      pricing: "Pricing",
      myCourses: "My courses",
      signIn: "Sign in",
      free: "Free",
      paid: "Paid",
      byEnrollment: "By invitation",
      inPlans: "In {count, plural, one {# plan} other {# plans}}",
      everyCourse: "Every course",
      everyCourseCount: "Every course, {count, plural, one {# today} other {# today}}, and each new one",
      opens: "Includes",
      andMore: "and {count} more",
      featured: "Most popular",
      orYearly: "or {price}",
      noPlans: "There are no plans yet.",
      lessons: "{count, plural, one {# lesson} other {# lessons}}",
      minutes: "{count} min",
      hours: "{count, plural, one {# hour} other {# hours}}",
      about: "About this course",
      curriculum: "Curriculum",
      included: "Included in",
      yourProgress: "Your progress",
      menu: "Main",
      language: "Language",
      skip: "Skip to content",
      rights: "All rights reserved.",
    },
  },
  ar: {
    academy: {
      kicker: "تعلّم بالسرعة التي تناسبك",
      intro: "دورات يقدّمها أناس يمارسون ما يعلّمونه. ابدأ بدورة مجانية، أو اشترِ ما تريد، أو اشترك في خطة تفتح لك دورات كثيرة دفعة واحدة.",
      browse: "تصفّح الدورات",
      seePlans: "اطّلع على الخطط",
      courses: "الدورات",
      coursesLead: "كل الدورات، الأحدث أولًا.",
      courseCount: "{count, plural, zero {لا دورات} one {دورة واحدة} two {دورتان} few {# دورات} many {# دورة} other {# دورة}}",
      noCourses: "لا دورات بعد. عُد قريبًا.",
      plans: "الخطط",
      plansLead: "اشترك مرة واحدة وخذ كل دورة تشملها خطتك.",
      pricing: "الأسعار",
      myCourses: "دوراتي",
      signIn: "تسجيل الدخول",
      free: "مجانية",
      paid: "مدفوعة",
      byEnrollment: "بدعوة",
      inPlans: "{count, plural, one {في خطة واحدة} two {في خطتين} few {في # خطط} many {في # خطة} other {في # خطة}}",
      everyCourse: "كل الدورات",
      everyCourseCount: "كل الدورات، {count} حاليًا، وكل دورة جديدة",
      opens: "تشمل",
      andMore: "و{count} أخرى",
      featured: "الأكثر طلبًا",
      orYearly: "أو {price}",
      noPlans: "لا خطط بعد.",
      lessons: "{count, plural, zero {لا دروس} one {درس واحد} two {درسان} few {# دروس} many {# درسًا} other {# درس}}",
      minutes: "{count} دقيقة",
      hours: "{count, plural, one {ساعة واحدة} two {ساعتان} few {# ساعات} many {# ساعة} other {# ساعة}}",
      about: "عن هذه الدورة",
      curriculum: "المنهج",
      included: "مشمولة في",
      yourProgress: "تقدّمك",
      menu: "القائمة الرئيسية",
      language: "اللغة",
      skip: "انتقل إلى المحتوى",
      rights: "جميع الحقوق محفوظة.",
    },
  },
};

/** An address in the page's language: "/pricing" is "/ar/pricing" on an Arabic page. */
const inLanguage = (props: Pick<Props, "language">, path: string) => props.language?.href(path) ?? path;

/** From the collection's URL pattern, so links follow whatever the owner sets. */
const hrefOf = (record: SiteRecord | undefined, props: Pick<Props, "language">) => (record && text(record.recordPath) ? inLanguage(props, text(record.recordPath)) : undefined);

/** The LMS's words, for its client parts. */
const lmsParts = (props: Pick<Props, "words">) => (props.words ? pickWords(props.words, "lms") : undefined);

/** The pricing page, or the plans on the front page when the owner hasn't made one. */
const pricingHref = (props: Pick<Props, "data" | "language">) => hrefOf(items(props.data.pricingPage)[0], props) ?? `${inLanguage(props, "/")}#plans`;

/* ------------------------------------------------------------------ plans */

interface PlanCard extends PlanOption {
  description: string;
  /** Every course, now and later, or these. */
  everything: boolean;
  courses: SiteRecord[];
}

/**
 * Published plans that open at least one course, each with what it opens: every course, when one
 * of its access opens the whole collection, or the courses "Included in" one of its access. Plans
 * that open only other things, such as articles, aren't for this site's pricing.
 */
export function planCards(data: Props["data"]): PlanCard[] {
  const courses = items(data.courses);
  const whole = new Set(items(data.access).filter((access) => Array.isArray(access.collections) && access.collections.includes("lms-courses")).map((access) => access.id));
  const cards = items(data.plans).map((plan): PlanCard => {
    const includes = new Set(ids(plan.includes));
    const everything = [...includes].some((id) => whole.has(id));
    return {
      ...planOption(plan),
      description: text(plan.description),
      everything,
      courses: everything ? courses : courses.filter((course) => ids(course.included).some((id) => includes.has(id))),
    };
  }).filter((card) => card.everything || card.courses.length > 0);
  const order = sortPlans(cards).map((card) => card.name);
  return cards.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
}

const SHOWN = 6;

function Plans({ props, cards }: { props: Props; cards: PlanCard[] }) {
  const { t, words, language } = props;
  if (!cards.length) return <p className="ac-empty">{t("academy.noPlans")}</p>;
  return (
    <ul className="ac-plans">
      {cards.map((plan) => {
        const price = planPrice(plan, words);
        const yearly = planPrice(plan, words, true);
        return (
          <li key={plan.name} className={plan.featured ? "ac-plan ac-plan-featured" : "ac-plan"}>
            {plan.featured && <p className="ac-plan-flag">{t("academy.featured")}</p>}
            <h3 className="ac-plan-title">{plan.title}</h3>
            {price && <p className="ac-plan-price">{price}</p>}
            {yearly && <p className="ac-muted ac-plan-yearly">{t("academy.orYearly", { price: yearly })}</p>}
            {plan.description && <p className="ac-muted">{plan.description}</p>}
            <p className="ac-plan-opens">{t("academy.opens")}</p>
            <ul className="ac-plan-courses">
              {plan.everything
                ? <li><strong>{t("academy.everyCourseCount", { count: plan.courses.length })}</strong></li>
                : plan.courses.slice(0, SHOWN).map((course) => {
                  const href = hrefOf(course, { language });
                  return <li key={course.id}>{href ? <a href={href}>{text(course.title)}</a> : text(course.title)}</li>;
                })}
              {!plan.everything && plan.courses.length > SHOWN && <li className="ac-muted">{t("academy.andMore", { count: plan.courses.length - SHOWN })}</li>}
            </ul>
            <SubscribeToPlan plan={plan} className={plan.featured ? "ac-button" : "ac-button ac-button-quiet"} words={lmsParts(props)} />
          </li>
        );
      })}
    </ul>
  );
}

/* ---------------------------------------------------------------- courses */

/** Free, sold, by invitation, and the plans that include it. */
function AccessBadges({ course, cards, t }: { course: SiteRecord; cards: PlanCard[]; t: Props["t"] }) {
  const inPlans = cards.filter((plan) => plan.everything || plan.courses.some((item) => item.id === course.id)).length;
  const access = text(course.access);
  return (
    <p className="ac-badges">
      {access === "free" && <span className="ac-badge ac-badge-free">{t("academy.free")}</span>}
      {access === "paid" && <span className="ac-badge">{t("academy.paid")}</span>}
      {access === "enrollment" && !inPlans && <span className="ac-badge">{t("academy.byEnrollment")}</span>}
      {inPlans > 0 && access !== "free" && <span className="ac-badge ac-badge-plan">{t("academy.inPlans", { count: inPlans })}</span>}
    </p>
  );
}

const LEVELS = new Set(["beginner", "intermediate", "advanced"]);
const levelOf = (record: SiteRecord, t: Props["t"]) => {
  const level = text(record.level);
  return level ? (LEVELS.has(level) ? t(`lms.levels.${level}`) : level) : "";
};

function Duration({ minutes, t }: { minutes: unknown; t: Props["t"] }) {
  if (typeof minutes !== "number" || minutes <= 0) return null;
  return <>{minutes >= 60 ? t("academy.hours", { count: Math.round(minutes / 60) }) : t("academy.minutes", { count: minutes })}</>;
}

function CourseGrid({ props, cards }: { props: Props; cards: PlanCard[] }) {
  const { data, t, fileUrl, fileText, language } = props;
  const courses = items(data.courses);
  if (!courses.length) return <p className="ac-empty">{t("academy.noCourses")}</p>;
  return (
    <ul className="ac-courses">
      {courses.map((course) => {
        const href = hrefOf(course, { language });
        const cover = text(course.cover);
        const level = levelOf(course, t);
        return (
          <li key={course.id} className="ac-course" lang={typeof course.locale === "string" ? course.locale : undefined}>
            <div className="ac-course-cover">
              {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked API address that redirects to a signed URL, which next/image can't optimize */}
              {cover ? <img src={fileUrl(cover, "800x0")} alt={fileText(cover).alt} loading="lazy" /> : <span aria-hidden="true">{text(course.title).slice(0, 1)}</span>}
            </div>
            <div className="ac-course-body">
              <AccessBadges course={course} cards={cards} t={t} />
              <h3 className="ac-course-title">{href ? <a className="ac-course-link" href={href}>{text(course.title)}</a> : text(course.title)}</h3>
              {text(course.summary) && <p className="ac-muted ac-course-summary">{text(course.summary)}</p>}
              <p className="ac-course-meta">
                {[text(course.byline), level].filter(Boolean).join(" · ")}
                {typeof course.estimatedMinutes === "number" && course.estimatedMinutes > 0 && <>{(text(course.byline) || level) && " · "}<Duration minutes={course.estimatedMinutes} t={t} /></>}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------ layout */

/** The same page in each language it's published in. */
function LanguageSwitcher({ language, t }: Pick<Props, "language" | "t">) {
  if (!language) return null;
  const available = language.locales.filter((locale) => language.alternates[locale.code]);
  if (available.length < 2) return null;
  return (
    <nav className="ac-languages" aria-label={t("academy.language")}>
      {available.map((locale) => (
        <a key={locale.code} href={language.alternates[locale.code]} hrefLang={locale.code} lang={locale.code} aria-current={locale.code === language.locale ? "true" : undefined}>{locale.label}</a>
      ))}
    </nav>
  );
}

function Brand({ branding, language }: Pick<Props, "branding" | "language">) {
  return (
    <Link className="ac-brand" href={inLanguage({ language }, "/")} prefetch={false}>
      {/* eslint-disable-next-line @next/next/no-img-element -- the logo from Settings, a site path or data image */}
      {branding.logoUrl ? <img src={branding.logoUrl} alt="" width={28} height={28} /> : <span className="ac-brand-mark" aria-hidden="true">{branding.name.slice(0, 1)}</span>}
      <span>{branding.name}</span>
    </Link>
  );
}

function Layout(props: LayoutProps<AcademyOptions>) {
  const { branding, globals, options, children, language, t, path, data } = props;
  const menu = globals["site-menu"]?.items;
  const pricing = pricingHref(props);
  const mine = hrefOf(items(data.myCoursesPage)[0], props);
  return (
    <div className="ac-shell" data-scheme={options.colorScheme}>
      <a className="ac-skip" href="#ac-content">{t("academy.skip")}</a>
      <header className="ac-header">
        <div className="ac-header-inner">
          <Brand branding={branding} language={language} />
          <nav className="ac-nav" aria-label={t("academy.menu")}>
            <a href={`${inLanguage(props, "/")}#courses`}>{t("academy.courses")}</a>
            <a href={pricing} aria-current={pricing === path ? "page" : undefined}>{t("academy.pricing")}</a>
            <Menu items={menu} />
          </nav>
          <div className="ac-header-end">
            <LanguageSwitcher language={language} t={t} />
            {mine
              ? <a className="ac-button ac-button-quiet" href={mine} aria-current={mine === path ? "page" : undefined}>{t("academy.myCourses")}</a>
              : <a className="ac-button ac-button-quiet" href={authPath("signin")}>{t("academy.signIn")}</a>}
          </div>
        </div>
      </header>
      <div id="ac-content" className="ac-content">{children}</div>
      <footer className="ac-footer">
        <div className="ac-footer-inner">
          <div>
            <Brand branding={branding} language={language} />
            {options.tagline && <p className="ac-muted">{options.tagline}</p>}
          </div>
          <nav className="ac-footer-nav" aria-label={t("academy.menu")}><Menu items={menu} /></nav>
          <p className="ac-muted">© {new Date().getFullYear()} {branding.name}. {t("academy.rights")}</p>
        </div>
      </footer>
    </div>
  );
}

/* --------------------------------------------------------------- templates */

/** The front page: what the school offers, the catalogue, then the plans. */
function Home(props: Props) {
  const { data, options, t, branding } = props;
  const cards = planCards(data);
  const total = data.courses?.totalItems ?? 0;
  return (
    <main>
      <header className="ac-hero">
        <div className="ac-wide">
          <p className="ac-kicker">{t("academy.kicker")}</p>
          <h1>{branding.name}</h1>
          <p className="ac-lead">{options.tagline || t("academy.intro")}</p>
          <p className="ac-actions">
            <a className="ac-button" href="#courses">{t("academy.browse")}</a>
            {cards.length > 0 && <a className="ac-button ac-button-quiet" href={pricingHref(props)}>{t("academy.seePlans")}</a>}
          </p>
          {total > 0 && <p className="ac-muted">{t("academy.courseCount", { count: total })}</p>}
        </div>
      </header>
      <section id="courses" className="ac-section" aria-labelledby="ac-courses">
        <div className="ac-wide">
          <h2 id="ac-courses" className="ac-section-title">{t("academy.courses")}</h2>
          <p className="ac-muted ac-section-lead">{t("academy.coursesLead")}</p>
          <CourseGrid props={props} cards={cards} />
        </div>
      </section>
      {cards.length > 0 && (
        <section id="plans" className="ac-section ac-section-alt" aria-labelledby="ac-plans">
          <div className="ac-wide">
            <h2 id="ac-plans" className="ac-section-title">{t("academy.plans")}</h2>
            <p className="ac-muted ac-section-lead">{t("academy.plansLead")}</p>
            <Plans props={props} cards={cards} />
          </div>
        </section>
      )}
    </main>
  );
}

/** The pricing page: its title and introduction from the record, then every plan with the courses it opens. */
function Pricing(props: Props) {
  const { record, data, t } = props;
  return (
    <main>
      <header className="ac-hero ac-hero-compact">
        <div className="ac-wide">
          <p className="ac-kicker">{t("academy.pricing")}</p>
          <h1>{text(record?.title) || t("academy.plans")}</h1>
          {hasDoc(record?.intro) ? <div className="ac-lead"><RichText doc={record!.intro} /></div> : <p className="ac-lead">{t("academy.plansLead")}</p>}
          <SubscribedNotice words={lmsParts(props)} />
        </div>
      </header>
      <section className="ac-section" aria-label={t("academy.plans")}>
        <div className="ac-wide"><Plans props={props} cards={planCards(data)} /></div>
      </section>
    </main>
  );
}

/**
 * A course: what it covers on the left, and how to take it on the right. The outline, the
 * enroll, buy and subscribe buttons and the progress bar are the LMS plugin's parts, fed its
 * lists through `data`, so they behave as on its own page.
 */
function Course(props: Props) {
  const { record, data, stream, fileUrl, fileText, t, words, language } = props;
  if (!record) return null;
  const outline = courseOutline(data, words);
  const { plans } = coursePlans(record, data);
  const level = levelOf(record, t);
  const cover = text(record.cover);
  const minutes = outline.ordered.reduce((sum, lesson) => sum + (lesson.minutes ?? 0), 0) || record.estimatedMinutes;
  return (
    <main className="ac-course-page">
      <header className="ac-hero ac-hero-compact">
        <div className="ac-wide">
          <p className="ac-kicker"><a href={`${inLanguage({ language }, "/")}#courses`}>{t("academy.courses")}</a>{level && <> · {level}</>}</p>
          <h1>{text(record.title)}</h1>
          {text(record.summary) && <p className="ac-lead">{text(record.summary)}</p>}
          <p className="ac-course-meta">
            {text(record.byline) && <>{t("lms.taughtBy", { name: text(record.byline) })} · </>}
            {t("academy.lessons", { count: outline.ordered.length })}
            {typeof minutes === "number" && minutes > 0 && <> · <Duration minutes={minutes} t={t} /></>}
          </p>
        </div>
      </header>
      <div className="ac-wide ac-course-columns">
        <div className="ac-course-main">
          {Array.isArray(record.description) && record.description.length > 0 && (
            <section aria-labelledby="ac-about">
              <h2 id="ac-about" className="ac-section-title">{t("academy.about")}</h2>
              <div className="ac-prose"><StreamField blocks={record.description} {...stream} /></div>
            </section>
          )}
          <section aria-labelledby="ac-curriculum">
            <h2 id="ac-curriculum" className="ac-section-title">{t("academy.curriculum")}</h2>
            <div className="ac-card"><Outline outline={outline} words={words} /></div>
          </section>
        </div>
        <aside className="ac-course-side">
          <div className="ac-card ac-take">
            {/* eslint-disable-next-line @next/next/no-img-element -- an access-checked API address that redirects to a signed URL, which next/image can't optimize */}
            {cover && <img className="ac-take-cover" src={fileUrl(cover, "800x0")} alt={fileText(cover).alt} />}
            {outline.enrolled && outline.ordered.length > 0 && (
              <div>
                <p className="ac-plan-opens">{t("academy.yourProgress")}</p>
                <Progress percent={Math.round((outline.done / outline.ordered.length) * 100)} label={t("lms.lessonsDone", { done: outline.done, total: outline.ordered.length })} name={t("lms.progress")} />
              </div>
            )}
            <CourseAction course={record} outline={outline} data={data} words={words} />
            {plans.length > 0 && outline.enrolled && (
              <p className="ac-muted">{t("academy.included")} {plans.map((plan) => plan.title).join(", ")}</p>
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}

/** The LMS plugin's own pages, in this theme's layout. Named here so the layout gets the theme's lists too. */
const lmsTemplates = (lmsRenderers as unknown as { templates?: Record<string, ComponentType<Props>> }).templates ?? {};
const fromLms = (name: string) => function LmsPage(props: Props) {
  const Template = lmsTemplates[name];
  return Template ? <div className="ac-lms"><Template {...props} /></div> : null;
};

/** Any other page, such as About. */
function Page({ record, stream }: Props) {
  if (!record) return null;
  return (
    <main>
      <article className="ac-article">
        <h1>{text(record.title)}</h1>
        <div className="ac-prose"><StreamField blocks={record.body} {...stream} /></div>
      </article>
    </main>
  );
}

export default defineThemeComponents<AcademyOptions>({
  // Lesson blocks come from the LMS plugin and are restyled in theme.css.
  templates: {
    home: Home,
    "academy-pricing": Pricing,
    "lms-courses": Course,
    "lms-lessons": fromLms("lms-lessons"),
    "lms-my-courses": fromLms("lms-my-courses"),
    "lms-certificate": fromLms("lms-certificate"),
    default: Page,
  },
  layouts: { default: Layout },
  messages,
});
