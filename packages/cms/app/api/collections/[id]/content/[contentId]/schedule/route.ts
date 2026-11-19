import { z } from "zod";
import { route } from "../../../../../../../core/authz/guard";
import { getSchedule, requireRecord, setSchedule } from "../../../../../../../core/content/revisions";
import { canPublish, reviewRequired } from "../../../../../../../core/content/workflow";

const moment = z.iso.datetime({ offset: true }).nullable();
const body = z.object({ publishAt: moment, unpublishAt: moment });

export const GET = route({ access: "permission", permission: "record:read", scope: "record", apiKey: true }, async ({ params, principal, request }) => {
  const { collection, item } = await requireRecord(params, principal, request, "view");
  return getSchedule(collection, item.id);
});

export const PUT = route(
  { access: "permission", permission: ["record:read", "record:update"], scope: "record", apiKey: true, body, audit: "record.schedule" },
  async ({ params, body, principal, request, auditTarget }) => {
    const { collection, item } = await requireRecord(params, principal, request, "update");
    // It would fail when it runs anyway, since a schedule acts with its author's permissions.
    if ((body.publishAt || body.unpublishAt) && !canPublish(collection, principal.permissions)) throw reviewRequired();
    auditTarget("record", String(item.id), { collection: collection.slug, publishAt: body.publishAt, unpublishAt: body.unpublishAt });
    await setSchedule(collection, item.id, body, principal.user.id);
    return getSchedule(collection, item.id);
  },
);
