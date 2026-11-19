"use client";

import { useT } from "../i18n";
import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import { ChevronDownIcon, ChevronLeftIcon, ChevronUpIcon, MagnifyingGlassIcon } from "@heroicons/react/16/solid";
import Link from "next/link";
import { useId, useState } from "react";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, InputHTMLAttributes, KeyboardEvent, ReactNode } from "react";
import { cn } from "../../lib/utils";
import { useRowLink } from "./row-link";

const variants = {
  primary: "cms-btn-primary",
  secondary: "cms-btn-secondary",
  danger: "cms-btn-danger",
  ghost: "cms-btn-ghost",
};

export function Button({ variant = "primary", loading, className, children, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof variants; loading?: boolean }) {
  const { t } = useT();
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || loading}
      className={cn("cms-btn", variants[variant], className)}
    >
      {loading ? t("common.working") : children}
    </button>
  );
}

/**
 * A link that looks like a button, for actions that go somewhere: "New item", "Settings".
 * `native` makes it a plain anchor, for downloads and pages outside the app's router.
 */
export function ButtonLink({ href, variant = "primary", native, className, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; variant?: keyof typeof variants; native?: boolean }) {
  const classes = cn("cms-btn", variants[variant], className);
  if (native || props.download !== undefined || props.target) return <a {...props} href={href} className={classes}>{children}</a>;
  return <Link {...props} href={href} className={classes}>{children}</Link>;
}

const tones = {
  neutral: "",
  accent: "cms-badge-accent",
  success: "cms-badge-success",
  warning: "cms-badge-warning",
  danger: "cms-badge-danger",
  info: "cms-badge-info",
};

export type BadgeTone = keyof typeof tones;

/** A short status or category label. Pick the tone by meaning: success for live, warning for draft, danger for failed. */
export function Badge({ tone = "neutral", tight, href, title, className, children }: { tone?: BadgeTone; tight?: boolean; href?: string; title?: string; className?: string; children: ReactNode }) {
  const classes = cn("cms-badge", tones[tone], tight && "cms-badge-tight", className);
  return href ? <Link href={href} title={title} className={classes}>{children}</Link> : <span title={title} className={classes}>{children}</span>;
}

/** A search box with its icon, for the start of a toolbar. Give it an aria-label. */
export function SearchInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={cn("cms-search", className)}>
      <MagnifyingGlassIcon className="cms-search-icon" aria-hidden="true" />
      <input type="search" {...props} className="cms-input" />
    </div>
  );
}

/** The row above a list: search and filters first, then `end`, the actions, pushed to the far side. */
export function Toolbar({ children, end }: { children?: ReactNode; end?: ReactNode }) {
  return (
    <div className="cms-toolbar">
      {children}
      {end && <div className="cms-toolbar-end">{end}</div>}
    </div>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn("cms-input", className)} />;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="cms-block">
      <span className="cms-label cms-mb-1">{label}</span>
      {children}
      {hint && <span className="cms-hint cms-mt-1 cms-block">{hint}</span>}
    </label>
  );
}

/**
 * The surface every section of a page sits on. `toolbar` is a row under the header, such as a
 * search with filters. `flush` drops the body's padding for a table, list or timeline that runs edge to edge.
 */
export function Card({ title, description, actions, toolbar, flush, children }: { title?: string; description?: string; actions?: ReactNode; toolbar?: ReactNode; flush?: boolean; children: ReactNode }) {
  return (
    <section className="cms-panel">
      {(title || actions) && (
        <header className="cms-card-header">
          <div className="cms-min-0">
            {title && <h2 className="cms-card-title">{title}</h2>}
            {description && <p className="cms-muted cms-mt-1">{description}</p>}
          </div>
          {actions && <div className="cms-row cms-gap-2 cms-no-shrink">{actions}</div>}
        </header>
      )}
      {toolbar}
      <div className={cn("cms-card-body", flush && "cms-card-flush")}>{children}</div>
    </section>
  );
}

const alerts = {
  error: "cms-alert-error",
  success: "cms-alert-success",
  warning: "cms-alert-warning",
  info: "cms-alert-info",
};

