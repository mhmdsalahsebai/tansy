import { getCmsConfig } from "../../../core/config";
import { getT } from "../../../core/i18n/admin";
import { Alert, ButtonLink, Card, EmptyState, PageHeader, Tabs } from "../../../components/ui/kit";
import { PuzzlePieceIcon } from "@heroicons/react/24/outline";
import { requirePage } from "../../../core/authz/page";
import { listJobRuns } from "../../../core/extend/jobs";
import { backgroundStatus } from "../../../core/background/runner";
import { listHookProblems } from "../../../core/extend/hook-deliveries";
import { can } from "../../../core/authz/principal";
import type HookRetryButtonType from "./page.client";
import { clientPage } from "../../../routes/client-page";
import { listPluginStates } from "../../../core/extend/lifecycle";
import { contractProblems } from "../../../core/extend/schema";
import { extensionJobs, extensionRoutes, hookFiles, hooksFor } from "../../../core/extend/registry";
import { HOOK_EVENTS } from "../../../core/extend/define";
import { adminPath, apiPath } from "../../../lib/paths";
import { pluginSettingsPath } from "../../../core/extend/admin-nav";

const HookRetryButton = clientPage<typeof HookRetryButtonType>("extensions");

const th = "cms-cell";
const td = "cms-cell cms-soft";
const table = "cms-table cms-text-sm";
const head = "cms-thead";

function Table({ empty, nothing, children }: { empty: boolean; nothing: string; children: React.ReactNode }) {
  return empty ? <p className="cms-empty cms-empty-sm">{nothing}</p> : <div className="cms-table-wrap">{children}</div>;
}

const count = (n: number) => (n ? String(n) : undefined);

