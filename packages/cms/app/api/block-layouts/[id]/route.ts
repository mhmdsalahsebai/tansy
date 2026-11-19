import { route } from "../../../../core/authz/guard";
import { deleteBlockLayout } from "../../../../core/blocks/layouts";
import { parseId } from "../../../../core/content/ids";

export const DELETE = route(
  { access: "permission", permission: "collection:delete", audit: "block_layout.delete", fresh: true },
  async ({ params, auditTarget }) => {
    const name = await deleteBlockLayout(parseId(params.id));
    auditTarget("block_layout", params.id, { name });
    return null;
  },
);
