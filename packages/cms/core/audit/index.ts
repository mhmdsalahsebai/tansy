import "server-only";
import type { Prisma } from "../../generated/client-sqlite";
import prisma from "../../lib/prisma";
import { authExtensions } from "../config";
import { currentScopeValue } from "../scope/context";
import { createDenialFolder } from "./fold";

export interface AuditEvent {
  action: string;
  outcome: "success" | "failure" | "denied";
  actorId?: string | null;
  actorEmail?: string | null;
  actorKind?: "user" | "apiKey" | "anonymous" | "system";
  targetType?: string;
  targetId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** The scope value it happened in. Left out, the one the work in progress is for. */
  scope?: string | null;
  /** Never put secrets, passwords, tokens or OTPs in here. */
  metadata?: Record<string, unknown>;
}

const SENSITIVE_KEY = /pass|secret|token|otp|code|key|authorization|cookie/i;

export function sanitizeMetadata(metadata: Record<string, unknown> | undefined) {
  if (!metadata) return undefined;
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 500) : value]),
  );
}

declare const globalThis: { cmsDenialFolder?: ReturnType<typeof createDenialFolder> } & typeof global;
// On globalThis because Next.js can load this module in more than one copy.
const foldDenial = (globalThis.cmsDenialFolder ??= createDenialFolder());

/** The same caller refused the same way at the same address, in the same scope value. */
const denialKey = (event: AuditEvent, scope: string) =>
  JSON.stringify([scope, event.ipAddress ?? "", event.actorId ?? "", event.metadata?.path ?? "", event.metadata?.method ?? "", event.metadata?.reason ?? ""]);

/**
 * Hands the event to every plugin's `onAudit`, in the background and each on its own, so a slow
 * or failing plugin neither holds up the request nor stops the others. Plugins get the event as
 * it was stored, with its metadata sanitized, so forwarding it can't be where a secret leaks.
 */
function notifyPlugins(event: AuditEvent) {
  for (const extension of authExtensions()) {
    if (!extension.onAudit) continue;
    void Promise.resolve()
      .then(() => extension.onAudit!(event))
      .catch((error) => console.error(`[extension:${extension.name}] onAudit failed`, error));
  }
}

/**
 * Records an event, then tells plugins about it. Repeated `authz.denied` from one source within
 * a minute are folded into one entry: the next one written carries how many were left out in
 * `metadata.foldedBefore`. Recording an event must never break the request that caused it.
 */
export async function audit(event: AuditEvent): Promise<void> {
  // The scope value the work is for, so a tenant's events can be told apart, exported and purged with it.
  const scope = (event.scope === undefined ? currentScopeValue() : event.scope) ?? "";
  let metadata = sanitizeMetadata(event.metadata);
  if (event.action === "authz.denied") {
    const folded = foldDenial(denialKey(event, scope));
    if (!folded.write) return;
    if (folded.folded) metadata = { ...metadata, foldedBefore: folded.folded };
  }
  const recorded: AuditEvent = { ...event, scope: scope || null, metadata };
  try {
    await prisma.auditLog.create({
      data: {
        scope,
        action: event.action,
        outcome: event.outcome,
        actorId: event.actorId ?? null,
        actorEmail: event.actorEmail?.slice(0, 320) ?? null,
        actorKind: event.actorKind ?? (event.actorId ? "user" : "anonymous"),
        targetType: event.targetType,
        targetId: event.targetId,
        ipAddress: event.ipAddress?.slice(0, 64) ?? null,
        userAgent: event.userAgent?.slice(0, 500) ?? null,
        metadata: metadata as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (error) {
    console.error("[audit] failed to record event", event.action, error);
  }
  // Even when the write failed: a plugin forwarding the log elsewhere may be the only copy then.
  try {
    notifyPlugins(recorded);
  } catch (error) {
    console.error("[audit] failed to notify plugins", event.action, error);
  }
}

export async function purgeAuditLog(retentionDays: number) {
  await prisma.auditLog.deleteMany({ where: { at: { lt: new Date(Date.now() - retentionDays * 86_400_000) } } });
}
