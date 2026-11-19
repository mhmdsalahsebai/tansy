import { z } from "zod";

export const webhookBody = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().min(1).max(2000),
  events: z.array(z.enum(["create", "update", "delete"])).min(1).max(3),
  collections: z.array(z.string().max(63)).max(200).default([]),
  enabled: z.boolean().default(true),
});
