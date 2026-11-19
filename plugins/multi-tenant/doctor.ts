import type { DoctorCheck } from "tansy/plugin";

/**
 * What `tansy doctor` says about this plugin. It runs with no server and no database, so these are
 * about the options the app passes in `tansy.config.ts`: the kind of mistake that works until a real
 * tenant hits it. Counting tenants or finding a domain whose DNS has gone would need the database,
 * and those belong to the dashboard's Tenants page and the daily jobs.
 */

/** A DNS server as the resolver takes it: a host or address, with an optional port. */
const SERVER = /^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/;

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/;

export function tenantChecks(options: { siteUrl: string; scopeNewCollections: boolean; dnsServers?: string[] }): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const dashboard = new URL(options.siteUrl);

  // Invitation emails and each tenant's own site address are built from this.
  checks.push({
    ok: !LOCAL.test(dashboard.hostname),
    label: "the dashboard's address is one other people can reach",
    fix: `siteUrl is ${dashboard.origin}, so invitation emails link there and a tenant with no verified domain has no site address. Set it to this instance's public address.`,
    warning: true,
  });

  const bad = (options.dnsServers ?? []).filter((server) => !SERVER.test(server));
  if (options.dnsServers?.length) {
    checks.push({
      ok: bad.length === 0,
      label: "its DNS servers are addresses",
      fix: `dnsServers has ${bad.map((server) => JSON.stringify(server)).join(", ")}, which isn't a host or address with an optional port, such as "10.0.0.2" or "10.0.0.2:5353". Domains would never verify.`,
    });
    checks.push({
      ok: !options.dnsServers.some((server) => LOCAL.test(server.replace(/:\d+$/, ""))),
      label: "its DNS servers aren't this machine",
      fix: "dnsServers points at this machine, which is how the test suite stands in for DNS. In production a tenant could then prove a domain it doesn't own.",
      warning: true,
    });
  }

  // Off means a new collection is shared by every tenant, which is easy to miss until one tenant reads another's rows.
  checks.push({
    ok: options.scopeNewCollections,
    label: "new collections keep each tenant's records apart",
    fix: "scopeNewCollections is false, so a collection made under Collections is shared by every tenant until someone turns its scope on, on the collection's schema page.",
    warning: true,
  });

  return checks;
}
