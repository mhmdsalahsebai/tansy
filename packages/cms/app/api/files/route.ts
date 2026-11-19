import { z } from "zod";
import { route } from "../../../core/authz/guard";
import { listFiles } from "../../../core/files/service";
import { fileTextChain, fileTextLocale } from "../../../core/files/text";

const query = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(200).default(30),
  search: z.string().max(200).optional(),
  /** The language to read each file's text in. The default language when left out. */
  locale: z.string().max(35).optional(),
});

export const GET = route({ access: "permission", permission: "file:list", apiKey: true, query }, async ({ query, principal }) =>
  listFiles(query.page, query.perPage, query.search, await fileTextChain(await fileTextLocale(query.locale, principal.permissions.has("file:read")))));
