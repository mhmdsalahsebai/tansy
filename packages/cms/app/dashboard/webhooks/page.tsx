import { requirePage } from "../../../core/authz/page";
import { listWebhooks } from "../../../core/extend/webhooks";
import { plain } from "../../../core/http/plain";
import type ClientType from "./page.client";
import type { WebhookRow } from "./page.client";
import { clientPage } from "../../../routes/client-page";

const Client = clientPage<typeof ClientType>("webhooks");

export default async function Page() {
  const principal = await requirePage("webhook:read");
  return <Client initial={plain<WebhookRow[]>(await listWebhooks(principal.scope))} canManage={principal.permissions.has("webhook:manage")} />;
}
