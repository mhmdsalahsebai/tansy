"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { adminPath, Alert, apiPath, Badge, Button, ButtonLink, Card, DataTable, Field, Input, Modal, PageHeader, useT } from "tansy/admin";

/**
 * The Tenants section and the account panel. Everything goes through this plugin's guarded
 * routes as the signed-in person, which decide what they may see and do. Hiding a button here
 * is only a convenience.
 */

class CallError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function call<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(apiPath(`/ext/multi-tenant${path}`), {
    method: options.method ?? "GET",
    headers: options.body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 204) return null as T;
  const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) {
    const code = payload?.error?.code ?? "ERROR";
    // Creating a tenant needs a recent sign-in, as other sensitive steps do.
    if (code === "REAUTH_REQUIRED") window.location.href = adminPath(`/auth/signin?reauth=1&next=${encodeURIComponent(window.location.pathname)}`);
    throw new CallError(response.status, code, payload?.error?.message ?? "Request failed.");
  }
  return payload as T;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Reads one of this plugin's routes, with a way to read it again. */
function useCall<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<CallError | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (path === null) return;
    let live = true;
    call<T>(path)
      .then((result) => { if (live) { setData(result); setError(null); } })
      .catch((failure: unknown) => { if (live) setError(failure instanceof CallError ? failure : new CallError(0, "ERROR", message(failure))); });
    return () => { live = false; };
  }, [path, version]);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return { data, error, reload };
}

/** Makes a tenant the one this session works in, then reloads, since every page can depend on it. */
async function workIn(tenant: string | null, then?: string) {
  await call("/switcher", { method: "POST", body: { value: tenant } });
  if (then) window.location.href = then;
  else window.location.reload();
}

interface TenantItem { id: string; name: string; slug: string; status: "active" | "suspended"; roles: string[] }
interface RoleItem { name: string; label: string }
interface MemberItem { id: string; userId: string; name: string | null; email: string | null; roles: string[] }
interface InvitationItem { id: string; email: string; roles: string[]; expiresAt: string | null }

function RoleBadges({ roles, labels }: { roles: string[]; labels?: Map<string, string> }) {
  return <span className="cms-row cms-gap-1">{roles.map((role) => <Badge key={role} tight>{labels?.get(role) ?? role}</Badge>)}</span>;
}

/** Ticks for the tenant roles someone may give. */
function RolePicker({ roles, value, onChange }: { roles: RoleItem[]; value: string[]; onChange: (roles: string[]) => void }) {
  const { t } = useT();
  if (!roles.length) return <Alert kind="warning">{t("ext.multi-tenant.members.noRolesToGive")}</Alert>;
  return (
    <fieldset className="cms-stack-2">
      <legend className="cms-label cms-mb-1">{t("ext.multi-tenant.members.roles")}</legend>
      {roles.map((role) => (
        <label key={role.name} className="cms-check-label">
          <input type="checkbox" className="cms-check" checked={value.includes(role.name)} onChange={(event) => onChange(event.target.checked ? [...value, role.name] : value.filter((name) => name !== role.name))} />
          {role.label}
        </label>
      ))}
      <p className="cms-hint">{t("ext.multi-tenant.members.rolesHint")}</p>
    </fieldset>
  );
}

/** Every tenant the person can work in, with a way to switch and, for those who may, to make one. */
interface Limits { records: number | null; storageBytes: number | null; members: number | null; requestsPerMinute: number | null }
interface PlanView { tenant: TenantItem; limits: Limits; usage: { records: number; storageBytes: number; files: number; members: number }; purgeAt: string | null }

const LIMIT_KEYS = ["records", "storageBytes", "members", "requestsPerMinute"] as const;

/**
 * One tenant's plan and danger zone, for instance staff: what it uses against its limits,
 * suspending and resuming it, downloading everything it has, and asking for it to be removed.
 */
