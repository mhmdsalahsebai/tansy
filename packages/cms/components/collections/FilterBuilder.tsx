"use client";

import { FunnelIcon, PlusIcon, XMarkIcon } from "@heroicons/react/16/solid";
import { useEffect, useRef, useState } from "react";
import type { FieldTypeInfo } from "../fields/types";
import type { Field } from "../../types/content";
import { Button, Input } from "../ui/kit";
import { useFieldText, useT } from "../i18n";

/** What a condition does, in words. Each becomes one comparison in the filter expression. */
type Op = "is" | "isNot" | "contains" | "notContains" | "gt" | "lt" | "empty" | "notEmpty" | "includes";

type Kind = "text" | "number" | "date" | "boolean" | "choice" | "choices" | "status";

export interface Condition { field: string; op: Op; value: string }

interface Target { name: string; label: string; kind: Kind; options?: Array<{ value: string; label: string }>; allowed?: string[] }

const OPS: Record<Kind, Op[]> = {
  text: ["contains", "notContains", "is", "isNot", "empty", "notEmpty"],
  number: ["is", "isNot", "gt", "lt", "empty", "notEmpty"],
  date: ["gt", "lt", "is", "empty", "notEmpty"],
  boolean: ["is"],
  choice: ["is", "isNot", "empty", "notEmpty"],
  choices: ["includes", "empty", "notEmpty"],
  status: ["is", "isNot"],
};

/** The expression operator each condition needs, so a type that limits operators only offers what it takes. */
const SYMBOL: Record<Op, string> = { is: "=", isNot: "!=", contains: "~", notContains: "!~", gt: ">", lt: "<", empty: "=", notEmpty: "!=", includes: "?=" };

const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function kindOf(input: string | undefined): Kind | null {
  switch (input) {
    case "text": case "email": case "url": case "code": return "text";
    case "number": return "number";
    case "date": case "datetime": return "date";
    case "boolean": return "boolean";
    case "select": return "choice";
    case "multiselect": return "choices";
    case "reference": return "number";
    default: return null;
  }
}

function literal(target: Target, value: string) {
  if (target.kind === "number") return String(Number(value) || 0);
  if (target.kind === "boolean") return value === "true" ? "true" : "false";
  // A date compares as text, and the stored form is ISO, which sorts in time order.
  return quote(value);
}

/** One comparison, or a pair for "is empty", which covers both a missing value and an empty one. */
function clause(target: Target, condition: Condition) {
  const name = target.name;
  if (condition.op === "empty") return target.kind === "text" ? `(${name} = null || ${name} = "")` : `${name} = null`;
  if (condition.op === "notEmpty") return target.kind === "text" ? `(${name} != null && ${name} != "")` : `${name} != null`;
  if (target.kind === "date" && condition.op === "is") return `(${name} >= ${quote(condition.value)} && ${name} < ${quote(`${condition.value}T23:59:59.999Z`)})`;
  return `${name} ${SYMBOL[condition.op]} ${literal(target, condition.value)}`;
}

export function buildFilter(targets: Target[], conditions: Condition[], match: "all" | "any") {
  const parts = conditions.flatMap((condition) => {
    const target = targets.find((candidate) => candidate.name === condition.field);
    const needsValue = condition.op !== "empty" && condition.op !== "notEmpty";
    return target && (!needsValue || condition.value !== "") ? [clause(target, condition)] : [];
  });
  return parts.join(match === "all" ? " && " : " || ");
}

const needsValue = (op: Op) => op !== "empty" && op !== "notEmpty";

/**
 * Filters for a record list built by picking: a field, what to check, and a value. Each
 * condition shows as a chip that removes it. The expression the API takes is built from them,
 * and people who write expressions can still type one under Advanced.
 */
