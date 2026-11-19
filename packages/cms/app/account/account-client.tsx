"use client";

import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState, type ReactNode } from "react";
import { Alert, Button, Card, Field, Input, Modal, PageHeader } from "../../components/ui/kit";
import { authClient } from "../../lib/auth-client";
import UserFieldsForm, { type UserFieldValue } from "../../components/users/UserFieldsForm";
import { api, unwrap, useAction, useApi } from "../../lib/client/api";
import { apiPath } from "../../lib/paths";
import { useT } from "../../components/i18n";
import { ADMIN_LOCALE_NAMES, ADMIN_LOCALES } from "../../core/i18n/catalogs";

interface Props { initialName: string; email: string; twoFactorEnabled: boolean; permissions: string[]; denied: boolean; enrollMfa: boolean; customFields: UserFieldValue[]; interfaceLocale: string | null; children?: ReactNode }

/** The dashboard's language for this person, saved on their profile and remembered by the browser. */
function InterfaceLanguage({ initial }: { initial: string | null }) {
  const { t } = useT();
  const [value, setValue] = useState(initial ?? "");
  const { busy, error, run } = useAction();
  const save = async (next: string) => {
    setValue(next);
    // The whole dashboard changes language, and right to left with it, so the page reloads.
    if (await run(() => api(apiPath("/account/locale"), { method: "PUT", body: { locale: next || null } }))) window.location.reload();
  };
  return (
    <Card title={t("account.language")} description={t("account.languageHint")}>
      {error && <Alert>{error}</Alert>}
      <Field label={t("account.language")}>
        <select className="cms-input" value={value} disabled={busy} onChange={(event) => void save(event.target.value)}>
          <option value="">{t("account.browserLanguage")}</option>
          {ADMIN_LOCALES.map((code) => <option key={code} value={code} lang={code}>{ADMIN_LOCALE_NAMES[code] ?? code}</option>)}
        </select>
      </Field>
    </Card>
  );
}

function Profile({ initialName, email }: { initialName: string; email: string }) {
  const { t } = useT();
  const [name, setName] = useState(initialName);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <Card title={t("account.profile")}>
      {error && <Alert>{error}</Alert>}
      {saved && <Alert kind="success">{t("account.saved")}</Alert>}
      <Field label={t("account.email")}><Input value={email} disabled /></Field>
      <Field label={t("account.name")}><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Button loading={busy} onClick={async () => setSaved(await run(() => unwrap(authClient.updateUser({ name }))))}>{t("account.save")}</Button>
    </Card>
  );
}

function Password() {
  const { t } = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await run(() => unwrap(authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true })));
    setSaved(ok);
    if (ok) { setCurrent(""); setNext(""); }
  };
  return (
    <Card title={t("account.password")} description={t("account.passwordHint")}>
      {error && <Alert>{error}</Alert>}
      {saved && <Alert kind="success">{t("account.passwordChanged")}</Alert>}
      <form onSubmit={submit} className="cms-stack-4">
        <Field label={t("account.currentPassword")}><Input required type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label={t("account.newPassword")}><Input required type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Button type="submit" loading={busy}>{t("account.changePassword")}</Button>
      </form>
    </Card>
  );
}

