import { route } from "../../../../core/authz/guard";
import { parseId } from "../../../../core/content/ids";
import { webhookBody } from "../../../../core/extend/webhook-input";
import { deleteWebhook, updateWebhook } from "../../../../core/extend/webhooks";

export const PATCH = route(
  { access: "permission", permission: "webhook:manage", body: webhookBody, audit: "webhook.update", fresh: true },
  async ({ params, body, principal, auditTarget }) => {
    auditTarget("webhook", params.id, { name: body.name, url: body.url });
    return updateWebhook(parseId(params.id), body, principal.user.id, principal.scope);
  },
);

export const DELETE = route({ access: "permission", permission: "webhook:manage", audit: "webhook.delete", fresh: true }, async ({ params, principal, auditTarget }) => {
  auditTarget("webhook", params.id);
  await deleteWebhook(parseId(params.id), principal.scope);
  return null;
});
