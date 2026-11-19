"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { apiPath, authPath, contentLocale, sitePath, type SiteWords } from "tansy/react";
import { money } from "./logic";
import { lmsWords } from "./words";

/**
 * The LMS's parts with behaviour. Each takes the page's `words` (`pickWords(words, "lms")`
 * from a template) to speak its language, read courses in it and keep links in it. Without them, English.
 */

const ext = (path: string) => apiPath(`/ext/lms${path}`);
/** `?locale=…` on the LMS's reads, on a site with more than one language. */
const inLanguage = (words: SiteWords | undefined) => (contentLocale(words) ? `?locale=${encodeURIComponent(contentLocale(words)!)}` : "");
const here = () => `${window.location.pathname}${window.location.search}`;
const signInHref = () => authPath(`signin?next=${encodeURIComponent(here())}`);

async function post(path: string, body?: unknown) {
  const response = await fetch(ext(path), { method: "POST", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json().catch(() => null) as Record<string, unknown> & { error?: { message?: string } } | null;
  return { status: response.status, ok: response.ok, json };
}

/** Enrolls the visitor in a free course, or one their plan covers, sending them to sign in first if they need to. */
export function EnrollButton({ courseId, continueHref, label, words }: { courseId: number; continueHref: string | null; label?: string; words?: SiteWords }) {
  const { t } = lmsWords(words);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function enroll() {
    setBusy(true);
    setError(null);
    try {
      const { status, ok } = await post(`/courses/${courseId}/enroll`);
      if (status === 401) return void window.location.assign(signInHref());
      if (!ok) return setError(t("lms.enrollFailed"));
      // The course's lessons now open, so the page reads them as this learner.
      window.location.assign(continueHref ?? here());
    } catch {
      setError(t("lms.enrollOffline"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="lms-cta">
      <button type="button" className="lms-button" onClick={enroll} disabled={busy}>{busy ? t("lms.enrolling") : label ?? t("lms.enroll")}</button>
      {error && <p className="lms-error" role="alert">{error}</p>}
    </div>
  );
}

interface Offer { forSale: boolean; amount: number | null; currency: string | null; purchased: boolean }


/**
 * A paid course, bought through the Payments plugin. Payments is reached over its API only,
 * so without it, or before a payment provider is connected, the course just isn't on sale yet.
 * After paying, the enrollment arrives from the provider's webhook, so this waits for it.
 */
export function CourseOffer({ courseId, words }: { courseId: number; words?: SiteWords }) {
  const { t } = lmsWords(words);
  const params = useSearchParams();
  const returned = params.get("purchase") === "success";
  const sessionId = params.get("session_id");
  const [offer, setOffer] = useState<Offer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(apiPath(`/ext/payments/offer?collection=lms-courses&id=${courseId}`))
      .then(async (response) => (response.ok ? (await response.json()) as Offer : null))
      .catch(() => null)
      .then((found) => { if (live) setOffer(found ?? { forSale: false, amount: null, currency: null, purchased: false }); });
    return () => { live = false; };
  }, [courseId]);

  useEffect(() => {
    if (!returned) return;
    // Confirms the payment with the provider through Payments, so the purchase doesn't wait for the webhook.
    if (sessionId) void fetch(apiPath("/ext/payments/confirm"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId }) }).catch(() => null);
    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      const response = await fetch(ext("/me/courses")).catch(() => null);
      const json = response?.ok ? await response.json().catch(() => null) as { items?: Array<{ course: { id: number } }> } | null : null;
      if (json?.items?.some((item) => item.course.id === courseId)) {
        clearInterval(timer);
        window.location.assign(window.location.pathname);
      } else if (tries >= 20) {
        clearInterval(timer);
        setSlow(true);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [returned, sessionId, courseId]);

  async function buy() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(apiPath("/ext/payments/checkout"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ collection: "lms-courses", id: courseId, returnPath: window.location.pathname }) });
      if (response.status === 401) return void window.location.assign(signInHref());
      const json = await response.json().catch(() => null) as { url?: string; error?: { message?: string } } | null;
      if (!response.ok || !json?.url) return setError(t("lms.checkoutFailed"));
      window.location.assign(json.url);
    } catch {
      setError(t("lms.checkoutOffline"));
    } finally {
      setBusy(false);
    }
  }

  if (returned) {
    return slow
      ? <p className="lms-muted" role="status">{t("lms.paymentSlow")}</p>
      : <p className="lms-success" role="status">{t("lms.paymentReceived")}</p>;
  }
  if (!offer) return null;
  if (offer.purchased) return <p className="lms-muted">{t("lms.boughtNotEnrolled")}</p>;
  if (!offer.forSale || offer.amount === null || !offer.currency) return <p className="lms-muted">{t("lms.notForSale")}</p>;
  return (
    <div className="lms-cta">
      <button type="button" className="lms-button" onClick={buy} disabled={busy}>{busy ? t("lms.opening") : t("lms.buyFor", { price: money(offer.amount, offer.currency, words?.locale ?? "en") })}</button>
      {error && <p className="lms-error" role="alert">{error}</p>}
    </div>
  );
}

