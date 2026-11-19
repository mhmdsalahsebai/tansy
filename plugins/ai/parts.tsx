"use client";

import type { UIMessage } from "ai";
import { useT } from "tansy/admin";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Markdown } from "./markdown";
import { PictureCard } from "./attach";

/* The assistant's smaller pieces: icons, copy buttons, code, thinking and tool calls. */

export type Part = UIMessage["parts"][number];
export type ToolPart = Extract<Part, { type: "dynamic-tool" }>;
export type ReasoningPart = Extract<Part, { type: "reasoning" }>;
export type T = ReturnType<typeof useT>["t"];

/* Icons, drawn on a 16 by 16 box with the current text colour. */
export const Icon = ({ children, className }: { children: ReactNode; className?: string }) => (
  <svg className={`ai-icon ${className ?? ""}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
export const Spark = ({ className }: { className?: string }) => (
  <svg className={`ai-icon ${className ?? ""}`} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.25a.75.75 0 0 1 .72.54l.9 3.06a2.25 2.25 0 0 0 1.53 1.53l3.06.9a.75.75 0 0 1 0 1.44l-3.06.9a2.25 2.25 0 0 0-1.53 1.53l-.9 3.06a.75.75 0 0 1-1.44 0l-.9-3.06a2.25 2.25 0 0 0-1.53-1.53l-3.06-.9a.75.75 0 0 1 0-1.44l3.06-.9a2.25 2.25 0 0 0 1.53-1.53l.9-3.06A.75.75 0 0 1 8 1.25Z" /></svg>
);
export const ArrowUp = () => <Icon><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></Icon>;
export const ArrowDown = () => <Icon><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" /></Icon>;
export const StopSquare = () => <svg className="ai-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.5" /></svg>;
export const Plus = () => <Icon><path d="M8 3v10M3 8h10" /></Icon>;
export const Copy = () => <Icon><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" /></Icon>;
export const Check = () => <Icon><path d="m3.5 8.5 3 3 6-7" /></Icon>;
export const Cross = () => <Icon><path d="m4.5 4.5 7 7M11.5 4.5l-7 7" /></Icon>;
export const Retry = () => <Icon><path d="M2.75 8a5.25 5.25 0 1 0 1.6-3.77M2.75 2.75v2.5h2.5" /></Icon>;
export const Chevron = ({ open }: { open: boolean }) => <Icon className={open ? "ai-chevron ai-chevron-open" : "ai-chevron"}><path d="m6 4 4 4-4 4" /></Icon>;
export const ChevronDown = () => <Icon className="ai-caret"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" /></Icon>;
export const Pause = () => <Icon><path d="M6 4.5v7M10 4.5v7" /></Icon>;
export const Trash = () => <Icon><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1" /></Icon>;
export const Search = () => <Icon><circle cx="7" cy="7" r="4.25" /><path d="m10.25 10.25 3.25 3.25" /></Icon>;
export const Panel = () => <Icon><rect x="2" y="2.75" width="12" height="10.5" rx="2" /><path d="M6 2.75v10.5" /></Icon>;
export const Brain = () => <Icon><path d="M6 13.25V2.75M6 2.75a2.25 2.25 0 0 0-2.25 2.25 2 2 0 0 0-1.25 3 2.25 2.25 0 0 0 1.5 3.5A2 2 0 0 0 6 13.25M10 13.25V2.75M10 2.75A2.25 2.25 0 0 1 12.25 5a2 2 0 0 1 1.25 3 2.25 2.25 0 0 1-1.5 3.5A2 2 0 0 1 10 13.25" /></Icon>;
export const Shield = () => <Icon><path d="M8 1.75 13 3.75v4c0 3-2.1 5.4-5 6.5-2.9-1.1-5-3.5-5-6.5v-4L8 1.75Z" /></Icon>;
export const Cube = () => <Icon><path d="M8 1.75 13.5 4.75v6.5L8 14.25l-5.5-3v-6.5L8 1.75ZM2.5 4.75 8 7.75l5.5-3M8 7.75v6.5" /></Icon>;

/** Closes a menu on Escape or a click outside it. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) close(); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); close(); } };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [ref, open, close]);
}

/** A button that copies text, and says so for a moment. */
export function CopyButton({ text, label }: { text: string; label?: boolean }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const name = copied ? t("ext.ai.assistant.copied") : t("ext.ai.assistant.copy");
  return (
    <button type="button" className="ai-ghost" aria-label={name} title={name} onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined)}>
      {copied ? <Check /> : <Copy />}{label && <span>{name}</span>}
    </button>
  );
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  return (
    <div className="ai-code">
      <div className="ai-code-head"><span>{language}</span><CopyButton text={code} label /></div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

export const renderCode = (code: string, language: string, key: string) => <CodeBlock key={key} code={code} language={language} />;

/** What the model thought before answering: one quiet line, open while it thinks, folded once it's done. */
export function Thinking({ part }: { part: ReasoningPart }) {
  const { t } = useT();
  const active = part.state === "streaming";
  const [open, setOpen] = useState<boolean | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const shown = open ?? active;
  // While it streams, keep its latest lines in view inside the folded box.
  useEffect(() => { if (active && body.current) body.current.scrollTop = body.current.scrollHeight; }, [active, part.text]);
  if (!part.text.trim() && !active) return null;
  return (
    <div className={`ai-thinking${active ? " ai-thinking-active" : ""}`}>
      <button type="button" className="ai-thinking-head" aria-expanded={shown} onClick={() => setOpen(!shown)}>
        <Brain />
        <span>{active ? t("ext.ai.assistant.thinking") : t("ext.ai.assistant.thought")}</span>
        <Chevron open={shown} />
      </button>
      {shown && <div ref={body} className="ai-thinking-body">{part.text}</div>}
    </div>
  );
}

const VERBS = new Set(["generate_image", "create_record", "update_record", "delete_record", "list_records", "get_record", "list_collections", "describe_collection"]);

/** "lms_create_course" as "Lms create course", for tools without a verb in the messages. */
const titleOf = (t: T, name: string) => (VERBS.has(name) ? t(`ext.ai.tool.verbs.${name}`) : `${name.charAt(0).toUpperCase()}${name.slice(1).replaceAll("_", " ")}`);

function summaryOf(t: T, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const value = input as Record<string, unknown>;
  const data = (value.data && typeof value.data === "object" ? value.data : value) as Record<string, unknown>;
  const name = [data.title, data.name].find((item) => typeof item === "string" && item);
  return [typeof value.collection === "string" ? t("ext.ai.tool.in", { collection: value.collection }) : "", typeof value.id === "number" ? `#${value.id}` : "", name ? `“${String(name)}”` : ""].filter(Boolean).join(" ");
}

export function ToolCard({ part, respond }: { part: ToolPart; respond: (id: string, approved: boolean) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const failed = part.state === "output-error" || (part.state === "output-available" && Boolean((part.output as { error?: unknown } | null)?.error));
  const asking = part.state === "approval-requested";
  const state = asking ? "ask" : part.state === "output-denied" ? "denied" : failed ? "failed" : part.state === "output-available" ? "done" : "working";
  const status = t(`ext.ai.tool.${asking ? "waiting" : state === "denied" ? "notDone" : state}`);
  const error = part.state === "output-error" ? part.errorText : failed ? String((part.output as { error?: { message?: string } }).error?.message ?? "") : "";
  const hasDetails = part.input !== undefined;
  return (
    <div className={`ai-tool ai-tool-${state}`}>
      <button type="button" className="ai-tool-head" aria-expanded={open} disabled={!hasDetails} onClick={() => setOpen(!open)}>
        <span className="ai-tool-mark">{state === "working" ? <span className="ai-spinner" /> : state === "done" ? <Check /> : state === "failed" || state === "denied" ? <Cross /> : <Pause />}</span>
        <span className="ai-tool-title">{titleOf(t, part.toolName)} <span className="ai-tool-summary">{summaryOf(t, part.input)}</span></span>
        <span className="ai-tool-status">{status}</span>
        {hasDetails && <Chevron open={open} />}
      </button>
      {error && <p className="ai-tool-error">{error}</p>}
      {open && <pre className="ai-tool-detail">{JSON.stringify({ input: part.input, ...(part.state === "output-available" ? { result: part.output } : {}) }, null, 2)}</pre>}
      {asking && !part.approval.isAutomatic && (
        <div className="ai-tool-actions">
          <button type="button" className="ai-btn ai-btn-primary" onClick={() => respond(part.approval.id, true)}><Check />{t("ext.ai.tool.approve")}</button>
          <button type="button" className="ai-btn" onClick={() => respond(part.approval.id, false)}>{t("ext.ai.tool.deny")}</button>
        </div>
      )}
    </div>
  );
}

export const textOf = (message: UIMessage) => message.parts.map((part) => (part.type === "text" ? part.text : "")).filter(Boolean).join("\n\n");

/** One answer's parts, in the order they came. */
export function AnswerParts({ message, respond }: { message: UIMessage; respond: (id: string, approved: boolean) => void }) {
  return (
    <>
      {message.parts.map((part, at) => {
        if (part.type === "text") return part.text ? <div key={at} className="ai-prose"><Markdown text={part.text} renderCode={renderCode} /></div> : null;
        if (part.type === "reasoning") return <Thinking key={at} part={part} />;
        if (part.type === "dynamic-tool" && part.toolName === "generate_image" && part.state !== "approval-requested" && part.state !== "output-denied") return <PictureCard key={part.toolCallId} part={part} />;
        if (part.type === "dynamic-tool") return <ToolCard key={part.toolCallId} part={part} respond={respond} />;
        return null;
      })}
    </>
  );
}