export default async function Page() {
  const principal = await requirePage("setting:read");
  const { t, locale } = await getT(principal.user.id);
  const when = (date: Date) => date.toLocaleString(locale, { timeZone: "UTC", timeZoneName: "short" });
  const nothing = t("extensions.nothing");
  const failures = await listHookProblems();
  const canRetry = can(principal, "setting:update");
  const runs = new Map((await listJobRuns()).map((run) => [run.name, run]));
  const background = await backgroundStatus();
  const endpoint = apiPath("/background");
  const lateTotal = background.late.schedules + background.late.hooks + background.late.webhooks;
  const neverCalled = background.mode === "external" && !background.lastPass;
  const modeSetting = ["TANSY_BACKGROUND", background.mode].join("=");
  const states = new Map((await listPluginStates()).map((state) => [state.name, state.version]));
  const hooks = HOOK_EVENTS.flatMap((event) => hooksFor(event).map((hook) => ({ event, source: hook.source })));
  const routes = extensionRoutes();
  const jobs = extensionJobs();
  const files = hookFiles();
  const plugins = getCmsConfig().plugins ?? [];
  const problems = new Map(await Promise.all(plugins.map(async (p) => [p.name, await contractProblems(p)] as const)));
  const pluginCards = plugins.map((p) => {
    const permissions = Object.entries(p.permissions ?? {}).flatMap(([resource, actions]) => actions.map((action) => `${resource}:${action}`));
    const stored = states.get(p.name);
    const trouble = problems.get(p.name) ?? [];
    return (
      <article key={p.name} className="cms-plugin-card">
        <header className="cms-plugin-head">
          <span className="cms-plugin-mark" aria-hidden="true">{p.name.replace(/^@[^/]+\//, "").slice(0, 2)}</span>
          <div className="cms-min-0 cms-grow">
            <h3 className="cms-plugin-name" title={p.name}>{p.name}</h3>
            <p className="cms-hint cms-mono">v{p.version}{stored && stored !== p.version ? t("extensions.databaseAt", { version: stored }) : ""}</p>
          </div>
          <span className={trouble.length ? "cms-status cms-status-warn" : "cms-status cms-status-on"}>{trouble.length ? t("extensions.error") : t("extensions.loaded")}</span>
        </header>
        <dl className="cms-plugin-meta">
          <dt>{t("extensions.permissions")}</dt><dd>{permissions.length ? <span className="cms-mono">{permissions.join(", ")}</span> : <span className="cms-faint">{t("extensions.none")}</span>}</dd>
          {Boolean(p.fields?.length) && <><dt>{t("extensions.fields")}</dt><dd>{p.fields!.map((f) => f.type).join(", ")}</dd></>}
          {Boolean(p.blocks?.length) && <><dt>{t("extensions.blocks")}</dt><dd>{p.blocks!.map((b) => b.name).join(", ")}</dd></>}
          {(p.contract || trouble.length > 0) && <><dt>{t("extensions.collections")}</dt><dd className={trouble.length ? "cms-danger" : undefined}>{trouble.join(" ") || t("extensions.asExpected")}</dd></>}
        </dl>
        {p.settings && (
          <footer className="cms-plugin-foot">
            <ButtonLink native variant="secondary" href={pluginSettingsPath(p.name)}>{t("extensions.settings")}</ButtonLink>
          </footer>
        )}
      </article>
    );
  });
  return (
    <div className="cms-gutter cms-stack-6">
      <PageHeader title={t("extensions.title")} description={t("extensions.description")} actions={<ButtonLink native variant="secondary" href={adminPath("/extensions/directory")}>{t("extensions.browse")}</ButtonLink>} />
      {neverCalled ? <Alert kind="warning">{t("extensions.backgroundNeverCalled", { path: endpoint })}</Alert> : lateTotal > 0 && <Alert kind="warning">{t("extensions.backgroundLate")}</Alert>}
      <Card title={t("extensions.background")} description={background.mode === "timers" ? t("extensions.backgroundTimers") : t("extensions.backgroundExternal", { path: endpoint })}>
        <dl className="cms-plugin-meta">
          <dt>{t("extensions.backgroundMode")}</dt><dd><span className="cms-mono cms-mr-2">{modeSetting}</span>{background.mode === "timers" ? t("extensions.backgroundModeTimers") : t("extensions.backgroundModeExternal")}</dd>
          <dt>{t("extensions.lastPass")}</dt><dd className={background.lastPass?.error ? "cms-danger" : undefined}>{background.lastPass ? t("extensions.lastPassAt", { when: when(background.lastPass.at), trigger: background.lastPass.trigger === "timers" ? t("extensions.triggerTimers") : t("extensions.triggerEndpoint") }) : t("extensions.never")}{background.lastPass?.error && <span className="cms-mono cms-ml-2">{background.lastPass.error}</span>}</dd>
          <dt>{t("extensions.lateWork")}</dt><dd className={lateTotal ? "cms-danger" : undefined}>{lateTotal ? t("extensions.lateCounts", background.late) : t("extensions.nothingLate")}</dd>
        </dl>
      </Card>
      <section>
        <h2 className="cms-section-title cms-mb-3">{t("extensions.plugins")} <span className="cms-faded cms-medium">{plugins.length}</span></h2>
        {plugins.length ? <div className="cms-card-grid">{pluginCards}</div> : <EmptyState icon={<PuzzlePieceIcon />} title={nothing} />}
      </section>
      {failures.length > 0 && (
        <section>
          <h2 className="cms-section-title cms-mb-1">{t("extensions.hookFailures")}</h2>
          <p className="cms-soft cms-text-sm cms-mb-3">{t("extensions.hookFailuresHint")}</p>
          <div className="cms-table-wrap"><table className={table}><thead className={head}><tr><th scope="col" className={th}>{t("extensions.hook")}</th><th scope="col" className={th}>{t("extensions.record")}</th><th scope="col" className={th}>{t("extensions.attempts")}</th><th scope="col" className={th}>{t("extensions.state")}</th><th scope="col" className={th}>{t("extensions.error")}</th>{canRetry && <th scope="col" className={th}><span className="cms-sr-only">{t("extensions.actions")}</span></th>}</tr></thead>
            <tbody>{failures.map((f) => <tr key={f.id}><td className="cms-cell cms-mono cms-strong">{f.event} · {f.source}</td><td className={td}>{f.collectionId}/{f.recordId}</td><td className={td}>{f.attempts}</td><td className={f.status === "failed" ? "cms-cell cms-danger" : td}>{f.status === "failed" ? t("extensions.failedAt", { when: f.finishedAt ? when(f.finishedAt) : "" }) : t("extensions.retryingAt", { when: when(f.nextAttemptAt) })}</td><td className="cms-cell cms-danger">{f.error ?? ""}</td>{canRetry && <td className={td}>{f.status === "failed" && <HookRetryButton id={f.id} />}</td>}</tr>)}</tbody></table></div>
        </section>
      )}
      <section>
        <h2 className="cms-section-title cms-mb-2">{t("extensions.diagnostics")}</h2>
        <Tabs
          label={t("extensions.diagnostics")}
          tabs={[
            { id: "jobs", label: t("extensions.jobs"), badge: count(jobs.length), content: (
              <Table empty={!jobs.length} nothing={nothing}>
                <table className={table}><thead className={head}><tr><th scope="col" className={th}>{t("extensions.name")}</th><th scope="col" className={th}>{t("extensions.schedule")}</th><th scope="col" className={th}>{t("extensions.lastRun")}</th><th scope="col" className={th}>{t("extensions.result")}</th></tr></thead>
                  <tbody>{jobs.map(({ value }) => { const run = runs.get(value.name); return <tr key={value.name}><td className="cms-cell cms-mono cms-strong">{value.name}</td><td className={`${td} cms-mono`}>{value.cron}</td><td className={td}>{run && run.status !== "waiting" ? when(run.lastRunAt) : t("extensions.never")}</td><td className={run?.error ? "cms-cell cms-danger" : td}>{run && run.status !== "waiting" ? (run.error ?? <span className={run.status === "ok" || run.status === "success" ? "cms-status cms-status-on" : "cms-status"}>{run.status}</span>) : "—"}</td></tr>; })}</tbody></table>
              </Table>
            ) },
            { id: "routes", label: t("extensions.routes"), badge: count(routes.length), content: (
              <Table empty={!routes.length} nothing={nothing}>
                <table className={table}><thead className={head}><tr><th scope="col" className={th}>{t("extensions.route")}</th><th scope="col" className={th}>{t("extensions.access")}</th><th scope="col" className={th}>{t("extensions.source")}</th></tr></thead>
                  <tbody>{routes.map(({ source, value }) => <tr key={`${value.method} ${value.path}`}><td className="cms-cell cms-mono cms-strong"><span className="cms-tag cms-mr-2">{value.method}</span>{apiPath("/ext")}{value.path}</td><td className={td}>{value.access === "permission" ? <span className="cms-mono">{value.permission}</span> : value.access === "public" ? t("extensions.publicReason", { reason: value.reason }) : t("extensions.signedIn")}</td><td className={td}>{source}</td></tr>)}</tbody></table>
              </Table>
            ) },
            { id: "hooks", label: t("extensions.hooks"), badge: count(hooks.length), content: (
              <Table empty={!hooks.length} nothing={nothing}>
                <table className={table}><thead className={head}><tr><th scope="col" className={th}>{t("extensions.event")}</th><th scope="col" className={th}>{t("extensions.source")}</th></tr></thead>
                  <tbody>{hooks.map((h, i) => <tr key={i}><td className="cms-cell cms-mono cms-strong">{h.event}</td><td className={td}>{h.source}</td></tr>)}</tbody></table>
              </Table>
            ) },
            { id: "files", label: t("extensions.hookFiles"), badge: count(files.length), content: (
              <Table empty={!files.length} nothing={nothing}>
                <table className={table}><thead className={head}><tr><th scope="col" className={th}>{t("extensions.file")}</th><th scope="col" className={th}>{t("extensions.state")}</th></tr></thead>
                  <tbody>{files.map((f) => <tr key={f.file}><td className="cms-cell cms-mono cms-strong">{f.file}</td><td className={f.error ? "cms-cell cms-danger" : td}>{f.error ? t("extensions.loadFailed", { error: f.error }) : <span className="cms-status cms-status-on">{t("extensions.loaded")}</span>}</td></tr>)}</tbody></table>
              </Table>
            ) },
          ]}
        />
      </section>
    </div>
  );
}