function TenantManage({ tenant, canUpdate, canDelete, onChanged }: { tenant: TenantItem; canUpdate: boolean; canDelete: boolean; onChanged: () => void }) {
  const { t, locale } = useT();
  const word = (key: string, values?: Record<string, string | number>) => t(`ext.multi-tenant.manage.${key}`, values);
  const plan = useCall<PlanView>(`/tenants/${tenant.id}/plan`);
  const [limits, setLimits] = useState<Record<string, string> | null>(null);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!plan.data) return;
    const timer = setTimeout(() => setLimits(Object.fromEntries(LIMIT_KEYS.map((key) => [key, plan.data!.limits[key] === null ? "" : String(plan.data!.limits[key])]))));
    return () => clearTimeout(timer);
  }, [plan.data]);

  const act = async (name: string, work: () => Promise<unknown>, done: string) => {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
      plan.reload();
      onChanged();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(null);
    }
  };

  const saveLimits = (event: FormEvent) => {
    event.preventDefault();
    const body = Object.fromEntries(LIMIT_KEYS.map((key) => [key, limits?.[key]?.trim() ? Number(limits[key]) : null]));
    void act("limits", () => call(`/tenants/${tenant.id}/limits`, { method: "PUT", body }), word("limitsSaved"));
  };

  const number = (value: number) => value.toLocaleString(locale);
  const data = plan.data;
  const suspended = (data?.tenant.status ?? tenant.status) === "suspended";
  return (
    <div className="cms-stack-4">
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {plan.error && <Alert>{plan.error.message}</Alert>}
      {data && limits && (
        <form onSubmit={saveLimits} className="cms-stack-3">
          <h3 className="cms-strong">{word("limits")}</h3>
          <p className="cms-hint">{word("limitsHint")}</p>
          {LIMIT_KEYS.map((key) => (
            <Field key={key} label={word(`limit.${key}`)} hint={key === "requestsPerMinute" ? undefined : word("used", { count: number(data.usage[key]) })}>
              <Input type="number" min={0} step={1} inputMode="numeric" dir="ltr" disabled={!canUpdate} placeholder={word("noLimit")} value={limits[key]} onChange={(event) => setLimits({ ...limits, [key]: event.target.value })} />
            </Field>
          ))}
          {canUpdate && <div className="cms-flex cms-end"><Button type="submit" loading={busy === "limits"}>{word("saveLimits")}</Button></div>}
        </form>
      )}
      {canDelete && data && (
        <Card>
          <div className="cms-stack-3">
            <h3 className="cms-strong">{word("danger")}</h3>
            <p className="cms-hint">{suspended ? word("suspendedHint") : word("activeHint")}</p>
            <div className="cms-row cms-gap-2">
              {suspended
                ? <Button variant="secondary" loading={busy === "resume"} onClick={() => void act("resume", () => call(`/tenants/${tenant.id}/resume`, { method: "POST" }), word("resumed"))}>{word("resume")}</Button>
                : <Button variant="danger" loading={busy === "suspend"} onClick={() => void act("suspend", () => call(`/tenants/${tenant.id}/suspend`, { method: "POST" }), word("suspendedDone"))}>{word("suspend")}</Button>}
              <ButtonLink native variant="secondary" href={apiPath(`/ext/multi-tenant/tenants/${tenant.id}/export`)}>{word("export")}</ButtonLink>
            </div>
            {suspended && (data.purgeAt
              ? (
                <div className="cms-stack-2">
                  <Alert kind="warning">{word("purgeScheduled", { date: new Date(data.purgeAt).toLocaleString(locale) })}</Alert>
                  <div><Button variant="secondary" loading={busy === "cancel"} onClick={() => void act("cancel", () => call(`/tenants/${tenant.id}/purge`, { method: "DELETE" }), word("purgeCancelled"))}>{word("cancelPurge")}</Button></div>
                </div>
              )
              : (
                <form className="cms-stack-2" onSubmit={(event) => { event.preventDefault(); void act("purge", () => call(`/tenants/${tenant.id}/purge`, { method: "POST", body: { confirm } }), word("purgeAsked")); }}>
                  <Field label={word("purgeConfirm", { slug: tenant.slug })} hint={word("purgeHint")}><Input value={confirm} dir="ltr" autoComplete="off" onChange={(event) => setConfirm(event.target.value)} /></Field>
                  <div><Button type="submit" variant="danger" disabled={confirm !== tenant.slug} loading={busy === "purge"}>{word("purge")}</Button></div>
                </form>
              ))}
          </div>
        </Card>
      )}
    </div>
  );
}

