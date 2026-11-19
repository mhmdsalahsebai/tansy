import { route } from "../../../core/authz/guard";
import { webhookBody } from "../../../core/extend/webhook-input";
import { createWebhook, listWebhooks } from "../../../core/extend/webhooks";

export const GET = route({ access: "permission", permission: "webhook:read" }, async ({ principal }) => listWebhooks(principal.scope));

// A webhook sends records to an outside address with its owner's access, so this asks for a fresh sign-in.
export const POST = route(
  { access: "permission", permission: "webhook:manage", body: webhookBody, audit: "webhook.create", fresh: true },
  async ({ body, principal, auditTarget }) => {
    const webhook = await createWebhook(body, principal.user.id, principal.scope);
    auditTarget("webhook", String(webhook.id), { name: body.name, url: body.url });
    return webhook;
  },
);
