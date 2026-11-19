import "server-only";
import type { Prisma } from "../../generated/client-sqlite";
import prisma from "../../lib/prisma";
import { authExtensions } from "../config";
import { currentScopeValue } from "../scope/context";

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

/** Recording an event must never break the request that caused it. */
export async function audit(event: AuditEvent): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        // The scope value the work is for, so a tenant's events can be told apart, exported and purged with it.
        scope: (event.scope === undefined ? currentScopeValue() : event.scope) ?? "",
        action: event.action,
        outcome: event.outcome,
        actorId: event.actorId ?? null,
        actorEmail: event.actorEmail?.slice(0, 320) ?? null,
        actorKind: event.actorKind ?? (event.actorId ? "user" : "anonymous"),
        targetType: event.targetType,
        targetId: event.targetId,
        ipAddress: event.ipAddress?.slice(0, 64) ?? null,
        userAgent: event.userAgent?.slice(0, 500) ?? null,
        metadata: sanitizeMetadata(event.metadata) as Prisma.InputJsonValue | undefined,
      },
    });
    for (const extension of authExtensions()) await extension.onAudit?.(event);
  } catch (error) {
    console.error("[audit] failed to record event", event.action, error);
  }
}

export async function purgeAuditLog(retentionDays: number) {
  await prisma.auditLog.deleteMany({ where: { at: { lt: new Date(Date.now() - retentionDays * 86_400_000) } } });
}