export function TenantsList({ canCreate, canManage = false, canUpdate = false, canDelete = false }: { canCreate: boolean; canManage?: boolean; canUpdate?: boolean; canDelete?: boolean }) {
  const { t } = useT();
  const word = (key: string, values?: Record<string, string | number>) => t(`ext.multi-tenant.tenants.${key}`, values);
  const tenants = useCall<{ current: string | null; items: TenantItem[] }>("/tenants");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", slug: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [managing, setManaging] = useState<TenantItem | null>(null);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await call<TenantItem>("/tenants", { method: "POST", body: form });
      setCreating(false);
      setForm({ name: "", slug: "" });
      setNotice(word("created", { name: created.name }));
      tenants.reload();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  };

  const switchTo = async (id: string) => {
    setError(null);
    try {
      await workIn(id);
    } catch (failure) {
      setError(message(failure));
    }
  };

  const current = tenants.data?.current ?? null;
  return (
    <div className="cms-gutter cms-stack-6">
      <PageHeader title={t("ext.multi-tenant.pages.tenants")} description={word("description")} actions={canCreate ? <Button onClick={() => setCreating(true)}>{word("new")}</Button> : undefined} />
      {notice && <Alert kind="success">{notice}</Alert>}
      {error && !creating && <Alert>{error}</Alert>}
      {tenants.error && <Alert>{tenants.error.message}</Alert>}
      <DataTable
        label={word("list")}
        columns={[
          { id: "name", label: word("columnName") },
          { id: "slug", label: word("columnSlug") },
          { id: "status", label: word("columnStatus") },
          { id: "roles", label: word("columnRoles") },
        ]}
        rows={tenants.data ? tenants.data.items.map((tenant) => ({
          id: tenant.id,
          cells: {
            name: <span className="cms-row cms-gap-2"><span className="cms-strong">{tenant.name}</span>{tenant.id === current && <Badge tone="info" tight>{word("current")}</Badge>}</span>,
            slug: <code>{tenant.slug}</code>,
            status: <Badge tone={tenant.status === "active" ? "success" : "warning"} tight>{word(tenant.status)}</Badge>,
            roles: tenant.roles.length ? <RoleBadges roles={tenant.roles} /> : <span className="cms-muted">{word("noRoles")}</span>,
          },
          actions: (
            <span className="cms-row cms-gap-2">
              {tenant.status === "active" && tenant.id !== current && <button type="button" className="cms-row-action" onClick={() => void switchTo(tenant.id)}>{word("switchTo")}</button>}
              {canManage && <button type="button" className="cms-row-action" onClick={() => setManaging(tenant)}>{word("manage")}</button>}
            </span>
          ),
        })) : null}
        empty={{ title: word("empty"), hint: word("emptyHint") }}
      />
      <Modal open={managing !== null} onClose={() => setManaging(null)} title={managing?.name ?? ""}>
        {managing && <TenantManage tenant={managing} canUpdate={canUpdate} canDelete={canDelete} onChanged={tenants.reload} />}
      </Modal>
      <Modal open={creating} onClose={() => setCreating(false)} title={word("new")}>
        <form onSubmit={create} className="cms-stack-4">
          {error && <Alert>{error}</Alert>}
          <Field label={word("name")}><Input required maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
          <Field label={word("slug")} hint={word("slugHint")}><Input required pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value })} /></Field>
          <div className="cms-flex cms-end cms-gap-2">
            <Button variant="secondary" onClick={() => setCreating(false)}>{word("cancel")}</Button>
            <Button type="submit" loading={busy}>{word("create")}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/** The current tenant's members and open invitations. */
