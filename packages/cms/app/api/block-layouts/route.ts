import { z } from "zod";
import { route } from "../../../core/authz/guard";
import { createBlockLayout, listBlockLayouts } from "../../../core/blocks/layouts";
import { storedBlock } from "../../../core/fields/builtin";

const body = z.object({
  name: z.string().trim().min(1).max(100),
  blocks: z.array(storedBlock).min(1).max(200),
});

export const GET = route({ access: "permission", permission: "collection:read" }, async () => listBlockLayouts());

export const POST = route(
  { access: "permission", permission: "collection:create", body, audit: "block_layout.create", fresh: true },
  async ({ body, principal, auditTarget }) => {
    const layout = await createBlockLayout(body, principal.user.id);
    auditTarget("block_layout", String(layout.id), { name: layout.name });
    return layout;
  },
);
