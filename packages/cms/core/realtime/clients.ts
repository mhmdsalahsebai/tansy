import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getRuntime } from "../auth/instance";
import { READ_AS_HEADER, resolvePrincipal } from "../authz/guard";
import type { Principal } from "../authz/principal";
import { ANONYMOUS } from "../authz/principal";
import { decideRecord, loadRuleLookups, matchesFilter, type RuleRequest } from "../authz/records";
import { requireCollectionBySlug, type CollectionWithFields } from "../content/access";
import { callerFilterProblem, viewRecord } from "../content/public-records";
import { parseExpand, parseFields, recordViewQuery, type RecordViewQuery } from "../content/query";
import { flattenRecord, type RecordRow } from "../content/records";
import { badRequest, HttpError, notFound } from "../http/errors";
import { hub, type RecordEvent } from "./hub";
import { isLocalizedCollection, type CollectionLocale } from "../i18n/context";
import { readingLocale } from "../i18n/request";
import { findRecordsById } from "../content/content-service";
import { SCOPE_COLUMN, withScope } from "../scope/context";
import { principalInScope } from "../scope/request";

const MAX_CLIENTS = 5000;
const MAX_CLIENTS_PER_IDENTITY = 20;
const IDLE_MS = 5 * 60_000;
const SWEEP_MS = 25_000;
/** How long a principal is trusted before it's resolved again, as for dashboard changes in getRuntime. */
const RECHECK_MS = 2000;
/** A client this far behind is dropped rather than buffered without limit. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

interface Subscription {
  topic: string;
  collectionId: number;
  recordId: number | null;
  query: RecordViewQuery;
  request: RuleRequest;
  /** For a localized collection, the languages this subscriber reads, from `?locale=` in its options. */
  locale?: CollectionLocale;
}

interface Client {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  subscriptions: Subscription[];
  /** Set by the first subscribe call, and required to match after that. */
  identity: string | null;
  /** The scope value the connection subscribed in (core/scope). Undefined until its first subscription. */
  scope?: string | null;
  /** Credentials from that call, so access can be re-checked for each event. Memory only. */
  credentials: Headers | null;
  checked: { at: number; principal: Principal | null };
  lastMessage: number;
}

interface ClientState {
  clients: Map<string, Client>;
  sweeper?: NodeJS.Timeout;
}

declare const globalThis: { cmsRealtimeClients?: ClientState } & typeof global;

const state: ClientState = (globalThis.cmsRealtimeClients ??= { clients: new Map() });
const encoder = new TextEncoder();

function remove(client: Client, close = true) {
  if (!state.clients.delete(client.id) || !close) return;
  try { client.controller.close(); } catch { /* already closed by the browser */ }
}

function write(client: Client, chunk: string) {
  if ((client.controller.desiredSize ?? 0) <= 0) return remove(client);
  try {
    client.controller.enqueue(encoder.encode(chunk));
  } catch {
    remove(client, false);
  }
}

