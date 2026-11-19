import "server-only";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Prisma, Webhook } from "../../generated/client-sqlite";
import { getRuntime } from "../auth/instance";
import { decryptSecret, encryptSecret } from "../auth/secrets";
import { principalForUser } from "../authz/principal";
import { decideRecord, loadRuleLookups, type RuleRequest } from "../authz/records";
import { viewRecord } from "../content/public-records";
import { flattenRecord } from "../content/records";
import { badRequest, notFound } from "../http/errors";
import type { RecordEvent } from "../realtime/hub";
import prisma from "../../lib/prisma";
import { SCOPE_COLUMN } from "../scope/context";
import { principalInScope } from "../scope/request";
import { postJson, webhookUrlProblem } from "./safe-http";

/** Seconds to wait before each retry. After the last one the delivery is marked failed. */
const RETRY_DELAYS = [30, 300, 1800, 7200, 21_600];
const BATCH = 20;
const KEEP_MS = 30 * 86_400_000;

export interface WebhookInput {
  name: string;
  url: string;
  events: string[];
  collections: string[];
  enabled: boolean;
}

const OWNER_PERMISSION = "webhook:manage";

/**
 * Row scopes: a webhook belongs to the scope value it was created in, "" for none, and is
 * listed, changed and sent records only there. So a tenant's records never reach another
 * tenant's webhook, nor one made outside any tenant, whoever owns it.
 */
const present = (hook: Webhook) => ({ id: hook.id, scope: hook.scope || null, name: hook.name, url: hook.url, events: hook.events as string[], collections: hook.collections as string[], enabled: hook.enabled, createdById: hook.createdById, createdAt: hook.createdAt, updatedAt: hook.updatedAt });

function assertUrl(url: string) {
  const problem = webhookUrlProblem(url);
  if (problem) throw badRequest(problem);
}

const inScope = (scope: string | null | undefined) => scope ?? "";

export const listWebhooks = async (scope: string | null | undefined) => (await prisma.webhook.findMany({ where: { scope: inScope(scope) }, orderBy: { id: "asc" } })).map(present);

/** The only time the secret is returned. */
export async function createWebhook(input: WebhookInput, ownerId: string, scope: string | null | undefined) {
  assertUrl(input.url);
  const secret = randomBytes(32).toString("base64url");
  const hook = await prisma.webhook.create({ data: { ...input, scope: inScope(scope), secret: encryptSecret(secret), createdById: ownerId } });
  return { ...present(hook), secret };
}

/** Whoever edits a webhook becomes its owner, so nobody can redirect another person's access to a new address. */
export async function updateWebhook(id: number, input: WebhookInput, ownerId: string, scope: string | null | undefined) {
  assertUrl(input.url);
  const existing = await prisma.webhook.findFirst({ where: { id, scope: inScope(scope) } });
  if (!existing) throw notFound("Webhook");
  return present(await prisma.webhook.update({ where: { id }, data: { ...input, createdById: ownerId } }));
}

export async function deleteWebhook(id: number, scope: string | null | undefined) {
  const { count } = await prisma.webhook.deleteMany({ where: { id, scope: inScope(scope) } });
  if (!count) throw notFound("Webhook");
}

/** Status only. Payloads hold what the owner could read, which a reader of this list may not be allowed to see. */
export async function listDeliveries(webhookId: number, scope: string | null | undefined) {
  if (!(await prisma.webhook.findFirst({ where: { id: webhookId, scope: inScope(scope) }, select: { id: true } }))) throw notFound("Webhook");
  return prisma.webhookDelivery.findMany({ where: { webhookId }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, event: true, status: true, attempts: true, responseStatus: true, error: true, createdAt: true, finishedAt: true, nextAttemptAt: true } });
}

