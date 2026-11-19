"use client";

import { AdjustmentsHorizontalIcon, ArrowLeftIcon, ArrowTopRightOnSquareIcon, ClockIcon, ExclamationTriangleIcon } from "@heroicons/react/16/solid";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAdminClient, useAdminSlots, useRecordAccess } from "../admin-client";
import { useAdminLocale, useFieldText, usePluginWord, useSchemaText, useT } from "../i18n";
import { PluginBoundary } from "../PluginBoundary";
import FieldValueInput from "../fields/FieldValueInput";
import { isShown } from "../fields/show-if";
import { issueFor, issuesOf, type EditorCatalog, type IssueMap } from "../fields/types";
import { Alert, Badge, Button, ButtonLink, PageSkeleton } from "../ui/kit";
import { EditorSelectionContext, focusFirstInput, useSelectionState } from "../stream/editor-context";
import Outline from "../stream/Outline";
import { placement } from "../stream/stream-ops";
import { api, ApiError, errorText } from "../../lib/client/api";
import type { Block } from "../../core/blocks/limits";
import type { EditorInput } from "../../core/fields/define";
import type { FormField } from "../../core/extend/admin";
import type { Collection, ContentItem, Field } from "../../types/content";
import { adminPath, apiPath } from "../../lib/paths";
import { relativeTime } from "../../lib/time";
import { cn } from "../../lib/utils";
import { buildRecordPath } from "../../core/urls/pattern";
import { alignStream, isSyncedStream } from "../../core/i18n/synced";
import { canEditLocale, FieldLanguageNote, LanguagePanel, LanguageSwitcher, type EditorLocalization } from "./LanguagePanel";
import { ReviewPanel } from "./ReviewPanel";

interface Props {
  collection: Collection;
  catalog: EditorCatalog;
  /** Set when editing an existing record. */
  recordId?: string;
}

/** How long typing has to pause before the editor saves on its own. */
const AUTOSAVE_DELAY = 1500;

/** Inputs that need the full width of the form. The rest sit side by side on wide screens. */
const WIDE_INPUTS = new Set<EditorInput>(["richtext", "stream", "json", "code", "gallery", "multiselect", "custom", "unavailable"]);

interface ScheduleEntry {
  at: string;
  failedAt: string | null;
  error: string | null;
}

interface Schedule {
  publish: ScheduleEntry | null;
  unpublish: ScheduleEntry | null;
}

type Tab = "record" | "block" | "outline";

function toLocalInput(value: string | undefined) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

const fromLocalInput = (value: string) => (value ? new Date(value).toISOString() : null);



/** The record's name, edited as a heading at the top of the canvas. */
function TitleInput({ field, label, value, onChange, readOnly, error, onEnter }: { field: Field; label: string; value: unknown; onChange: (value: string) => void; readOnly: boolean; error?: string; onEnter: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const text = typeof value === "string" ? value : "";
  useLayoutEffect(() => {
    if (!ref.current) return;
    ref.current.style.height = "auto";
    ref.current.style.height = `${ref.current.scrollHeight}px`;
  }, [text]);
  return (
    <div data-path={field.name} className="cms-title-field">
      <textarea
        ref={ref}
        id={`field-${field.id}`}
        rows={1}
        aria-label={label}
        aria-invalid={Boolean(error)}
        placeholder={label}
        className="cms-title-input"
        readOnly={readOnly}
        value={text}
        onChange={(event) => onChange(event.target.value.replace(/\n/g, " "))}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); onEnter(); } }}
      />
      {error && <p className="cms-error">{error}</p>}
    </div>
  );
}

function SideSection({ title, children, open = true }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="cms-side-section" open={open}>
      <summary className="cms-side-summary">{title}</summary>
      <div className="cms-side-body">{children}</div>
    </details>
  );
}

/** "body.2.value.title" as "Body › block 3 › title". */
function describePath(path: string, fields: Field[], labelOf: (field: Field) => string) {
  const [first, ...rest] = path.split(".");
  const field = fields.find((item) => item.name === first);
  const parts = [field ? labelOf(field) : first];
  for (let index = 0; index < rest.length; index += 1) {
    if (/^\d+$/.test(rest[index])) parts.push(`block ${Number(rest[index]) + 1}`);
    else if (rest[index] !== "value") parts.push(rest[index]);
  }
  return parts.filter(Boolean).join(" › ");
}

type FieldActionItem = ReturnType<typeof useAdminSlots>["fieldActions"][number];