function send(client: Client, event: string, data: unknown) {
  client.lastMessage = Date.now();
  write(client, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const CREDENTIAL_HEADERS = new Set(["cookie", "x-api-key", "authorization", READ_AS_HEADER]);

const identityOf = (principal: Principal) => (principal.kind === "anonymous" ? "anonymous" : principal.kind === "user" ? `user:${principal.user.id}` : `key:${principal.keyId}`);

/** Null means this connection's access has ended. Goes through the same checks as a request, so bans, role changes and revoked sessions apply. */
async function currentPrincipal(client: Client): Promise<Principal | null> {
  if (!client.credentials) return ANONYMOUS;
  if (Date.now() - client.checked.at < RECHECK_MS) return client.checked.principal;
  const principal = await getRuntime().then(async (runtime) => {
    const resolved = await resolvePrincipal({ headers: client.credentials! }, runtime, true);
    // Bound to the scope value it subscribed in, with its roles there read again.
    return principalInScope(resolved, client.scope ?? null, runtime, client.credentials!.get(READ_AS_HEADER) === "member");
  }).catch(() => null);
  const valid = principal && identityOf(principal) === client.identity ? principal : null;
  client.checked = { at: Date.now(), principal: valid };
  return valid;
}

async function deliver(event: RecordEvent) {
  for (const client of [...state.clients.values()]) {
    const matching = client.subscriptions.filter((sub) => sub.collectionId === event.collection.id && (sub.recordId === null || sub.recordId === event.row.id));
    if (!matching.length) continue;
    const principal = await currentPrincipal(client);
    if (!principal) {
      remove(client);
      continue;
    }
    // Another scope's record never reaches this connection, whatever its rules say.
    const rowScope = (event.row as Record<string, unknown>)[SCOPE_COLUMN];
    if (typeof rowScope === "string" && rowScope !== (client.scope ?? null)) continue;
    await withScope(client.scope ?? null, () => deliverTo(client, principal, event, matching));
  }
}

async function deliverTo(client: Client, principal: Principal, event: RecordEvent, matching: Client["subscriptions"]) {
  {
    // Fresh for every event: a connection can outlive any number of changes to what these rules read.
    const lookups = await loadRuleLookups([event.collection]);
    // A localized record is checked as each subscriber reads it, which can be another language than the one written.
    const asRead = new Map<string, RecordRow | null>();
    const readIn = async (locale: CollectionLocale) => {
      const key = locale.chain.join(",");
      if (!asRead.has(key)) asRead.set(key, (await findRecordsById({ ...event.collection, locale }, [event.row.id]))[0] ?? null);
      return asRead.get(key)!;
    };
    for (const subscription of matching) {
      const request = { ...subscription.request, lookups };
      const localized = isLocalizedCollection(event.collection) && event.action !== "delete" && subscription.locale;
      const collection = localized ? { ...event.collection, locale: subscription.locale } : event.collection;
      // A whole-collection topic follows the list rule, and a single-record topic the view rule.
      const action = subscription.recordId === null ? "list" : "view";
      const filter = typeof subscription.query.filter === "string" ? subscription.query.filter : "";
      // Checked again each time, as losing access to a hidden field must also end filtering on it.
      if (filter && callerFilterProblem(event.collection, principal, filter)) continue;
      const visible = (row: RecordRow) => decideRecord(principal, event.collection, action, flattenRecord(row), request) === "allow" && (!filter || matchesFilter(principal, filter, flattenRecord(row), request));
      try {
        const row = localized ? await readIn(subscription.locale!) : event.row;
        // The previous version counts only if it was in a language this subscriber reads.
        const before = event.previous && (!localized || subscription.locale!.chain.includes(String(event.previous.locale))) ? event.previous : undefined;
        if (!row || !visible(row)) {
          // Only the id, and only to someone who could see it until now, so clients can drop their copy.
          if (event.action === "update" && before && visible(before)) send(client, subscription.topic, { action: "delete", record: { id: event.row.id } });
          continue;
        }
        const record = await viewRecord(collection, row, subscription.query, principal, request);
        send(client, subscription.topic, { action: event.action, record });
      } catch (error) {
        // One subscription's bad expansion must not stop delivery to everyone else.
        if (!(error instanceof HttpError)) console.error("[realtime]", error);
      }
    }
  }
}

async function sweep() {
  const now = Date.now();
  for (const client of [...state.clients.values()]) {
    if (now - client.lastMessage > IDLE_MS || !(await currentPrincipal(client))) remove(client);
    else write(client, ": ping\n\n");
  }
}

function ensureRunning() {
  hub.dispatch = deliver;
  hub.subscribers = () => state.clients.size;
  state.sweeper ??= setInterval(() => void sweep().catch((error) => console.error("[realtime]", error)), SWEEP_MS);
  state.sweeper.unref();
}

/** Opens the event stream and sends the id the client needs to subscribe. */
export function connect(signal: AbortSignal) {
  if (state.clients.size >= MAX_CLIENTS) throw new HttpError(503, "REALTIME_BUSY", "Too many realtime connections.");
  ensureRunning();
  const id = randomBytes(16).toString("base64url");
  let client: Client;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      client = { id, controller, subscriptions: [], identity: null, credentials: null, checked: { at: 0, principal: ANONYMOUS }, lastMessage: Date.now() };
      state.clients.set(id, client);
      send(client, "PB_CONNECT", { clientId: id });
    },
    cancel() {
      remove(client, false);
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: MAX_BUFFERED_BYTES }));
  signal.addEventListener("abort", () => remove(client));
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // no-transform also keeps compression from holding events back.
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}

