import { z } from "zod";
import { route } from "../../../../../core/authz/guard";
import { updateRules } from "../../../../../core/content/collections";
import { parseId } from "../../../../../core/content/ids";

const rule = z.string().max(4096).nullable();
const body = z.object({ listRule: rule, viewRule: rule, createRule: rule, updateRule: rule, deleteRule: rule });

export const PUT = route(
  { access: "permission", permission: "collection:manage-rules", body, audit: "collection.update_rules", fresh: true },
  async ({ params, body, auditTarget }) => {
    auditTarget("collection", params.id, body);
    return updateRules(parseId(params.id), body);
  },
);