function TwoFactor({ enabled }: { enabled: boolean }) {
  const { t } = useT();
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<{ uri: string; backupCodes: string[] } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const { busy, error, run } = useAction();

  const start = () => run(async () => {
    const data = await unwrap(authClient.twoFactor.enable({ password }));
    if (data?.method !== "totp") throw new Error(t("account.setupFailed"));
    setSetup({ uri: data.totpURI, backupCodes: data.backupCodes });
    setPassword("");
  });
  const confirm = () => run(async () => {
    await unwrap(authClient.twoFactor.verifyTotp({ code }));
    setCodes(setup?.backupCodes ?? []);
    setSetup(null);
  });
  const disable = async () => {
    if (await run(() => unwrap(authClient.twoFactor.disable({ password })))) window.location.reload();
  };
  const regenerate = () => run(async () => {
    const data = await unwrap(authClient.twoFactor.generateBackupCodes({ password }));
    setCodes(data?.backupCodes ?? []);
    setPassword("");
  });

  return (
    <Card title={t("account.twoFactor")} description={t("account.twoFactorHint")}>
      {error && <Alert>{error}</Alert>}
      {codes && (
        <div className="cms-stack-3">
          <Alert kind="warning">{t("account.backupCodes")}</Alert>
          <pre className="cms-codes">{codes.map((c) => <span key={c}>{c}</span>)}</pre>
          <Button variant="secondary" onClick={() => window.location.reload()}>{t("account.savedThem")}</Button>
        </div>
      )}
      {setup && (
        <div className="cms-stack-3">
          <p className="cms-text-sm cms-soft">{t("account.scan")}</p>
          <div className="cms-qr"><QRCodeSVG value={setup.uri} size={176} /></div>
          <Field label={t("account.code")}><Input autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <Button loading={busy} onClick={confirm}>{t("account.turnOn")}</Button>
        </div>
      )}
      {!setup && !codes && (
        <>
          <p className="cms-text-sm cms-soft">{t("account.statusLabel")} <strong>{enabled ? t("account.on") : t("account.off")}</strong></p>
          <Field label={t("account.confirmPassword")}><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <div className="cms-flex cms-gap-2">
            {enabled ? (
              <>
                <Button variant="secondary" loading={busy} disabled={!password} onClick={regenerate}>{t("account.newBackupCodes")}</Button>
                <Button variant="danger" loading={busy} disabled={!password} onClick={disable}>{t("account.turnOff")}</Button>
              </>
            ) : (
              <Button loading={busy} disabled={!password} onClick={start}>{t("account.setUp")}</Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

interface PasskeyRow { id: string; name?: string | null; createdAt?: string | Date | null }

function Passkeys() {
  const { t } = useT();
  const [keys, setKeys] = useState<PasskeyRow[]>([]);
  const [tick, setTick] = useState(0);
  const [name, setName] = useState("");
  const { busy, error, run } = useAction();
  useEffect(() => {
    let active = true;
    authClient.passkey.listUserPasskeys().then((result) => { if (active) setKeys((result.data as PasskeyRow[] | null) ?? []); });
    return () => { active = false; };
  }, [tick]);
  const refresh = () => setTick((t) => t + 1);
  return (
    <Card title={t("account.passkeys")} description={t("account.passkeysHint")}>
      {error && <Alert>{error}</Alert>}
      <ul className="cms-divide">
        {keys.map((key) => (
          <li key={key.id} className="cms-row cms-between cms-py-2 cms-text-sm cms-body">
            <span>{key.name || t("account.unnamedPasskey")}</span>
            <Button variant="secondary" onClick={() => run(async () => { await unwrap(authClient.passkey.deletePasskey({ id: key.id })); refresh(); })}>{t("account.remove")}</Button>
          </li>
        ))}
      </ul>
      <div className="cms-flex cms-gap-2">
        <Input placeholder={t("account.passkeyName")} value={name} onChange={(e) => setName(e.target.value)} />
        <Button loading={busy} className="cms-no-shrink" onClick={() => run(async () => { await unwrap(authClient.passkey.addPasskey({ name })); setName(""); refresh(); })}>{t("account.addPasskey")}</Button>
      </div>
    </Card>
  );
}

interface SessionRow { id: string; token: string; createdAt: string | Date; ipAddress?: string | null; userAgent?: string | null }

function Sessions() {
  const { t, locale } = useT();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [tick, setTick] = useState(0);
  const { busy, error, run } = useAction();
  useEffect(() => {
    let active = true;
    authClient.listSessions().then((result) => { if (active) setSessions((result.data as SessionRow[] | null) ?? []); });
    return () => { active = false; };
  }, [tick]);
  const refresh = () => setTick((t) => t + 1);
  return (
    <Card title={t("account.devices")} actions={<Button variant="secondary" loading={busy} onClick={() => run(async () => { await unwrap(authClient.revokeOtherSessions()); refresh(); })}>{t("account.signOutOthers")}</Button>}>
      {error && <Alert>{error}</Alert>}
      <ul className="cms-divide">
        {sessions.map((session) => (
          <li key={session.id} className="cms-row cms-between cms-gap-3 cms-py-2 cms-text-sm">
            <span className="cms-min-0">
              <span className="cms-block cms-truncate cms-strong">{session.userAgent ?? t("account.unknownDevice")}</span>
              <span className="cms-hint">{session.ipAddress ?? t("account.unknownIp")} · {new Date(session.createdAt).toLocaleString(locale)}</span>
            </span>
            <Button variant="secondary" onClick={() => run(async () => { await unwrap(authClient.revokeSession({ token: session.token })); refresh(); })}>{t("account.signOut")}</Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

interface ApiKeyRow { id: string; name: string | null; start: string | null; expiresAt: string | null; lastRequest: string | null; permissions: string[] }

function ApiKeys({ permissions }: { permissions: string[] }) {
  const { t, locale } = useT();
  const canCreate = permissions.includes("api-key:create");
  const canRevoke = permissions.includes("api-key:revoke");
  const list = useApi<ApiKeyRow[]>(apiPath("/account/api-keys"));
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [days, setDays] = useState(90);
  const [selected, setSelected] = useState<string[]>([]);
  const [created, setCreated] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const grantable = permissions.filter((p) => p.startsWith("record:") || p.startsWith("collection:read") || p.startsWith("ext."));
  const create = async () => {
    const ok = await run(async () => {
      const result = await api<{ key: string }>(apiPath("/account/api-keys"), { method: "POST", body: { name, permissions: selected, expiresInDays: days } });
      setCreated(result.key);
    });
    if (ok) { setOpen(false); setName(""); setSelected([]); list.reload(); }
  };
  return (
    <Card title={t("account.apiKeys")} description={t("account.apiKeysHint")} actions={canCreate ? <Button onClick={() => setOpen(true)}>{t("account.newKey")}</Button> : undefined}>
      {list.error && <Alert>{list.error}</Alert>}
      {error && !open && <Alert>{error}</Alert>}
      {created && <Alert kind="warning">{t("account.copyKey")}{"\n"}<code className="cms-break-all">{created}</code></Alert>}
      <ul className="cms-divide">
        {list.data?.map((key) => (
          <li key={key.id} className="cms-row cms-between cms-gap-3 cms-py-2 cms-text-sm">
            <span>
              <span className="cms-block cms-strong">{key.name} <code className="cms-hint">{key.start}…</code></span>
              <span className="cms-hint">{key.expiresAt ? t("account.expires", { date: new Date(key.expiresAt).toLocaleDateString(locale) }) : t("account.noExpiry")} · {t("account.permissionCount", { count: key.permissions.length })}</span>
            </span>
            {canRevoke && <Button variant="secondary" onClick={() => run(async () => { await api(apiPath(`/account/api-keys/${key.id}`), { method: "DELETE" }); list.reload(); })}>{t("account.revoke")}</Button>}
          </li>
        ))}
      </ul>
      <Modal open={open} onClose={() => setOpen(false)} title={t("account.newApiKey")}>
        <div className="cms-stack-4">
          {error && <Alert>{error}</Alert>}
          <Field label={t("account.name")}><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t("account.expiresInDays")}><Input type="number" min={1} value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field>
          <fieldset className="cms-scroll-48 cms-stack-1">
            <legend className="cms-label cms-mb-1">{t("account.permissions")}</legend>
            {grantable.map((permission) => (
              <label key={permission} className="cms-check-label">
                <input type="checkbox" checked={selected.includes(permission)} onChange={(e) => setSelected(e.target.checked ? [...selected, permission] : selected.filter((p) => p !== permission))} />
                {permission}
              </label>
            ))}
          </fieldset>
          <div className="cms-flex cms-end cms-gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>{t("account.cancel")}</Button>
            <Button loading={busy} disabled={!name || selected.length === 0} onClick={create}>{t("account.create")}</Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

/** `children` are plugins' account panels, after the person's own details. */
export default function AccountClient({ initialName, email, twoFactorEnabled, permissions, denied, enrollMfa, customFields, interfaceLocale, children }: Props) {
  const { t } = useT();
  return (
    <div className="cms-gutter cms-stack-6">
      <PageHeader title={t("account.yourAccount")} />
      {denied && <Alert kind="warning">{t("account.denied")}</Alert>}
      {enrollMfa && <Alert kind="warning">{t("account.enrollMfa")}</Alert>}
      <Profile initialName={initialName} email={email} />
      {children}
      <InterfaceLanguage initial={interfaceLocale} />
      <UserFieldsForm fields={customFields} url={apiPath("/account/fields")} method="PATCH" own />
      <Password />
      <TwoFactor enabled={twoFactorEnabled} />
      <Passkeys />
      <Sessions />
      {permissions.includes("api-key:list") && <ApiKeys permissions={permissions} />}
    </div>
  );
}