export function Alert({ kind = "error", children }: { kind?: keyof typeof alerts; children: ReactNode }) {
  return <div role="alert" className={cn("cms-alert", alerts[kind])}>{children}</div>;
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  return (
    <Dialog open={open} onClose={onClose} className="cms-modal">
      <div className="cms-modal-backdrop" aria-hidden="true" />
      <div className="cms-modal-frame">
        <DialogPanel className="cms-modal-panel">
          <DialogTitle className="cms-section-title cms-mb-4">{title}</DialogTitle>
          {children}
        </DialogPanel>
      </div>
    </Dialog>
  );
}

/**
 * The top of every dashboard page: an optional way back, the title, a line of description or
 * `meta` (counts, quiet links), and the page's actions on the far side, the primary one last.
 */
export function PageHeader({ title, description, actions, back, meta }: { title: string; description?: string; actions?: ReactNode; back?: { href: string; label: string }; meta?: ReactNode }) {
  return (
    <div className="cms-page-header">
      <div>
        {back && <Link href={back.href} className="cms-page-back"><ChevronLeftIcon className="cms-icon cms-flip-rtl" aria-hidden="true" />{back.label}</Link>}
        <h1 className="cms-page-title">{title}</h1>
        {description && <p className="cms-muted cms-mt-1">{description}</p>}
        {meta && <div className="cms-page-meta">{meta}</div>}
      </div>
      {actions && <div className="cms-page-actions">{actions}</div>}
    </div>
  );
}

export interface TabItem {
  id: string;
  label: ReactNode;
  /** A short note beside the label, such as "In use" or a count. */
  badge?: ReactNode;
  content: ReactNode;
}

/**
 * Tabs that switch panels in place, with arrow-key movement between them as the ARIA
 * tabs pattern describes. `variant="pills"` suits a choice inside a card, such as providers.
 */
export function Tabs({ label, tabs, value, onChange, defaultTab, variant = "line", className }: { label: string; tabs: TabItem[]; value?: string; onChange?: (id: string) => void; defaultTab?: string; variant?: "line" | "pills"; className?: string }) {
  const [own, setOwn] = useState(defaultTab ?? tabs[0]?.id);
  const base = useId();
  const current = tabs.some((tab) => tab.id === (value ?? own)) ? (value ?? own) : tabs[0]?.id;
  const select = (id: string) => { setOwn(id); onChange?.(id); };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === current);
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, Home: -index, End: tabs.length - 1 - index }[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length];
    select(next.id);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-tab="${CSS.escape(next.id)}"]`)?.focus();
  };
  const active = tabs.find((tab) => tab.id === current);
  return (
    <div className={className}>
      <div role="tablist" aria-label={label} className={variant === "pills" ? "cms-pills" : "cms-tabs"} onKeyDown={onKey}>
        {tabs.map((tab) => {
          const selected = tab.id === current;
          return (
            <button key={tab.id} type="button" role="tab" data-tab={tab.id} id={`${base}-tab-${tab.id}`} aria-selected={selected} aria-controls={`${base}-panel`} tabIndex={selected ? 0 : -1} onClick={() => select(tab.id)} className={cn(variant === "pills" ? "cms-pill" : "cms-tab", selected && (variant === "pills" ? "cms-pill-active" : "cms-tab-active"))}>
              {tab.label}
              {tab.badge !== undefined && tab.badge !== null && tab.badge !== false && <span className="cms-tab-badge">{tab.badge}</span>}
            </button>
          );
        })}
      </div>
      {active && <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${active.id}`} className="cms-tab-panel">{active.content}</div>}
    </div>
  );
}

