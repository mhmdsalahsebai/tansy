import { createReadStream, createWriteStream, statSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { defineCommand, type PluginCommand, type PluginCommandContext } from "tansy/plugin";
import { TENANT_HEADER } from "./tenants";

/**
 * `tansy tenant`, for running tenants from a terminal or a script.
 *
 * It talks to a running server as the API key in `TANSY_API_KEY`, over this plugin's own routes, so
 * every command does exactly what that key may do over HTTP and each write is audited like any
 * other. That is why there is no `tansy tenant create`, `limits` or `purge`: those routes ask for a
 * recent sign-in, which a key can't show, and a purge removes everything a tenant has, so a person
 * does them in the dashboard. See MULTI_TENANT_PLAN.md.
 */

interface Tenant { id: string; name: string; slug: string; status: string }

const pad = (value: string, width: number) => value.padEnd(width, " ");

/** A table, so a terminal shows columns rather than JSON nobody can read. */
function table(rows: string[][], log: (line: string) => void) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  for (const row of rows) log(row.map((cell, column) => pad(cell, widths[column])).join("  ").trimEnd());
}

const bytes = (value: number | null) => (value === null ? "—" : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${value} B`);
const count = (value: number | null) => (value === null ? "—" : String(value));

/** The tenant a command works on, which every one of these takes as a word, never as a flag. */
function tenantArgument(context: PluginCommandContext, command: string): string {
  const id = context.args[1];
  if (!id) context.fail(`Usage: tansy tenant ${command} <tenant id>. Run cms tenant list for the ids.`);
  return id;
}

async function list(context: PluginCommandContext) {
  const { items } = await context.api.request<{ items: Tenant[]; current: string | null }>("/tenants");
  if (!items.length) return context.log("This instance has no tenants the key can see.");
  table([["ID", "SHORT NAME", "NAME", "STATUS"], ...items.map((tenant) => [tenant.id, tenant.slug, tenant.name, tenant.status])], context.log);
}

async function show(context: PluginCommandContext) {
  const id = tenantArgument(context, "show");
  const plan = await context.api.request<{
    tenant: Tenant;
    limits: { records: number | null; storageBytes: number | null; members: number | null; requestsPerMinute: number | null };
    usage: { records: number; storageBytes: number; members: number };
    purgeAt: string | null;
  }>(`/tenants/${encodeURIComponent(id)}/plan`);
  const { tenant, limits, usage } = plan;
  context.log(`${tenant.name} (${tenant.slug})  ${tenant.id}  ${tenant.status}`);
  table([
    ["", "USING", "LIMIT"],
    ["Records", String(usage.records), count(limits.records)],
    ["Files", bytes(usage.storageBytes), bytes(limits.storageBytes)],
    ["Members", String(usage.members), count(limits.members)],
    ["Requests a minute", "—", count(limits.requestsPerMinute)],
  ], context.log);
  if (plan.purgeAt) context.log(`\nEverything this tenant has is deleted at ${plan.purgeAt} unless it is resumed first.`);
}

async function domains(context: PluginCommandContext) {
  const tenant = typeof context.flags.tenant === "string" ? context.flags.tenant : undefined;
  if (!tenant) context.fail("Usage: tansy tenant domains --tenant <tenant id>. A key bound to one tenant already names it, and then --tenant must match.");
  const { items } = await context.api.request<{ items: Array<{ host: string; verified: boolean; primary: boolean; record: { name: string; value: string } }> }>(
    "/domains",
    { headers: { [TENANT_HEADER]: tenant! } },
  );
  if (!items.length) return context.log("This tenant has claimed no domain.");
  table([
    ["HOST", "STATE", "MAIN", "TXT RECORD"],
    ...items.map((domain) => [domain.host, domain.verified ? "verified" : "waiting", domain.primary ? "yes" : "", domain.verified ? "" : `${domain.record.name} = ${domain.record.value}`]),
  ], context.log);
}

const statusChange = (command: "suspend" | "resume") => async (context: PluginCommandContext) => {
  const id = tenantArgument(context, command);
  const tenant = await context.api.request<Tenant>(`/tenants/${encodeURIComponent(id)}/${command}`, { method: "POST" });
  context.log(command === "suspend"
    ? `${tenant.name} is suspended. Its domains, members and keys now reach nothing, and everything it has stays where it is.`
    : `${tenant.name} is active again, and any purge it was waiting for is called off.`);
};

async function exportTenant(context: PluginCommandContext) {
  const id = tenantArgument(context, "export");
  const response = await context.api.fetch(`/tenants/${encodeURIComponent(id)}/export`);
  if (!response.ok || !response.body) {
    const text = await response.text();
    return context.fail(`The server answered ${response.status}: ${text.slice(0, 400)}`);
  }
  const named = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1];
  const out = typeof context.flags.out === "string" ? context.flags.out : (named ?? `${id}.tar.gz`);
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(out) as unknown as Writable);
  context.log(`Wrote ${out} (${bytes(statSync(out).size)}). It holds everything this tenant has, so keep it as you would a backup.`);
}

async function importTenant(context: PluginCommandContext) {
  const id = tenantArgument(context, "import");
  const file = typeof context.flags.in === "string" ? context.flags.in : undefined;
  if (!file) context.fail("Usage: tansy tenant import <tenant id> --in <archive>. The tenant must exist and have no data yet.");
  const size = statSync(file!).size;
  const response = await context.api.fetch(`/tenants/${encodeURIComponent(id)}/import`, {
    method: "POST",
    headers: { "content-type": "application/gzip", "content-length": String(size) },
    // Node streams the file rather than holding an archive of any size in memory.
    body: Readable.toWeb(createReadStream(file!)) as unknown as BodyInit,
  });
  const text = await response.text();
  if (!response.ok) return context.fail(`The server answered ${response.status}: ${text.slice(0, 400)}`);
  const placed = JSON.parse(text) as { records: number; files: number };
  context.log(`Placed ${placed.records} records and ${placed.files} files in ${id}.`);
}

const actions: Record<string, (context: PluginCommandContext) => Promise<void>> = {
  list,
  show,
  domains,
  suspend: statusChange("suspend"),
  resume: statusChange("resume"),
  export: exportTenant,
  import: importTenant,
};

export function tenantCommands(): PluginCommand[] {
  return [
    defineCommand({
      name: "tenant",
      usage: "cms tenant <list | show <id> | domains --tenant <id> | suspend <id> | resume <id> | export <id> [--out <file>] | import <id> --in <file>>",
      describe: "Run this instance's tenants through the API, as the key in TANSY_API_KEY. Making one, its limits and a purge are the dashboard's.",
      run: async (context) => {
        const action = actions[context.args[0] ?? ""];
        if (!action) {
          context.fail(`Usage: tansy tenant <${Object.keys(actions).join(" | ")}>. Making a tenant, setting its limits and asking for a purge all need a person signed in, so they are in the dashboard under Tenants.`);
        }
        await action(context);
      },
    }),
  ];
}
