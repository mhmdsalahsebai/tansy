import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Card, PageHeader, Timeline } from "../../components/ui/kit";
import {
  ArrowRightIcon, ClipboardDocumentListIcon, Cog6ToothIcon, ExclamationTriangleIcon, PencilSquareIcon, PhotoIcon, PlusIcon,
  RectangleStackIcon, ShieldCheckIcon, UsersIcon, CheckIcon, XMarkIcon,
} from "@heroicons/react/16/solid";
import { getAdminConfig } from "../../core/config";
import { requirePage } from "../../core/authz/page";
import { holdsRecordPermission, type Permission } from "../../core/authz/permissions";
import { loadOverview, type OverviewRecord } from "../../core/content/overview";
import { scopedRecords } from "../../core/extend/records";
import { adminPath } from "../../lib/paths";
import { relativeTime } from "../../lib/time";
import { getT } from "../../core/i18n/admin";
import { pluginWord } from "../../core/i18n/messages";
import { clientPage } from "../../routes/client-page";
import type PluginSlotType from "./page.client";

// Keeps a broken widget from taking the dashboard down.
const PluginSlot = clientPage<typeof PluginSlotType>("");

const recordHref = (record: Pick<OverviewRecord, "collectionId" | "id">) => adminPath(`/collections/${record.collectionId}/content/${record.id}`);

type Translate = Awaited<ReturnType<typeof getT>>["t"];

function greeting(name: string, t: Translate) {
  const first = name.trim().split(/\s+/)[0];
  return first ? t("overview.welcome", { name: first }) : t("overview.welcomeBack");
}

function Time({ value, locale }: { value: string; locale: string }) {
  return <time dateTime={value} title={value}>{relativeTime(value, undefined, locale)}</time>;
}

function StatusBadge({ status, t }: { status: string; t: Translate }) {
  return <Badge tone={status === "published" ? "success" : "warning"}>{status === "published" || status === "draft" ? t(`editor.status.${status}`) : status}</Badge>;
}

function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Card title={title} actions={action} flush>{children}</Card>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="cms-feed-empty">{children}</p>;
}