/** A plan from the Payments plugin, as a pricing page or course page shows it. */
export interface PlanOption { name: string; title: string; amount: number | null; annualAmount: number | null; currency: string | null; featured: boolean }

/**
 * Subscribes to a plan through the Payments plugin, over its API only, so the LMS never imports it.
 * Back from the provider with `?subscription=success`, it says so: the plan's courses open once the
 * provider confirms, and the person enrolls in each with one click.
 */
export function SubscribeToPlan({ plan, annual = false, label, className, words }: { plan: PlanOption; annual?: boolean; label?: string; className?: string; words?: SiteWords }) {
  const { t } = lmsWords(words);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function subscribe() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(apiPath("/ext/payments/subscribe"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: plan.name, annual, returnPath: window.location.pathname }) });
      if (response.status === 401) return void window.location.assign(signInHref());
      const json = await response.json().catch(() => null) as { url?: string } | null;
      if (!response.ok || !json?.url) return setError(t("lms.subscribeFailed"));
      window.location.assign(json.url);
    } catch {
      setError(t("lms.subscribeFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="lms-cta">
      <button type="button" className={className ?? "lms-button"} onClick={subscribe} disabled={busy}>{busy ? t("lms.opening") : label ?? t("lms.subscribeTo", { plan: plan.title })}</button>
      {error && <p className="lms-error" role="alert">{error}</p>}
    </div>
  );
}

/** Says so when the visitor is back from subscribing. */
export function SubscribedNotice({ words }: { words?: SiteWords }) {
  const { t } = lmsWords(words);
  return useSearchParams().get("subscription") === "success" ? <p className="lms-success" role="status">{t("lms.subscribed")}</p> : null;
}

/** Marks the lesson done, then moves on to the next one when there is one. */
export function MarkComplete({ lessonId, done, nextHref, words }: { lessonId: number; done: boolean; nextHref: string | null; words?: SiteWords }) {
  const { t } = lmsWords(words);
  const [state, setState] = useState<"idle" | "busy" | "done" | "course">(done ? "done" : "idle");
  const [error, setError] = useState<string | null>(null);
  async function complete() {
    setState("busy");
    setError(null);
    const { ok, json } = await post(`/lessons/${lessonId}/complete`).catch(() => ({ ok: false, json: null, status: 0 }));
    if (!ok) {
      setState("idle");
      return setError(t("lms.saveFailed"));
    }
    setState(json?.courseCompleted ? "course" : "done");
    if (nextHref && !json?.courseCompleted) window.location.assign(nextHref);
  }
  if (state === "course") return <p className="lms-success" role="status">{t("lms.finishedCourse")}</p>;
  if (state === "done") return <p className="lms-success">✓ {t("lms.completed")}{nextHref && <> · <a href={nextHref}>{t("lms.nextLesson")}</a></>}</p>;
  return (
    <div className="lms-cta">
      <button type="button" className="lms-button" onClick={complete} disabled={state === "busy"}>{state === "busy" ? t("lms.saving") : t("lms.markComplete")}</button>
      {error && <p className="lms-error" role="alert">{error}</p>}
    </div>
  );
}

interface QuizQuestion { id: string; prompt: string; kind: "single" | "multiple" | "short"; choices: string[] }
interface QuizData { id: number; title: string; passingScore: number; maxAttempts: number | null; attemptsLeft: number | null; passed: boolean; best: number | null; questions: QuizQuestion[] }
type Result = { score: number; correct: number; total: number; passed: boolean; attemptsLeft: number | null };

/** Loads a quiz's questions without their answers, and sends answers to be graded on the server. */
export function Quiz({ quizId, words }: { quizId: number; words?: SiteWords }) {
  const { t } = lmsWords(words);
  const language = inLanguage(words);
  const id = useId();
  const [quiz, setQuiz] = useState<QuizData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, number | number[] | string>>({});
  const [result, setResult] = useState<Result | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(ext(`/quizzes/${quizId}${language}`)).then(async (response) => {
      if (!live) return;
      if (response.ok) setQuiz(await response.json() as QuizData);
      else setFailed(response.status === 401 ? t("lms.quizSignIn") : t("lms.quizLocked"));
    }).catch(() => live && setFailed(t("lms.quizFailed")));
    return () => { live = false; };
  }, [quizId, language, t]);

  if (failed) return <aside className="lms-quiz"><p className="lms-muted">{failed}</p></aside>;
  if (!quiz) return <aside className="lms-quiz"><p className="lms-muted">{t("lms.quizLoading")}</p></aside>;

  const set = (question: string, value: number | number[] | string) => setAnswers((current) => ({ ...current, [question]: value }));
  const toggle = (question: string, choice: number) => {
    const current = Array.isArray(answers[question]) ? answers[question] as number[] : [];
    set(question, current.includes(choice) ? current.filter((c) => c !== choice) : [...current, choice]);
  };
  const outOfAttempts = quiz.attemptsLeft === 0 || result?.attemptsLeft === 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    const { ok, status, json } = await post(`/quizzes/${quizId}/attempts${language}`, { answers }).catch(() => ({ ok: false, json: null, status: 0 }));
    setSending(false);
    if (!ok) return setFailed(status === 409 ? t("lms.noAttempts") : t("lms.sendFailed"));
    setResult(json as unknown as Result);
  }

  return (
    <aside className="lms-quiz" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{quiz.title}</h2>
      <p className="lms-muted">
        {[
          t("lms.passWith", { score: quiz.passingScore }),
          quiz.attemptsLeft !== null ? t("lms.attemptsLeft", { count: result?.attemptsLeft ?? quiz.attemptsLeft }) : "",
          quiz.passed ? t("lms.passedQuiz") : "",
          quiz.best !== null ? t("lms.bestScore", { score: quiz.best }) : "",
        ].filter(Boolean).join(" ")}
      </p>
      {result && (
        <p className={result.passed ? "lms-success" : "lms-error"} role="status">
          {t("lms.result", { correct: result.correct, total: result.total, score: result.score })} {result.passed ? t("lms.passed") : t("lms.notPassed")}
        </p>
      )}
      {!outOfAttempts && (
        <form onSubmit={submit}>
          <ol className="lms-questions">
            {quiz.questions.map((question) => (
              <li key={question.id}>
                <fieldset>
                  <legend>{question.prompt}</legend>
                  {question.kind === "short"
                    ? <input aria-label={t("lms.yourAnswer")} value={typeof answers[question.id] === "string" ? answers[question.id] as string : ""} onChange={(event) => set(question.id, event.target.value)} maxLength={500} />
                    : question.choices.map((choice, index) => (
                      <label key={index} className="lms-choice">
                        <input
                          type={question.kind === "single" ? "radio" : "checkbox"}
                          name={`${id}-${question.id}`}
                          checked={question.kind === "single" ? answers[question.id] === index : Array.isArray(answers[question.id]) && (answers[question.id] as number[]).includes(index)}
                          onChange={() => (question.kind === "single" ? set(question.id, index) : toggle(question.id, index))}
                        />
                        {choice}
                      </label>
                    ))}
                </fieldset>
              </li>
            ))}
          </ol>
          <button type="submit" className="lms-button" disabled={sending}>{sending ? t("lms.grading") : result ? t("lms.tryAgain") : t("lms.submit")}</button>
        </form>
      )}
    </aside>
  );
}