export function TenantMembers({ canRename }: { canRename: boolean }) {
  const { t, formatDate } = useT();
  const word = (key: string, values?: Record<string, string | number>) => t(`ext.multi-tenant.members.${key}`, values);
  const invitationWord = (key: string, values?: Record<string, string | number>) => t(`ext.multi-tenant.invitations.${key}`, values);
  const tenant = useCall<{ id: string; name: string }>("/tenant");
  const ready = Boolean(tenant.data);
  const members = useCall<{ items: MemberItem[] }>(ready ? "/members" : null);
  const invitations = useCall<{ items: InvitationItem[] }>(ready ? "/invitations" : null);
  const roles = useCall<{ items: RoleItem[] }>(ready ? "/roles" : null);
  const [editing, setEditing] = useState<{ member: MemberItem; roles: string[] } | null>(null);
  const [inviting, setInviting] = useState<{ email: string; roles: string[] } | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      if (done) setNotice(done);
      return true;
    } catch (failure) {
      setError(message(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (tenant.error?.code === "SCOPE_REQUIRED") {
    return <div className="cms-gutter cms-stack-6"><PageHeader title={t("ext.multi-tenant.pages.tenants/members")} /><Alert kind="info">{word("chooseFirst")}</Alert></div>;
  }
  const labels = new Map((roles.data?.items ?? []).map((role) => [role.name, role.label]));
  const giveable = roles.data?.items ?? [];

  const saveRoles = async () => {
    if (!editing) return;
    if (await run(() => call(`/members/${encodeURIComponent(editing.member.id)}`, { method: "PATCH", body: { roles: editing.roles } }))) {
      setEditing(null);
      members.reload();
    }
  };
  const remove = async (member: MemberItem) => {
    if (!window.confirm(word("confirmRemove", { name: member.name ?? member.email ?? member.userId }))) return;
    if (await run(() => call(`/members/${encodeURIComponent(member.id)}`, { method: "DELETE" }))) members.reload();
  };
  const invite = async (event: FormEvent) => {
    event.preventDefault();
    if (!inviting) return;
    if (await run(() => call("/invitations", { method: "POST", body: inviting }), invitationWord("sent", { email: inviting.email }))) {
      setInviting(null);
      invitations.reload();
    }
  };
  const cancelInvitation = async (invitation: InvitationItem) => {
    if (await run(() => call(`/invitations/${encodeURIComponent(invitation.id)}`, { method: "DELETE" }))) invitations.reload();
  };
  const rename = async (event: FormEvent) => {
    event.preventDefault();
    if (name !== null && await run(() => call("/tenant", { method: "PATCH", body: { name } }), word("renamed"))) tenant.reload();
  };

  return (
    <div className="cms-gutter cms-stack-6">
      <PageHeader
        title={t("ext.multi-tenant.pages.tenants/members")}
        description={tenant.data ? word("description", { tenant: tenant.data.name }) : undefined}
        actions={<Button onClick={() => { setError(null); setInviting({ email: "", roles: [] }); }}>{word("invite")}</Button>}
      />
      {notice && <Alert kind="success">{notice}</Alert>}
      {error && !editing && !inviting && <Alert>{error}</Alert>}
      {tenant.error && <Alert>{tenant.error.message}</Alert>}
      {members.error && <Alert>{members.error.message}</Alert>}
      <DataTable
        label={word("list")}
        title={word("list")}
        columns={[
          { id: "name", label: word("columnName") },
          { id: "email", label: word("columnEmail") },
          { id: "roles", label: word("columnRoles") },
        ]}
        rows={members.data ? members.data.items.map((member) => ({
          id: member.id,
          cells: { name: member.name ?? "—", email: member.email ?? "—", roles: <RoleBadges roles={member.roles} labels={labels} /> },
          actions: (
            <>
              <button type="button" className="cms-row-action" onClick={() => { setError(null); setEditing({ member, roles: member.roles }); }}>{word("editRoles")}</button>
              <button type="button" className="cms-row-action cms-row-action-danger" onClick={() => void remove(member)}>{word("remove")}</button>
            </>
          ),
        })) : null}
        empty={{ title: word("empty"), hint: word("emptyHint") }}
      />
      <DataTable
        label={invitationWord("list")}
        title={invitationWord("list")}
        columns={[
          { id: "email", label: invitationWord("columnEmail") },
          { id: "roles", label: invitationWord("columnRoles") },
          { id: "expires", label: invitationWord("columnExpires") },
        ]}
        rows={invitations.data ? invitations.data.items.map((invitation) => ({
          id: invitation.id,
          cells: { email: invitation.email, roles: <RoleBadges roles={invitation.roles} labels={labels} />, expires: invitation.expiresAt ? formatDate(invitation.expiresAt) : "—" },
          actions: <button type="button" className="cms-row-action cms-row-action-danger" onClick={() => void cancelInvitation(invitation)}>{invitationWord("cancelInvitation")}</button>,
        })) : null}
        empty={{ title: invitationWord("empty"), hint: invitationWord("emptyHint") }}
      />
      {canRename && tenant.data && (
        <Card title={word("details")}>
          <form onSubmit={rename} className="cms-stack-4">
            <Field label={word("name")}><Input required maxLength={120} value={name ?? tenant.data.name} onChange={(event) => setName(event.target.value)} /></Field>
            <div className="cms-flex cms-end"><Button type="submit" loading={busy}>{word("rename")}</Button></div>
          </form>
        </Card>
      )}
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={word("editRoles")}>
        {editing && (
          <div className="cms-stack-4">
            {error && <Alert>{error}</Alert>}
            <RolePicker roles={giveable} value={editing.roles} onChange={(next) => setEditing({ ...editing, roles: next })} />
            <div className="cms-flex cms-end cms-gap-2">
              <Button variant="secondary" onClick={() => setEditing(null)}>{word("cancel")}</Button>
              <Button loading={busy} disabled={!editing.roles.length} onClick={() => void saveRoles()}>{word("save")}</Button>
            </div>
          </div>
        )}
      </Modal>
      <Modal open={inviting !== null} onClose={() => setInviting(null)} title={invitationWord("title")}>
        {inviting && (
          <form onSubmit={invite} className="cms-stack-4">
            {error && <Alert>{error}</Alert>}
            <Field label={invitationWord("email")}><Input type="email" required maxLength={254} value={inviting.email} onChange={(event) => setInviting({ ...inviting, email: event.target.value })} /></Field>
            <RolePicker roles={giveable} value={inviting.roles} onChange={(next) => setInviting({ ...inviting, roles: next })} />
            <div className="cms-flex cms-end cms-gap-2">
              <Button variant="secondary" onClick={() => setInviting(null)}>{word("cancel")}</Button>
              <Button type="submit" loading={busy} disabled={!inviting.roles.length}>{invitationWord("send")}</Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

interface DomainItem { id: number; host: string; primary: boolean; verified: boolean; verifiedAt: string | null; checkedAt: string | null; record: { type: string; name: string; value: string } }

/** The current tenant's domains: adding one, the TXT record that proves it, checking it, and choosing the main one. */
export function TenantDomains() {
  const { t, formatDate } = useT();
  const word = (key: string, values?: Record<string, string | number>) => t(`ext.multi-tenant.domains.${key}`, values);
  const tenant = useCall<{ id: string; name: string }>("/tenant");
  const domains = useCall<{ items: DomainItem[] }>(tenant.data ? "/domains" : null);
  const [adding, setAdding] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (tenant.error?.code === "SCOPE_REQUIRED") {
    return <div className="cms-gutter cms-stack-6"><PageHeader title={t("ext.multi-tenant.pages.tenants/domains")} /><Alert kind="info">{word("chooseFirst")}</Alert></div>;
  }

  const run = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      if (done) setNotice(done);
      domains.reload();
      return true;
    } catch (failure) {
      setError(message(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (adding !== null && await run(() => call("/domains", { method: "POST", body: { host: adding } }))) setAdding(null);
  };
  const remove = async (domain: DomainItem) => {
    if (window.confirm(word("confirmRemove", { host: domain.host }))) await run(() => call(`/domains/${domain.id}`, { method: "DELETE" }));
  };

  const pending = (domains.data?.items ?? []).filter((domain) => !domain.verified);
  return (
    <div className="cms-gutter cms-stack-6">
      <PageHeader
        title={t("ext.multi-tenant.pages.tenants/domains")}
        description={tenant.data ? word("description", { tenant: tenant.data.name }) : undefined}
        actions={<Button onClick={() => { setError(null); setAdding(""); }}>{word("add")}</Button>}
      />
      {notice && <Alert kind="success">{notice}</Alert>}
      {error && adding === null && <Alert>{error}</Alert>}
      {tenant.error && <Alert>{tenant.error.message}</Alert>}
      {domains.error && <Alert>{domains.error.message}</Alert>}
      <DataTable
        label={word("list")}
        columns={[
          { id: "host", label: word("columnHost") },
          { id: "state", label: word("columnState") },
        ]}
        rows={domains.data ? domains.data.items.map((domain) => ({
          id: String(domain.id),
          cells: {
            host: <span className="cms-row cms-gap-2"><code>{domain.host}</code>{domain.primary && <Badge tone="info" tight>{word("primary")}</Badge>}</span>,
            state: domain.verified
              ? <Badge tone="success" tight>{word("verified")}</Badge>
              : <span className="cms-row cms-gap-2"><Badge tone="warning" tight>{word("waiting")}</Badge>{domain.checkedAt && <span className="cms-muted">{word("checked", { date: formatDate(domain.checkedAt) })}</span>}</span>,
          },
          actions: (
            <>
              {!domain.verified && <button type="button" className="cms-row-action" disabled={busy} onClick={() => void run(() => call(`/domains/${domain.id}/verify`, { method: "POST" }), word("verifiedNotice", { host: domain.host }))}>{word("verify")}</button>}
              {domain.verified && !domain.primary && <button type="button" className="cms-row-action" disabled={busy} onClick={() => void run(() => call(`/domains/${domain.id}/primary`, { method: "POST" }))}>{word("makePrimary")}</button>}
              <button type="button" className="cms-row-action cms-row-action-danger" disabled={busy} onClick={() => void remove(domain)}>{word("remove")}</button>
            </>
          ),
        })) : null}
        empty={{ title: word("empty"), hint: word("emptyHint") }}
      />
      {pending.length > 0 && (
        <Card title={word("howTitle")}>
          <div className="cms-stack-4">
            <p>{word("how")}</p>
            {pending.map((domain) => (
              <dl key={domain.id} className="cms-stack-1">
                <dt className="cms-strong">{domain.host}</dt>
                <dd>{word("recordType", { type: domain.record.type })}</dd>
                <dd>{word("recordName")} <code>{domain.record.name}</code></dd>
                <dd>{word("recordValue")} <code>{domain.record.value}</code></dd>
              </dl>
            ))}
          </div>
        </Card>
      )}
      <Modal open={adding !== null} onClose={() => setAdding(null)} title={word("add")}>
        {adding !== null && (
          <form onSubmit={add} className="cms-stack-4">
            {error && <Alert>{error}</Alert>}
            <Field label={word("host")} hint={word("hostHint")}><Input required maxLength={253} value={adding} onChange={(event) => setAdding(event.target.value)} /></Field>
            <div className="cms-flex cms-end cms-gap-2">
              <Button variant="secondary" onClick={() => setAdding(null)}>{word("cancel")}</Button>
              <Button type="submit" loading={busy}>{word("add")}</Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}

interface MyInvitation { id: string; tenant: string; tenantName: string | null; roles: string[]; expiresAt: string }

/**
 * On the account page, which anyone signed in can open: invitations to accept, and the tenants
 * they belong to, so someone with no dashboard access yet can join and open their tenant.
 */
export function AccountTenants() {
  const { t, formatDate } = useT();
  const word = (key: string, values?: Record<string, string | number>) => t(`ext.multi-tenant.account.${key}`, values);
  const invitations = useCall<{ items: MyInvitation[] }>("/invitations/mine");
  const tenants = useCall<{ current: string | null; items: TenantItem[] }>("/tenants");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState<{ id: string; name: string } | null>(null);

  const answer = async (invitation: MyInvitation, accept: boolean) => {
    setBusy(invitation.id);
    setError(null);
    try {
      await call(`/invitations/${encodeURIComponent(invitation.id)}/${accept ? "accept" : "reject"}`, { method: "POST" });
      if (accept) setJoined({ id: invitation.tenant, name: invitation.tenantName ?? invitation.tenant });
      invitations.reload();
      tenants.reload();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(null);
    }
  };
  const open = async (tenant: string) => {
    setBusy(tenant);
    setError(null);
    try {
      await workIn(tenant, adminPath());
    } catch (failure) {
      setError(message(failure));
      setBusy(null);
    }
  };

  // Only the tenants they belong to, not every one staff can reach.
  const memberships = (tenants.data?.items ?? []).filter((tenant) => tenant.roles.length && tenant.status === "active");
  const pending = invitations.data?.items ?? [];
  if (!pending.length && !memberships.length && !joined && !error) return null;
  return (
    <div id="tenant-invitations">
      <Card title={word("title")} description={word("description")}>
        <div className="cms-stack-4">
          {error && <Alert>{error}</Alert>}
          {joined && <Alert kind="success">{word("accepted", { tenant: joined.name })}</Alert>}
          {pending.map((invitation) => (
            <div key={invitation.id} className="cms-flex cms-between cms-gap-2">
              <div>
                <p>{word("invited", { tenant: invitation.tenantName ?? invitation.tenant, roles: invitation.roles.join(", ") })}</p>
                <p className="cms-hint">{word("expires", { date: formatDate(invitation.expiresAt) })}</p>
              </div>
              <div className="cms-row cms-gap-2">
                <Button variant="secondary" loading={busy === invitation.id} onClick={() => void answer(invitation, false)}>{word("decline")}</Button>
                <Button loading={busy === invitation.id} onClick={() => void answer(invitation, true)}>{word("accept")}</Button>
              </div>
            </div>
          ))}
          {memberships.map((tenant) => (
            <div key={tenant.id} className="cms-flex cms-between cms-gap-2">
              <p>{word("memberOf", { tenant: tenant.name })}</p>
              <Button variant="secondary" loading={busy === tenant.id} onClick={() => void open(tenant.id)}>{word("open")}</Button>
            </div>
          ))}
          {!memberships.length && joined && <div className="cms-flex cms-end"><ButtonLink href={adminPath()} native>{word("open")}</ButtonLink></div>}
        </div>
      </Card>
    </div>
  );
}
