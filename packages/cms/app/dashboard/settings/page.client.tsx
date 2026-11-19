"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { usePluginWord, useT } from "../../../components/i18n";
import { Alert, Button, ButtonLink, Card, Field, Input, PageHeader, PageSkeleton } from "../../../components/ui/kit";
import { Switch } from "../../../components/ui/Switch";
import type { AuthSettings } from "../../../core/auth/settings-schema";
import { api, useAction, useApi } from "../../../lib/client/api";
import { useAdminSlots } from "../../../components/admin-client";
import { PluginBoundary } from "../../../components/PluginBoundary";
import { cn } from "../../../lib/utils";
import { adminPath, apiPath } from "../../../lib/paths";

type Update = (mutate: (draft: AuthSettings) => void) => void;

const TABS = ["signIn", "passwords", "sessions", "mfa", "oauth", "rateLimits", "email", "security"] as const;
/** A built-in tab's name, or the id of a plugin's tab. */
type Tab = string;

function Toggle({ label, hint, value, onChange, disabled }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className={cn(disabled && "cms-disabled")}>
      <Switch checked={value} onChange={onChange} label={label} />
      {hint && <p className="cms-hint cms-mt-1 cms-ml-12">{hint}</p>}
    </div>
  );
}

function NumberField({ label, hint, value, onChange }: { label: string; hint?: string; value: number; onChange: (v: number) => void }) {
  return <Field label={label} hint={hint}><Input type="number" value={value} onChange={(e) => onChange(Number(e.target.value))} /></Field>;
}

