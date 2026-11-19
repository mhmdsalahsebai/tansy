"use client";

import { useEffect, useState } from "react";
import { adminPath, Alert, apiPath, Button, defineAdminClient, useT, type RecordPanelProps } from "tansy/admin";
import { CampaignActions } from "./dashboard";

/**
 * On any published record with a page on the site, such as a blog post: drafts a campaign about
 * it, to edit and send. Shows only to people who may send campaigns, for collections with an address.
 */
function SendAsCampaign({ collection, recordId, status }: RecordPanelProps) {
  const { t } = useT();
  const [eligible, setEligible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (collection.slug.startsWith("newsletter-")) return;
    let live = true;
    fetch(apiPath(`/ext/newsletter/sources/${encodeURIComponent(collection.slug)}`)).then((response) => (response.ok ? response.json() : { eligible: false })).then((json: { eligible?: boolean }) => { if (live) setEligible(json.eligible === true); }).catch(() => {});
    return () => { live = false; };
  }, [collection.slug]);
  if (!eligible || !recordId) return null;

  async function draft() {
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch(apiPath("/ext/newsletter/campaigns/from-record"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ collection: collection.slug, id: Number(recordId) }) });
      const json = await response.json().catch(() => null) as { id?: number; error?: { message?: string } } | null;
      if (!response.ok || !json?.id) throw new Error(json?.error?.message ?? t("ext.newsletter.errors.failed"));
      // To the new draft in the record editor, by the campaigns collection's id.
      const collections = await fetch(apiPath("/collections")).then((r) => (r.ok ? r.json() : [])) as Array<{ id: number; slug: string }>;
      const campaigns = collections.find((item) => item.slug === "newsletter-campaigns");
      window.location.href = campaigns ? adminPath(`/collections/${campaigns.id}/content/${json.id}`) : adminPath("/ext/newsletter");
    } catch (error) {
      setProblem((error as Error).message);
      setBusy(false);
    }
  }

  return (
    <section className="cms-panel cms-cell cms-stack-2">
      <h3 className="cms-section-title">{t("ext.newsletter.panel.title")}</h3>
      <p className="cms-text-sm cms-muted">{status === "published" ? t("ext.newsletter.panel.description") : t("ext.newsletter.panel.unpublished")}</p>
      <div><Button variant="secondary" disabled={busy || status !== "published"} onClick={() => void draft()}>{t("ext.newsletter.panel.button")}</Button></div>
      {problem && <Alert>{problem}</Alert>}
    </section>
  );
}

/** On a campaign in the record editor: its progress, and the same actions as the Newsletter page. */
function CampaignPanel({ collection, recordId, values }: RecordPanelProps) {
  const { t } = useT();
  if (collection.slug !== "newsletter-campaigns" || !recordId) return null;
  const state = typeof values.state === "string" ? values.state : "draft";
  const subject = typeof values.subject === "string" ? values.subject : "";
  return (
    <section className="cms-panel cms-cell cms-stack-2">
      <h3 className="cms-section-title">{t("ext.newsletter.panel.campaign")}</h3>
      <p className="cms-text-sm cms-muted">
        {t(`ext.newsletter.campaigns.states.${state}`)}
        {state !== "draft" && ` · ${t("ext.newsletter.campaigns.progressText", { sent: Number(values.sent) || 0, recipients: Number(values.recipients) || 0 })}`}
      </p>
      {state === "draft" && <p className="cms-text-xs cms-muted">{t("ext.newsletter.panel.saveFirst")}</p>}
      <CampaignActions campaign={{ id: Number(recordId), state, subject }} onChange={() => window.location.reload()} onCopied={() => { window.location.href = adminPath("/ext/newsletter"); }} />
    </section>
  );
}

export default defineAdminClient({
  recordPanels: [
    { id: "newsletter-send-record", component: SendAsCampaign },
    { id: "newsletter-campaign", component: CampaignPanel },
  ],
});