interface MyCourse {
  enrollment: { id: number; state: string };
  course: { id: number; title: string; summary: string; recordPath: string | null };
  lessons: number;
  completed: number;
  percent: number;
  next: { title: string; recordPath: string | null } | null;
}

/** The signed-in learner's courses, with their progress and where to pick up. */
export function MyCourses({ words }: { words?: SiteWords }) {
  const { t } = lmsWords(words);
  const language = inLanguage(words);
  const [items, setItems] = useState<MyCourse[] | null>(null);
  const [state, setState] = useState<"loading" | "signed-out" | "error" | "ready">("loading");
  useEffect(() => {
    fetch(ext(`/me/courses${language}`)).then(async (response) => {
      if (response.status === 401) return setState("signed-out");
      if (!response.ok) return setState("error");
      setItems(((await response.json()) as { items: MyCourse[] }).items);
      setState("ready");
    }).catch(() => setState("error"));
  }, [language]);

  if (state === "loading") return <p className="lms-muted">{t("lms.loadingCourses")}</p>;
  if (state === "signed-out") return <p><a href={signInHref()}>{t("lms.signInToSee")}</a></p>;
  if (state === "error") return <p className="lms-error">{t("lms.coursesFailed")}</p>;
  if (!items?.length) return <p className="lms-muted">{t("lms.noCourses")}</p>;
  return (
    <ul className="lms-cards">
      {items.map((item) => (
        <li key={item.enrollment.id} className="lms-card">
          <h2>{item.course.recordPath ? <a href={sitePath(words, item.course.recordPath)}>{item.course.title || t("lms.course")}</a> : item.course.title || t("lms.course")}</h2>
          {item.course.summary && <p className="lms-muted">{item.course.summary}</p>}
          <Progress percent={item.percent} label={t("lms.lessonsDone", { done: item.completed, total: item.lessons })} name={t("lms.progress")} />
          {item.enrollment.state === "completed"
            ? <p className="lms-success">{t("lms.completed")}</p>
            : item.next?.recordPath && <p><a className="lms-button" href={sitePath(words, item.next.recordPath)}>{t("lms.continue", { title: item.next.title })}</a></p>}
        </li>
      ))}
    </ul>
  );
}

