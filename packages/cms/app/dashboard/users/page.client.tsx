"use client";

import { useT } from "../../../components/i18n";
import { PlusIcon, UsersIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { Alert, Badge, Button, ButtonLink, DataTable, Field, Input, Modal, PageHeader, Pagination, SearchInput, Toolbar } from "../../../components/ui/kit";
import { api, useAction, useApi } from "../../../lib/client/api";
import type { Paginated } from "../../../types/content";
import { adminPath, apiPath } from "../../../lib/paths";

export interface UserRow { id: string; name: string; email: string; role: string | null; banned: boolean | null; emailVerified: boolean; twoFactorEnabled?: boolean | null; createdAt: string }
export interface RolesResponse {
  /** `scope` "scoped": given within one scope value by the scope provider, never as someone's own role. */
  roles: Array<{ name: string; label: string; description: string | null; permissions: string[]; system: boolean; immutable: boolean; userCount: number; scope?: "instance" | "scoped" }>;
  catalogue: Array<{ resource: string; label: string; actions: string[] }>;
  collections: Array<{ id: number; name: string; type?: string; scoped?: boolean }>;
  locales?: Array<{ code: string; label: string }>;
  /** The scope provider, and what a role within one of its values may hold. Null without one. */
  scope?: { plugin: string; label: string; permissions: string[] } | null;
}

/** Roles someone can hold as their own: a scoped role is given within one scope value instead. */
export const ownRoles = (roles: RolesResponse["roles"]) => roles.filter((role) => role.scope !== "scoped");

export default function UsersClient({ permissions }: { permissions: string[] }) {
  const { t, locale } = useT();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const canCreate = permissions.includes("user:create");
  const users = useApi<Paginated<UserRow>>(apiPath(`/users?page=${page}&perPage=25${search ? `&search=${encodeURIComponent(search)}` : ""}`));
  const roles = useApi<RolesResponse>(canCreate && permissions.includes("role:list") ? apiPath("/roles") : null);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "user" });
  const { busy, error, run } = useAction();

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await run(() => api(apiPath("/users"), { method: "POST", body: form }))) {
      setCreating(false);
      setForm({ name: "", email: "", password: "", role: "user" });
      users.reload();
    }
  };

  const roleLabel = (name: string | null) => roles.data?.roles.find((role) => role.name === name)?.label ?? name;
  return (
    <div className="cms-gutter">
      <PageHeader
        title={t("users.title")}
        meta={users.data && <span>{t("common.total", { count: users.data.totalItems })}</span>}
        actions={canCreate && <Button onClick={() => setCreating(true)}><PlusIcon className="cms-icon" aria-hidden="true" />{t("users.newUser")}</Button>}
      />
      {users.error && <div className="cms-mb-4"><Alert>{users.error}</Alert></div>}
      <DataTable
        label={t("users.title")}
        columns={[{ id: "user", label: t("users.user") }, { id: "role", label: t("users.role") }, { id: "twoFactor", label: t("users.twoFactor") }, { id: "status", label: t("users.status") }, { id: "joined", label: t("users.joined") }]}
        rows={users.data ? users.data.items.map((user) => ({
          id: user.id,
          href: adminPath(`/users/${user.id}`),
          cells: {
            user: <span className="cms-stack-1"><span className="cms-truncate">{user.name}</span><span className="cms-hint cms-truncate">{user.email}</span></span>,
            role: user.role ? <Badge>{roleLabel(user.role)}</Badge> : null,
            twoFactor: user.twoFactorEnabled ? <Badge tone="success">{t("users.on")}</Badge> : <Badge>{t("users.off")}</Badge>,
            status: user.banned ? <Badge tone="danger">{t("users.banned")}</Badge> : <Badge tone="success">{t("users.active")}</Badge>,
            joined: <span className="cms-nowrap">{new Date(user.createdAt).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" })}</span>,
          },
        })) : null}
        toolbar={(
          <Toolbar end={permissions.includes("setting:update") && permissions.includes("user:get") && <ButtonLink variant="secondary" href={adminPath("/users/fields")}>{t("users.userFields")}</ButtonLink>}>
            <SearchInput placeholder={t("users.search")} aria-label={t("users.search")} value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
          </Toolbar>
        )}
        empty={{ icon: <UsersIcon />, title: search ? t("grid.noMatches") : t("users.empty"), hint: search ? t("grid.noMatchesHint") : undefined }}
        footer={users.data && users.data.totalItems > 0 ? <Pagination page={page} perPage={users.data.perPage} total={users.data.totalItems} onPage={setPage} /> : undefined}
      />
      <Modal open={creating} onClose={() => setCreating(false)} title={t("users.newUser")}>
        <form onSubmit={create} className="cms-stack-4">
          {error && <Alert>{error}</Alert>}
          <Field label={t("users.name")}><Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label={t("users.email")}><Input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label={t("users.password")}><Input required type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <Field label={t("users.role")}>
            <select className="cms-input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {(roles.data ? ownRoles(roles.data.roles) : [{ name: "user", label: "User" }]).map((role) => <option key={role.name} value={role.name}>{role.label}</option>)}
            </select>
          </Field>
          <div className="cms-flex cms-end cms-gap-2">
            <Button variant="secondary" onClick={() => setCreating(false)}>{t("users.cancel")}</Button>
            <Button type="submit" loading={busy}>{t("users.create")}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