const TOPIC = /^([a-z0-9-]+)\/(\*|\d{1,10})(?:\?options=([^\r\n]*))?$/;
const topicOptions = z.object({
  query: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

function parseOptions(raw: string | undefined) {
  if (!raw) return {};
  try {
    return topicOptions.parse(JSON.parse(decodeURIComponent(raw)));
  } catch {
    throw badRequest("A subscription has invalid options.");
  }
}

/** The caller's real headers win, so options can't fake one a rule trusts, such as a proxy's client IP. */
function ruleHeaders(given: Record<string, string> | undefined, real: Headers) {
  try {
    const headers = new Headers(given);
    real.forEach((value, name) => headers.set(name, value));
    return headers;
  } catch {
    throw badRequest("A subscription has invalid headers.");
  }
}

export type TopicCheck = (collection: CollectionWithFields, action: "list" | "view") => boolean;

async function parseTopic(topic: string, real: Headers, allowed: TopicCheck, principal: Principal): Promise<Subscription> {
  const match = TOPIC.exec(topic);
  if (!match) throw badRequest(`Invalid subscription "${topic.slice(0, 100)}". Use collection/* or collection/recordId.`);
  const collection = await requireCollectionBySlug(match[1]);
  if (collection.type === "view") throw badRequest("View collections have no realtime events.");
  const recordId = match[2] === "*" ? null : Number(match[2]);
  if (!allowed(collection, recordId === null ? "list" : "view")) throw new HttpError(403, "RULE_LOCKED", "Only administrators can perform this action.");

  const options = parseOptions(match[3]);
  const query = recordViewQuery.safeParse(options.query ?? {});
  if (!query.success) throw badRequest("A subscription has invalid options.");
  parseExpand(query.data.expand);
  parseFields(query.data.fields);
  const filter = query.data.filter;
  if (filter !== undefined) {
    if (typeof filter !== "string" || filter.length > 2048) throw badRequest("A subscription has invalid options.");
    const problem = callerFilterProblem(collection, principal, filter);
    if (problem) throw new HttpError(400, "INVALID_FILTER", problem);
  }
  const reading = await readingLocale(collection, principal, { locale: query.data.locale, fallback: query.data.fallback });
  if (reading.all) throw badRequest('Subscribe to one language at a time, not "*".');
  return { topic, collectionId: collection.id, recordId, query: query.data, locale: reading.collection.locale, request: { method: "GET", headers: ruleHeaders(options.headers, real), query: query.data, body: {}, locale: reading.locale } };
}

/** Replaces the client's subscriptions. An empty list unsubscribes from everything. */
export async function setSubscriptions(clientId: string, topics: string[], principal: Principal, headers: Headers, allowed: TopicCheck) {
  const client = state.clients.get(clientId);
  if (!client) throw notFound("Client");

  const identity = identityOf(principal);
  if (client.identity !== null && client.identity !== identity) throw new HttpError(403, "REALTIME_AUTH_MISMATCH", "The current and previous authorization don't match.");
  // A connection stays in the scope value it first subscribed in.
  const scope = principal.scope ?? null;
  if (client.scope !== undefined && client.scope !== scope) throw new HttpError(403, "REALTIME_AUTH_MISMATCH", "The current and previous authorization don't match.");
  if (client.identity === null && identity !== "anonymous") {
    const open = [...state.clients.values()].filter((other) => other.identity === identity).length;
    if (open >= MAX_CLIENTS_PER_IDENTITY) throw new HttpError(429, "RATE_LIMITED", "Too many realtime connections for this user.");
  }

  const subscriptions = await Promise.all([...new Set(topics)].map((topic) => parseTopic(topic, headers, allowed, principal)));
  client.identity = identity;
  client.scope = scope;
  if (principal.kind !== "anonymous") {
    // With the read-as header, so a member's connection is re-checked as the member it subscribed as.
    client.credentials = new Headers([...headers].filter(([name]) => CREDENTIAL_HEADERS.has(name)));
    client.checked = { at: Date.now(), principal };
  }
  client.subscriptions = subscriptions;
  client.lastMessage = Date.now();
}
