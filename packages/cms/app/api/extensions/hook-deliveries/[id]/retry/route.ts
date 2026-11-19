import { route } from "../../../../../../core/authz/guard";
import { parseId } from "../../../../../../core/content/ids";
import { retryHookDelivery } from "../../../../../../core/extend/hook-deliveries";

/** Runs a failed after-hook again. The hook gets the record as it was written, never anything the caller sends. */
export const POST = route({ access: "permission", permission: "setting:update", audit: "hook.retry" }, async ({ params, auditTarget }) => {
  auditTarget("hook_delivery", params.id);
  await retryHookDelivery(parseId(params.id));
  return null;
});
