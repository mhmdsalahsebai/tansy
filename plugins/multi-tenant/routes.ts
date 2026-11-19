import { z } from "zod";
import { adminPath, defineRoute, HttpError, type ExtensionRoute, type ExtensionRouteContext } from "tansy/plugin";
import { invitationMail, wordIn } from "./messages";
import { cancelPurge, DEFAULT_PURGE_DAYS, planOf, resumeTenant, schedulePurge, setLimits, suspendTenant } from "./lifecycle";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { forgetSlugs, usableSlug } from "./paths";
import { claimsOn, DEFAULT_RECORD, dnsHasProof, DOMAINS, domainsOf, findDomain, forgetHosts, normalizeHost, newToken, proof, RECORD_NAME, type Domain } from "./domains";

type Principal = ExtensionRouteContext["principal"];
import {
  EVERY_TENANT, findInvitation, findMember, findMemberById, findTenant, INVITATIONS, invitationById, invitationsOf, MEMBERS, MEMBERS_PERMISSION,
  membersOf, newId, ORGANIZATIONS, PLUGIN, publicTenant, reachable, RECORD_KEY, requireTenant, setActiveTenant, TENANT_ID, TENANT_SLUG,
  userOf, type Member,
} from "./tenants";


const tenantId = z.string().regex(TENANT_ID);
const roleNames = z.array(z.string().min(1).max(64)).min(1).max(10);

/** The tenant this request is for. Every tenant route works on it alone, never on an id from the body. */
function currentTenant(principal: Principal): string {
  if (!principal.scope) throw new HttpError(400, "SCOPE_REQUIRED", "Choose a tenant first.");
  return principal.scope;
}

/**
 * Roles someone may give in a tenant: any tenant role with the permission for every tenant,
 * otherwise only roles they hold there themselves, so nobody hands out more than they have.
 */
async function assertCanGive(context: ExtensionRouteContext, tenant: string, roles: string[]) {
  const known = new Map((await context.tools.roles()).map((role) => [role.name, role]));
  const unknown = roles.find((name) => known.get(name)?.scope !== "scoped");
  if (unknown) throw new HttpError(400, "UNKNOWN_ROLE", `"${unknown.slice(0, 64)}" isn't a tenant role. Mark a role "Within a tenant" under Dashboard → Roles to offer it here.`);
  if (context.principal.permissions.has(EVERY_TENANT)) return;
  const own = await findMember(context, tenant, userOf(context.principal).id);
  const missing = roles.find((name) => !own?.roles.includes(name));
  if (missing) throw new HttpError(403, "ROLE_NOT_HELD", `Only someone who holds "${missing}" in this tenant can give it.`);
}

/** The same check for changing or removing someone: their roles must all be ones the caller could give. */
async function assertCanManage(context: ExtensionRouteContext, tenant: string, member: Member) {
  if (member.roles.length) await assertCanGive(context, tenant, member.roles);
}

/** Makes a tenant the one a session works in, or none. The same answer for a tenant that doesn't exist and one the caller can't reach. */
async function switchTo(context: ExtensionRouteContext, value: string | null) {
  const { principal } = context;
  if (principal.kind !== "user") throw new HttpError(400, "SESSION_REQUIRED", "Only a signed-in session can switch tenant. An API key is bound to one when it's created.");
  if (value !== null) {
    const tenant = await findTenant(context, value);
    const member = tenant ? await findMember(context, tenant.id, principal.user.id) : null;
    if (!tenant || tenant.status !== "active" || (!member && !principal.permissions.has(EVERY_TENANT))) throw new HttpError(404, "SCOPE_NOT_FOUND", "This tenant doesn't exist.");
    context.auditTarget("tenant", tenant.id, { member: Boolean(member) });
  }
  await setActiveTenant(context, principal.session.id, value);
  return { current: value };
}

