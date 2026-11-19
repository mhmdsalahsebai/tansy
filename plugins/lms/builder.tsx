"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { adminPath, Alert, apiPath, Badge, Button, PageHeader, Field, Input, Modal, PageSkeleton, translate, useT } from "tansy/admin";
import "./admin.css";

type Row = Record<string, unknown> & { id: number };
interface Course extends Row { price?: number | null; title?: string; summary?: string; access?: string; level?: string; byline?: string; estimatedMinutes?: number | null; status?: string }
interface Section extends Row { title: string; position?: number | null }
interface Lesson extends Row { title: string; section?: number | null; position?: number | null; status?: string; preview?: boolean }
interface Quiz extends Row { title: string; lesson?: number | null }

class ApiError extends Error {}

type Values = Record<string, string | number>;

/** This plugin's words, in a component. */
function useWords() {
  const { t } = useT();
  return (key: string, values?: Values) => t(`ext.lms.${key}`, values);
}

/** This plugin's words outside a component, such as an error from a click. */
const word = (key: string, values?: Values) => translate(`ext.lms.${key}`, values);

/** Through the records API, so every change passes the same rules and permissions as anywhere else. */
async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(apiPath(path), { method: init?.method ?? "GET", headers: init?.body === undefined ? undefined : { "content-type": "application/json" }, body: init?.body === undefined ? undefined : JSON.stringify(init.body) });
  const json = await response.json().catch(() => null) as { error?: { message?: string; details?: Array<{ path?: string; message?: string }> } } | null;
  if (!response.ok) {
    const detail = json?.error?.details?.[0];
    throw new ApiError(detail?.message ? `${json?.error?.message ?? word("builder.notSaved")} ${detail.path ? `${detail.path}: ` : ""}${detail.message}` : (json?.error?.message ?? word("builder.failed", { status: response.status })));
  }
  return json as T;
}

const records = (slug: string) => `/collections/${slug}/records`;
const list = async <T,>(slug: string, filter: string, fields: string) =>
  (await call<{ items: T[] }>(`${records(slug)}?filter=${encodeURIComponent(filter)}&perPage=200&fields=${fields}`)).items;
const create = (slug: string, body: Record<string, unknown>) => call<Row>(records(slug), { method: "POST", body });
const update = (slug: string, id: number, body: Record<string, unknown>) => call<Row>(`${records(slug)}/${id}`, { method: "PATCH", body });
const remove = (slug: string, id: number) => call<unknown>(`${records(slug)}/${id}`, { method: "DELETE" });

const byPosition = <T extends Row & { position?: number | null }>(items: T[]) => [...items].sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || a.id - b.id);
const nextPosition = (items: Array<{ position?: number | null }>) => Math.max(0, ...items.map((item) => item.position ?? 0)) + 10;
const move = <T,>(items: T[], from: number, to: number) => { const copy = [...items]; const [item] = copy.splice(from, 1); copy.splice(to, 0, item); return copy; };

/** Positions 10 apart in this order, saving only the ones that change. */
async function renumber(slug: string, items: Array<Row & { position?: number | null }>) {
  for (const [index, item] of items.entries()) {
    const position = (index + 1) * 10;
    if (item.position !== position) await update(slug, item.id, { position });
  }
}

async function fetchCourse(courseId: number, priceField: string | null) {
  const [course, sections, lessons] = await Promise.all([
    call<Row>(`${records("lms-courses")}/${courseId}?fields=id,title,summary,access,level,byline,estimatedMinutes,status${priceField ? `,${priceField}` : ""}`).then((row): Course => ({ ...row, price: priceField && typeof row[priceField] === "number" ? row[priceField] as number : null })),
    list<Section>("lms-sections", `course = ${courseId}`, "id,title,position"),
    list<Lesson>("lms-lessons", `course = ${courseId}`, "id,title,section,position,status,preview"),
  ]);
  // Quizzes are optional: someone who can't list them still builds the rest.
  const quizzes = await list<Quiz>("lms-quizzes", `course = ${courseId}`, "id,title,lesson").catch(() => []);
  return { course, sections: byPosition(sections), lessons: byPosition(lessons), quizzes };
}

