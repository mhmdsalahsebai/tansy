import { z } from "zod";
import { route } from "../../../core/authz/guard";
import { listAudit } from "../../../core/audit/query";

const query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().trim().max(100).optional(),
  actor: z.string().trim().max(320).optional(),
  outcome: z.enum(["success", "failure", "denied"]).optional(),
});

export const GET = route({ access: "permission", permission: "audit:read", query }, async ({ query }) => listAudit(query));