async function describeMember(context: ExtensionRouteContext, member: Member) {
  const user = await context.system.users.get(member.userId);
  return { id: member.id, userId: member.userId, name: user?.name ?? null, email: user?.email ?? null, roles: member.roles, createdAt: member.createdAt };
}

const DOMAINS_PERMISSION = "ext.multi-tenant:domains";
/** Enough for a site with a few aliases, and a limit on what one tenant can claim. */
const MAX_DOMAINS = 20;

/** The name the TXT record goes under, from the plugin's settings. */
async function recordName(context: ExtensionRouteContext): Promise<string> {
  const value = (await context.settings.get()).verificationRecord;
  return typeof value === "string" && RECORD_NAME.test(value) ? value : DEFAULT_RECORD;
}

async function describeDomain(context: ExtensionRouteContext, domain: Domain) {
  return {
    id: domain.id,
    host: domain.host,
    primary: domain.primary,
    verified: domain.verifiedAt !== null,
    verifiedAt: domain.verifiedAt,
    checkedAt: domain.checkedAt,
    // What the tenant's DNS must hold for the domain to verify.
    record: { type: "TXT", name: `${await recordName(context)}.${domain.host}`, value: proof(domain.token) },
  };
}

/** Another tenant's verified domain, or one of this tenant's own: the same answer either way, which names no tenant. */
const unavailable = () => new HttpError(409, "DOMAIN_UNAVAILABLE", "This domain can't be added to this tenant.");

/** After a change to which hosts route where: this server forgets what it held, and trusts the new set of origins at once. */
async function domainsChanged(context: ExtensionRouteContext) {
  forgetHosts();
  await context.auth.refreshTrustedOrigins();
}

const DELETE_PERMISSION = "ext.multi-tenant:delete";
/** The largest archive an import takes. */
const MAX_IMPORT_BYTES = 2 * 1024 ** 3;

/** A tenant named in the address, for instance staff's routes that act on any tenant, suspended ones included. */
const tenantFromPath = (context: ExtensionRouteContext) => requireTenant(context, context.params.id);

/** How many people a tenant has and has asked, against its limit on members. */
async function assertMemberRoom(context: ExtensionRouteContext, tenant: string, adding = 1) {
  const { members: limit } = await planOf(context, tenant);
  if (limit === null) return;
  const now = Date.now();
  const pending = (await invitationsOf(context, tenant)).filter((invitation) => invitation.expiresAt !== null && Date.parse(invitation.expiresAt) > now).length;
  if ((await membersOf(context, tenant)).length + pending + adding > limit) throw new HttpError(403, "SCOPE_LIMIT_REACHED", "This tenant has reached its limit on members.");
}

const limitValue = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();

async function requireDomain(context: ExtensionRouteContext, tenant: string): Promise<Domain> {
  const id = Number(context.params.id);
  const domain = Number.isSafeInteger(id) && id > 0 ? await findDomain(context, tenant, id) : null;
  if (!domain) throw new HttpError(404, "NOT_FOUND", "Domain not found.");
  return domain;
}