function Mover({ label, index, count, disabled, onMove }: { label: string; index: number; count: number; disabled: boolean; onMove(to: number): void }) {
  const t = useWords();
  return (
    <span className="lms-admin-mover">
      <button type="button" className="cms-icon-btn" disabled={disabled || index === 0} onClick={() => onMove(index - 1)} aria-label={t("builder.moveLabelUp", { label })} title={t("builder.moveUp")}>↑</button>
      <button type="button" className="cms-icon-btn" disabled={disabled || index === count - 1} onClick={() => onMove(index + 1)} aria-label={t("builder.moveLabelDown", { label })} title={t("builder.moveDown")}>↓</button>
    </span>
  );
}

/** A one-line form that adds something by its title. */
function AddForm({ label, placeholder, disabled, onAdd }: { label: string; placeholder: string; disabled: boolean; onAdd(title: string): Promise<void> }) {
  const [title, setTitle] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    await onAdd(title.trim());
    setTitle("");
  };
  return (
    <form className="lms-admin-add" onSubmit={submit}>
      <Input aria-label={placeholder} placeholder={placeholder} value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} disabled={disabled} />
      <Button type="submit" variant="secondary" disabled={disabled || !title.trim()}>{label}</Button>
    </form>
  );
}

/** A title edited in place, saved when it loses focus. */
function TitleInput({ value, label, disabled, onSave }: { value: string; label: string; disabled: boolean; onSave(title: string): void }) {
  const [draft, setDraft] = useState(value);
  // A saved title replaces whatever was typed, as React's guide does for state that follows a prop.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(value);
  }
  return <input className="lms-admin-title-input" aria-label={label} value={draft} maxLength={200} disabled={disabled} onChange={(event) => setDraft(event.target.value)} onBlur={() => { if (draft.trim() && draft !== value) onSave(draft.trim()); else setDraft(value); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />;
}

function StatusBadge({ status }: { status?: string }) {
  const t = useWords();
  return status === "published" ? <Badge tone="success">{t("builder.published")}</Badge> : <Badge tone="warning">{t("builder.draft")}</Badge>;
}

export function CourseBuilder({ courseId, canManage }: { courseId: number; canManage: boolean }) {
  const t = useWords();
  const [course, setCourse] = useState<Course | null>(null);
  const [details, setDetails] = useState<Course | null>(null);
  const [sections, setSections] = useState<Section[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [collectionIds, setCollectionIds] = useState<Record<string, number>>({});
  /** The Payments price field on courses, when the owner has added one. Courses are sold through it. */
  const [priceField, setPriceField] = useState<string | null>(null);
  const priceRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => fetchCourse(courseId, priceRef.current).then(({ course: loaded, sections: sectionRows, lessons: lessonRows, quizzes: quizRows }) => {
    setCourse(loaded);
    setDetails((current) => current ?? loaded);
    setSections(sectionRows);
    setLessons(lessonRows);
    setQuizzes(quizRows);
  }), [courseId]);

  useEffect(() => {
    // The collections first, so the course is read with its price field when it has one.
    call<Array<{ id: string | number; slug: string; fields?: Array<{ name: string; type: string }> }>>("/collections").then(
      (rows) => {
        setCollectionIds(Object.fromEntries(rows.map((row) => [row.slug, Number(row.id)])));
        priceRef.current = rows.find((row) => row.slug === "lms-courses")?.fields?.find((field) => field.type === "payments_price")?.name ?? null;
        setPriceField(priceRef.current);
      },
      () => setCollectionIds({}),
    ).then(load).catch((err: Error) => setError(err.message));
  }, [load]);

  /** Runs a change, then reloads, so what shows is always what was saved. */
  const run = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      if (done) setNotice(done);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("builder.wrong"));
    }
    await load().catch(() => undefined);
    setBusy(false);
  };

  const editorHref = (slug: string, id: number) => (collectionIds[slug] ? adminPath(`/collections/${collectionIds[slug]}/content/${id}`) : null);
  const editLink = (slug: string, id: number, children: ReactNode) => {
    const href = editorHref(slug, id);
    return href ? <a className="cms-link" href={href}>{children}</a> : null;
  };

  if (!course || !details) {
    return <div className="cms-gutter">{error ? <Alert>{error}</Alert> : <PageSkeleton kind="detail" />}</div>;
  }

  const set = (name: keyof Course, value: unknown) => setDetails({ ...details, [name]: value });
  const saveDetails = (event: FormEvent) => {
    event.preventDefault();
    const body: Record<string, unknown> = { title: details.title, summary: details.summary ?? "", access: details.access, level: details.level || null, estimatedMinutes: details.estimatedMinutes ?? null };
    if (canManage) body.byline = details.byline ?? "";
    // Only a paid course keeps a price.
    if (priceField) body[priceField] = details.access === "paid" ? details.price ?? null : null;
    void run(async () => { await update("lms-courses", courseId, body); setDetails(null); }, t("builder.detailsSaved"));
  };

  const groups: Array<{ section: Section | null; lessons: Lesson[] }> = [
    ...sections.map((section) => ({ section, lessons: lessons.filter((lesson) => lesson.section === section.id) })),
    { section: null, lessons: lessons.filter((lesson) => !sections.some((section) => section.id === lesson.section)) },
  ];

  const addQuiz = (lesson: Lesson) => run(async () => {
    const quiz = await create("lms-quizzes", { title: t("builder.quizTitle", { lesson: lesson.title }).slice(0, 200), lesson: lesson.id });
    // The quiz shows where a Quiz block places it, so put one at the end of the lesson.
    const stored = await call<{ content?: unknown }>(`${records("lms-lessons")}/${lesson.id}?fields=content`);
    const content = Array.isArray(stored.content) ? stored.content : [];
    await update("lms-lessons", lesson.id, { content: [...content, { id: crypto.randomUUID(), type: "lms_quiz", v: 1, value: { quiz: quiz.id } }] });
  }, t("builder.quizAdded"));

  const lessonRow = (lesson: Lesson, index: number, siblings: Lesson[]) => {
    const quiz = quizzes.find((candidate) => candidate.lesson === lesson.id);
    return (
      <li key={lesson.id} className="lms-admin-lesson">
        <Mover label={lesson.title} index={index} count={siblings.length} disabled={busy} onMove={(to) => run(() => renumber("lms-lessons", move(siblings, index, to)))} />
        <div className="lms-admin-lesson-main">
          <TitleInput value={lesson.title} label={t("builder.lessonTitle")} disabled={busy} onSave={(title) => run(() => update("lms-lessons", lesson.id, { title }))} />
          <div className="lms-admin-meta">
            <StatusBadge status={lesson.status} />
            {lesson.preview && <Badge tone="info">{t("builder.freePreview")}</Badge>}
            {quiz ? <span>{t("builder.quiz")} {editLink("lms-quizzes", quiz.id, quiz.title)}</span> : <button type="button" className="cms-link" disabled={busy} onClick={() => addQuiz(lesson)}>{t("builder.addQuiz")}</button>}
          </div>
        </div>
        <div className="lms-admin-actions">
          {editLink("lms-lessons", lesson.id, t("builder.editContent"))}
          {sections.length > 0 && (
            <select className="cms-input lms-admin-select" aria-label={t("builder.sectionFor", { lesson: lesson.title })} value={lesson.section ?? ""} disabled={busy} onChange={(event) => {
              const section = event.target.value ? Number(event.target.value) : null;
              void run(() => update("lms-lessons", lesson.id, { section, position: nextPosition(lessons.filter((other) => other.section === section)) }));
            }}>
              <option value="">{t("builder.noSection")}</option>
              {sections.map((section) => <option key={section.id} value={section.id}>{section.title}</option>)}
            </select>
          )}
          <Button variant="secondary" disabled={busy} onClick={() => run(() => update("lms-lessons", lesson.id, { preview: !lesson.preview }))}>{lesson.preview ? t("builder.removePreview") : t("builder.makePreview")}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => run(() => update("lms-lessons", lesson.id, { status: lesson.status === "published" ? "draft" : "published" }))}>{lesson.status === "published" ? t("builder.unpublish") : t("builder.publish")}</Button>
          <Button variant="danger" disabled={busy} onClick={() => { if (window.confirm(t("builder.confirmDeleteLesson", { lesson: lesson.title }))) void run(() => remove("lms-lessons", lesson.id), t("builder.lessonDeleted")); }}>{t("builder.delete")}</Button>
        </div>
      </li>
    );
  };

  const published = course.status === "published";
  return (
    <div className="cms-gutter lms-admin">
      <PageHeader
        back={{ href: adminPath("/ext/lms/courses"), label: t("builder.backToCourses") }}
        title={course.title || t("common.course", { id: course.id })}
        meta={<><StatusBadge status={course.status} /><span>{t("builder.counts", { lessons: lessons.length, sections: sections.length })}</span></>}
        actions={(
          <>
            {editLink("lms-courses", courseId, t("builder.coverAndDescription"))}
            <Button disabled={busy} variant={published ? "secondary" : "primary"} onClick={() => run(() => update("lms-courses", courseId, { status: published ? "draft" : "published" }), published ? t("builder.draftAgain") : t("builder.nowPublished"))}>{published ? t("builder.unpublishCourse") : t("builder.publishCourse")}</Button>
          </>
        )}
      />

      {error && <div className="cms-mb-4"><Alert>{error}</Alert></div>}
      {notice && <div className="cms-mb-4"><Alert kind="success">{notice}</Alert></div>}

      <div className="lms-admin-grid">
        <section className="cms-panel lms-admin-panel" aria-labelledby="lms-curriculum">
          <h2 id="lms-curriculum" className="cms-section-title cms-mb-4">{t("builder.curriculum")}</h2>
          {groups.map(({ section, lessons: inGroup }) => (section || inGroup.length > 0) && (
            <div key={section?.id ?? "none"} className="lms-admin-section">
              <div className="lms-admin-section-head">
                {section ? (
                  <>
                    <Mover label={section.title} index={sections.indexOf(section)} count={sections.length} disabled={busy} onMove={(to) => run(() => renumber("lms-sections", move(sections, sections.indexOf(section), to)))} />
                    <TitleInput value={section.title} label={t("builder.sectionTitle")} disabled={busy} onSave={(title) => run(() => update("lms-sections", section.id, { title }))} />
                    <Button variant="danger" disabled={busy || inGroup.length > 0} title={inGroup.length ? t("builder.moveLessonsFirst") : undefined} onClick={() => { if (window.confirm(t("builder.confirmDeleteSection", { section: section.title }))) void run(() => remove("lms-sections", section.id), t("builder.sectionDeleted")); }}>{t("builder.deleteSection")}</Button>
                  </>
                ) : <strong className="cms-muted">{t("builder.notInSection")}</strong>}
              </div>
              {inGroup.length > 0 ? <ol className="lms-admin-lessons">{inGroup.map((lesson, index) => lessonRow(lesson, index, inGroup))}</ol> : <p className="cms-muted cms-text-sm">{t("builder.noLessons")}</p>}
              {section && <AddForm label={t("builder.addLesson")} placeholder={t("builder.newLesson")} disabled={busy} onAdd={(title) => run(() => create("lms-lessons", { title, course: courseId, section: section.id, position: nextPosition(inGroup) }), t("builder.lessonAdded"))} />}
            </div>
          ))}
          {sections.length === 0 && lessons.length === 0 && <p className="cms-muted cms-mb-4">{t("builder.start")}</p>}
          <div className="lms-admin-section">
            <AddForm label={t("builder.addSection")} placeholder={t("builder.newSection")} disabled={busy} onAdd={(title) => run(() => create("lms-sections", { title, course: courseId, position: nextPosition(sections) }), t("builder.sectionAdded"))} />
            {sections.length === 0 && <AddForm label={t("builder.addLesson")} placeholder={t("builder.lessonWithoutSection")} disabled={busy} onAdd={(title) => run(() => create("lms-lessons", { title, course: courseId, position: nextPosition(lessons) }), t("builder.lessonAdded"))} />}
          </div>
        </section>

        <form className="cms-panel lms-admin-panel cms-stack-4" onSubmit={saveDetails} aria-labelledby="lms-details">
          <h2 id="lms-details" className="cms-section-title">{t("builder.details")}</h2>
          <Field label={t("builder.title")}><Input required maxLength={200} value={details.title ?? ""} onChange={(event) => set("title", event.target.value)} /></Field>
          <Field label={t("builder.summary")} hint={t("builder.summaryHint")}><textarea className="cms-input" rows={3} maxLength={500} value={details.summary ?? ""} onChange={(event) => set("summary", event.target.value)} /></Field>
          <Field label={t("builder.whoCanEnroll")}>
            <select className="cms-input" value={details.access ?? "free"} onChange={(event) => set("access", event.target.value)}>
              <option value="free">{t("builder.accessFree")}</option>
              <option value="paid">{t("builder.accessPaid")}</option>
              <option value="enrollment">{t("builder.accessEnrollment")}</option>
            </select>
          </Field>
          {details.access === "paid" && (priceField
            ? <Field label={t("builder.price")} hint={t("builder.priceHint")}><Input type="number" required min={0.01} step={0.01} value={details.price ?? ""} onChange={(event) => set("price", event.target.value === "" ? null : Number(event.target.value))} /></Field>
            : <Alert>{t("builder.noPayments")}</Alert>)}
          <Field label={t("builder.level")}>
            <select className="cms-input" value={details.level ?? ""} onChange={(event) => set("level", event.target.value)}>
              <option value="">{t("builder.notSet")}</option>
              <option value="beginner">{t("builder.beginner")}</option>
              <option value="intermediate">{t("builder.intermediate")}</option>
              <option value="advanced">{t("builder.advanced")}</option>
            </select>
          </Field>
          <Field label={t("builder.minutes")}><Input type="number" min={0} step={1} value={details.estimatedMinutes ?? ""} onChange={(event) => set("estimatedMinutes", event.target.value === "" ? null : Number(event.target.value))} /></Field>
          <Field label={t("builder.taughtBy")} hint={canManage ? t("builder.taughtByManager") : t("builder.taughtByOwn")}><Input maxLength={200} value={details.byline ?? ""} disabled={!canManage} onChange={(event) => set("byline", event.target.value)} /></Field>
          <div><Button type="submit" loading={busy}>{t("builder.saveDetails")}</Button></div>
        </form>
      </div>
    </div>
  );
}

/** Creates a draft course and opens it in the builder. */
export function NewCourse() {
  const t = useWords();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button onClick={() => setOpen(true)}>{t("courses.create")}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={t("courses.create")}>
        <div className="cms-stack-4">
          <AddForm label={t("courses.create")} placeholder={t("courses.newTitle")} disabled={busy} onAdd={async (title) => {
            setBusy(true);
            setError(null);
            try {
              const course = await create("lms-courses", { title });
              window.location.href = adminPath(`/ext/lms/courses/${course.id}`);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : t("courses.notCreated"));
              setBusy(false);
            }
          }} />
          {error && <Alert>{error}</Alert>}
        </div>
      </Modal>
    </>
  );
}
