"use client";

import { useEffect, useState } from "react";
import { adminPath, Alert, apiPath, ButtonLink, SegmentedControl, useT } from "tansy/admin";
import type { AnalyticsReport, Breakdown } from "./tracker";

interface Source { id: string; label: string; dashboardUrl: string | null }
interface Answer {
  sources: Source[];
  source: string;
  report: AnalyticsReport | null;
  failed: boolean;
  collecting: boolean;
  tracking: string | null;
}

function useWords() {
  const { t, locale } = useT();
  const words = (key: string, values?: Record<string, string | number>) => t(`ext.analytics.${key}`, values);
  const number = (value: number) => value.toLocaleString(locale);
  const date = (value: string) => new Date(`${value}T00:00:00Z`).toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" });
  let regions: Intl.DisplayNames | null = null;
  try {
    regions = new Intl.DisplayNames([locale], { type: "region" });
  } catch {
    regions = null;
  }
  const country = (code: string) => (/^[A-Z]{2}$/.test(code) ? regions?.of(code) ?? code : code);
  return { t: words, number, date, country };
}

function useReport(days: string, source: string | null) {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    const query = new URLSearchParams({ days, ...(source ? { source } : {}) });
    fetch(apiPath(`/ext/analytics/report?${query}`), { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((value: Answer) => { if (live) { setAnswer(value); setError(false); } })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [days, source]);
  return { answer, error };
}

/** Views a day as bars, with visitors as a darker bar inside each. Each bar names its day for screen readers. */
function DayChart({ days, height = 140 }: { days: AnalyticsReport["days"]; height?: number }) {
  const { t, number, date } = useWords();
  const most = Math.max(1, ...days.map((day) => day.views));
  const width = 100 / Math.max(1, days.length);
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" width="100%" height={height} role="img" aria-label={t("chart")} style={{ display: "block" }}>
      {days.map((day, index) => {
        const views = (day.views / most) * (height - 4);
        const visitors = (day.visitors / most) * (height - 4);
        const label = t("day", { date: date(day.date), views: number(day.views), visitors: number(day.visitors) });
        return (
          <g key={day.date}>
            <title>{label}</title>
            <rect x={index * width + width * 0.1} y={height - views} width={width * 0.8} height={views} fill="var(--cms-color-accent-tint)" />
            <rect x={index * width + width * 0.1} y={height - visitors} width={width * 0.8} height={visitors} fill="var(--cms-color-accent)" />
          </g>
        );
      })}
    </svg>
  );
}

function Table({ title, rows, name }: { title: string; rows: Breakdown | undefined; name?: (value: string) => string }) {
  const { t, number } = useWords();
  if (!rows) return null;
  const most = Math.max(1, ...rows.map((row) => row.count));
  return (
    <section className="cms-panel" style={{ padding: "var(--cms-space-4)" }}>
      <h2 className="cms-medium cms-strong cms-mb-2">{title}</h2>
      {rows.length === 0 ? <p className="cms-muted cms-text-sm">{t("none")}</p> : (
        <ol className="cms-stack-1" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {rows.map((row) => (
            <li key={row.name} className="cms-text-sm" style={{ position: "relative", display: "flex", justifyContent: "space-between", gap: "var(--cms-space-2)", padding: "0.25rem 0.5rem" }}>
              <span aria-hidden="true" style={{ position: "absolute", insetBlock: 0, insetInlineStart: 0, width: `${(row.count / most) * 100}%`, background: "var(--cms-color-accent-surface)", borderRadius: "var(--cms-radius-sm)" }} />
              <span style={{ position: "relative", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} dir="auto">{name ? name(row.name) : row.name}</span>
              <span style={{ position: "relative" }}>{number(row.count)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const RANGES = ["7", "30", "90"] as const;

/** The numbers, from the CMS's own count or the provider's API, with a choice of range and source. */
export function AnalyticsReportView() {
  const { t, number, country } = useWords();
  const [days, setDays] = useState<string>("30");
  const [source, setSource] = useState<string | null>(null);
  const { answer, error } = useReport(days, source);
  if (error) return <Alert kind="error">{t("failed", { provider: t("pages.analytics") })}</Alert>;
  if (!answer) return <div className="cms-panel" aria-busy="true" style={{ height: 240 }} />;
  const current = answer.sources.find((candidate) => candidate.id === answer.source);
  const label = (item: Source) => item.label || t("own");
  const report = answer.report;

  return (
    <div className="cms-stack-4">
      {!answer.collecting && !answer.tracking && <Alert kind="info">{t("off")}</Alert>}
      {answer.tracking && answer.source === "cms" && (answer.collecting
        ? <p className="cms-muted cms-text-sm">{t("sentTo", { provider: answer.tracking })}</p>
        : <Alert kind="info">{t("noKey", { provider: answer.tracking })}</Alert>)}
      <div className="cms-row cms-wrap cms-gap-2">
        {answer.sources.length > 1 && <SegmentedControl label={t("pages.analytics")} options={answer.sources.map((item) => ({ id: item.id, label: label(item) }))} value={answer.source} onChange={setSource} />}
        <div className="cms-row cms-wrap cms-gap-2 cms-ml-auto">
          {current?.dashboardUrl && <ButtonLink variant="secondary" href={current.dashboardUrl} target="_blank" rel="noopener noreferrer">{t("openProvider", { provider: current.label })}</ButtonLink>}
          <SegmentedControl label={t("range")} options={RANGES.map((range) => ({ id: range, label: t(`ranges.${range}`) }))} value={days as (typeof RANGES)[number]} onChange={setDays} />
        </div>
      </div>
      {answer.failed && <Alert kind="warning">{t("failed", { provider: current ? label(current) : "" })}</Alert>}
      {report && (
        <>
          <div className="cms-grid cms-gap-3 cms-sm-3">
            <div className="cms-stat"><p className="cms-muted cms-text-sm">{t("totals.views")}</p><p className="cms-stat-value">{number(report.totals.views)}</p></div>
            <div className="cms-stat"><p className="cms-muted cms-text-sm">{t("totals.visitors")}</p><p className="cms-stat-value">{number(report.totals.visitors)}</p></div>
          </div>
          <div className="cms-panel" style={{ padding: "var(--cms-space-4)" }}><DayChart days={report.days} /></div>
          {answer.source === "cms" && <p className="cms-muted cms-text-sm">{t("visitorsNote")}</p>}
          <div className="cms-grid cms-gap-3 cms-sm-2">
            <Table title={t("tables.pages")} rows={report.pages} />
            <Table title={t("tables.referrers")} rows={report.referrers} />
            <Table title={t("tables.countries")} rows={report.countries} name={country} />
            <Table title={t("tables.devices")} rows={report.devices} />
            <Table title={t("tables.browsers")} rows={report.browsers} />
          </div>
        </>
      )}
    </div>
  );
}

/** The last week on the dashboard's home page. */
export function AnalyticsWidget() {
  const { t, number } = useWords();
  const { answer, error } = useReport("7", null);
  if (error || !answer?.report) return error ? <p className="cms-muted cms-text-sm">{t("none")}</p> : null;
  const { totals, days } = answer.report;
  return (
    <div className="cms-stack-2">
      <p className="cms-muted cms-text-sm">{t("widget.summary", { views: number(totals.views), visitors: number(totals.visitors) })}</p>
      <DayChart days={days} height={48} />
      <a className="cms-text-sm" href={adminPath("/ext/analytics")}>{t("widget.more")}</a>
    </div>
  );
}