/** Plugins' buttons by one field, such as writing it with AI. A component of its own, so a plugin's menu keeps its state while the person types. */
function FieldActionBar({ actions, collection, recordId, field, value, values, onChange }: { actions: FieldActionItem[]; collection: Collection; recordId?: string; field: FormField; value: unknown; values: Record<string, unknown>; onChange: (value: unknown) => void }) {
  const word = usePluginWord();
  const context = { collection: { id: collection.id, slug: collection.slug, name: collection.name }, recordId, field, value, values, setValue: onChange };
  return (
    <div className="cms-field-actions">
      {actions.filter((action) => !action.types || action.types.includes(field.type)).map((action) => (
        <PluginBoundary key={`${action.plugin}:${action.id}`} plugin={action.plugin}>
          {action.component ? createElement(action.component, context) : <button type="button" className="cms-field-action" onClick={() => void action.run?.(context)}>{word(action.plugin, `actions.${action.id}`, action.label)}</button>}
        </PluginBoundary>
      ))}
    </div>
  );
}

/** The create and edit form, generated from the collection's fields. Collections with blocks or rich text get a writing canvas. */
export default function RecordForm({ collection, catalog, recordId: initialId }: Props) {
  const { recordPanels } = useAdminClient();
  const { locale: uiLocale } = useAdminLocale();
  const { t } = useT();
  const collectionName = useSchemaText().collection(collection);
  const { label: labelOf } = useFieldText();
  const statusText = (value: string) => (value === "published" || value === "draft" ? t(`editor.status.${value}`) : value);
  const { fieldActions } = useAdminSlots(collection.slug);
  const canRecords = useRecordAccess();
  // Where review is required, people without `record:publish` submit changes instead of publishing them.
  const reviewed = collection.reviewRequired === true;
  const mustSubmit = reviewed && !canRecords("record:publish", collection.id);
  const [reviewVersion, setReviewVersion] = useState(0);
  const router = useRouter();
  // A new record becomes an existing one in place once it is first saved, so typing carries on undisturbed.
  const [recordId, setRecordId] = useState(initialId);
  const createdHere = useRef<string | null>(null);
  const back = adminPath(`/collections/${collection.id}`);
  const [values, setValues] = useState<Record<number, unknown>>({});
  const [status, setStatus] = useState("draft");
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [publishAt, setPublishAt] = useState("");
  const [unpublishAt, setUnpublishAt] = useState("");
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(initialId));
  const [issues, setIssues] = useState<IssueMap>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [autosaveFailed, setAutosaveFailed] = useState(false);
  // Counts edits, so a save that finishes after more typing doesn't mark the newer work as saved.
  const revision = useRef(0);
  const busy = useRef(false);
  // What this editor loaded, so a save can tell whether someone else got there first.
  const [loaded, setLoaded] = useState<{ updatedAt?: string; draftAt: string | null }>({ draftAt: null });
  const [conflict, setConflict] = useState<(() => void) | null>(null);
  // The address the published record had when this editor opened, and where publishing moved it.
  const [liveValues, setLiveValues] = useState<Record<string, unknown>>({});
  const [moved, setMoved] = useState<{ from: string; to: string } | null>(null);
  const [tab, setTab] = useState<Tab>("record");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspector, setInspector] = useState<HTMLElement | null>(null);
  const [, setTick] = useState(0);
  // A localized collection's editor has one language open, named in the address as ?locale=.
  const localizedCollection = collection.localization?.enabled === true;
  const [locale, setLocale] = useState<string | null>(() => (localizedCollection && typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("locale") : null));
  const [localization, setLocalization] = useState<EditorLocalization | null>(null);
  const [translators, setTranslators] = useState<Array<{ name: string; label: string }>>([]);
  const inLocale = (path: string) => (locale ? `${path}${path.includes("?") ? "&" : "?"}locale=${encodeURIComponent(locale)}` : path);
  const isLocalized = (field: Field) => localizedCollection && field.config?.localized === true;

  const blockFields = useMemo(() => new Map(catalog.blockTypes.map((type) => [type.name, { fields: type.fields }])), [catalog.blockTypes]);
  const inputOf = useCallback((field: Pick<Field, "type">): EditorInput => catalog.fieldTypes.find((type) => type.type === field.type)?.input ?? "unavailable", [catalog.fieldTypes]);
  // Writing collections get the canvas. Others, such as settings, stay a plain form.
  const documentMode = collection.fields.some((field) => inputOf(field) === "stream" || inputOf(field) === "richtext");
  const titleField = documentMode ? collection.fields.find((field) => inputOf(field) === "text" && !field.config?.multiline) : undefined;
  const hasStreams = collection.fields.some((field) => inputOf(field) === "stream");

  const showSettings = useCallback(() => { setSidebarOpen(true); setTab("block"); }, []);
  const onSelect = useCallback((id: string | null) => { if (id) setTab("block"); else setTab((current) => (current === "block" ? "record" : current)); }, []);
  const selection = useSelectionState(inspector, onSelect, showSettings);

  useEffect(() => {
    // Small screens start with the canvas alone. Decided after mount, so the server and browser render alike.
    const start = setTimeout(() => { if (window.matchMedia("(max-width: 63.99rem)").matches) setSidebarOpen(false); });
    // Keeps "saved 2 minutes ago" current.
    const timer = setInterval(() => setTick((tick) => tick + 1), 30_000);
    return () => { clearTimeout(start); clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!localizedCollection) return;
    api<{ items: Array<{ name: string; label: string }> }>(apiPath("/translators")).then((result) => setTranslators(result.items), () => setTranslators([]));
    // A new record only needs the languages. An existing one gets them with its values.
    if (!initialId) api<{ localization: EditorLocalization | null }>(inLocale(apiPath(`/collections/${collection.id}/localization`))).then((result) => { setLocalization(result.localization); if (result.localization && !locale) setLocale(result.localization.locale); }, () => setLocalization(null));
    // Once, when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!recordId || createdHere.current === recordId) return;
    let active = true;
    const base = apiPath(`/collections/${collection.id}/content/${recordId}`);
    const withLanguage = (path: string) => (locale ? `${path}${path.includes("?") ? "&" : "?"}locale=${encodeURIComponent(locale)}` : path);
    // The record decides whether the page can load. Drafts and schedules are extras a role may not have.
    // A translation that doesn't exist yet opens empty, ready to write.
    Promise.all([
      api<ContentItem & { localization?: EditorLocalization }>(locale ? withLanguage(`${base}?fallback=none&translate=1`) : base),
      api<{ createdAt: string; values: Array<{ fieldId: number; value: unknown }> } | undefined>(withLanguage(`${base}/draft`)).catch(() => undefined),
      api<Schedule>(withLanguage(`${base}/schedule`)).catch(() => null),
    ]).then(
      ([item, draft, planned]) => {
        if (!active) return;
        setLocalization(item.localization ?? null);
        // Opened without a language: read again in the default one exactly, before showing anything.
        if (item.localization && !locale) return setLocale(item.localization.locale);
        setValues({ ...Object.fromEntries(item.values.map((entry) => [entry.fieldId, entry.value])), ...Object.fromEntries((draft?.values ?? []).map((entry) => [entry.fieldId, entry.value])) });
        setStatus(item.status);
        setLiveValues(Object.fromEntries([["id", item.id], ...item.values.map((entry) => [entry.field.name, entry.value])]));
        setDraftSavedAt(draft?.createdAt ?? null);
        setLoaded({ updatedAt: item.updatedAt, draftAt: draft?.createdAt ?? null });
        setSchedule(planned);
        setPublishAt(toLocalInput(planned?.publish?.at));
        setUnpublishAt(toLocalInput(planned?.unpublish?.at));
        setLoading(false);
      },
      (err) => {
        if (!active) return;
        setError(errorText(err));
        setLoading(false);
      },
    );
    return () => { active = false; };
  }, [collection.id, recordId, locale]);

  // Leaving with unsaved work asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const namedValues = useMemo(() => Object.fromEntries(collection.fields.filter((field) => field.id in values).map((field) => [field.name, values[field.id]])), [collection.fields, values]);
  const base = apiPath(`/collections/${collection.id}/content/${recordId}`);
  // Someone who can't edit the default language, a translator, can't change what every language shares.
  const sharedLocked = Boolean(localization) && !canEditLocale(localization!, localization!.defaultLocale);
  const languageLocked = Boolean(localization) && !canEditLocale(localization!, localization!.locale);
  // Only fields present in the form, so hidden fields this user can't read are left alone. Shared ones stay out when they're locked.
  const formValues = () => collection.fields.filter((field) => (recordId ? field.id in values : true) && !(sharedLocked && !isLocalized(field))).map((field) => ({ fieldId: field.id, value: values[field.id] ?? "" }));
  const setValue = (field: Field, value: unknown) => {
    setValues((current) => ({ ...current, [field.id]: value }));
    revision.current += 1;
    setDirty(true);
    setAutosaveFailed(false);
  };
  /** For plugins' slots: the form's fields by name, and changing them as if typed. Read-only fields on a saved record stay as they are. */
  const formFields = useMemo(() => collection.fields.map((field) => ({ name: field.name, type: field.type, label: labelOf(field), config: (field.config ?? {}) as Record<string, unknown> })), [collection.fields, labelOf]);
  const editable = (field: Field) => !(recordId && field.config?.readonly === true) && !languageLocked && !(sharedLocked && !isLocalized(field));
  const setNamed = (named: Record<string, unknown>) => {
    for (const field of collection.fields) if (Object.hasOwn(named, field.name) && editable(field)) setValue(field, named[field.name]);
  };
  const keep = (item: ContentItem) => setLiveValues(Object.fromEntries([["id", item.id], ...item.values.map((entry) => [entry.field.name, entry.value])]));

  /**
   * `work` receives the versions to check, which are empty when the editor chose to overwrite.
   * A quiet attempt is an autosave: it keeps errors out of the way and only reports a conflict.
   */
  type Expected = { expectedUpdatedAt?: string; expectedDraftAt?: string | null };
  type Options = { overwrite?: boolean; quiet?: boolean; savesValues?: boolean };
  const attempt = async (work: (expected: Expected) => Promise<unknown>, options: Options = {}) => {
    if (busy.current) return;
    const { overwrite = false, quiet = false, savesValues = false } = options;
    const edit = revision.current;
    busy.current = true;
    setSaving(true);
    if (!quiet) {
      setIssues({});
      setError(null);
      setNotice(null);
    }
    setConflict(null);
    try {
      await work(overwrite ? {} : { expectedUpdatedAt: loaded.updatedAt, expectedDraftAt: loaded.draftAt });
      if (savesValues && revision.current === edit) setDirty(false);
      if (savesValues) {
        setAutosaveFailed(false);
        setIssues({});
        setError(null);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === "RECORD_CHANGED") setConflict(() => () => void attempt(work, { ...options, overwrite: true, quiet: false }));
      else if (quiet) setAutosaveFailed(true);
      else {
        setIssues(issuesOf(err));
        setError(errorText(err));
      }
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  /** Saving an existing record stays here, as writing usually continues. So does creating one: the address changes, the editor doesn't. */
  const save = (next: "draft" | "published", quiet = false) => attempt(async ({ expectedUpdatedAt }) => {
    const body = { status: next, values: formValues() };
    if (recordId) {
      const updated = await api<ContentItem>(inLocale(base), { method: "PATCH", body: { ...body, expectedUpdatedAt } });
      setStatus(updated.status);
      setLoaded((current) => ({ ...current, updatedAt: updated.updatedAt }));
      keep(updated);
      if (!quiet) setNotice(next === "published" ? t("editor.published") : t("editor.saved"));
    } else {
      const created = await api<ContentItem>(inLocale(apiPath(`/collections/${collection.id}/content`)), { method: "POST", body });
      const id = String(created.id);
      createdHere.current = id;
      setRecordId(id);
      setStatus(created.status);
      setLoaded({ updatedAt: created.updatedAt, draftAt: null });
      keep(created);
      window.history.replaceState(null, "", inLocale(`${back}/content/${id}`));
      if (!quiet) setNotice(next === "published" ? t("editor.published") : t("editor.saved"));
    }
  }, { quiet, savesValues: true });

  const saveDraftChanges = (quiet = false) => attempt(async (expected) => {
    const draft = await api<{ createdAt: string }>(inLocale(`${base}/draft`), { method: "PUT", body: { values: formValues(), ...expected } });
    setDraftSavedAt(draft.createdAt);
    setLoaded((current) => ({ ...current, draftAt: draft.createdAt }));
    if (!quiet) setNotice(t("editor.draftSaved"));
  }, { quiet, savesValues: true });

  const publishChanges = () => attempt(async (expected) => {
    await api(inLocale(`${base}/draft`), { method: "PUT", body: { values: formValues(), ...expected } });
    const published = await api<ContentItem>(inLocale(`${base}/draft/publish`), { method: "POST" });
    const from = collection.urlPattern ? buildRecordPath(collection.urlPattern, liveValues) : null;
    const to = collection.urlPattern ? buildRecordPath(collection.urlPattern, { ...liveValues, ...namedValues }) : null;
    setDraftSavedAt(null);
    setStatus(published.status);
    setLoaded({ updatedAt: published.updatedAt, draftAt: null });
    keep(published);
    if (from && to && from !== to) setMoved({ from, to });
    else setNotice(t("editor.changesPublished"));
  }, { savesValues: true });

  /** Saves what's in the form as unpublished changes, then asks a reviewer to publish them. */
  const submitForReview = () => attempt(async (expected) => {
    if (published) {
      const draft = await api<{ createdAt: string }>(inLocale(`${base}/draft`), { method: "PUT", body: { values: formValues(), ...expected } });
      setDraftSavedAt(draft.createdAt);
      setLoaded((current) => ({ ...current, draftAt: draft.createdAt }));
    } else {
      const updated = await api<ContentItem>(inLocale(base), { method: "PATCH", body: { status: "draft", values: formValues(), expectedUpdatedAt: expected.expectedUpdatedAt } });
      setLoaded((current) => ({ ...current, updatedAt: updated.updatedAt }));
    }
    await api(inLocale(`${base}/review`), { method: "POST", body: {} });
    setReviewVersion((current) => current + 1);
    setNotice(t("review.submitted"));
  }, { savesValues: true });

  const createRedirect = () => attempt(async () => {
    await api(apiPath("/redirects"), { method: "POST", body: moved });
    router.push(back);
  });

  const discardDraft = () => attempt(async () => {
    await api(inLocale(`${base}/draft`), { method: "DELETE" });
    window.location.reload();
  });

  const unpublish = () => attempt(async () => {
    const updated = await api<ContentItem>(inLocale(base), { method: "PATCH", body: { status: "draft", values: [] } });
    setLoaded((current) => ({ ...current, updatedAt: updated.updatedAt }));
    setStatus("draft");
    setNotice(t("editor.unpublished"));
  });

  const saveSchedule = () => attempt(async () => {
    const planned = await api<Schedule>(inLocale(`${base}/schedule`), { method: "PUT", body: { publishAt: fromLocalInput(publishAt), unpublishAt: fromLocalInput(unpublishAt) } });
    setSchedule(planned);
    setNotice(t("editor.scheduleSaved"));
  });

  /** Opens another language. Unsaved work asks first, since the form then holds that language's values. */
  const switchLocale = (code: string) => {
    if (code === locale) return;
    if (dirty && !window.confirm(t("editor.switchUnsaved"))) return;
    createdHere.current = null;
    setDirty(false);
    setNotice(null);
    setIssues({});
    setError(null);
    if (recordId) setLoading(true);
    setLocale(code);
    setLocalization((current) => (current ? { ...current, locale: code } : current));
    const url = new URL(window.location.href);
    url.searchParams.set("locale", code);
    window.history.replaceState(null, "", url);
  };

  /** Starts a translation from the default language's text, unsaved. */
  const copySource = () => {
    const source = localization?.source?.values;
    if (!source) return;
    for (const field of collection.fields) if (isLocalized(field) && Object.hasOwn(source, field.name) && editable(field)) setValue(field, source[field.name]);
    setNotice(t("editor.copied", { source: localization?.locales.find((entry) => entry.code === localization.source?.locale)?.label ?? localization?.source?.locale ?? "" }));
  };

  /** A machine translation from the default language, put in the form unsaved. */
  const translateWith = (provider: string) => attempt(async () => {
    if (!localization) return;
    const result = await api<{ values: Record<string, unknown> }>(apiPath(`/collections/${collection.id}/content/${recordId}/translate`), { method: "POST", body: { from: localization.defaultLocale, to: localization.locale, provider } });
    setNamed(result.values);
    setNotice(t("editor.translated"));
  });

  const deleteTranslation = (code: string) => attempt(async () => {
    if (!window.confirm(t("editor.confirmDeleteTranslation", { locale: code }))) return;
    await api(apiPath(`/collections/${collection.id}/content/${recordId}/translations/${encodeURIComponent(code)}`), { method: "DELETE" });
    switchLocale(localization?.defaultLocale ?? code);
  });

  const published = Boolean(recordId) && status === "published";
  const saveDraft = (quiet = false) => void (published ? saveDraftChanges(quiet) : save("draft", quiet));
  // Publishing closes any review, so the panel reloads.
  const publish = () => void (published ? publishChanges() : save("published")).then(() => setReviewVersion((current) => current + 1));

  // Saves on its own once typing pauses: a draft, never the published version.
  // A new record with read-only fields waits for a deliberate first save, since saving locks those fields.
  const lockOnCreate = collection.fields.some((field) => field.config?.readonly === true);
  const canAutosave = recordId ? canRecords("record:update", collection.id) : !lockOnCreate && canRecords("record:create", collection.id);
  const autosave = useRef(() => saveDraft(true));
  useEffect(() => { autosave.current = () => saveDraft(true); });
  useEffect(() => {
    if (!dirty || saving || conflict || autosaveFailed || !canAutosave) return;
    const timer = setTimeout(() => autosave.current(), AUTOSAVE_DELAY);
    return () => clearTimeout(timer);
  }, [values, dirty, saving, conflict, autosaveFailed, canAutosave]);

  // Ctrl+S or ⌘S saves a draft, as in most editors.
  const saveRef = useRef(() => saveDraft());
  useEffect(() => { saveRef.current = () => saveDraft(); });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openPreview = async () => {
    // Opened first, or the browser treats a window opened after a request as a popup.
    const tab = window.open("about:blank", "_blank");
    try {
      const { url } = await api<{ url: string }>(inLocale(apiPath(`/collections/${collection.id}/content/${recordId}/preview-token`)), { method: "POST" });
      if (tab) { tab.opener = null; tab.location.href = url; }
    } catch (err) {
      tab?.close();
      setError(errorText(err));
    }
  };

  /** Brings a problem into view: the field, or the block holding it, which then shows its settings. */
  const revealIssue = (path: string) => {
    const find = () => {
      const parts = path.split(".");
      for (let length = parts.length; length > 0; length -= 1) {
        const element = document.querySelector<HTMLElement>(`[data-path="${CSS.escape(parts.slice(0, length).join("."))}"]`);
        if (element) return { element, exact: length === parts.length };
      }
      return null;
    };
    const found = find();
    if (!found) return;
    const block = found.element.closest<HTMLElement>("[data-block-id]");
    if (block?.dataset.blockId) selection.select(block.dataset.blockId);
    if (found.element.closest(".cms-editor-side")) { setSidebarOpen(true); setTab("record"); }
    found.element.scrollIntoView({ block: "center", behavior: "smooth" });
    focusFirstInput(found.element, { canvasOnly: false, attempts: 0 });
    // A block's settings appear only once it's selected, so look again for the field itself.
    if (!found.exact) requestAnimationFrame(() => requestAnimationFrame(() => {
      const again = find();
      if (again?.exact) { again.element.scrollIntoView({ block: "center" }); focusFirstInput(again.element, { canvasOnly: false, attempts: 0 }); }
    }));
  };

  if (loading) {
    return (
      <PageSkeleton kind="form" />
    );
  }

  const shown = collection.fields.filter((field) => isShown(field.config, (name) => namedValues[name]) || issueFor(issues, field.name));
  const placeOf = (field: Field) => (!documentMode ? "canvas" : field === titleField ? "title" : placement(inputOf(field), field.config, "record"));
  const isWide = (field: Field) => WIDE_INPUTS.has(inputOf(field)) || field.config?.multiline === true;
  // A synced stream's translation shows the default language's blocks, in its order, with only their text to write.
  const syncedHere = (field: Field) => Boolean(localization && localization.locale !== localization.defaultLocale && localization.source && isSyncedStream(field));
  const shownField = (field: Field): Field => (syncedHere(field) ? { ...field, config: { ...field.config, fixed: true } } : field);
  const shownValue = (field: Field) => (syncedHere(field) ? alignStream(localization!.source!.values[field.name] ?? null, values[field.id], blockFields) : values[field.id]);
  const fieldInput = (field: Field, variant?: "bare" | "grid") => (
    <div key={field.id} data-path={field.name} className={variant === "bare" ? "cms-canvas-field" : variant === "grid" ? cn("cms-form-cell", isWide(field) && "cms-form-cell-wide") : undefined}>
      {localization && <FieldLanguageNote localization={localization} name={field.name} localized={isLocalized(field)} input={inputOf(field)} />}
      {editable(field) && fieldActions.some((action) => !action.types || action.types.includes(field.type)) && (
        <FieldActionBar actions={fieldActions} collection={collection} recordId={recordId} field={formFields.find((item) => item.name === field.name)!} value={values[field.id]} values={namedValues} onChange={(value) => setValue(field, value)} />
      )}
      <FieldValueInput
        field={shownField(field)}
        input={inputOf(field)}
        value={shownValue(field)}
        onChange={(value) => setValue(field, value)}
        error={field.type === "stream" ? issues[field.name] : issueFor(issues, field.name)}
        catalog={catalog}
        issues={issues}
        issuePath={field.name}
        readOnly={!editable(field)}
      />
    </div>
  );

  const canvasFields = shown.filter((field) => placeOf(field) === "canvas");
  const detailFields = shown.filter((field) => placeOf(field) === "settings");
  const title = titleField && typeof namedValues[titleField.name] === "string" && String(namedValues[titleField.name]).trim();
  const issueList = Object.entries(issues);
  const streams = collection.fields.filter((field) => inputOf(field) === "stream").map((field) => ({ name: field.name, label: labelOf(field), blocks: Array.isArray(values[field.id]) ? (values[field.id] as Block[]) : [] }));
  const address = published && collection.urlPattern ? buildRecordPath(collection.urlPattern, liveValues) : null;

  const saveState = saving ? t("editor.saving") : autosaveFailed ? t("editor.saveFailed") : dirty ? (canAutosave || recordId ? t("editor.unsaved") : t("editor.saveToAutosave")) : draftSavedAt ? t("editor.draftSavedAgo", { when: relativeTime(draftSavedAt, undefined, uiLocale) }) : loaded.updatedAt ? t("editor.savedAgo", { when: relativeTime(loaded.updatedAt, undefined, uiLocale) }) : canAutosave ? t("editor.savesAsYouType") : t("editor.notSavedYet");

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "record", label: collection.type === "singleton" ? t("editor.tabs.settings") : t("editor.tabs.record") },
    ...(documentMode && hasStreams ? [{ id: "block" as const, label: t("editor.tabs.block") }, { id: "outline" as const, label: t("editor.tabs.outline") }] : []),
  ];

  return (
    <EditorSelectionContext.Provider value={selection}>
      <form className="cms-editor-page" onSubmit={(event) => { event.preventDefault(); saveDraft(); }}>
        <header className="cms-editor-bar">
          <Link href={back} className="cms-editor-back" aria-label={t("editor.backTo", { collection: collectionName })} title={t("editor.backTo", { collection: collectionName })}>
            <ArrowLeftIcon className="cms-icon" aria-hidden="true" />
          </Link>
          <div className="cms-editor-heading">
            <span className="cms-editor-crumb">{collectionName}</span>
            <h1 className="cms-editor-title">{title || (recordId ? t("editor.editItem") : t("editor.newItem"))}</h1>
          </div>
          <Badge tone={published ? "success" : "warning"} className="cms-editor-badge">{recordId ? statusText(status) : t("editor.new")}</Badge>
          {autosaveFailed && !saving
            ? <button type="button" className="cms-editor-state cms-editor-state-dirty cms-underline" onClick={() => saveDraft()}>{saveState}</button>
            : <span className={cn("cms-editor-state", dirty && !saving && "cms-editor-state-dirty")} role="status">{saveState}</span>}
          {localization && <LanguageSwitcher localization={localization} onSwitch={switchLocale} disabled={saving} />}
          <div className="cms-editor-actions">
            {recordId && collection.urlPattern && (
              <Button variant="ghost" onClick={() => void openPreview()}><ArrowTopRightOnSquareIcon className="cms-icon" aria-hidden="true" /><span className="cms-hide-sm">{t("editor.preview")}</span></Button>
            )}
            {/* Short labels on small screens. The full name stays the accessible one. */}
            <Button type="submit" variant="secondary" loading={saving} aria-label={published ? t("editor.saveDraftChanges") : t("editor.saveDraft")}>{t("editor.save")}<span className="cms-hide-sm">{published ? t("editor.draftChangesSuffix") : t("editor.draftSuffix")}</span></Button>
            {mustSubmit
              ? recordId && <Button loading={saving} onClick={() => void submitForReview()}>{t("review.submit")}</Button>
              : <Button loading={saving} onClick={publish} aria-label={published ? t("editor.publishChanges") : t("editor.publish")}>{t("editor.publish")}<span className="cms-hide-sm">{published ? t("editor.changesSuffix") : ""}</span></Button>}
            <button type="button" className={cn("cms-icon-btn cms-editor-toggle", sidebarOpen && "cms-editor-toggle-on")} aria-label={sidebarOpen ? t("editor.hideSettings") : t("editor.showSettings")} title={sidebarOpen ? t("editor.hideSettings") : t("editor.showSettings")} aria-expanded={sidebarOpen} aria-controls="cms-editor-side" onClick={() => setSidebarOpen(!sidebarOpen)}>
              <AdjustmentsHorizontalIcon className="cms-icon" aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="cms-editor-alerts">
          {error && (
            <Alert>
              {issueList.length ? t("editor.fieldsNeedAttention", { count: issueList.length }) : error}
              {issueList.length > 0 && (
                <ul className="cms-issue-list">
                  {issueList.slice(0, 8).map(([path, message]) => (
                    <li key={path}><button type="button" className="cms-issue-link" onClick={() => revealIssue(path)}><strong>{describePath(path, collection.fields, labelOf)}</strong>: {message}</button></li>
                  ))}
                  {issueList.length > 8 && <li>{t("editor.andMore", { count: issueList.length - 8 })}</li>}
                </ul>
              )}
            </Alert>
          )}
          {conflict && (
            <Alert kind="warning">
              {t("editor.conflict")}{" "}
              <button type="button" className="cms-medium cms-underline" onClick={() => window.location.reload()}>{t("editor.loadTheirs")}</button>
              {t("editor.or")}
              <button type="button" className="cms-medium cms-underline" onClick={conflict}>{t("editor.keepMine")}</button>
            </Alert>
          )}
          {notice && <Alert kind="success">{notice}</Alert>}
          {moved && (
            <Alert kind="warning">
              {t("editor.moved", { from: moved.from, to: moved.to })}{" "}
              <button type="button" className="cms-medium cms-underline" onClick={() => void createRedirect()}>{t("editor.redirectOld")}</button>
              {t("editor.or")}
              <button type="button" className="cms-medium cms-underline" onClick={() => setMoved(null)}>{t("editor.leaveIt")}</button>
            </Alert>
          )}
        </div>

        <div className={cn("cms-editor-layout", sidebarOpen && "cms-editor-layout-side")}>
          <div className={cn("cms-editor-canvas", !documentMode && "cms-editor-canvas-form")} lang={localization?.locale} dir={localization?.locales.find((entry) => entry.code === localization.locale)?.direction} onPointerDown={(event) => { if (event.target === event.currentTarget) selection.select(null); }}>
            {documentMode ? (
              <div className="cms-canvas">
                {titleField && shown.includes(titleField) && (
                  <TitleInput
                    label={labelOf(titleField)}
                    field={titleField}
                    value={values[titleField.id]}
                    onChange={(value) => setValue(titleField, value)}
                    readOnly={!editable(titleField)}
                    error={issueFor(issues, titleField.name)}
                    onEnter={() => focusFirstInput(document.querySelector(".cms-canvas-field"), { canvasOnly: false })}
                  />
                )}
                {canvasFields.map((field) => fieldInput(field, "bare"))}
              </div>
            ) : (
              <section className="cms-form-grid">{canvasFields.map((field) => fieldInput(field, "grid"))}</section>
            )}
          </div>

          {sidebarOpen && <div className="cms-editor-scrim" aria-hidden="true" onClick={() => setSidebarOpen(false)} />}
          <aside id="cms-editor-side" className="cms-editor-side" aria-label={t("editor.tabs.settings")} hidden={!sidebarOpen}>
            {tabs.length > 1 && (
              <div className="cms-side-tabs" role="tablist" aria-label={t("editor.tabs.settings")}>
                {tabs.map((item) => (
                  <button key={item.id} type="button" role="tab" id={`editor-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`editor-panel-${item.id}`} className={cn("cms-side-tab", tab === item.id && "cms-side-tab-active")} onClick={() => setTab(item.id)}>
                    {item.label}
                  </button>
                ))}
              </div>
            )}

            <div role="tabpanel" id="editor-panel-record" aria-labelledby="editor-tab-record" hidden={tab !== "record"}>
              <SideSection title={t("editor.sections.status")}>
                <dl className="cms-facts">
                  <div><dt>{t("editor.statusLabel")}</dt><dd><Badge tone={published ? "success" : "warning"}>{recordId ? statusText(status) : t("editor.notSaved")}</Badge></dd></div>
                  {loaded.updatedAt && <div><dt>{t("editor.lastSaved")}</dt><dd title={new Date(loaded.updatedAt).toLocaleString()}>{relativeTime(loaded.updatedAt, undefined, uiLocale)}</dd></div>}
                  {address && <div><dt>{t("editor.address")}</dt><dd className="cms-mono cms-text-xs cms-truncate" title={address}>{address}</dd></div>}
                </dl>
                {draftSavedAt && (
                  <div className="cms-side-note">
                    <ExclamationTriangleIcon className="cms-icon cms-caution cms-no-shrink" aria-hidden="true" />
                    <span>{t("editor.unpublishedChanges", { when: relativeTime(draftSavedAt, undefined, uiLocale) })} <button type="button" className="cms-underline cms-medium" onClick={() => void discardDraft()}>{t("editor.discardThem")}</button></span>
                  </div>
                )}
                {recordId && <div className="cms-row cms-wrap cms-gap-2">
                  <ButtonLink variant="secondary" href={inLocale(`${back}/content/${recordId}/history`)}><ClockIcon className="cms-icon" aria-hidden="true" />{t("editor.history")}</ButtonLink>
                  {published && !mustSubmit && <Button variant="secondary" loading={saving} onClick={() => void unpublish()}>{t("editor.unpublish")}</Button>}
                </div>}
              </SideSection>

              {recordId && reviewed && (
                <SideSection title={t("review.title")}>
                  <ReviewPanel path={inLocale(`${base}/review`)} version={reviewVersion} canReview={!mustSubmit} busy={saving} onChanged={() => setReviewVersion((current) => current + 1)} />
                </SideSection>
              )}

              {localization && (
                <SideSection title={t("editor.sections.languages")}>
                  <LanguagePanel localization={localization} recordId={recordId} busy={saving} translators={recordId ? translators : []} onSwitch={switchLocale} onCopySource={copySource} onTranslate={(provider) => void translateWith(provider)} onDeleteTranslation={(code) => void deleteTranslation(code)} />
                </SideSection>
              )}

              {detailFields.length > 0 && <SideSection title={t("editor.sections.details")}><div className="cms-stack-4">{detailFields.map((field) => fieldInput(field))}</div></SideSection>}

              {recordId && !mustSubmit && (
                <SideSection title={t("editor.sections.schedule")} open={Boolean(schedule?.publish || schedule?.unpublish)}>
                  <p className="cms-hint">{t("editor.scheduleHint")}</p>
                  {([[t("editor.publishAt"), publishAt, setPublishAt, schedule?.publish], [t("editor.unpublishAt"), unpublishAt, setUnpublishAt, schedule?.unpublish]] as const).map(([label, value, set, entry]) => (
                    <div key={label}>
                      <label htmlFor={`schedule-${label}`} className="cms-label">{label}</label>
                      <input id={`schedule-${label}`} type="datetime-local" className="cms-input cms-mt-1" value={value} onChange={(e) => set(e.target.value)} />
                      {entry?.failedAt && <p className="cms-error cms-mt-1">{t("editor.failed", { error: entry.error ?? "" })}</p>}
                    </div>
                  ))}
                  {(issues.publishAt || issues.unpublishAt) && <p className="cms-error">{issues.publishAt ?? issues.unpublishAt}</p>}
                  <div><Button variant="secondary" loading={saving} onClick={() => void saveSchedule()}>{t("editor.saveSchedule")}</Button></div>
                </SideSection>
              )}

              {recordPanels.map(({ id, plugin, component: Panel }) => <div key={id} className="cms-side-plugin"><PluginBoundary plugin={plugin}><Panel collection={collection} recordId={recordId} status={status} values={namedValues} fields={formFields.filter((field) => !recordId || field.name in namedValues)} setValues={(named) => setNamed(named)} /></PluginBoundary></div>)}
            </div>

            <div role="tabpanel" id="editor-panel-block" aria-labelledby="editor-tab-block" hidden={tab !== "block"} className="cms-side-pad">
              <div ref={setInspector} />
              {!selection.selected && <p className="cms-muted">{t("editor.selectBlock")}</p>}
            </div>

            <div role="tabpanel" id="editor-panel-outline" aria-labelledby="editor-tab-outline" hidden={tab !== "outline"} className="cms-side-pad">
              <Outline streams={streams} catalog={catalog} issues={Object.keys(issues)} />
            </div>
          </aside>
        </div>
      </form>
    </EditorSelectionContext.Provider>
  );
}
