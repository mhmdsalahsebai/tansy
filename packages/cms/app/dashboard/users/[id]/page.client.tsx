"use client";

import { useT } from "../../../../components/i18n";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Alert, Button, Card, Field, Input, PageHeader, PageSkeleton } from "../../../../components/ui/kit";
import UserFieldsForm, { type UserFieldValue } from "../../../../components/users/UserFieldsForm";
import { api, useAction, useApi } from "../../../../lib/client/api";
import { ownRoles, type RolesResponse, type UserRow } from "../page.client";
import { accountPath, adminPath, apiPath } from "../../../../lib/paths";

interface SessionRow { id: string; createdAt: string; expiresAt: string; ipAddress: string | null; userAgent: string | null; impersonatedBy: string | null }

export default function UserClient({ userId, selfId, permissions }: { userId: string; selfId: string; permissions: string[] }) {
  const { t, locale } = useT();
  const can = (permission: string) => permissions.includes(permission);
  const isSelf = userId === selfId;
  const user = useApi<UserRow & { banReason: string | null }>(apiPath(`/users/${userId}`));
  const roles = useApi<RolesResponse>(can("role:list") ? apiPath("/roles") : null);
  const sessions = useApi<SessionRow[]>(can("session:list") ? apiPath(`/users/${userId}/sessions`) : null);
  const customFields = useApi<UserFieldValue[]>(apiPath(`/users/${userId}/fields`));
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [password, setPassword] = useState("");
  const [banReason, setBanReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (!user.data) return;
    const timer = setTimeout(() => { setName(user.data!.name); setRole(user.data!.role ?? ""); });
    return () => clearTimeout(timer);
  }, [user.data]);

  const act = async (message: string, action: () => Promise<unknown>) => {
    setNotice(null);
    if (await run(action)) { setNotice(message); user.reload(); sessions.reload(); }
  };
  const path = apiPath(`/users/${userId}`);

  if (user.error) return <div className="cms-gutter"><Alert>{user.error}</Alert></div>;
  if (!user.data) return <PageSkeleton kind="detail" />;
  const banned = Boolean(user.data.banned);

  return (
    <div className="cms-gutter cms-stack-6">
      <PageHeader title={user.data.name} description={user.data.email} back={{ href: adminPath("/users"), label: t("user.backToUsers") }} />
      {isSelf && <Alert kind="info">{t("user.isSelf")} <Link className="cms-underline" href={accountPath()}>{t("user.yourAccountPage")}</Link>.</Alert>}
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {!isSelf && (
        <>
          {can("user:update") && customFields.data && <UserFieldsForm fields={customFields.data} url={apiPath(`/users/${userId}/fields`)} method="PUT" />}
          {can("user:update") && (
            <Card title={t("user.profile")}>
              <Field label={t("user.name")}><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Button loading={busy} onClick={() => act(t("user.profileSaved"), () => api(path, { method: "PATCH", body: { name } }))}>{t("user.save")}</Button>
            </Card>
          )}
          {can("user:set-role") && roles.data && (
            <Card title={t("user.role")} description={t("user.roleHint")}>
              <select className="cms-input" value={role} onChange={(e) => setRole(e.target.value)}>
                {ownRoles(roles.data.roles).map((r) => <option key={r.name} value={r.name}>{r.label}</option>)}
              </select>
              <Button loading={busy} onClick={() => act(t("user.roleUpdated"), () => api(`${path}/role`, { method: "PUT", body: { role } }))}>{t("user.updateRole")}</Button>
            </Card>
          )}
          {can("user:set-password") && (
            <Card title={t("user.setPassword")} description={t("user.setPasswordHint")}>
              <Field label={t("user.newPassword")}><Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
              <Button loading={busy} disabled={!password} onClick={() => act(t("user.passwordSet"), async () => { await api(`${path}/password`, { method: "PUT", body: { password } }); setPassword(""); })}>{t("user.setPassword")}</Button>
            </Card>
          )}
          {can("user:ban") && (
            <Card title={banned ? t("user.banned") : t("user.banUser")} description={banned ? user.data.banReason ?? undefined : t("user.banHint")}>
              {banned ? (
                <Button loading={busy} onClick={() => act(t("user.unbanned"), () => api(`${path}/ban`, { method: "DELETE" }))}>{t("user.removeBan")}</Button>
              ) : (
                <>
                  <Field label={t("user.reason")}><Input value={banReason} onChange={(e) => setBanReason(e.target.value)} /></Field>
                  <Button variant="danger" loading={busy} onClick={() => act(t("user.bannedDone"), () => api(`${path}/ban`, { method: "POST", body: { reason: banReason || undefined } }))}>{t("user.banUser")}</Button>
                </>
              )}
            </Card>
          )}
          {can("session:list") && (
            <Card title={t("user.sessions")} actions={can("session:revoke") ? <Button variant="secondary" loading={busy} onClick={() => act(t("user.sessionsRevoked"), () => api(`${path}/sessions`, { method: "DELETE" }))}>{t("user.revokeAll")}</Button> : undefined}>
              {sessions.data?.length === 0 && <p className="cms-muted">{t("user.noSessions")}</p>}
              <ul className="cms-divide cms-text-sm">
                {sessions.data?.map((s) => (
                  <li key={s.id} className="cms-py-2">
                    <span className="cms-block cms-truncate cms-strong">{s.userAgent ?? t("user.unknownDevice")}</span>
                    <span className="cms-hint">{s.ipAddress ?? t("user.unknownIp")} · {t("user.started", { when: new Date(s.createdAt).toLocaleString(locale) })}{s.impersonatedBy ? ` · ${t("user.impersonated")}` : ""}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {(can("user:impersonate") || can("user:delete")) && (
            <Card title={t("user.advanced")}>
              <div className="cms-flex cms-gap-2">
                {can("user:impersonate") && <Button variant="secondary" loading={busy} onClick={() => run(async () => { await api(`${path}/impersonate`, { method: "POST" }); window.location.href = "/"; })}>{t("user.impersonate")}</Button>}
                {can("user:delete") && <Button variant="danger" loading={busy} onClick={async () => { if (window.confirm(t("user.confirmDelete")) && await run(() => api(path, { method: "DELETE" }))) window.location.href = adminPath("/users"); }}>{t("user.deleteUser")}</Button>}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