function ListField({ label, hint, value, onChange }: { label: string; hint?: string; value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useT();
  return (
    <Field label={label} hint={hint ?? t("settings.separateWithCommas")}>
      <Input value={value.join(", ")} onChange={(e) => onChange(e.target.value.split(",").map((v) => v.trim()).filter(Boolean))} />
    </Field>
  );
}

function Grid({ children }: { children: ReactNode }) {
  return <div className="cms-grid cms-gap-4 cms-sm-2">{children}</div>;
}

function SignIn({ s, u }: { s: AuthSettings; u: Update }) {
  const { t } = useT();
  return (
    <>
      <Card title={t("settings.general")}>
        <Field label={t("settings.applicationName")} hint={t("settings.shownOnSignInScreens")}><Input value={s.general.appName} onChange={(e) => u((d) => { d.general.appName = e.target.value; })} /></Field>
      </Card>
      <Card title={t("settings.signInMethods")}>
        <Toggle label={t("settings.emailAndPassword")} value={s.methods.password} onChange={(v) => u((d) => { d.methods.password = v; })} />
        <Toggle label={t("settings.passkeys")} hint={t("settings.passkeysHint")} value={s.methods.passkey} onChange={(v) => u((d) => { d.methods.passkey = v; })} />
        <Toggle label={t("settings.magicLink")} hint={t("settings.singleFactorHint")} value={s.methods.magicLink} onChange={(v) => u((d) => { d.methods.magicLink = v; })} />
        <Toggle label={t("settings.emailCode")} hint={t("settings.singleFactorHint")} value={s.methods.emailOtp} onChange={(v) => u((d) => { d.methods.emailOtp = v; })} />
        <Toggle label={t("settings.bearerTokens")} hint={t("settings.forHeadlessSitesOnAnother")} value={s.methods.bearer} onChange={(v) => u((d) => { d.methods.bearer = v; })} />
      </Card>
      <Card title={t("settings.registration")}>
        <Toggle label={t("settings.allowPublicSignUp")} hint={t("settings.offMeansOnlyAdministratorsCan")} value={s.signUp.enabled} onChange={(v) => u((d) => { d.signUp.enabled = v; })} />
        <Field label={t("settings.roleForNewAccounts")} hint={t("settings.cannotBeARoleWith")}><Input value={s.signUp.defaultRole} onChange={(e) => u((d) => { d.signUp.defaultRole = e.target.value; })} /></Field>
        <Field label={t("settings.logo")} hint={t("settings.aPathOnThisSite")}><Input value={s.general.logoUrl} onChange={(e) => u((d) => { d.general.logoUrl = e.target.value; })} /></Field>
        <Field label={t("settings.accentColour")} hint={t("settings.aHexColourSuchAs")}><Input value={s.general.accentColor} onChange={(e) => u((d) => { d.general.accentColor = e.target.value; })} /></Field>
        <ListField label={t("settings.onlyAllowTheseEmailDomains")} hint={t("settings.commaSeparatedLeaveEmptyTo")} value={s.signUp.allowedDomains} onChange={(v) => u((d) => { d.signUp.allowedDomains = v; })} />
        <ListField label={t("settings.blockTheseEmailDomains")} value={s.signUp.blockedDomains} onChange={(v) => u((d) => { d.signUp.blockedDomains = v; })} />
        <Toggle label={t("settings.requireAVerifiedEmail")} hint={t("settings.needsEmail")} value={s.emailVerification.required} onChange={(v) => u((d) => { d.emailVerification.required = v; })} />
        <NumberField label={t("settings.verificationLinkLifetimeSeconds")} value={s.emailVerification.tokenTtl} onChange={(v) => u((d) => { d.emailVerification.tokenTtl = v; })} />
      </Card>
    </>
  );
}

function Passwords({ s, u }: { s: AuthSettings; u: Update }) {
  const { t } = useT();
  return (
    <>
      <Card title={t("settings.passwordPolicy")} description={t("settings.owaspRecommendsAtLeast15")}>
        <Grid>
          <NumberField label={t("settings.minimumLength")} value={s.password.minLength} onChange={(v) => u((d) => { d.password.minLength = v; })} />
          <NumberField label={t("settings.maximumLength")} value={s.password.maxLength} onChange={(v) => u((d) => { d.password.maxLength = v; })} />
        </Grid>
        <NumberField label={t("settings.resetLinkLifetimeSeconds")} value={s.password.resetTokenTtl} onChange={(v) => u((d) => { d.password.resetTokenTtl = v; })} />
        <Toggle label={t("settings.signOutEverywhereAfterA")} value={s.password.revokeSessionsOnReset} onChange={(v) => u((d) => { d.password.revokeSessionsOnReset = v; })} />
      </Card>
      <Card title={t("settings.failedSignInLockout")} description={t("settings.countsFailuresPerAccountAnd")}>
        <Toggle label={t("settings.enableLockout")} value={s.lockout.enabled} onChange={(v) => u((d) => { d.lockout.enabled = v; })} />
        <Grid>
          <NumberField label={t("settings.failuresBeforeLockout")} value={s.lockout.maxFailures} onChange={(v) => u((d) => { d.lockout.maxFailures = v; })} />
          <NumberField label={t("settings.firstDelaySeconds")} value={s.lockout.baseDelaySeconds} onChange={(v) => u((d) => { d.lockout.baseDelaySeconds = v; })} />
          <NumberField label={t("settings.longestDelaySeconds")} value={s.lockout.maxDelaySeconds} onChange={(v) => u((d) => { d.lockout.maxDelaySeconds = v; })} />
        </Grid>
      </Card>
    </>
  );
}

function Sessions({ s, u }: { s: AuthSettings; u: Update }) {
  const { t } = useT();
  return (
    <Card title={t("settings.sessionLifetime")}>
      <Grid>
        <NumberField label={t("settings.idleTimeoutSeconds")} hint={t("settings.idleTimeoutHint")} value={s.session.idleTimeout} onChange={(v) => u((d) => { d.session.idleTimeout = v; })} />
        <NumberField label={t("settings.refreshIntervalSeconds")} hint={t("settings.howOftenActivityExtendsThe")} value={s.session.refreshAfter} onChange={(v) => u((d) => { d.session.refreshAfter = v; })} />
        <NumberField label={t("settings.absoluteTimeoutSeconds")} hint={t("settings.absoluteTimeoutHint")} value={s.session.absoluteTimeout} onChange={(v) => u((d) => { d.session.absoluteTimeout = v; })} />
        <NumberField label={t("settings.reAuthenticationWindowSeconds")} hint={t("settings.sensitiveActionsNeedASign")} value={s.session.freshFor} onChange={(v) => u((d) => { d.session.freshFor = v; })} />
        <NumberField label={t("settings.impersonationLengthSeconds")} value={s.session.impersonationDuration} onChange={(v) => u((d) => { d.session.impersonationDuration = v; })} />
      </Grid>
    </Card>
  );
}

function Mfa({ s, u }: { s: AuthSettings; u: Update }) {
  const { t } = useT();
  return (
    <Card title={t("settings.multiFactorAuthentication")}>
      <Toggle label={t("settings.authenticatorAppsTotp")} value={s.mfa.totp} onChange={(v) => u((d) => { d.mfa.totp = v; })} />
      <Toggle label={t("settings.codesByEmailAsA")} hint={t("settings.weakerThanAnAuthenticatorApp")} value={s.mfa.emailOtp} onChange={(v) => u((d) => { d.mfa.emailOtp = v; })} />
      <Toggle label={t("settings.requireMfaForDashboardUsers")} hint={t("settings.staffWithoutItAreSent")} value={s.mfa.requireForDashboard} onChange={(v) => u((d) => { d.mfa.requireForDashboard = v; })} />
    </Card>
  );
}

const NO_PROVIDER = { enabled: false, clientId: "", clientSecret: "" };

function OAuth({ s, u, baseUrl, providers }: { s: AuthSettings; u: Update; baseUrl: string; providers: Array<{ id: string; label: string }> }) {
  const { t } = useT();
  return (
    <>
      <Card title={t("settings.accountLinking")}>
        <Toggle label={t("settings.linkSocialSignInsTo")} hint={t("settings.onlyForProvidersThatVerify")} value={s.oauth.allowAccountLinking} onChange={(v) => u((d) => { d.oauth.allowAccountLinking = v; })} />
      </Card>
      {providers.length === 0 && <Alert kind="info">{t("settings.noProviders")}</Alert>}
      {providers.map(({ id, label }) => {
        const provider = s.oauth.providers[id] ?? NO_PROVIDER;
        const set = (change: Partial<typeof NO_PROVIDER>) => u((d) => { d.oauth.providers[id] = { ...(d.oauth.providers[id] ?? NO_PROVIDER), ...change }; });
        return (
          <Card key={id} title={label} description={t("settings.redirectUrl", { url: `${baseUrl}/api/auth/callback/${id}` })}>
            <Toggle label={t("settings.enabled")} value={provider.enabled} onChange={(v) => set({ enabled: v })} />
            <Grid>
              <Field label={t("settings.clientId")}><Input value={provider.clientId} onChange={(e) => set({ clientId: e.target.value })} /></Field>
              <Field label={t("settings.clientSecret")} hint={t("settings.encryptedAtRest")}><Input type="password" autoComplete="off" value={provider.clientSecret} onChange={(e) => set({ clientSecret: e.target.value })} /></Field>
            </Grid>
          </Card>
        );
      })}
    </>
  );
}

function RateLimits({ s, u }: { s: AuthSettings; u: Update }) {
  const { t } = useT();
  return (
    <Card title={t("settings.rateLimits")}>
      <Toggle label={t("settings.enableRateLimiting")} value={s.rateLimit.enabled} onChange={(v) => u((d) => { d.rateLimit.enabled = v; })} />
      <Grid>
        <NumberField label={t("settings.generalWindowSeconds")} value={s.rateLimit.window} onChange={(v) => u((d) => { d.rateLimit.window = v; })} />
        <NumberField label={t("settings.generalMaximum")} value={s.rateLimit.max} onChange={(v) => u((d) => { d.rateLimit.max = v; })} />
        <NumberField label={t("settings.signInWindowSeconds")} value={s.rateLimit.authWindow} onChange={(v) => u((d) => { d.rateLimit.authWindow = v; })} />
        <NumberField label={t("settings.signInMaximum")} value={s.rateLimit.authMax} onChange={(v) => u((d) => { d.rateLimit.authMax = v; })} />
        <NumberField label={t("settings.apiWritesWindowSeconds")} value={s.rateLimit.apiWriteWindow} onChange={(v) => u((d) => { d.rateLimit.apiWriteWindow = v; })} />
        <NumberField label={t("settings.apiWritesMaximum")} value={s.rateLimit.apiWriteMax} onChange={(v) => u((d) => { d.rateLimit.apiWriteMax = v; })} />
        <NumberField label={t("settings.apiReadsWindowSeconds")} hint={t("settings.perSignedInUserOr")} value={s.rateLimit.apiReadWindow} onChange={(v) => u((d) => { d.rateLimit.apiReadWindow = v; })} />
        <NumberField label={t("settings.apiReadsMaximum")} value={s.rateLimit.apiReadMax} onChange={(v) => u((d) => { d.rateLimit.apiReadMax = v; })} />
      </Grid>
      <Toggle label={t("settings.allowBatchRequestsPostApi")} value={s.batch.enabled} onChange={(v) => u((d) => { d.batch.enabled = v; })} />
      <Grid>
        <NumberField label={t("settings.batchMaximumRequests")} value={s.batch.maxRequests} onChange={(v) => u((d) => { d.batch.maxRequests = v; })} />
      </Grid>
    </Card>
  );
}

interface MailDelivery { active: string | null; plugins: string[] }

/** Which delivers mail: a plugin once it's set up, else SMTP. Each plugin links to its own settings. */
function Delivery({ delivery }: { delivery: MailDelivery }) {
  const { t } = useT();
  const word = usePluginWord();
  const name = (plugin: string) => word(plugin, "section", plugin);
  return (
    <Card title={t("settings.mailDelivery")} description={t("settings.mailDeliveryHint")}>
      {delivery.active
        ? <Alert kind="success">{t("settings.mailPlugin", { plugin: name(delivery.active) })}</Alert>
        : <Alert kind="warning">{t("settings.mailPluginNotReady", { plugin: delivery.plugins.map(name).join(", ") })}</Alert>}
      <div className="cms-flex cms-gap-3">
        {delivery.plugins.map((plugin) => (
          <ButtonLink key={plugin} variant="secondary" href={adminPath(`/extensions/${plugin}/settings`)}>{t("settings.openMailPlugin", { plugin: name(plugin) })}</ButtonLink>
        ))}
      </div>
    </Card>
  );
}

function Email({ s, u, canEdit, delivery }: { s: AuthSettings; u: Update; canEdit: boolean; delivery: MailDelivery }) {
  const { t } = useT();
  const { busy, error, run } = useAction();
  const [sent, setSent] = useState(false);
  const fallback = delivery.plugins.length > 0;
  return (
    <>
      {fallback && <Delivery delivery={delivery} />}
      <Card title={fallback ? t("settings.smtpFallback") : t("settings.smtp")} description={delivery.active ? t("settings.smtpUnused") : t("settings.neededForPasswordResetVerification")}>
        {error && <Alert>{error}</Alert>}
        {sent && <Alert kind="success">{t("settings.testSent")}</Alert>}
        <Grid>
          <Field label={t("settings.host")}><Input value={s.mail.host} onChange={(e) => u((d) => { d.mail.host = e.target.value; })} /></Field>
          <NumberField label={t("settings.port")} value={s.mail.port} onChange={(v) => u((d) => { d.mail.port = v; })} />
          <Field label={t("settings.username")}><Input autoComplete="off" value={s.mail.username} onChange={(e) => u((d) => { d.mail.username = e.target.value; })} /></Field>
          <Field label={t("settings.password")} hint={t("settings.encryptedAtRest")}><Input type="password" autoComplete="off" value={s.mail.password} onChange={(e) => u((d) => { d.mail.password = e.target.value; })} /></Field>
          <Field label={t("settings.fromAddress")}><Input value={s.mail.fromAddress} onChange={(e) => u((d) => { d.mail.fromAddress = e.target.value; })} /></Field>
          <Field label={t("settings.fromName")}><Input value={s.mail.fromName} onChange={(e) => u((d) => { d.mail.fromName = e.target.value; })} /></Field>
        </Grid>
        <Toggle label={t("settings.useImplicitTls")} hint={t("settings.usuallyPort465")} value={s.mail.secure} onChange={(v) => u((d) => { d.mail.secure = v; })} />
        <Toggle label={t("settings.requireStarttls")} hint={t("settings.refusesToSendOverAn")} value={s.mail.requireStartTls} onChange={(v) => u((d) => { d.mail.requireStartTls = v; })} />
      </Card>
      <Card title={t("settings.mailOptions")}>
        <Toggle label={t("settings.emailUsersAboutSecurityChanges")} hint={t("settings.passwordChangesAnd2faBeing")} value={s.mail.securityAlerts} onChange={(v) => u((d) => { d.mail.securityAlerts = v; })} />
        {canEdit && <Button variant="secondary" loading={busy} onClick={async () => setSent(await run(() => api(apiPath("/settings/auth/test-email"), { method: "POST" })))}>{t("settings.sendTest")}</Button>}
      </Card>
    </>
  );
}

function Security({ s, u }: { s: AuthSettings; u: Update }) {
  const { t } = useT();
  return (
    <>
      <Card title={t("settings.network")}>
        <ListField label={t("settings.clientIpHeaders")} hint={t("settings.headersYourReverseProxySets")} value={s.network.ipHeaders} onChange={(v) => u((d) => { d.network.ipHeaders = v; })} />
        <ListField label={t("settings.trustedProxies")} hint={t("settings.proxyIpsOrCidrRanges")} value={s.network.trustedProxies} onChange={(v) => u((d) => { d.network.trustedProxies = v; })} />
        <ListField label={t("settings.trustedOrigins")} hint={t("settings.otherSitesAllowedToCall")} value={s.network.trustedOrigins} onChange={(v) => u((d) => { d.network.trustedOrigins = v; })} />
      </Card>
      <Card title={t("settings.apiKeys")}>
        <Toggle label={t("settings.allowApiKeys")} value={s.apiKeys.enabled} onChange={(v) => u((d) => { d.apiKeys.enabled = v; })} />
        <NumberField label={t("settings.longestAllowedLifetimeDays")} value={s.apiKeys.maxLifetimeDays} onChange={(v) => u((d) => { d.apiKeys.maxLifetimeDays = v; })} />
      </Card>
      <Card title={t("settings.uploads")}>
        <NumberField label={t("settings.removeUnusedFormUploadsAfter")} value={s.files.unattachedRetentionDays} onChange={(v) => u((d) => { d.files.unattachedRetentionDays = v; })} />
      </Card>
      <Card title={t("settings.trash")}>
        <p className="cms-hint">{t("settings.trashHint")}</p>
        <Toggle label={t("settings.keepDeletedRecords")} value={s.trash.enabled} onChange={(v) => u((d) => { d.trash.enabled = v; })} />
        <NumberField label={t("settings.keepDeletedForDays")} value={s.trash.retentionDays} onChange={(v) => u((d) => { d.trash.retentionDays = v; })} />
      </Card>
      <Card title={t("settings.auditLog")}>
        <p className="cms-hint">{t("settings.auditAlwaysOn")}</p>
        <NumberField label={t("settings.keepEntriesForDays")} value={s.audit.retentionDays} onChange={(v) => u((d) => { d.audit.retentionDays = v; })} />
      </Card>
    </>
  );
}

export default function SettingsClient({ canEdit }: { canEdit: boolean }) {
  const { t } = useT();
  const remote = useApi<{ settings: AuthSettings; baseUrl: string; oauthProviders: Array<{ id: string; label: string }>; mail: MailDelivery }>(apiPath("/settings/auth"));
  const [settings, setSettings] = useState<AuthSettings | null>(null);
  // Other pages link straight to a tab, such as ?tab=logs from the request logs.
  const asked = useSearchParams().get("tab");
  const [tab, setTab] = useState<Tab>(() => ((TABS as readonly string[]).includes(asked ?? "") ? asked! : "signIn"));
  const { settingsTabs } = useAdminSlots();
  const word = usePluginWord();
  const activePluginTab = settingsTabs.find(({ id }) => tab === `plugin:${id}`);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (!remote.data) return;
    const timer = setTimeout(() => setSettings(remote.data!.settings));
    return () => clearTimeout(timer);
  }, [remote.data]);

  const update: Update = (mutate) => {
    setSaved(false);
    setSettings((current) => {
      if (!current) return current;
      const draft = structuredClone(current);
      mutate(draft);
      return draft;
    });
  };
  const save = async () => setSaved(await run(() => api(apiPath("/settings/auth"), { method: "PUT", body: settings })));

  if (remote.error) return <div className="cms-gutter"><Alert>{remote.error}</Alert></div>;
  if (!settings) return <PageSkeleton kind="form" />;

  return (
    <div>
      <PageHeader title={t("settings.settings")} description={t("settings.changesApplyToEveryServer")} actions={canEdit ? <Button loading={busy} onClick={save}>{t("settings.saveChanges")}</Button> : undefined} />
      <div className="cms-gutter cms-split">
        <nav className="cms-vnav" aria-label={t("settings.settings")}>
          {TABS.map((name) => (
            <button key={name} type="button" aria-current={tab === name ? "page" : undefined} onClick={() => setTab(name)} className={cn("cms-vnav-link", tab === name && "cms-vnav-link-active")}>{t(`settings.tabs.${name}`)}</button>
          ))}
          {settingsTabs.length > 0 && <span className="cms-vnav-label">{t("nav.Extensions")}</span>}
          {settingsTabs.map(({ id, title, plugin }) => (
            <button key={id} type="button" aria-current={tab === `plugin:${id}` ? "page" : undefined} onClick={() => setTab(`plugin:${id}`)} className={cn("cms-vnav-link", tab === `plugin:${id}` && "cms-vnav-link-active")}>{word(plugin, `tabs.${id}`, title)}</button>
          ))}
        </nav>
        <div className="cms-stack-4 cms-min-0">
        {error && <Alert>{error}</Alert>}
        {saved && <Alert kind="success">{t("settings.saved")}</Alert>}
        <fieldset disabled={!canEdit} className="cms-stack-4">
          {tab === "signIn" && <SignIn s={settings} u={update} />}
          {tab === "passwords" && <Passwords s={settings} u={update} />}
          {tab === "sessions" && <Sessions s={settings} u={update} />}
          {tab === "mfa" && <Mfa s={settings} u={update} />}
          {tab === "oauth" && <OAuth s={settings} u={update} baseUrl={remote.data!.baseUrl} providers={remote.data?.oauthProviders ?? []} />}
          {tab === "rateLimits" && <RateLimits s={settings} u={update} />}
          {tab === "email" && <Email s={settings} u={update} canEdit={canEdit} delivery={remote.data?.mail ?? { active: null, plugins: [] }} />}
          {tab === "security" && <Security s={settings} u={update} />}
        </fieldset>
        {activePluginTab && <PluginBoundary plugin={activePluginTab.plugin}><activePluginTab.component /></PluginBoundary>}
        </div>
      </div>
    </div>
  );
}