export function FilterBuilder({ fields, fieldTypes, onChange }: { fields: Field[]; fieldTypes: FieldTypeInfo[]; onChange: (filter: string) => void }) {
  const { t } = useT();
  const { label: fieldLabel } = useFieldText();
  const [open, setOpen] = useState(false);
  const [conditions, setConditions] = useState<Condition[]>([]);
  const [draft, setDraft] = useState<Condition[]>([]);
  const [match, setMatch] = useState<"all" | "any">("all");
  const [advanced, setAdvanced] = useState("");
  const [expression, setExpression] = useState("");
  const root = useRef<HTMLDivElement>(null);

  const targets: Target[] = [
    { name: "status", label: t("filters.status"), kind: "status", options: [{ value: "published", label: t("editor.status.published") }, { value: "draft", label: t("editor.status.draft") }] },
    ...fields.flatMap((field): Target[] => {
      if (field.config?.hidden) return [];
      const type = fieldTypes.find((candidate) => candidate.type === field.type);
      const kind = kindOf(type?.input);
      if (!kind || (type?.operators && type.operators.length === 0)) return [];
      const options = Array.isArray(field.config?.options) ? (field.config.options as Array<{ value: string; label: string }>).map((option) => ({ value: option.value, label: option.label || option.value })) : undefined;
      return [{ name: field.name, label: fieldLabel(field), kind, options, allowed: type?.operators }];
    }),
    { name: "updatedAt", label: t("filters.updated"), kind: "date" },
    { name: "createdAt", label: t("filters.created"), kind: "date" },
  ];
  const opsFor = (target: Target) => OPS[target.kind].filter((op) => !target.allowed || target.allowed.includes(SYMBOL[op]));
  const targetOf = (name: string) => targets.find((target) => target.name === name) ?? targets[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", close); };
  }, [open]);

  const blank = (name = targets[1]?.name ?? "status"): Condition => {
    const target = targetOf(name);
    return { field: target.name, op: opsFor(target)[0], value: target.kind === "boolean" ? "true" : target.options?.[0]?.value ?? "" };
  };
  const commit = (next: Condition[], nextMatch = match, nextAdvanced = advanced) => {
    setConditions(next);
    setMatch(nextMatch);
    setAdvanced(nextAdvanced);
    const built = buildFilter(targets, next, nextMatch);
    const combined = [built && (next.length > 1 ? `(${built})` : built), nextAdvanced.trim() && `(${nextAdvanced.trim()})`].filter(Boolean).join(" && ");
    onChange(combined);
  };
  const openPanel = () => {
    setDraft(conditions.length ? conditions : [blank()]);
    setExpression(advanced);
    setOpen(!open);
  };
  const setRow = (index: number, change: Partial<Condition>) => setDraft(draft.map((row, at) => {
    if (at !== index) return row;
    if (change.field && change.field !== row.field) return blank(change.field);
    return { ...row, ...change };
  }));

  const chipText = (condition: Condition) => {
    const target = targetOf(condition.field);
    const shown = target.options?.find((option) => option.value === condition.value)?.label ?? (target.kind === "boolean" ? (condition.value === "true" ? t("grid.yes") : t("grid.no")) : condition.value);
    return `${target.label} ${t(`filters.ops.${condition.op}`)}${needsValue(condition.op) ? ` ${shown}` : ""}`;
  };
  const active = conditions.length + (advanced.trim() ? 1 : 0);

  return (
    <div className="cms-filter" ref={root}>
      <Button variant="secondary" aria-expanded={open} aria-haspopup="dialog" onClick={openPanel}>
        <FunnelIcon className="cms-icon" aria-hidden="true" />{t("filters.filter")}
        {active > 0 && <span className="cms-filter-count">{active}</span>}
      </Button>
      {conditions.map((condition, index) => (
        <span key={index} className="cms-filter-chip">
          {index > 0 && <span className="cms-faded">{t(`filters.join.${match}`)}</span>}
          <span className="cms-truncate">{chipText(condition)}</span>
          <button type="button" className="cms-filter-chip-remove" aria-label={t("filters.remove", { condition: chipText(condition) })} onClick={() => commit(conditions.filter((_, at) => at !== index))}>
            <XMarkIcon className="cms-icon-xs" aria-hidden="true" />
          </button>
        </span>
      ))}
      {advanced.trim() && (
        <span className="cms-filter-chip">
          <span className="cms-mono cms-truncate">{advanced}</span>
          <button type="button" className="cms-filter-chip-remove" aria-label={t("filters.removeAdvanced")} onClick={() => commit(conditions, match, "")}>
            <XMarkIcon className="cms-icon-xs" aria-hidden="true" />
          </button>
        </span>
      )}
      {active > 1 && <button type="button" className="cms-link-btn cms-text-sm" onClick={() => commit([], match, "")}>{t("filters.clear")}</button>}

      {open && (
        <div className="cms-popover cms-filter-panel" role="dialog" aria-label={t("filters.title")}>
          <form className="cms-stack-3" onSubmit={(event) => { event.preventDefault(); commit(draft.filter((row) => !needsValue(row.op) || row.value !== ""), match, expression); setOpen(false); }}>
            {draft.length > 1 && (
              <label className="cms-row cms-gap-2 cms-text-sm">
                {t("filters.matchPrefix")}
                <select className="cms-input cms-input-auto" value={match} onChange={(event) => setMatch(event.target.value as "all" | "any")}>
                  <option value="all">{t("filters.matchAll")}</option>
                  <option value="any">{t("filters.matchAny")}</option>
                </select>
                {t("filters.matchSuffix")}
              </label>
            )}
            {draft.map((row, index) => {
              const target = targetOf(row.field);
              return (
                <div key={index} className="cms-filter-row">
                  <select aria-label={t("filters.field")} className="cms-input" value={row.field} onChange={(event) => setRow(index, { field: event.target.value })}>
                    {targets.map((candidate) => <option key={candidate.name} value={candidate.name}>{candidate.label}</option>)}
                  </select>
                  <select aria-label={t("filters.condition")} className="cms-input" value={row.op} onChange={(event) => setRow(index, { op: event.target.value as Op })}>
                    {opsFor(target).map((op) => <option key={op} value={op}>{t(target.kind === "date" && (op === "gt" || op === "lt") ? `filters.ops.${op === "gt" ? "after" : "before"}` : `filters.ops.${op}`)}</option>)}
                  </select>
                  {needsValue(row.op) && <ValueInput target={target} value={row.value} onChange={(value) => setRow(index, { value })} />}
                  <button type="button" className="cms-icon-btn" aria-label={t("filters.removeRow")} onClick={() => setDraft(draft.filter((_, at) => at !== index))}>
                    <XMarkIcon className="cms-icon" aria-hidden="true" />
                  </button>
                </div>
              );
            })}
            <div>
              <button type="button" className="cms-link-btn cms-text-sm cms-inline-row cms-gap-1" onClick={() => setDraft([...draft, blank()])}>
                <PlusIcon className="cms-icon-xs" aria-hidden="true" />{t("filters.add")}
              </button>
            </div>
            <details className="cms-filter-advanced" open={Boolean(expression)}>
              <summary className="cms-text-sm cms-muted">{t("filters.advanced")}</summary>
              <Input className="cms-mono cms-mt-2" aria-label={t("filters.expression")} placeholder={t("grid.filterPlaceholder")} value={expression} onChange={(event) => setExpression(event.target.value)} />
              <p className="cms-hint cms-mt-1">{t("filters.advancedHint")}</p>
            </details>
            <div className="cms-row cms-gap-2 cms-end">
              <Button variant="ghost" onClick={() => { setDraft([]); setExpression(""); }}>{t("filters.reset")}</Button>
              <Button type="submit">{t("filters.apply")}</Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function ValueInput({ target, value, onChange }: { target: Target; value: string; onChange: (value: string) => void }) {
  const { t } = useT();
  if (target.kind === "boolean") {
    return (
      <select aria-label={t("filters.value")} className="cms-input" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="true">{t("grid.yes")}</option>
        <option value="false">{t("grid.no")}</option>
      </select>
    );
  }
  if (target.options) {
    return (
      <select aria-label={t("filters.value")} className="cms-input" value={value} onChange={(event) => onChange(event.target.value)}>
        {target.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }
  return <Input aria-label={t("filters.value")} type={target.kind === "number" ? "number" : target.kind === "date" ? "date" : "text"} placeholder={t("filters.valuePlaceholder")} value={value} onChange={(event) => onChange(event.target.value)} />;
}
