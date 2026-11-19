import "server-only";
import type { ScheduledAction } from "../../generated/client-sqlite";
import { audit } from "../audit";
import { getRuntime } from "../auth/instance";
import { holdsOwnRecordPermission, holdsRecordPermission } from "../authz/permissions";
import { isBanned } from "../authz/principal";
import { permissionsForRole } from "../authz/roles";
import { HttpError } from "../http/errors";
import prisma from "../../lib/prisma";
import { requireCollection } from "./access";
import { requireContent, updateContent } from "./content-service";
import { publishLatest } from "./revisions";
import { withLocale, writeLocale } from "../i18n/storage";

const BATCH = 100;

function failureMessage(error: unknown) {
  if (!(error instanceof HttpError)) return "Something went wrong.";
  const details = Array.isArray(error.details) ? (error.details as Array<{ path: string; message: string }>) : [];
  return (details.length ? details.map((d) => `${d.path}: ${d.message}`).join("; ") : error.message).slice(0, 1000);
}

/**
 * Runs with the authority of whoever scheduled it, as it stands now, so a schedule can't outlive
 * that person's access. An own grant counts while the record is still theirs.
 */
async function assertStillAllowed(userId: string | null, collectionId: number, createdById: string | null) {
  const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
  const { roles } = await getRuntime();
  const permissions = user ? permissionsForRole(roles, user.role) : new Set<string>();
  const allowed = holdsRecordPermission(permissions, "record:update", collectionId)
    || (holdsOwnRecordPermission(permissions, "record:update", collectionId) && user !== null && createdById === user.id);
  if (!user || isBanned(user) || !allowed) {
    throw new HttpError(403, "SCHEDULER_NOT_ALLOWED", "The person who scheduled this can no longer edit records.");
  }
  return permissions;
}

async function perform(action: ScheduledAction) {
  // A localized record's schedule publishes one language.
  const loaded = await requireCollection(action.collectionId);
  const collection = action.locale ? withLocale(loaded, writeLocale(action.locale)) : loaded;
  const item = await requireContent(collection, action.recordId);
  // Hooks see the person's permissions as they stand now, as the check above does.
  const actor = { userId: action.createdById, permissions: await assertStillAllowed(action.createdById, action.collectionId, item.createdById) };
  if (action.action === "publish") await publishLatest(collection, item, actor);
  else await updateContent(collection, item, "draft", {}, { ...actor, canUseAny: true }, "Unpublished on schedule");
}

let running = false;

/** Failures stay on the schedule with their reason and aren't retried, so an editor can see and fix them. */
export async function runScheduledActions(now = new Date()) {
  if (running) return;
  running = true;
  try {
    const due = await prisma.scheduledAction.findMany({ where: { at: { lte: now }, failedAt: null }, orderBy: { at: "asc" }, take: BATCH });
    for (const action of due) {
      const event = { action: `record.scheduled_${action.action}`, actorId: action.createdById, actorKind: "system" as const, targetType: "record", targetId: String(action.recordId), metadata: { collectionId: action.collectionId, ...(action.locale ? { locale: action.locale } : {}) } };
      try {
        await perform(action);
        await prisma.scheduledAction.delete({ where: { id: action.id } });
        await audit({ ...event, outcome: "success" });
      } catch (error) {
        if (!(error instanceof HttpError)) console.error("[scheduler]", error);
        await prisma.scheduledAction.update({ where: { id: action.id }, data: { failedAt: new Date(), error: failureMessage(error) } });
        await audit({ ...event, outcome: "failure", metadata: { ...event.metadata, reason: failureMessage(error) } });
      }
    }
  } finally {
    running = false;
  }
}