/** Tabs that are pages: each one a link, the current one marked. For tabs that switch in place, use Tabs. */
export function TabLinks({ label, links }: { label: string; links: Array<{ href: string; label: ReactNode; active?: boolean; badge?: ReactNode }> }) {
  return (
    <nav aria-label={label} className="cms-tabs cms-mb-6">
      {links.map((link) => (
        <Link key={link.href} href={link.href} aria-current={link.active ? "page" : undefined} className={cn("cms-tab", link.active && "cms-tab-active")}>
          {link.label}
          {link.badge !== undefined && link.badge !== null && <span className="cms-tab-badge">{link.badge}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** One choice of a few that filters what's below, such as a date range or a data source. */
export function SegmentedControl<T extends string>({ label, options, value, onChange }: { label: string; options: Array<{ id: T; label: ReactNode }>; value: T; onChange: (id: T) => void }) {
  return (
    <div role="group" aria-label={label} className="cms-pills">
      {options.map((option) => (
        <button key={option.id} type="button" aria-pressed={option.id === value} onClick={() => onChange(option.id)} className={cn("cms-pill", option.id === value && "cms-pill-active")}>{option.label}</button>
      ))}
    </div>
  );
}

/** A labelled group of settings: its title and help on one side, the controls on the other on wide screens. */
export function SettingsSection({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="cms-settings-section">
      <div className="cms-settings-intro">
        <h2 className="cms-card-title">{title}</h2>
        {description && <p className="cms-hint cms-mt-1">{description}</p>}
        {actions && <div className="cms-mt-3">{actions}</div>}
      </div>
      <div className="cms-panel cms-settings-body">{children}</div>
    </section>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="cms-empty cms-empty-state">
      {icon && <span className="cms-empty-icon" aria-hidden="true">{icon}</span>}
      <p className="cms-medium cms-strong">{title}</p>
      {children && <p className="cms-muted cms-mt-1">{children}</p>}
      {action && <div className="cms-mt-4">{action}</div>}
    </div>
  );
}

export function Pagination({ page, perPage, total, onPage }: { page: number; perPage: number; total: number; onPage: (page: number) => void }) {
  const { t } = useT();
  const pages = Math.max(1, Math.ceil(total / perPage));
  return (
    <div className="cms-pagination">
      <span>{t("common.total", { count: total })}</span>
      <div className="cms-row cms-gap-2">
        <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>{t("common.previous")}</Button>
        <span className="cms-nowrap">{t("common.pageOf", { page, pages })}</span>
        <Button variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>{t("common.next")}</Button>
      </div>
    </div>
  );
}

export interface TimelineEntry {
  id: string;
  /** A small icon in the entry's marker. */
  icon?: ReactNode;
  tone?: "neutral" | "accent" | "success" | "danger";
  /** Who did what, in a sentence: "Ada published Home". */
  title: ReactNode;
  time?: ReactNode;
  /** More under the title, such as a comment, a diff or files. */
  detail?: ReactNode;
}

/** An activity feed: one entry per event, newest first, joined by a line. */
export function Timeline({ entries }: { entries: TimelineEntry[] }) {
  return (
    <ol className="cms-timeline">
      {entries.map((entry) => (
        <li key={entry.id} className="cms-timeline-item">
          <span className={cn("cms-timeline-marker", entry.tone && entry.tone !== "neutral" && `cms-timeline-${entry.tone}`)} aria-hidden="true">{entry.icon}</span>
          <div className="cms-timeline-body">
            <div className="cms-timeline-head"><span className="cms-min-0">{entry.title}</span>{entry.time && <span className="cms-timeline-time">{entry.time}</span>}</div>
            {entry.detail && <div className="cms-timeline-detail">{entry.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** A placeholder bar while something loads. `width` is a share of the line, so rows look like the text they stand for. */
export function Skeleton({ width = "100%", height = "line", className }: { width?: string; height?: "line" | "title" | "control" | "block"; className?: string }) {
  return <span aria-hidden="true" className={cn("cms-skeleton cms-pulse", `cms-skeleton-${height}`, className)} style={{ width }} />;
}

/** Widths that vary row by row, so a loading table reads like a filled one rather than stripes. */
const SKELETON_WIDTHS = ["72%", "54%", "64%", "46%", "80%", "58%"];

export interface DataColumn {
  id: string;
  label: ReactNode;
  /** Right-aligned, for amounts and counts. */
  numeric?: boolean;
  /** Offers sorting by this column when the table has `sort`. The id is the sort key. */
  sortable?: boolean;
  /** Keeps the label for screen readers only, for a column of controls. */
  hideLabel?: boolean;
}

export interface DataRow {
  id: string | number;
  /** Where the row opens. The first cell becomes its link, and a click anywhere on the row follows it. */
  href?: string;
  cells: Record<string, ReactNode>;
  /** Small actions at the end of the row, shown fully on hover: `<button className="cms-row-action">`. */
  actions?: ReactNode;
}

/**
 * Every list in the dashboard: a card with a toolbar, the table, and a footer. `rows` null means
 * loading, and shows the same columns with placeholder rows. The first column is the row's
 * title. Pass `selection` for checkboxes and a `bulk` bar, `sort` for sortable headers.
 */
export function DataTable({ label, title, actions, columns, rows, toolbar, bulk, empty, footer, sort, selection, skeletonRows = 6, testId }: {
  label: string;
  /** A heading on the card, for a table that is one section of a page. */
  title?: string;
  actions?: ReactNode;
  columns: DataColumn[];
  rows: DataRow[] | null;
  toolbar?: ReactNode;
  /** Shown above the table while rows are selected. */
  bulk?: ReactNode;
  empty: { title: string; hint?: ReactNode; icon?: ReactNode; action?: ReactNode };
  footer?: ReactNode;
  /** "name" ascending, "-name" descending. */
  sort?: { value: string; onChange: (value: string) => void };
  selection?: { selected: Array<string | number>; onChange: (ids: Array<string | number>) => void };
  skeletonRows?: number;
  testId?: string;
}) {
  const { t } = useT();
  const rowLink = useRowLink();
  const hasActions = rows?.some((row) => row.actions) ?? false;
  const selected = selection?.selected ?? [];
  const all = rows?.map((row) => row.id) ?? [];
  const toggle = (id: string | number, on: boolean) => selection?.onChange(on ? [...selected, id] : selected.filter((other) => other !== id));

  const header = (column: DataColumn) => {
    const direction = sort?.value === column.id ? "ascending" : sort?.value === `-${column.id}` ? "descending" : undefined;
    const content = column.hideLabel ? <span className="cms-sr-only">{column.label}</span> : column.label;
    return (
      <th key={column.id} scope="col" aria-sort={direction} className={cn(column.numeric && "cms-cell-num")}>
        {sort && column.sortable ? (
          <button type="button" className="cms-th-sort" onClick={() => sort.onChange(sort.value === column.id ? `-${column.id}` : column.id)}>
            {content}
            {direction === "ascending" && <ChevronUpIcon className="cms-icon-xs" aria-hidden="true" />}
            {direction === "descending" && <ChevronDownIcon className="cms-icon-xs" aria-hidden="true" />}
          </button>
        ) : content}
      </th>
    );
  };

  return (
    <section className="cms-panel cms-data-table" aria-label={label} aria-busy={rows === null || undefined}>
      {(title || actions) && (
        <header className="cms-card-header">
          {title && <h2 className="cms-card-title">{title}</h2>}
          {actions && <div className="cms-row cms-gap-2 cms-no-shrink">{actions}</div>}
        </header>
      )}
      {toolbar}
      {bulk && selected.length > 0 && <div className="cms-bulkbar" role="region" aria-label={t("table.selected", { count: selected.length })}>{bulk}</div>}
      {rows !== null && rows.length === 0 ? (
        <EmptyState icon={empty.icon} title={empty.title} action={empty.action}>{empty.hint}</EmptyState>
      ) : (
        <div className="cms-table-wrap">
          <table className="cms-table" data-testid={testId}>
            <thead>
              <tr>
                {selection && (
                  <th scope="col" className="cms-col-check">
                    <input type="checkbox" aria-label={t("table.selectAll")} className="cms-check" disabled={!rows?.length} checked={all.length > 0 && selected.length === all.length} ref={(box) => { if (box) box.indeterminate = selected.length > 0 && selected.length < all.length; }} onChange={(event) => selection.onChange(event.target.checked ? all : [])} />
                  </th>
                )}
                {columns.map(header)}
                {(hasActions || rows === null) && <th scope="col" className="cms-col-actions"><span className="cms-sr-only">{t("table.actions")}</span></th>}
              </tr>
            </thead>
            <tbody>
              {rows === null
                ? Array.from({ length: skeletonRows }, (_, row) => (
                  <tr key={row} aria-hidden="true">
                    {selection && <td className="cms-col-check"><Skeleton width="1rem" /></td>}
                    {columns.map((column, index) => <td key={column.id} className={cn(column.numeric && "cms-cell-num")}><Skeleton width={index === 0 ? SKELETON_WIDTHS[row % SKELETON_WIDTHS.length] : SKELETON_WIDTHS[(row + index * 2) % SKELETON_WIDTHS.length]} /></td>)}
                    <td className="cms-col-actions" />
                  </tr>
                ))
                : rows.map((row) => {
                  const isSelected = selected.includes(row.id);
                  return (
                    <tr key={row.id} className={cn("cms-row-hover", row.href && "cms-row-link", isSelected && "cms-row-selected")} onClick={row.href ? rowLink(row.href) : undefined}>
                      {selection && (
                        <td className="cms-col-check" data-no-open>
                          <input type="checkbox" aria-label={t("table.selectRow", { id: String(row.id) })} className="cms-check" checked={isSelected} onChange={(event) => toggle(row.id, event.target.checked)} />
                        </td>
                      )}
                      {columns.map((column, index) => (
                        <td key={column.id} className={cn(index === 0 ? "cms-cell-title" : "cms-cell-soft", column.numeric && "cms-cell-num")}>
                          {index === 0 && row.href ? <Link className="cms-row-title" href={row.href}>{row.cells[column.id]}</Link> : row.cells[column.id] ?? <span className="cms-cell-empty">—</span>}
                        </td>
                      ))}
                      {hasActions && <td className="cms-col-actions cms-nowrap" data-no-open><span className="cms-row-actions">{row.actions}</span></td>}
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}
      {footer && <div className="cms-grid-foot">{footer}</div>}
    </section>
  );
}

/** What a page shows before its data arrives, shaped like the page: a header, then a table, a form or cards. */
export function PageSkeleton({ kind = "table", columns = 4 }: { kind?: "table" | "form" | "cards" | "detail"; columns?: number }) {
  const { t } = useT();
  return (
    <div className="cms-gutter" aria-busy="true" aria-label={t("table.loading")}>
      <div className="cms-page-skeleton-head">
        <div className="cms-stack-2 cms-grow">
          <Skeleton height="title" width="12rem" />
          <Skeleton width="20rem" />
        </div>
        {kind === "table" && <Skeleton height="control" width="7rem" />}
      </div>
      {kind === "table" && (
        <DataTable label={t("table.loading")} rows={null} empty={{ title: "" }} columns={Array.from({ length: columns }, (_, index) => ({ id: String(index), label: <Skeleton width={index === 0 ? "5rem" : "3.5rem"} /> }))}
          toolbar={<Toolbar end={<Skeleton height="control" width="6rem" />}><Skeleton height="control" width="16rem" /></Toolbar>} />
      )}
      {(kind === "form" || kind === "detail") && (
        <div className="cms-stack-6">
          {Array.from({ length: kind === "form" ? 2 : 1 }, (_, section) => (
            <div key={section} className="cms-panel cms-card-body cms-stack-4" aria-hidden="true">
              <Skeleton height="line" width="9rem" />
              {Array.from({ length: 3 }, (_, field) => (
                <div key={field} className="cms-stack-2">
                  <Skeleton width="6rem" />
                  <Skeleton height="control" />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {kind === "cards" && (
        <div className="cms-skeleton-cards" aria-hidden="true">
          {Array.from({ length: 6 }, (_, card) => (
            <div key={card} className="cms-panel cms-card-body cms-stack-3">
              <Skeleton width="60%" />
              <Skeleton height="block" />
              <Skeleton width="40%" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