/** `name` is the bar's accessible name, so the page sends one word to the browser rather than all of them. */
export function Progress({ percent, label, name, words }: { percent: number; label: string; name?: string; words?: SiteWords }) {
  return (
    <div className="lms-progress">
      <div className="lms-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={name ?? lmsWords(words).t("lms.progress")}><span style={{ width: `${percent}%` }} /></div>
      <span className="lms-muted">{label} · {percent}%</span>
    </div>
  );
}

interface Verified { code: string; studentName: string; course: string; issuedAt: string | null }

async function verify(code: string, language: string): Promise<Verified | "missing" | "error"> {
  const response = await fetch(ext(`/certificates/${encodeURIComponent(code.trim())}${language}`)).catch(() => null);
  if (!response) return "error";
  if (response.status === 404) return "missing";
  return response.ok ? await response.json() as Verified : "error";
}

/** Checks a certificate code, from the form or the page's ?code=, so a link can carry it. */
export function CertificateCheck({ words }: { words?: SiteWords }) {
  const { t, formatDate } = lmsWords(words);
  const language = inLanguage(words);
  const id = useId();
  const given = useSearchParams().get("code")?.slice(0, 40) ?? "";
  const [code, setCode] = useState(given);
  const [result, setResult] = useState<Verified | "missing" | "error" | null>(null);

  useEffect(() => {
    let live = true;
    if (given.trim()) void verify(given, language).then((found) => live && setResult(found));
    return () => { live = false; };
  }, [given, language]);

  const check = (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim()) return;
    setResult(null);
    void verify(code, language).then(setResult);
  };

  return (
    <div>
      <form className="lms-form" onSubmit={check}>
        <label htmlFor={`${id}-code`}>{t("lms.certificateCode")}</label>
        <input id={`${id}-code`} value={code} onChange={(event) => setCode(event.target.value)} maxLength={40} autoComplete="off" spellCheck={false} />
        <button type="submit" className="lms-button">{t("lms.check")}</button>
      </form>
      {result === "missing" && <p className="lms-error" role="status">{t("lms.noCertificate")}</p>}
      {result === "error" && <p className="lms-error" role="status">{t("lms.checkFailed")}</p>}
      {result && typeof result === "object" && (
        <div className="lms-card" role="status">
          <p className="lms-success">✓ {t("lms.genuine")}</p>
          <p>{result.issuedAt ? t("lms.certifiedOn", { name: result.studentName, course: result.course, date: formatDate(result.issuedAt, "long") }) : t("lms.certified", { name: result.studentName, course: result.course })}</p>
          <p className="lms-muted">{t("lms.code", { code: result.code })}</p>
        </div>
      )}
    </div>
  );
}