export default async function DashboardPage() {
  const principal = await requirePage();
  const requestHeaders = await headers();
  const { t, locale } = await getT(principal.user.id);
  const { content, activity } = await loadOverview(principal, requestHeaders, locale);
  const can = (permission: Permission) => principal.permissions.has(permission);

  const cards = ([
    { href: adminPath("/collections"), title: t("nav.Collections"), text: t("overview.collectionsText"), icon: RectangleStackIcon, permission: "collection:read" },
    { href: adminPath("/files"), title: t("nav.Files"), text: t("overview.filesText"), icon: PhotoIcon, permission: "file:list" },
    { href: adminPath("/users"), title: t("nav.Users"), text: t("overview.usersText"), icon: UsersIcon, permission: "user:list" },
    { href: adminPath("/roles"), title: t("nav.Roles"), text: t("overview.rolesText"), icon: ShieldCheckIcon, permission: "role:list" },
    { href: adminPath("/settings"), title: t("nav.Settings"), text: t("overview.settingsText"), icon: Cog6ToothIcon, permission: "setting:read" },
    { href: adminPath("/audit"), title: t("nav.Audit log"), text: t("overview.auditText"), icon: ClipboardDocumentListIcon, permission: "audit:read" },
  ] satisfies Array<{ href: string; title: string; text: string; icon: unknown; permission: Permission }>).filter((card) => can(card.permission));
  const widgets = getAdminConfig().plugins.flatMap((plugin) => (plugin.widgets ?? []).map((widget) => ({ ...widget, plugin: plugin.name }))).filter((widget) => !widget.permission || principal.permissions.has(widget.permission));
  const widgetProps = { records: scopedRecords(principal, requestHeaders), user: { id: principal.user.id, email: principal.user.email, permissions: [...principal.permissions] }, params: {} };

  // Singletons open their one record; everything else starts a new one.
  const quick = (content?.collections ?? []).flatMap((collection) => {
    if (collection.type === "singleton") return collection.singletonId ? [{ key: collection.id, label: collection.name, href: recordHref({ collectionId: collection.id, id: collection.singletonId }), edit: true }] : [];
    return holdsRecordPermission(principal.permissions, "record:create", collection.id) ? [{ key: collection.id, label: collection.name, href: adminPath(`/collections/${collection.id}/content/new`), edit: false }] : [];
  });
  const total = content?.collections.reduce((sum, collection) => sum + Math.max(collection.total, 0), 0) ?? 0;

  return (
    <div className="cms-gutter cms-stack-6">
      <PageHeader title={greeting(principal.user.name, t)} description={t("overview.intro")} />

      {content && (
        <>
          <div className="cms-grid cms-gap-3 cms-cols-2 cms-md-4">
            <div className="cms-stat"><p className="cms-stat-label">{t("overview.records")}</p><p className="cms-stat-value">{total}</p></div>
            <div className="cms-stat"><p className="cms-stat-label">{t("overview.collections")}</p><p className="cms-stat-value">{content.collections.length}</p></div>
            <div className="cms-stat"><p className="cms-stat-label">{t("overview.pendingDrafts")}</p><p className="cms-stat-value">{content.counts.drafts}</p></div>
            <div className="cms-stat">
              <p className="cms-stat-label">{t("overview.scheduled")}</p>
              <p className="cms-stat-value">{content.counts.scheduled}</p>
              {content.counts.failed > 0 && <p className="cms-stat-note cms-danger">{t("overview.failed", { count: content.counts.failed })}</p>}
            </div>
          </div>

          {quick.length > 0 && (
            <div className="cms-quick" aria-label={t("overview.quickCreate")}>
              <span className="cms-hint cms-medium">{t("overview.quickCreate")}</span>
              {quick.map((item) => (
                <Link key={item.key} href={item.href} className="cms-chip">
                  {item.edit ? <PencilSquareIcon className="cms-icon-xs" aria-hidden="true" /> : <PlusIcon className="cms-icon-xs" aria-hidden="true" />}
                  {item.label}
                </Link>
              ))}
            </div>
          )}
        </>
      )}

      {(content || activity) && (
        <div className="cms-overview-grid">
          <div className="cms-stack-4 cms-min-0">
            {content && (
              <Panel title={t("overview.recentlyEdited")} action={can("collection:read") && <Link href={adminPath("/collections")} className="cms-panel-link">{t("overview.allCollections")}</Link>}>
                {content.recent.length ? (
                  <ul className="cms-feed">
                    {content.recent.map((record) => (
                      <li key={`${record.collectionId}:${record.id}`}>
                        <Link href={recordHref(record)} className="cms-feed-row">
                          <span className="cms-feed-main">
                            <span className="cms-feed-title">{record.title || t("overview.item", { id: record.id })}</span>
                            <span className="cms-feed-meta">{record.collection}</span>
                          </span>
                          <StatusBadge status={record.status} t={t} />
                          <span className="cms-feed-time"><Time value={record.updatedAt} locale={locale} /></span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : <Empty>{t("overview.nothingWritten")} {quick.length > 0 && t("overview.startQuick")}</Empty>}
              </Panel>
            )}
            {content && content.collections.length > 0 && (
              <Panel title={t("overview.collections")} action={content.collections.length > 8 && <Link href={adminPath("/collections")} className="cms-panel-link">{t("overview.viewAll")}</Link>}>
                <ul className="cms-feed">
                  {content.collections.slice(0, 8).map((collection) => (
                    <li key={collection.id}>
                      <Link href={adminPath(`/collections/${collection.id}`)} className="cms-feed-row">
                        <span className="cms-feed-main">
                          <span className="cms-feed-title">{collection.name}</span>
                          <span className="cms-feed-meta cms-capitalize">{collection.type === "base" ? t("overview.collection") : collection.type}</span>
                        </span>
                        <span className="cms-feed-time">{t("overview.recordCount", { count: collection.total })}</span>
                        <ArrowRightIcon className="cms-icon cms-stat-arrow" aria-hidden="true" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </div>

          <div className="cms-stack-4 cms-min-0">
            {content && (
              <Panel title={t("overview.pendingDrafts")}>
                {content.drafts.length ? (
                  <ul className="cms-feed">
                    {content.drafts.map((draft) => (
                      <li key={`${draft.collectionId}:${draft.id}`}>
                        <Link href={recordHref(draft)} className="cms-feed-row">
                          <span className="cms-feed-main">
                            <span className="cms-feed-title">{draft.title || t("overview.item", { id: draft.id })}</span>
                            <span className="cms-feed-meta">{draft.collection} · {t("overview.saved")} <Time value={draft.savedAt} locale={locale} /></span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : <Empty>{t("overview.noUnpublished")}</Empty>}
              </Panel>
            )}
            {content && (
              <Panel title={t("overview.scheduled")}>
                {content.scheduled.length ? (
                  <ul className="cms-feed">
                    {content.scheduled.map((entry) => (
                      <li key={`${entry.collectionId}:${entry.id}:${entry.action}`}>
                        <Link href={recordHref(entry)} className="cms-feed-row">
                          <span className="cms-feed-main">
                            <span className="cms-feed-title">{entry.title || t("overview.item", { id: entry.id })}</span>
                            {entry.error ? (
                              <span className="cms-feed-meta cms-danger cms-inline-row cms-gap-1"><ExclamationTriangleIcon className="cms-icon-xs" aria-hidden="true" />{entry.action === "publish" ? t("overview.publishFailed", { error: entry.error }) : t("overview.unpublishFailed", { error: entry.error })}</span>
                            ) : (
                              <span className="cms-feed-meta">{entry.action === "publish" ? t("overview.publishes") : t("overview.unpublishes")} <Time value={entry.at} locale={locale} /></span>
                            )}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : <Empty>{t("overview.nothingScheduled")}</Empty>}
              </Panel>
            )}
            {activity && (
              <Panel title={t("overview.activity")} action={<Link href={adminPath("/audit")} className="cms-panel-link">{t("overview.auditLog")}</Link>}>
                {activity.length ? (
                  <Timeline entries={activity.map((entry) => ({
                    id: entry.id,
                    icon: entry.outcome === "success" ? <CheckIcon /> : <XMarkIcon />,
                    tone: entry.outcome === "success" ? "neutral" : "danger",
                    title: <><span className="cms-sr-only">{entry.outcome}</span><span className="cms-medium cms-strong">{entry.actor ?? t("overview.system")}</span> <span className="cms-mono cms-text-xs">{entry.action}</span></>,
                    time: <Time value={entry.at} locale={locale} />,
                  }))} />
                ) : <Empty>{t("overview.noActivity")}</Empty>}
              </Panel>
            )}
          </div>
        </div>
      )}

      {cards.length > 0 && (
        <section>
          <h2 className="cms-hint cms-medium cms-mb-2">{t("overview.manage")}</h2>
          <div className="cms-grid cms-gap-3 cms-sm-2 cms-lg-3">
            {cards.map((card) => (
              <Link key={card.href} href={card.href} className="cms-stat cms-stat-link cms-stat-row">
                <span className="cms-stat-icon cms-mb-0"><card.icon className="cms-icon" aria-hidden="true" /></span>
                <span className="cms-grow cms-min-0">
                  <span className="cms-block cms-medium cms-strong cms-text-sm">{card.title}</span>
                  <span className="cms-block cms-hint cms-truncate">{card.text}</span>
                </span>
                <ArrowRightIcon className="cms-icon cms-stat-arrow" aria-hidden="true" />
              </Link>
            ))}
          </div>
        </section>
      )}

      {widgets.length > 0 && (
        <section>
          <h2 className="cms-hint cms-medium cms-mb-2">{t("overview.widgets")}</h2>
          <div className="cms-grid cms-gap-3 cms-sm-2 cms-lg-3">
            {widgets.map((widget) => (
              <div key={widget.id} className="cms-stat">
                <h3 className="cms-medium cms-strong">{pluginWord(t, widget.plugin, `widgets.${widget.id}`, widget.title)}</h3>
                <div className="cms-mt-2"><PluginSlot plugin={widget.plugin}><widget.component {...widgetProps} /></PluginSlot></div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