export function tenantRoutes(options: { siteUrl: string; dnsServers?: string[] }): ExtensionRoute[] {
  // The dashboard's own host is never a tenant's, so it can't be claimed.
  const reserved = new Set([new URL(options.siteUrl).hostname.toLowerCase()]);
  return [
    defineRoute({
      method: "GET",
      path: "/tenants",
      access: "authenticated",
      apiKey: true,
      handler: async (context) => {
        const user = userOf(context.principal);
        const { tenants, memberships } = await reachable(context, user.id);
        const roles = new Map(memberships.map((member) => [member.tenant, member.roles]));
        return { current: context.principal.scope ?? null, items: tenants.map((tenant) => ({ ...publicTenant(tenant), roles: roles.get(tenant.id) ?? [] })) };
      },
    }),

    defineRoute({
      method: "POST",
      path: "/tenants",
      access: "permission",
      permission: "ext.multi-tenant:create",
      apiKey: true,
      fresh: true,
      audit: "multi_tenant.create",
      body: z.object({ name: z.string().trim().min(1).max(120), slug: z.string().regex(TENANT_SLUG) }),
      handler: async (context) => {
        const user = userOf(context.principal);
        // Its short name is also the path its site is served under, so it can't be one the CMS answers on.
        if (!usableSlug(context.body.slug)) throw new HttpError(400, "VALIDATION_FAILED", "That short name belongs to the CMS itself. Choose another.");
        // As the server: better-auth makes the creator the tenant's first member, with the creator role.
        const created = await context.auth.server<{ id: string }>("/organization/create", {
          body: { name: context.body.name, slug: context.body.slug, userId: user.id, keepCurrentActiveOrganization: true, status: "active" },
        });
        const tenant = await findTenant(context, created.id);
        if (!tenant) throw new Error("The new tenant wasn't saved.");
        context.auditTarget("tenant", tenant.id, { name: tenant.name, slug: tenant.slug });
        // Its site answers under its short name at once on this server.
        forgetSlugs();
        return publicTenant(tenant);
      },
    }),

    defineRoute({
      method: "GET",
      path: "/tenant",
      access: "authenticated",
      apiKey: true,
      handler: async (context) => {
        const tenant = await findTenant(context, currentTenant(context.principal));
        if (!tenant) throw new HttpError(404, "SCOPE_NOT_FOUND", "This tenant doesn't exist.");
        const member = context.principal.kind === "anonymous" ? null : await findMember(context, tenant.id, context.principal.user.id);
        return { ...publicTenant(tenant), roles: member?.roles ?? [] };
      },
    }),

    defineRoute({
      method: "PATCH",
      path: "/tenant",
      access: "permission",
      permission: "ext.multi-tenant:update",
      apiKey: true,
      audit: "multi_tenant.update",
      body: z.object({ name: z.string().trim().min(1).max(120) }),
      handler: async (context) => {
        const tenant = await findTenant(context, currentTenant(context.principal));
        if (!tenant) throw new HttpError(404, "SCOPE_NOT_FOUND", "This tenant doesn't exist.");
        await context.system.records.update(ORGANIZATIONS, tenant.recordId, { name: context.body.name });
        context.auditTarget("tenant", tenant.id, { name: context.body.name });
        return { ...publicTenant(tenant), name: context.body.name };
      },
    }),

    defineRoute({
      method: "POST",
      path: "/switch",
      access: "authenticated",
      audit: "multi_tenant.switch",
      body: z.object({ tenant: tenantId.nullable() }),
      handler: (context) => switchTo(context, context.body.tenant),
    }),

    // The dashboard's top-bar switcher (AdminSwitcher): what to offer, and the choice.
    defineRoute({
      method: "GET",
      path: "/switcher",
      access: "authenticated",
      handler: async (context) => {
        const { principal } = context;
        if (principal.kind !== "user") return { current: null, options: [] };
        const { tenants } = await reachable(context, principal.user.id);
        const options: Array<{ value: string | null; label: string }> = tenants
          .filter((tenant) => tenant.status === "active")
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((tenant) => ({ value: tenant.id, label: tenant.name }));
        // Staff who reach every tenant can also work in none, for what isn't kept apart by tenant.
        if (principal.permissions.has(EVERY_TENANT)) options.unshift({ value: null, label: wordIn((await context.system.users.get(principal.user.id))?.locale, "switcherNone") });
        return { current: principal.scope ?? null, options };
      },
    }),

    defineRoute({
      method: "POST",
      path: "/switcher",
      access: "authenticated",
      audit: "multi_tenant.switch",
      body: z.object({ value: tenantId.nullable() }),
      handler: (context) => switchTo(context, context.body.value),
    }),

    defineRoute({
      method: "GET",
      path: "/domains",
      access: "permission",
      permission: DOMAINS_PERMISSION,
      apiKey: true,
      handler: async (context) => {
        const domains = await domainsOf(context, currentTenant(context.principal));
        return { items: await Promise.all(domains.map((domain) => describeDomain(context, domain))) };
      },
    }),

    defineRoute({
      method: "POST",
      path: "/domains",
      access: "permission",
      permission: DOMAINS_PERMISSION,
      apiKey: true,
      fresh: true,
      audit: "multi_tenant.domain_add",
      rateLimit: { window: 3600, max: 30 },
      body: z.object({ host: z.string().trim().min(1).max(300) }),
      handler: async (context) => {
        const tenant = currentTenant(context.principal);
        const host = normalizeHost(context.body.host, reserved);
        if (!host) throw new HttpError(400, "INVALID_DOMAIN", "Use a domain name such as www.example.com, without a path or port.");
        const claims = await claimsOn(context, host);
        // Claims don't block each other until one verifies, so nobody can hold a domain they don't control by naming it first.
        if (claims.some((claim) => claim.tenant === tenant || claim.verifiedAt !== null)) throw unavailable();
        if ((await domainsOf(context, tenant)).length >= MAX_DOMAINS) throw new HttpError(409, "TOO_MANY_DOMAINS", `A tenant can have at most ${MAX_DOMAINS} domains.`);
        const created = await context.system.records.create(DOMAINS, { status: "published", host, organizationId: tenant, primary: false, token: newToken() });
        const domain = await findDomain(context, tenant, Number(created.id));
        if (!domain) throw new Error("The new domain wasn't saved.");
        context.auditTarget("tenant_domain", String(domain.id), { tenant, host });
        return describeDomain(context, domain);
      },
    }),

    defineRoute({
      method: "POST",
      path: "/domains/:id/verify",
      access: "permission",
      permission: DOMAINS_PERMISSION,
      apiKey: true,
      audit: "multi_tenant.domain_verify",
      rateLimit: { window: 3600, max: 60 },
      handler: async (context) => {
        const tenant = currentTenant(context.principal);
        const domain = await requireDomain(context, tenant);
        if (domain.verifiedAt !== null) return describeDomain(context, domain);
        if ((await claimsOn(context, domain.host)).some((claim) => claim.id !== domain.id && claim.verifiedAt !== null)) throw unavailable();
        const now = new Date().toISOString();
        const record = await recordName(context);
        context.auditTarget("tenant_domain", String(domain.id), { tenant, host: domain.host });
        if (!(await dnsHasProof(domain, record, options.dnsServers))) {
          await context.system.records.update(DOMAINS, domain.id, { checkedAt: now });
          throw new HttpError(400, "DOMAIN_NOT_VERIFIED", `No TXT record at ${record}.${domain.host} holds ${proof(domain.token)} yet. DNS changes can take a while to appear.`);
        }
        // The first verified domain is where the tenant's site lives until someone chooses another.
        const hasPrimary = (await domainsOf(context, tenant)).some((other) => other.primary && other.verifiedAt !== null);
        await context.system.records.update(DOMAINS, domain.id, { verifiedAt: now, checkedAt: now, primary: !hasPrimary });
        await domainsChanged(context);
        return describeDomain(context, { ...domain, verifiedAt: now, checkedAt: now, primary: !hasPrimary });
      },
    }),

    defineRoute({
      method: "POST",
      path: "/domains/:id/primary",
      access: "permission",
      permission: DOMAINS_PERMISSION,
      apiKey: true,
      fresh: true,
      audit: "multi_tenant.domain_primary",
      handler: async (context) => {
        const tenant = currentTenant(context.principal);
        const domain = await requireDomain(context, tenant);
        if (domain.verifiedAt === null) throw new HttpError(409, "DOMAIN_NOT_VERIFIED", "Verify the domain before making it the main one.");
        for (const other of await domainsOf(context, tenant)) {
          if (other.primary !== (other.id === domain.id)) await context.system.records.update(DOMAINS, other.id, { primary: other.id === domain.id });
        }
        context.auditTarget("tenant_domain", String(domain.id), { tenant, host: domain.host });
        return describeDomain(context, { ...domain, primary: true });
      },
    }),

    defineRoute({
      method: "DELETE",
      path: "/domains/:id",
      access: "permission",
      permission: DOMAINS_PERMISSION,
      apiKey: true,
      fresh: true,
      audit: "multi_tenant.domain_remove",
      handler: async (context) => {
        const tenant = currentTenant(context.principal);
        const domain = await requireDomain(context, tenant);
        await context.system.records.delete(DOMAINS, domain.id);
        if (domain.primary) {
          const next = (await domainsOf(context, tenant)).find((other) => other.verifiedAt !== null);
          if (next) await context.system.records.update(DOMAINS, next.id, { primary: true });
        }
        context.auditTarget("tenant_domain", String(domain.id), { tenant, host: domain.host });
        await domainsChanged(context);
        return null;
      },
    }),

    defineRoute({
      method: "GET",
      path: "/roles",
      access: "permission",
      permission: MEMBERS_PERMISSION,
      apiKey: true,
      handler: async (context) => {
        // The tenant roles the caller could give here: every one with the permission for every tenant, else those they hold.
        const tenant = currentTenant(context.principal);
        const scoped = (await context.tools.roles()).filter((role) => role.scope === "scoped");
        if (context.principal.permissions.has(EVERY_TENANT)) return { items: scoped.map(({ name, label }) => ({ name, label })) };
        const own = await findMember(context, tenant, userOf(context.principal).id);
        return { items: scoped.filter((role) => own?.roles.includes(role.name)).map(({ name, label }) => ({ name, label })) };
      },
    }),

    defineRoute({
      method: "GET",
      path: "/members",
      access: "permission",
      permission: MEMBERS_PERMISSION,
      apiKey: true,
      handler: async (context) => {
        const members = await membersOf(context, currentTenant(context.principal));
        return { items: await Promise.all(members.map((member) => describeMember(context, member))) };
      },
    }),

    defineRoute({
      method: "PATCH",
      path: "/members/:id",
      access: "permission",
      permission: MEMBERS_PERMISSION,
      apiKey: true,
      audit: "multi_tenant.member_update",
      body: z.object({ roles: roleNames }),
      handler: async (context) => {
        const tenant = currentTenant(context.principal);
        const member = await findMemberById(context, tenant, context.params.id);
        if (!member) throw new HttpError(404, "NOT_FOUND", "Member not found.");
        await assertCanManage(context, tenant, member);
        const roles = [...new Set(context.body.roles)];
        await assertCanGive(context, tenant, roles);
        await context.system.records.update(MEMBERS, member.recordId, { role: roles.join(",") });
        context.auditTarget("tenant_member", member.id, { tenant, userId: member.userId, roles });
        return describeMember(context, { ...member, roles });
      },
    }),

    defineRoute({
      method: "DELETE",
      path: "/members/:id",
      access: "permission",
      permission: MEMBERS_PERMISSION,
      apiKey: true,
      audit: "multi_tenant.member_remove",
      handler: async (context) => {
        const tenant = currentTenant(context.principal);
        const member = await findMemberById(context, tenant, context.params.id);
        if (!member) throw new HttpError(404, "NOT_FOUND", "Member not found.");
        await assertCanManage(context, tenant, member);
        await context.system.records.delete(MEMBERS, member.recordId);
        context.auditTarget("tenant_member", member.id, { tenant, userId: member.userId });
        return null;
      },
    }),

    defineRoute({
      method: "GET",
      path: "/invitations",
      access: "permission",
      permission: MEMBERS_PERMISSION,
      apiKey: true,
      handler: async (context) => {
        const now = Date.now();
        const items = (await invitationsOf(context, currentTenant(context.principal)))
          .filter((invitation) => invitation.expiresAt !== null && Date.parse(invitation.expiresAt) > now)
          .map(({ id, email, roles, expiresAt }) => ({ id, email, roles, expiresAt }));
        return { items };
      },
    }),

    defineRoute({
      method: "POST",
      path: "/invitations",
      access: "permission",
      permission: MEMBERS_PERMISSION,
      apiKey: true,
      audit: "multi_tenant.invite",
      rateLimit: { window: 3600, max: 50 },
      body: z.object({ email: z.email().max(254), roles: roleNames }),
      handler: async (context) => {
        const tenantId = currentTenant(context.principal);
        const tenant = await findTenant(context, tenantId);
        if (!tenant || tenant.status !== "active") throw new HttpError(404, "SCOPE_NOT_FOUND", "This tenant doesn't exist.");
        const roles = [...new Set(context.body.roles)];
        await assertCanGive(context, tenantId, roles);
        const email = context.body.email.toLowerCase();
        const invited = await context.system.users.findByEmail(email);
        if (invited && (await findMember(context, tenantId, invited.id))) throw new HttpError(409, "ALREADY_MEMBER", "They're already a member of this tenant.");
        // Inviting someone again replaces what they were sent before.
        const earlier = (await invitationsOf(context, tenantId)).filter((invitation) => invitation.email === email);
        await assertMemberRoom(context, tenantId, earlier.length ? 0 : 1);
        for (const invitation of earlier) {
          await context.system.records.update(INVITATIONS, invitation.recordId, { invitationStatus: "canceled" });
        }
        const settings = await context.settings.get();
        const days = typeof settings.invitationDays === "number" ? settings.invitationDays : 7;
        const id = newId();
        const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
        await context.system.records.create(INVITATIONS, {
          status: "published",
          authId: id,
          organizationId: tenantId,
          email,
          role: roles.join(","),
          invitationStatus: "pending",
          expiresAt,
          inviterId: userOf(context.principal).id,
          invitationCreatedAt: new Date().toISOString(),
        });
        // In their language when they have an account, otherwise the site's.
        const words = invitationMail(invited?.locale ?? (await context.schema.languages()).defaultLocale, { tenant: tenant.name, inviter: userOf(context.principal).name, days });
        await context.mail.send({
          to: email,
          subject: words.subject.slice(0, 200),
          body: words.body,
          locale: words.locale,
          // The account page, which anyone signed in can open, lists their invitations to accept.
          action: { label: words.action, url: `${options.siteUrl}${adminPath(`/account?invitation=${id}`)}#tenant-invitations` },
        });
        context.auditTarget("tenant_invitation", id, { tenant: tenantId, roles });
        return { id, email, roles, expiresAt };
      },
    }),

    defineRoute({
      method: "DELETE",
      path: "/invitations/:id",
      access: "permission",
      permission: MEMBERS_PERMISSION,
      apiKey: true,
      audit: "multi_tenant.invitation_cancel",
      handler: async (context) => {
        const tenant = currentTenant(context.principal);
        const invitation = await findInvitation(context, tenant, context.params.id);
        if (!invitation || invitation.status !== "pending") throw new HttpError(404, "NOT_FOUND", "Invitation not found.");
        await context.system.records.update(INVITATIONS, invitation.recordId, { invitationStatus: "canceled" });
        context.auditTarget("tenant_invitation", invitation.id, { tenant });
        return null;
      },
    }),

    defineRoute({
      method: "GET",
      path: "/invitations/mine",
      access: "authenticated",
      handler: async (context) => {
        // better-auth finds them by the caller's own email, and names each tenant.
        const found = await context.auth.call<Array<{ id: string; organizationId: string; organizationName?: string; role: string; status: string; expiresAt: string | Date }>>("/organization/list-user-invitations");
        const now = Date.now();
        const items = found
          .filter((invitation) => invitation.status === "pending" && new Date(invitation.expiresAt).getTime() > now)
          .map((invitation) => ({ id: invitation.id, tenant: invitation.organizationId, tenantName: invitation.organizationName ?? null, roles: invitation.role.split(",").filter(Boolean), expiresAt: new Date(invitation.expiresAt).toISOString() }));
        return { items };
      },
    }),

    defineRoute({
      method: "POST",
      path: "/invitations/:id/accept",
      access: "authenticated",
      audit: "multi_tenant.invitation_accept",
      handler: async (context) => {
        if (!RECORD_KEY.test(context.params.id)) throw new HttpError(404, "NOT_FOUND", "Invitation not found.");
        // The invitation already holds its place under the limit on members, so this only stops a tenant whose limit was lowered since.
        const invitation = await invitationById(context, context.params.id);
        if (invitation) await assertMemberRoom(context, invitation.tenant, 0);
        // As the invitee: better-auth checks the invitation is theirs, still pending and unexpired, and that their email is verified.
        const accepted = await context.auth.call<{ member: { id: string; organizationId: string } }>("/organization/accept-invitation", { body: { invitationId: context.params.id } });
        context.auditTarget("tenant_invitation", context.params.id, { tenant: accepted.member.organizationId });
        return { tenant: accepted.member.organizationId, member: accepted.member.id };
      },
    }),

    defineRoute({
      method: "POST",
      path: "/invitations/:id/reject",
      access: "authenticated",
      audit: "multi_tenant.invitation_reject",
      handler: async (context) => {
        if (!RECORD_KEY.test(context.params.id)) throw new HttpError(404, "NOT_FOUND", "Invitation not found.");
        await context.auth.call("/organization/reject-invitation", { body: { invitationId: context.params.id } });
        context.auditTarget("tenant_invitation", context.params.id);
        return null;
      },
    }),

    // A tenant's life, for instance staff: its plan and limits, suspending, resuming, export, import and purge.
    // Each names the tenant in the address, since a suspended one can't be the current tenant.
    defineRoute({
      method: "GET",
      path: "/tenants/:id/plan",
      access: "permission",
      permission: "ext.multi-tenant:read",
      apiKey: true,
      handler: async (context) => {
        const tenant = await tenantFromPath(context);
        const [plan, usage, members] = await Promise.all([planOf(context, tenant.id), context.scope.data.usage(tenant.id), membersOf(context, tenant.id)]);
        const { records, storageBytes, members: memberLimit, requestsPerMinute, purgeAt } = plan;
        return { tenant: publicTenant(tenant), limits: { records, storageBytes, members: memberLimit, requestsPerMinute }, usage: { ...usage, members: members.length }, purgeAt };
      },
    }),

    defineRoute({
      method: "PUT",
      path: "/tenants/:id/limits",
      access: "permission",
      permission: "ext.multi-tenant:update",
      fresh: true,
      audit: "multi_tenant.limits",
      body: z.object({ records: limitValue, storageBytes: limitValue, members: limitValue, requestsPerMinute: limitValue }),
      handler: async (context) => {
        const tenant = await tenantFromPath(context);
        await setLimits(context, tenant.id, context.body);
        context.auditTarget("tenant", tenant.id, { ...context.body });
        return context.body;
      },
    }),

    defineRoute({
      method: "POST",
      path: "/tenants/:id/suspend",
      access: "permission",
      permission: DELETE_PERMISSION,
      apiKey: true,
      audit: "multi_tenant.suspend",
      handler: async (context) => {
        const tenant = await tenantFromPath(context);
        if (tenant.status !== "suspended") await suspendTenant(context, tenant);
        context.auditTarget("tenant", tenant.id);
        return { ...publicTenant(tenant), status: "suspended" };
      },
    }),

    defineRoute({
      method: "POST",
      path: "/tenants/:id/resume",
      access: "permission",
      permission: DELETE_PERMISSION,
      apiKey: true,
      audit: "multi_tenant.resume",
      handler: async (context) => {
        const tenant = await tenantFromPath(context);
        await resumeTenant(context, tenant);
        context.auditTarget("tenant", tenant.id);
        return { ...publicTenant(tenant), status: "active" };
      },
    }),

    defineRoute({
      method: "POST",
      path: "/tenants/:id/purge",
      access: "permission",
      permission: DELETE_PERMISSION,
      fresh: true,
      audit: "multi_tenant.purge_request",
      // The tenant's short name, typed again, so a purge is never one click.
      body: z.object({ confirm: z.string().max(64) }),
      handler: async (context) => {
        const tenant = await tenantFromPath(context);
        if (tenant.status !== "suspended") throw new HttpError(409, "NOT_SUSPENDED", "Suspend the tenant first. A purge only removes a suspended tenant.");
        if (context.body.confirm !== tenant.slug) throw new HttpError(400, "CONFIRMATION_MISMATCH", "Type the tenant's short name to confirm.");
        const value = (await context.settings.get()).purgeDays;
        const days = typeof value === "number" && value >= 1 ? value : DEFAULT_PURGE_DAYS;
        const purgeAt = await schedulePurge(context, tenant.id, days, userOf(context.principal).id);
        context.auditTarget("tenant", tenant.id, { purgeAt });
        return { purgeAt };
      },
    }),

    defineRoute({
      method: "DELETE",
      path: "/tenants/:id/purge",
      access: "permission",
      permission: DELETE_PERMISSION,
      audit: "multi_tenant.purge_cancel",
      handler: async (context) => {
        const tenant = await tenantFromPath(context);
        await cancelPurge(context, tenant.id);
        context.auditTarget("tenant", tenant.id);
        return null;
      },
    }),

    defineRoute({
      method: "GET",
      path: "/tenants/:id/export",
      access: "permission",
      permission: DELETE_PERMISSION,
      apiKey: true,
      audit: "multi_tenant.export",
      rateLimit: { window: 3600, max: 10 },
      handler: async (context) => {
        const tenant = await tenantFromPath(context);
        const archive = await context.scope.data.export(tenant.id);
        context.auditTarget("tenant", tenant.id);
        const { createReadStream, statSync } = await import("node:fs");
        const size = statSync(archive.path).size;
        const stream = createReadStream(archive.path);
        stream.once("close", () => void archive.cleanup());
        return new Response(Readable.toWeb(stream) as ReadableStream, {
          headers: {
            "content-type": "application/gzip",
            "content-length": String(size),
            "content-disposition": `attachment; filename="${archive.name}"`,
            "cache-control": "no-store",
          },
        });
      },
    }),

    defineRoute({
      method: "POST",
      path: "/tenants/:id/import",
      access: "permission",
      permission: "ext.multi-tenant:create",
      apiKey: true,
      audit: "multi_tenant.import",
      rateLimit: { window: 3600, max: 10 },
      handler: async (context) => {
        const tenant = await tenantFromPath(context);
        if (!context.request.body) throw new HttpError(400, "VALIDATION_FAILED", "Send the archive as the request's body.");
        const directory = await mkdtemp(path.join(tmpdir(), "cms-tenant-import-"));
        try {
          const file = path.join(directory, "archive.tar.gz");
          let received = 0;
          const cap = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              received += chunk.length;
              done(received > MAX_IMPORT_BYTES ? new HttpError(413, "PAYLOAD_TOO_LARGE", "The archive is too large.") : null, chunk);
            },
          });
          await pipeline(Readable.fromWeb(context.request.body as Parameters<typeof Readable.fromWeb>[0]), cap, createWriteStream(file));
          const placed = await context.scope.data.import(tenant.id, file);
          context.auditTarget("tenant", tenant.id, placed);
          return placed;
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    }),
  ];
}

export { DOMAINS_PERMISSION, EVERY_TENANT, MEMBERS_PERMISSION, PLUGIN };
