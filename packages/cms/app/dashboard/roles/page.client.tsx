"use client";

import { useSchemaText, useT } from "../../../components/i18n";
import { useId, useState } from "react";
import { Alert, Badge, Button, Card, Field, Input, PageHeader, SegmentedControl } from "../../../components/ui/kit";
import { api, useAction, useApi } from "../../../lib/client/api";
import type { RolesResponse } from "../users/page.client";
import { apiPath } from "../../../lib/paths";

const SCOPED = /^record:([a-z]+)@c(\d+)(:own)?$/;

/** Actions an own grant can cover. Creating has no record to own. */
const OWN_ACTIONS = new Set(["list", "read", "update", "delete"]);

/** Holding `record:update` covers `record:update@c3`, which covers `record:update@c3:own`, as on the server. */
const covers = (held: Set<string>, permission: string) => {
  const match = SCOPED.exec(permission);
  return held.has(permission) || (match !== null && (held.has(`record:${match[1]}`) || held.has(`record:${match[1]}@c${match[2]}`)));
};

interface Grant { permission: string; label: string; checked: boolean; disabled: boolean; note?: string }

/** One resource's permissions, with a switch for all of them. Collections use the same block, labelled as such. */
function PermissionGroup({ eyebrow, title, grants, onChange }: { eyebrow?: string; title: string; grants: Grant[]; onChange: (permissions: string[], on: boolean) => void }) {
  const { t } = useT();
  const open = grants.filter((grant) => !grant.disabled);
  const checked = grants.filter((grant) => grant.checked).length;
  const allOn = open.length > 0 && open.every((grant) => grant.checked);
  const id = useId();
  return (
    <fieldset className="cms-perm-group" aria-labelledby={id}>
      <div className="cms-perm-head">
        <div className="cms-perm-title">
          {eyebrow && <span className="cms-perm-eyebrow">{eyebrow}</span>}
          <span id={id}>{title}</span>
        </div>
        <span className="cms-perm-count">{checked}/{grants.length}</span>
        {open.length > 1 && (
          <button type="button" className="cms-quiet-btn" onClick={() => onChange(open.map((grant) => grant.permission), !allOn)}>
            {allOn ? t("roles.clear") : t("roles.selectAll")}
          </button>
        )}
      </div>
      <div className="cms-perm-grid">
        {grants.map((grant) => (
          <label key={grant.permission} className="cms-check-label" title={grant.note}>
            <input type="checkbox" className="cms-check" aria-label={eyebrow ? t("roles.grantIn", { grant: grant.label, group: title }) : undefined} disabled={grant.disabled} checked={grant.checked} onChange={(e) => onChange([grant.permission], e.target.checked)} />
            {grant.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Record permissions for one collection at a time, laid out like every other group. */
function CollectionGrants({ actions, collections, draft, held, canEdit, onChange }: {
  actions: string[];
  collections: Array<{ id: number; name: string; labels?: Record<string, string> | null; type?: string; scoped?: boolean }>;
  draft: Draft;
  held: Set<string>;
  canEdit: boolean;
  onChange: (permissions: string[], on: boolean) => void;
}) {
  const { t } = useT();
  const schemaText = useSchemaText();
  // Grants for collections this person can't see are still listed, so saving keeps them visibly.
  // A role within one scope value reaches only scoped collections there, so only they are offered.
  const shown = draft.scope === "scoped" ? collections.filter((c) => c.scoped) : collections;
  const known = new Set(collections.map((c) => c.id));
  const unseen = [...new Set(draft.permissions.flatMap((p) => { const m = SCOPED.exec(p); return m && !known.has(Number(m[2])) ? [Number(m[2])] : []; }))];
  const rows: Array<{ id: number; name: string; labels?: Record<string, string> | null; type?: string }> = [...shown, ...unseen.map((id) => ({ id, name: t("roles.collectionNumber", { id }) }))];
  if (!rows.length) return null;
  return (
    <section className="cms-stack-3">
      <div>
        <h3 className="cms-section-title">{t("roles.collections")}</h3>
        <p className="cms-hint">{t("roles.collectionsHint")}</p>
      </div>
      <div className="cms-perm-groups">
        {rows.map((collection) => (
          <PermissionGroup
            key={collection.id}
            eyebrow={t("roles.collection")}
            title={schemaText.collection(collection)}
            onChange={onChange}
            grants={[
              ...actions.map((action) => {
                const permission = `record:${action}@c${collection.id}`;
                const global = draft.permissions.includes(`record:${action}`);
                return { permission, label: action, checked: global || draft.permissions.includes(permission), disabled: !canEdit || global || !covers(held, permission), note: global ? t("roles.grantedEverywhere") : undefined };
              }),
              // A view's rows have no creator, so it has no own records.
              ...(collection.type === "view" ? [] : actions.filter((action) => OWN_ACTIONS.has(action)).map((action) => {
                const permission = `record:${action}@c${collection.id}:own`;
                const wider = draft.permissions.includes(`record:${action}`) || draft.permissions.includes(`record:${action}@c${collection.id}`);
                return { permission, label: t("roles.own", { action }), checked: wider || draft.permissions.includes(permission), disabled: !canEdit || wider || !covers(held, permission), note: wider ? t("roles.coveredBy", { action }) : undefined };
              })),
            ]}
          />
        ))}
      </div>
    </section>
  );
}

/** Per-language edit rights: `locale:edit` covers all, `locale:edit@fr` one. Shown only once a site has more than one language. */
function LanguageGrants({ locales, draft, held, canEdit, onChange }: { locales: Array<{ code: string; label: string }>; draft: Draft; held: Set<string>; canEdit: boolean; onChange: (permissions: string[], on: boolean) => void }) {
  const { t } = useT();
  if (locales.length < 2) return null;
  const all = draft.permissions.includes("locale:edit");
  return (
    <section className="cms-stack-3">
      <div>
        <h3 className="cms-section-title">{t("roles.languages")}</h3>
        <p className="cms-hint">{t("roles.languagesHint")}</p>
      </div>
      <PermissionGroup
        title={t("roles.editIn")}
        onChange={onChange}
        grants={locales.map((locale) => {
          const permission = `locale:edit@${locale.code}`;
          return { permission, label: `${locale.label} (${locale.code})`, checked: all || draft.permissions.includes(permission), disabled: !canEdit || all || !(held.has(permission) || held.has("locale:edit")), note: all ? t("roles.grantedEveryLanguage") : undefined };
        })}
      />
    </section>
  );
}

/** A starting point for the most common restricted role: reads everything, edits its languages only. */
const TRANSLATOR = ["dashboard:access", "collection:read", "record:list", "record:read", "record:update", "file:list", "file:read", "file:create"];

type RoleScope = "instance" | "scoped";
type Draft = { name: string; label: string; description: string; permissions: string[]; isNew: boolean; immutable: boolean; system: boolean; scope: RoleScope };
const empty: Draft = { name: "", label: "", description: "", permissions: [], isNew: true, immutable: false, system: false, scope: "instance" };

/** What a role within one scope value may hold: the provider's list, record grants and languages. */
const scopeable = (allowed: ReadonlySet<string>, permission: string) => allowed.has(permission) || /^(record:[a-z]+@c\d+(:own)?|locale:edit@.+)$/.test(permission);

/** `scopeLabel`: the scope provider's word for a value, such as "tenant", in the reader's language. */
export default function RolesClient({ permissions, scopeLabel = "" }: { permissions: string[]; scopeLabel?: string }) {
  const { t } = useT();
  const { data, error: loadError, reload } = useApi<RolesResponse>(apiPath("/roles"));
  const [draft, setDraft] = useState<Draft | null>(null);
  const { busy, error, run } = useAction();
  const held = new Set(permissions);
  const canEdit = draft && (draft.isNew ? held.has("role:create") : held.has("role:update")) && !draft.immutable;
  const scope = data?.scope ?? null;
  const scopeAllowed = new Set(scope?.permissions ?? []);
  const scopeWord = scopeLabel || scope?.label.toLocaleLowerCase() || "";
  const scopeBadge = (role: { scope?: RoleScope }) => role.scope === "scoped" ? <Badge tone="info" tight>{t("roles.scopeWithin", { label: scopeWord })}</Badge> : null;
  const chooseScope = (next: RoleScope) => draft && setDraft({ ...draft, scope: next, permissions: next === "scoped" ? draft.permissions.filter((permission) => scopeable(scopeAllowed, permission)) : draft.permissions });

  const toggle = (permissions: string[], on: boolean) => {
    if (!draft) return;
    const next = permissions.reduce((current, permission) => {
      const without = current.filter((p) => p !== permission);
      if (!on) return without;
      // A wider record permission replaces the grants it covers: global over per-collection, per-collection over own.
      const rest = permission === "locale:edit"
        ? without.filter((p) => !p.startsWith("locale:edit@"))
        : /^record:[a-z]+$/.test(permission)
        ? without.filter((p) => !p.startsWith(`${permission}@c`))
        : /^record:[a-z]+@c\d+$/.test(permission) ? without.filter((p) => p !== `${permission}:own`) : without;
      return [...rest, permission];
    }, draft.permissions);
    setDraft({ ...draft, permissions: next });
  };
  const save = async () => {
    if (!draft) return;
    const body = { label: draft.label, description: draft.description || undefined, permissions: draft.permissions };
    const ok = await run(() => draft.isNew
      ? api(apiPath("/roles"), { method: "POST", body: { ...body, name: draft.name, ...(scope ? { scope: draft.scope } : {}) } })
      : api(apiPath(`/roles/${draft.name}`), { method: "PUT", body }));
    if (ok) { setDraft(null); reload(); }
  };
  const remove = async () => {
    if (draft && window.confirm(t("roles.confirmDelete", { label: draft.label })) && await run(() => api(apiPath(`/roles/${draft.name}`), { method: "DELETE" }))) {
      setDraft(null);
      reload();
    }
  };

  return (
    <div>
      <PageHeader title={t("roles.title")} description={t("roles.description")} actions={held.has("role:create") ? (
        <div className="cms-row cms-gap-2">
          {(data?.locales?.length ?? 0) > 1 && <Button variant="secondary" onClick={() => setDraft({ ...empty, name: "translator", label: t("roles.translator"), description: t("roles.translatorDescription"), permissions: TRANSLATOR.filter((permission) => held.has(permission)) })}>{t("roles.newTranslatorRole")}</Button>}
          <Button onClick={() => setDraft(empty)}>{t("roles.newRole")}</Button>
        </div>
      ) : undefined} />
      <div className="cms-gutter cms-grid cms-gap-6 cms-lg-3">
        <div className="cms-stack-2">
          {loadError && <Alert>{loadError}</Alert>}
          {data?.roles.map((role) => (
            <button key={role.name} type="button" onClick={() => setDraft({ name: role.name, label: role.label, description: role.description ?? "", permissions: role.permissions, isNew: false, immutable: role.immutable, system: role.system, scope: role.scope ?? "instance" })}
              className={`cms-choice-card ${draft?.name === role.name ? "cms-choice-card-active" : ""}`}>
              <span className="cms-row cms-gap-2"><span className="cms-medium cms-strong">{role.label}</span>{scopeBadge(role)}</span>
              <span className="cms-hint cms-block">{t("roles.counts", { permissions: role.permissions.length, users: role.userCount })}</span>
            </button>
          ))}
        </div>
        <div className="cms-lg-span-2">
          {draft ? (
            <Card title={draft.isNew ? t("roles.newRole") : draft.label} description={draft.immutable ? t("roles.superadminHint") : undefined}>
              {error && <Alert>{error}</Alert>}
              {draft.isNew && <Field label={t("roles.identifier")} hint={t("roles.identifierHint")}><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></Field>}
              <Field label={t("roles.label")}><Input disabled={!canEdit} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></Field>
              <Field label={t("roles.descriptionLabel")}><Input disabled={!canEdit} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
              {scope && (
                <Field label={t("roles.scopeLabel")} hint={t("roles.scopeHint", { label: scopeWord })}>
                  {draft.isNew ? (
                    <SegmentedControl<RoleScope> label={t("roles.scopeLabel")} value={draft.scope} onChange={chooseScope} options={[
                      { id: "instance", label: t("roles.scopeInstance") },
                      { id: "scoped", label: t("roles.scopeWithin", { label: scopeWord }) },
                    ]} />
                  ) : (
                    <div>{scopeBadge(draft) ?? <Badge tight>{t("roles.scopeInstance")}</Badge>}</div>
                  )}
                </Field>
              )}
              <div className="cms-stack-6">
                <div className="cms-perm-groups">
                  {data?.catalogue.map((group) => (
                    <PermissionGroup
                      key={group.resource}
                      title={group.label}
                      onChange={toggle}
                      grants={group.actions.map((action) => {
                        const permission = `${group.resource}:${action}`;
                        return { permission, label: action, checked: draft.permissions.includes(permission), disabled: !canEdit || !held.has(permission) || (draft.scope === "scoped" && !scopeAllowed.has(permission)) };
                      })}
                    />
                  ))}
                </div>
                {data && <LanguageGrants locales={data.locales ?? []} draft={draft} held={held} canEdit={Boolean(canEdit)} onChange={toggle} />}
                {data && <CollectionGrants actions={data.catalogue.find((g) => g.resource === "record")?.actions ?? []} collections={data.collections} draft={draft} held={held} canEdit={Boolean(canEdit)} onChange={toggle} />}
              </div>
              {!draft.immutable && (
                <div className="cms-flex cms-between">
                  <Button loading={busy} disabled={!canEdit} onClick={save}>{t("roles.save")}</Button>
                  {!draft.isNew && !draft.system && held.has("role:delete") && <Button variant="danger" loading={busy} onClick={remove}>{t("roles.delete")}</Button>}
                </div>
              )}
            </Card>
          ) : (
            <p className="cms-muted">{t("roles.selectRole")}</p>
          )}
        </div>
      </div>
    </div>
  );
}