/** The owner as they act in the webhook's scope value, with their roles there read again, or null once they can't manage it. */
const ownerPrincipal = async (hook: Webhook) => {
  const runtime = await getRuntime();
  const user = await principalForUser(hook.createdById, runtime, `webhook:${hook.id}`);
  const principal = user && await principalInScope(user, hook.scope || null, runtime, false);
  return principal?.permissions.has(OWNER_PERMISSION) ? principal : null;
};

const REQUEST: RuleRequest = { method: "GET", headers: new Headers(), query: {}, body: {} };

/** Each webhook gets only what its owner can read now, through decideRecord, with hidden fields handled the same way. */
export async function enqueueWebhooks({ collection, action, row }: RecordEvent) {
  const rowScope = row[SCOPE_COLUMN];
  const scope = typeof rowScope === "string" ? rowScope : "";
  const hooks = (await prisma.webhook.findMany({ where: { enabled: true, scope } })).filter((hook) => (hook.events as string[]).includes(action) && ((hook.collections as string[]).length === 0 || (hook.collections as string[]).includes(collection.slug)));
  const event = `record.${action}`;
  for (const hook of hooks) {
    const owner = await ownerPrincipal(hook);
    // Read for each event, so a long-running server never judges from old values.
    const request = { ...REQUEST, lookups: await loadRuleLookups([collection]) };
    if (!owner || decideRecord(owner, collection, "view", flattenRecord(row), request) !== "allow") continue;
    const record = await viewRecord(collection, row, {}, owner, request);
    const id = randomUUID();
    const payload = JSON.stringify({ id, event, collection: collection.slug, ...(scope ? { scope } : {}), at: new Date().toISOString(), record });
    await prisma.webhookDelivery.create({ data: { id, webhookId: hook.id, event, payload } });
  }
}

export function signPayload(secret: string, timestamp: string, body: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

async function attempt(delivery: Prisma.WebhookDeliveryGetPayload<{ include: { webhook: true } }>) {
  const { webhook: hook } = delivery;
  const attempts = delivery.attempts + 1;
  const finish = (data: Partial<Prisma.WebhookDeliveryUpdateInput>) => prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { attempts, ...data } });
  const fail = (error: string, responseStatus?: number) => {
    const delay = RETRY_DELAYS[attempts - 1];
    return finish(delay === undefined
      ? { status: "failed", error, responseStatus, finishedAt: new Date() }
      : { error, responseStatus, nextAttemptAt: new Date(Date.now() + delay * 1000) });
  };

  // Access is checked again here, since a retry can come hours after the event.
  if (!hook.enabled || !(await ownerPrincipal(hook))) return finish({ status: "failed", error: "The webhook is disabled or its owner no longer has access.", finishedAt: new Date() });

  const timestamp = String(Math.floor(Date.now() / 1000));
  try {
    const status = await postJson(hook.url, delivery.payload, {
      "user-agent": "tansy-webhook",
      "x-cms-event": delivery.event,
      "x-cms-delivery": delivery.id,
      "x-cms-signature": `t=${timestamp},v1=${signPayload(decryptSecret(hook.secret), timestamp, delivery.payload)}`,
    });
    if (status >= 200 && status < 300) return finish({ status: "delivered", responseStatus: status, error: null, finishedAt: new Date() });
    return fail(`The endpoint answered ${status}.`, status);
  } catch (error) {
    return fail((error as Error).message.slice(0, 500));
  }
}

let running = false;
let lastPrune = 0;

export async function runWebhookDeliveries(now = new Date()) {
  if (running) return;
  running = true;
  try {
    const due = await prisma.webhookDelivery.findMany({ where: { status: "pending", nextAttemptAt: { lte: now } }, include: { webhook: true }, orderBy: { nextAttemptAt: "asc" }, take: BATCH });
    for (const delivery of due) await attempt(delivery);
    if (now.getTime() - lastPrune > 3_600_000) {
      lastPrune = now.getTime();
      await prisma.webhookDelivery.deleteMany({ where: { status: { not: "pending" }, createdAt: { lt: new Date(now.getTime() - KEEP_MS) } } });
    }
  } finally {
    running = false;
  }
}
