import { route } from "../../../../../core/authz/guard";
import { parseId } from "../../../../../core/content/ids";
import { listDeliveries } from "../../../../../core/extend/webhooks";

export const GET = route({ access: "permission", permission: "webhook:read" }, async ({ params, principal }) => listDeliveries(parseId(params.id), principal.scope));
